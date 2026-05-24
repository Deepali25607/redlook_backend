// BRD §11.5 Order APIs
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler, validate, badRequest, notFound, forbidden, HttpError } from '../lib/http.js';
import { serializeOrder } from '../lib/serialize.js';
import { generateInvoicePDF } from '../lib/invoice.js';
import { notify } from '../lib/notify.js';
import { isRazorpayEnabled, getKeyId, createRazorpayOrder, toPaise } from '../lib/razorpay.js';
import { canCancelOrder, getCancellationCutoff, cancellationBlockedMessage } from '../lib/orderPolicy.js';
import { geocodeAddress, haversineKm, getGeofence } from '../lib/geofence.js';
import { checkEligibility, computeDueDate, recordCreditDebit, throwIfIneligible } from '../lib/credit.js';
import { resolveProductPrice } from '../lib/pricing.js';

// Fire-and-forget wrapper — notify() must never break the user-facing response.
const fireNotify = (args) => notify(args).catch((err) => console.error('[notify] failed:', err.message));

const formatINR = (n) => `Rs. ${Number(n).toFixed(2)}`;

const router = Router();
router.use(requireAuth);

const placeOrderSchema = z.object({
  address_id: z.string().uuid(),
  delivery_slot: z.string().min(1),
  // CREDIT = pay-later (BRD §3). Eligibility is checked server-side via
  // checkEligibility before the order is created.
  payment_method: z.enum(['UPI', 'CARD', 'NETBANKING', 'COD', 'CREDIT']),
  coupon_code: z.string().optional().nullable(),
  items: z.array(z.object({
    product_id: z.string().min(1),
    qty: z.number().positive(),
  })).min(1),
  // Optional live-location override sent by checkout's "Share live
  // location with the delivery person" tile. When present, the snapshot
  // stores these coords instead of the saved address coords — useful
  // when the customer is at a slightly different spot than the saved
  // address (e.g. office address on file but standing on the next
  // street). Lat/lng range-validated; accuracy is meters (optional).
  delivery_location: z.object({
    latitude: z.number().gte(-90).lte(90),
    longitude: z.number().gte(-180).lte(180),
    accuracy: z.number().positive().optional().nullable(),
  }).optional().nullable(),
});

// All order thresholds — minimum value/quantity, delivery charge, and the
// "free delivery over" cutoff — live in the BusinessSettings table
// (admin-editable). The fallbacks below are only used when the row is missing,
// which should never happen in a seeded environment.
const MIN_ORDER_FALLBACK = 150;
const MIN_QTY_FALLBACK = 1;
const FREE_DELIVERY_OVER_FALLBACK = 299;
const DELIVERY_CHARGE_FALLBACK = 40;
// Fresh vegetables (HSN 0701–0714) are GST-exempt in practice, so we charge no
// tax. Kept as a single constant so flipping it back is one line if regulation
// changes; the rest of the order calc and the invoice handle tax > 0 cleanly.
const TAX_RATE = 0;

function generateOrderId() {
  return `ORD-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
}

// POST /api/orders — server-side price calculation; never trust totals from the client.
// FR-CART-04, FR-CART-05, FR-PAY-01..05
//
// Payment methods:
//   - COD: always enabled. Order saved with payment_status='Pending'; flips to
//     'Paid' on delivery confirmation by admin.
//   - UPI: enabled only when Razorpay keys are configured (see lib/razorpay.js).
//     The order is saved with payment_status='Pending' and a razorpay_order_id.
//     The response includes a `checkout` block; the frontend opens Razorpay
//     Checkout, and after the user pays we mark the order Paid via
//     /api/payments/verify (which validates the HMAC signature).
//   - CARD / NETBANKING: schema accepts the values so the contract is stable,
//     but the route still rejects them — Razorpay supports both, but enabling
//     them is a separate UAT step (different fee structure, KYC implications).

function getOnlinePaymentDisabledReason(method) {
  if (method === 'CARD' || method === 'NETBANKING') {
    return `${method === 'CARD' ? 'Card' : 'Net Banking'} payment is not available currently. Please choose UPI or Cash on Delivery.`;
  }
  if (method === 'UPI' && !isRazorpayEnabled()) {
    return 'UPI is not available currently and will be enabled very soon. Please choose Cash on Delivery.';
  }
  return null;
}

router.post('/', validate(placeOrderSchema), asyncHandler(async (req, res) => {
  const { address_id, delivery_slot, payment_method, coupon_code, items, delivery_location } = req.body;

  // Hard gate at checkout: if the customer hasn't verified their phone (or
  // the verified state was reset by a profile phone-change) we refuse to
  // place the order. Surface the customer_id so the FE can route to the
  // verify-otp page with a Resend CTA without making them re-enter
  // anything. Login itself is also gated, but a session that survived a
  // profile phone-change can reach this point unverified.
  if (!req.user.phone_verified) {
    throw new HttpError(403, 'Please verify your phone number before placing an order. We can resend the SMS code if needed.', {
      code: 'PHONE_NOT_VERIFIED',
      customer_id: req.user.customer_id,
      phone: req.user.phone,
    });
  }

  const disabledReason = getOnlinePaymentDisabledReason(payment_method);
  if (disabledReason) badRequest(disabledReason);

  const order = await prisma.$transaction(async (tx) => {
    // 0. Operational thresholds — admin-editable via /api/admin/settings.
    // Read inside the transaction so a concurrent admin update is reflected
    // for orders placed after the commit.
    const settings = await tx.businessSettings.findUnique({ where: { id: 1 } });
    const minOrderValue = Number(settings?.min_order_value ?? MIN_ORDER_FALLBACK);
    const minOrderQuantity = settings?.min_order_quantity ?? MIN_QTY_FALLBACK;
    const deliveryCharge = Number(settings?.delivery_charge ?? DELIVERY_CHARGE_FALLBACK);
    const freeDeliveryOver = Number(settings?.free_delivery_over ?? FREE_DELIVERY_OVER_FALLBACK);

    // Validate the delivery slot against the admin-configured catalog.
    // Storefront sends "<dayPrefix>, <slot.label>" (e.g. "Today, 4 PM – 7 PM"),
    // and we accept the order when the trailing label matches an enabled
    // slot. Tolerant of dayPrefix wording (Today / Tomorrow / a date string)
    // because the frontend may localize the prefix in the customer's
    // chosen language; the admin-edited label is the stable part. Empty
    // catalog falls through (older installs without the column yet).
    const slotCatalog = Array.isArray(settings?.delivery_slots) ? settings.delivery_slots : [];
    if (slotCatalog.length > 0) {
      const tail = String(delivery_slot).split(',').slice(-1)[0].trim();
      const ok = slotCatalog.some((s) => s.enabled !== false && s.label.trim() === tail);
      if (!ok) badRequest('Selected delivery slot is no longer available — please pick another slot.');
    }

    // 1. Address must belong to this user
    const address = await tx.address.findUnique({ where: { address_id } });
    if (!address || address.customer_id !== req.user.customer_id) {
      notFound('Address not found');
    }

    // 1a. Geofence: reject if the delivery point falls outside the firm's
    // delivery radius. When the customer sent a live-location override
    // (`delivery_location`), that point is what we check + snapshot —
    // they're telling us "deliver here, not at the saved address". For
    // the no-override case we check the saved address coords (geocoded
    // or device-captured), one-shot geocoding any legacy row that's
    // still missing both.
    const fence = getGeofence(settings);
    let snapshotLat = address.latitude == null ? null : Number(address.latitude);
    let snapshotLon = address.longitude == null ? null : Number(address.longitude);
    let snapshotSource = address.location_source ?? (snapshotLat != null ? 'geocode' : null);
    let snapshotAccuracy = address.location_accuracy == null ? null : Number(address.location_accuracy);
    if (delivery_location) {
      snapshotLat = delivery_location.latitude;
      snapshotLon = delivery_location.longitude;
      snapshotSource = 'device';
      snapshotAccuracy = delivery_location.accuracy ?? null;
    }
    if (fence) {
      if (snapshotLat == null || snapshotLon == null) {
        const coords = await geocodeAddress(address);
        if (!coords) {
          badRequest('We could not locate your saved address on the map. Please re-save it from your addresses to continue.');
        }
        snapshotLat = coords.latitude;
        snapshotLon = coords.longitude;
        snapshotSource = 'geocode';
        await tx.address.update({
          where: { address_id: address.address_id },
          data: { latitude: snapshotLat, longitude: snapshotLon, location_source: 'geocode' },
        });
      }
      const distance = haversineKm(fence.latitude, fence.longitude, snapshotLat, snapshotLon);
      if (distance > fence.radiusKm) {
        badRequest(
          `Sorry, this delivery point is ${distance.toFixed(1)} km from our store — outside our ${fence.radiusKm} km delivery area.`,
          { code: 'OUTSIDE_DELIVERY_AREA', distance_km: Number(distance.toFixed(2)), radius_km: fence.radiusKm },
        );
      }
    }

    // 2. Load products, verify stock, snapshot pricing. Include category so
    // the pricing resolver can apply category-level discounts; the snapshot
    // stored in unit_price is the post-discount price the customer was
    // shown on the storefront, so price changes after order placement
    // never affect historical orders or invoices.
    const productIds = items.map((i) => i.product_id);
    const products = await tx.product.findMany({
      where: { product_id: { in: productIds } },
      include: { category: true },
    });
    const productMap = Object.fromEntries(products.map((p) => [p.product_id, p]));

    let subtotal = 0;
    let totalQuantity = 0;
    const orderItems = [];
    for (const i of items) {
      const p = productMap[i.product_id];
      if (!p) badRequest(`Product ${i.product_id} not found`);
      if (p.status !== 'Active') badRequest(`${p.name} is not available`);
      if (Number(p.stock_quantity) < i.qty) badRequest(`${p.name} only has ${p.stock_quantity} ${p.unit} in stock`);
      const { price: unitPrice, mrp } = resolveProductPrice(p, p.category, settings);
      const lineTotal = unitPrice * i.qty;
      subtotal += lineTotal;
      totalQuantity += Number(i.qty);
      orderItems.push({
        product_id: p.product_id,
        name: p.name,
        image: p.image,
        unit: p.unit,
        quantity: i.qty,
        // Snapshot the MRP alongside unit_price so the invoice and order
        // history can show "you saved Rs. X" even if the admin later
        // changes either value on the product row.
        mrp,
        unit_price: unitPrice,
        line_total: lineTotal,
      });
    }

    if (totalQuantity < minOrderQuantity) {
      badRequest(`Minimum order is ${minOrderQuantity} item${minOrderQuantity === 1 ? '' : 's'}`);
    }
    if (subtotal < minOrderValue) badRequest(`Minimum order is ₹${minOrderValue}`);

    // 3. Resolve coupon (if any) — server-side authoritative
    let discount = 0;
    let redeemedCouponId = null;
    if (coupon_code) {
      const c = await tx.coupon.findUnique({ where: { code: coupon_code.toUpperCase() } });
      if (!c) badRequest('Invalid coupon');
      if (!c.is_active) badRequest('Coupon is no longer active');
      if (c.valid_until && c.valid_until < new Date()) badRequest('Coupon has expired');
      if (Number(c.min_order) > subtotal) badRequest(`Coupon needs min order ₹${c.min_order}`);
      if (c.max_uses && c.used_count >= c.max_uses) badRequest('Coupon usage limit reached');

      // Per-customer "use once" gate. Pre-flight check inside the tx for a
      // friendly error message; the unique index is the real source of truth
      // and will reject racing duplicates with a P2002 below.
      const prior = await tx.couponRedemption.findUnique({
        where: { coupon_id_customer_id: { coupon_id: c.coupon_id, customer_id: req.user.customer_id } },
      });
      if (prior) badRequest('You have already used this coupon');

      discount = c.type === 'PERCENT'
        ? Math.round(subtotal * (Number(c.value) / 100))
        : Math.min(Number(c.value), subtotal);
      await tx.coupon.update({
        where: { coupon_id: c.coupon_id },
        data: { used_count: { increment: 1 } },
      });
      redeemedCouponId = c.coupon_id;
    }

    // 4. Delivery + tax
    const delivery_charge = subtotal > freeDeliveryOver ? 0 : deliveryCharge;
    const tax = Math.round((subtotal - discount) * TAX_RATE);
    const total_amount = subtotal - discount + delivery_charge + tax;

    // 5. Snapshot the address into the order so future address edits don't change history.
    // Lat/lng + source/accuracy ride along so admin/delivery staff can open
    // a Google Maps pin without depending on the Address row still existing.
    const addressSnapshot = {
      address_id: address.address_id,
      label: address.label,
      recipient_name: address.recipient_name,
      recipient_phone: address.recipient_phone,
      address_line1: address.address_line1,
      address_line2: address.address_line2,
      landmark: address.landmark,
      city: address.city,
      state: address.state,
      pincode: address.pincode,
      latitude: snapshotLat,
      longitude: snapshotLon,
      location_source: snapshotSource,
      location_accuracy: snapshotAccuracy,
      location_captured_at: delivery_location ? new Date().toISOString() : (address.location_captured_at ?? null),
    };

    // 6. Generate the internal order_id up front so we can stamp it on the
    // Razorpay Order's `receipt` + notes (used to reconcile webhooks back to
    // our DB row).
    const order_id = generateOrderId();

    // For online payments (UPI), create a matching Razorpay Order BEFORE we
    // commit the local Order. Doing it inside the tx means a Razorpay outage
    // rolls back the whole placement cleanly — no orphan Redlook order with
    // stock decrements left behind. Trade-off is a slightly longer tx; we
    // bump the timeout below to absorb network latency to Razorpay.
    let razorpayOrderId = null;
    if (payment_method === 'UPI') {
      try {
        const rzpOrder = await createRazorpayOrder({
          amountInRupees: total_amount,
          internalOrderId: order_id,
          customerEmail: req.user.email,
          customerPhone: req.user.phone,
        });
        razorpayOrderId = rzpOrder.id;
      } catch (err) {
        // Surface a clear message rather than the raw SDK error. The
        // transaction rolls back automatically once we throw.
        throw new HttpError(502, `Could not initiate UPI payment: ${err?.error?.description || err.message}`);
      }
    }

    // 6a. Credit eligibility — if the customer chose Pay-on-Credit, gate
     //    on enabled/blocked/overdue/limit BEFORE the order is committed.
    //    Throws HttpError with details.code so the FE can render an inline
    //    "limit exceeded" / "credit blocked" message.
    if (payment_method === 'CREDIT') {
      throwIfIneligible(await checkEligibility(req.user.customer_id, total_amount, tx));
    }

    const created = await tx.order.create({
      data: {
        order_id,
        customer_id: req.user.customer_id,
        address_snapshot: addressSnapshot,
        delivery_slot,
        payment_method,
        // COD / UPI / CREDIT all start Pending. COD flips to Paid on
        // delivery confirmation, UPI on /api/payments/verify, CREDIT
        // when the credit_transaction is later marked PAID by a
        // PaymentReceived row.
        payment_status: 'Pending',
        razorpay_order_id: razorpayOrderId,
        subtotal,
        discount,
        delivery_charge,
        tax,
        total_amount,
        timeline: [{ status: 'Placed', at: new Date().toISOString(), note: 'Order placed successfully' }],
        items: { create: orderItems },
      },
      include: { items: true },
    });

    // 6b. For CREDIT orders: append the DEBIT row + compute due_date now.
    //     terms_start_from='delivery' means due_date is set provisionally
    //     from order_date and re-stamped at delivery confirmation; for
    //     'invoice' the order_date is the final base.
    if (payment_method === 'CREDIT') {
      const config = await tx.customerCreditConfig.findUnique({
        where: { customer_id: req.user.customer_id },
      });
      const dueDate = computeDueDate(
        config.terms_start_from,
        config.payment_terms_days,
        created.order_date,
        null, // delivery_date unknown at placement; re-stamped on delivery
      );
      await recordCreditDebit(tx, {
        customerId: req.user.customer_id,
        orderId: created.order_id,
        amount: total_amount,
        dueDate,
        createdBy: req.user.email,
        notes: `Order ${created.order_id} placed on credit`,
      });
    }

    // 7. Decrement stock
    for (const i of orderItems) {
      await tx.product.update({
        where: { product_id: i.product_id },
        data: { stock_quantity: { decrement: i.quantity } },
      });
    }

    // 8. Record per-customer coupon redemption — the unique index on
    // (coupon_id, customer_id) is the authoritative gate. If a racing request
    // already inserted, this throws P2002 and the whole transaction rolls back.
    if (redeemedCouponId) {
      await tx.couponRedemption.create({
        data: {
          coupon_id: redeemedCouponId,
          customer_id: req.user.customer_id,
          order_id,
        },
      });
    }

    // 9. Award loyalty points (1 per ₹10 spent)
    await tx.customer.update({
      where: { customer_id: req.user.customer_id },
      data: { loyalty_points: { increment: Math.floor(total_amount / 10) } },
    });

    return created;
  }, {
    // Default Prisma tx timeout is 5s. The Razorpay call inside this tx can
    // legitimately take a few seconds over a slow link, so widen the window.
    // Pure DB work still commits in <100 ms; this only matters for online
    // payments that hit the network.
    timeout: 30_000,
    maxWait: 5_000,
  });

  // For UPI we defer the welcome notification until /api/payments/verify
  // succeeds — sending "order placed" before the customer has actually paid
  // would be misleading. COD orders fire immediately.
  if (order.payment_method === 'COD') {
    fireNotify({
      template: 'order.placed',
      to: { email: req.user.email, phone: req.user.phone, customer_id: req.user.customer_id },
      data: {
        order_id: order.order_id,
        customer_name: req.user.full_name,
        total: formatINR(order.total_amount),
        slot: order.delivery_slot,
        payment_method: order.payment_method,
      },
    });
  }
  // CREDIT orders fire a dedicated invoice-style notification with the due
  // date — separate from order.placed because the customer experience is
  // "you owe money" not "you paid". Look up the freshly-created DEBIT to
  // get the actual due_date computed inside the transaction above.
  if (order.payment_method === 'CREDIT') {
    const debit = await prisma.creditTransaction.findFirst({
      where: { order_id: order.order_id, type: 'DEBIT' },
      orderBy: { created_at: 'desc' },
    });
    fireNotify({
      template: 'credit.order_placed',
      to: { email: req.user.email, phone: req.user.phone, customer_id: req.user.customer_id },
      data: {
        order_id: order.order_id,
        customer_name: req.user.full_name,
        amount: formatINR(order.total_amount),
        due_date: debit?.due_date
          ? new Date(debit.due_date).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
          : 'TBD',
      },
    });
  }

  // For UPI orders, return the params the frontend Razorpay Checkout SDK
  // needs in addition to the order. The FE opens the modal, the user pays,
  // and the success handler calls /api/payments/verify with the signature.
  const responseBody = { data: serializeOrder(order) };
  if (order.payment_method === 'UPI' && order.razorpay_order_id) {
    responseBody.checkout = {
      provider: 'razorpay',
      key_id: getKeyId(),
      razorpay_order_id: order.razorpay_order_id,
      amount_paise: toPaise(order.total_amount),
      currency: 'INR',
    };
  }
  res.status(201).json(responseBody);
}));

// GET /api/orders/{id}
// Includes the current Product.is_returnable for each item so the customer
// return form can filter non-returnable line items. Product flag (not a
// snapshot) is intentional: if an item became non-returnable AFTER the
// order was placed, the customer should see the current policy.
router.get('/:id', asyncHandler(async (req, res) => {
  const order = await prisma.order.findUnique({
    where: { order_id: req.params.id },
    include: { items: { include: { product: { select: { is_returnable: true } } } } },
  });
  if (!order) notFound('Order not found');
  if (order.customer_id !== req.user.customer_id) forbidden();
  res.json({ data: serializeOrder(order) });
}));

// GET /api/orders/user/{userId}
router.get('/user/:userId', asyncHandler(async (req, res) => {
  if (req.params.userId !== req.user.customer_id) forbidden();
  const orders = await prisma.order.findMany({
    where: { customer_id: req.params.userId },
    include: { items: { include: { product: { select: { is_returnable: true } } } } },
    orderBy: { order_date: 'desc' },
  });
  res.json({ data: orders.map(serializeOrder) });
}));

// POST /api/orders/{id}/return — FR-ORD-05 (return/refund within 24h of delivery)
const returnSchema = z.object({
  reason: z.string().min(5).max(500),
  items: z.array(z.object({
    product_id: z.string().min(1),
    qty: z.number().positive(),
    reason: z.string().optional(),
  })).optional(),
});

// Return window length is admin-configured at runtime via
// BusinessSettings.return_window_hours. We read it on each return request
// rather than caching so a policy change takes effect immediately —
// returns are infrequent enough that the extra row read is negligible.
router.post('/:id/return', validate(returnSchema), asyncHandler(async (req, res) => {
  const order = await prisma.order.findUnique({
    where: { order_id: req.params.id },
    include: { items: true },
  });
  if (!order) notFound('Order not found');
  if (order.customer_id !== req.user.customer_id) forbidden();
  if (order.order_status !== 'Delivered') {
    badRequest('Returns can only be requested on delivered orders');
  }

  const settings = await prisma.businessSettings.findUnique({ where: { id: 1 } });
  const returnWindowHours = settings?.return_window_hours ?? 24;

  const deliveredEntry = order.timeline.find((t) => t.status === 'Delivered');
  if (!deliveredEntry) badRequest('Delivery timestamp missing from order history');
  const hoursSinceDelivery = (Date.now() - new Date(deliveredEntry.at).getTime()) / 36e5;
  if (hoursSinceDelivery > returnWindowHours) {
    badRequest(`Return window of ${returnWindowHours} hours has expired`);
  }

  if (req.body.items?.length) {
    const orderProductIds = new Set(order.items.map((i) => i.product_id));
    for (const r of req.body.items) {
      if (!orderProductIds.has(r.product_id)) {
        badRequest(`Product ${r.product_id} is not in this order`);
      }
    }
  }

  // Enforce per-product return eligibility. The frontend already filters
  // non-returnable items out of the form, but a server-side check is the
  // authoritative gate — defends against manually-crafted requests and
  // catches the case where a product was flagged non-returnable AFTER the
  // order was placed.
  const productIdsToCheck = req.body.items?.length
    ? req.body.items.map((r) => r.product_id)
    : order.items.map((i) => i.product_id);
  const products = await prisma.product.findMany({
    where: { product_id: { in: productIdsToCheck } },
    select: { product_id: true, name: true, is_returnable: true },
  });
  const blocked = products.filter((p) => p.is_returnable === false);
  if (blocked.length) {
    const names = blocked.map((p) => p.name).join(', ');
    badRequest(`These items are not eligible for return: ${names}. Remove them from the request and try again.`);
  }

  const updated = await prisma.order.update({
    where: { order_id: req.params.id },
    data: {
      order_status: 'ReturnRequested',
      timeline: [
        ...order.timeline,
        {
          status: 'ReturnRequested',
          at: new Date().toISOString(),
          note: req.body.reason,
          items: req.body.items ?? null,
        },
      ],
    },
    include: { items: true },
  });

  fireNotify({
    template: 'order.return_requested',
    to: { email: req.user.email, phone: req.user.phone, customer_id: req.user.customer_id },
    data: { order_id: updated.order_id, reason: req.body.reason },
  });

  res.json({ data: serializeOrder(updated) });
}));

// GET /api/orders/{id}/invoice — FR-PAY-07 tax invoice PDF download
router.get('/:id/invoice', asyncHandler(async (req, res) => {
  const order = await prisma.order.findUnique({
    where: { order_id: req.params.id },
    include: { items: true },
  });
  if (!order) notFound('Order not found');
  if (order.customer_id !== req.user.customer_id) forbidden();
  if (order.order_status === 'Cancelled') {
    badRequest('Invoice is not available for cancelled orders');
  }

  // Seller block on the invoice is sourced from BusinessSettings so the
  // admin-edited company name / address / contacts flow into the PDF.
  const settings = await prisma.businessSettings.findUnique({ where: { id: 1 } });
  const pdf = await generateInvoicePDF(serializeOrder(order), req.user, settings);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="invoice-${order.order_id}.pdf"`);
  res.setHeader('Content-Length', pdf.length);
  res.send(pdf);
}));

// PUT /api/orders/{id}/cancel — FR-ORD-04
router.put('/:id/cancel', asyncHandler(async (req, res) => {
  const order = await prisma.order.findUnique({
    where: { order_id: req.params.id },
    include: { items: true },
  });
  if (!order) notFound('Order not found');
  if (order.customer_id !== req.user.customer_id) forbidden();
  // Terminal states first — these aren't part of the lifecycle ordering.
  if (['Cancelled', 'ReturnRequested'].includes(order.order_status)) {
    badRequest('Order cannot be cancelled at this stage');
  }
  // Configurable cutoff (BusinessSettings.cancellation_cutoff_status).
  // Default 'Out for Delivery' = cancel allowed up to and including 'Packed'.
  const cutoff = await getCancellationCutoff();
  if (!canCancelOrder(order.order_status, cutoff)) {
    throw new HttpError(400, cancellationBlockedMessage(order.order_status, cutoff), {
      code: 'CANCELLATION_CLOSED',
      cutoff_status: cutoff,
      current_status: order.order_status,
    });
  }

  const updated = await prisma.$transaction(async (tx) => {
    // Restore stock
    for (const i of order.items) {
      await tx.product.update({
        where: { product_id: i.product_id },
        data: { stock_quantity: { increment: i.quantity } },
      });
    }
    return tx.order.update({
      where: { order_id: req.params.id },
      data: {
        order_status: 'Cancelled',
        timeline: [
          ...order.timeline,
          { status: 'Cancelled', at: new Date().toISOString(), note: req.body?.reason || 'Cancelled by customer' },
        ],
      },
      include: { items: true },
    });
  });

  fireNotify({
    template: 'order.cancelled',
    to: { email: req.user.email, phone: req.user.phone, customer_id: req.user.customer_id },
    data: { order_id: updated.order_id },
  });

  res.json({ data: serializeOrder(updated) });
}));

export default router;
