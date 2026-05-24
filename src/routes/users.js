// BRD §11.2 Customer Profile APIs (and address sub-resources)
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { requireAuth, requireSelf } from '../middleware/auth.js';
import { asyncHandler, validate, badRequest, conflict, notFound } from '../lib/http.js';
import { serializeUser, serializeAddress, serializeProduct } from '../lib/serialize.js';
import { resolveLocale } from '../lib/i18n.js';
import { notify } from '../lib/notify.js';
import { geocodeAddress, getGeofence, annotateDeliverability } from '../lib/geofence.js';
import {
  computeCreditState, serializeConfig, serializeTransaction, serializePayment,
  decorateOverdue,
} from '../lib/credit.js';
import { isRazorpayEnabled, createPaymentLink, fetchPaymentLink } from '../lib/razorpay.js';
import { generatePaymentReceiptPDF } from '../lib/paymentReceipt.js';

// Mirrors the constants in routes/auth.js. Kept in this file rather than
// importing across route modules so each module's contract is self-evident
// from a single read.
const PHONE_OTP_TTL_MINUTES = 10;
const fireNotify = (args) => notify(args).catch((err) => console.error('[notify] failed:', err.message));

const router = Router();

const updateProfileSchema = z.object({
  full_name: z.string().min(2).max(100).optional(),
  phone: z.string().regex(/^[6-9]\d{9}$/).optional(),
  date_of_birth: z.string().nullable().optional(),
  gender: z.string().nullable().optional(),
  profile_picture_url: z.string().url().nullable().optional(),
  notification_prefs: z.record(z.boolean()).optional(),
  // Preferred storefront language. Synced from the in-app language switcher.
  language: z.enum(['en', 'hi', 'bn']).optional(),
});

const addressSchema = z.object({
  label: z.enum(['Home', 'Office', 'Other']),
  recipient_name: z.string().min(1).max(100),
  recipient_phone: z.string().regex(/^[6-9]\d{9}$/),
  address_line1: z.string().min(1).max(255),
  address_line2: z.string().max(255).optional().nullable(),
  landmark: z.string().max(100).optional().nullable(),
  city: z.string().min(1).max(50),
  state: z.string().min(1).max(50),
  pincode: z.string().regex(/^\d{6}$/),
  latitude: z.number().optional().nullable(),
  longitude: z.number().optional().nullable(),
  // Browser geolocation metadata — only set when the customer hit
  // "Use my current location" and granted permission. 'device' coords
  // are authoritative over the server-side geocoder fallback.
  location_source: z.enum(['device', 'geocode']).optional().nullable(),
  location_accuracy: z.number().optional().nullable(),
  is_default: z.boolean().optional(),
});

// All user routes require auth + self-only access.
router.use('/:id', requireAuth, requireSelf('id'));

// GET /api/users/{id}
router.get('/:id', asyncHandler(async (req, res) => {
  const user = await prisma.customer.findUnique({
    where: { customer_id: req.params.id },
    include: { addresses: true },
  });
  if (!user) notFound('User not found');
  const serialized = serializeUser(user);
  if (serialized.addresses) {
    serialized.addresses = await withDeliverability(serialized.addresses);
  }
  res.json({ data: serialized });
}));

// PUT /api/users/{id}
router.put('/:id', validate(updateProfileSchema), asyncHandler(async (req, res) => {
  const data = { ...req.body };
  if (data.date_of_birth) data.date_of_birth = new Date(data.date_of_birth);

  // Phone change → re-verification flow:
  //   1. Reject if the number already belongs to another customer (the unique
  //      constraint would catch this too via P2002 but the friendly error is
  //      better than a generic 409).
  //   2. Drop phone_verified back to false and clear any in-flight OTP slot
  //      so the next /verify-otp uses the new code, not a stale one for the
  //      previous number.
  //   3. Issue a fresh OTP via SMS to the new number, in the same DB write
  //      so we never leave the row in an inconsistent state where the phone
  //      changed but no code is on file.
  // The customer's session stays alive — we don't lock them out of the
  // app, but checkout (orders.js) will refuse until they verify.
  let issueFreshOtp = false;
  if (data.phone) {
    const current = await prisma.customer.findUnique({
      where: { customer_id: req.params.id },
      select: { phone: true },
    });
    if (current?.phone !== data.phone) {
      const taken = await prisma.customer.findUnique({ where: { phone: data.phone } });
      if (taken && taken.customer_id !== req.params.id) {
        conflict('That phone number is already registered to another account');
      }
      const otp = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
      data.phone_verified = false;
      data.phone_otp_hash = await bcrypt.hash(otp, 10);
      data.phone_otp_expires_at = new Date(Date.now() + PHONE_OTP_TTL_MINUTES * 60 * 1000);
      data.phone_otp_attempts = 0;
      data.phone_otp_issued_at = new Date();
      issueFreshOtp = otp; // Hold the plaintext to dispatch after the commit.
    } else {
      // No actual change — strip phone from the patch so we don't trip the
      // verification reset path.
      delete data.phone;
    }
  }

  const user = await prisma.customer.update({
    where: { customer_id: req.params.id },
    data,
    include: { addresses: true },
  });

  if (issueFreshOtp) {
    fireNotify({
      template: 'auth.phone_verification',
      to: { phone: user.phone, customer_id: user.customer_id },
      data: { otp: issueFreshOtp, ttl_minutes: PHONE_OTP_TTL_MINUTES },
    });
  }

  // Dev convenience: echo the freshly-issued OTP back so the FE can toast
  // it. Mirrors auth.js devOtpEcho gating — off when MSG91 is configured;
  // on in non-prod; in prod requires OTP_ECHO_FOR_TESTING=true.
  const echoEnabled = !process.env.MSG91_AUTH_KEY
    && (process.env.NODE_ENV !== 'production' || process.env.OTP_ECHO_FOR_TESTING === 'true');
  const dev_otp = issueFreshOtp && echoEnabled ? issueFreshOtp : undefined;

  res.json({ data: serializeUser(user), dev_otp });
}));

// ---------- Addresses ----------

// GET /api/users/{id}/addresses
router.get('/:id/addresses', asyncHandler(async (req, res) => {
  const list = await prisma.address.findMany({
    where: { customer_id: req.params.id },
    orderBy: { is_default: 'desc' },
  });
  const annotated = await withDeliverability(list.map(serializeAddress));
  res.json({ data: annotated });
}));

// Geocode the address (full → pincode fallback) and stamp the resolved
// coordinates onto `data` so deliverability can be computed downstream.
//
// We deliberately do NOT reject out-of-area or ungeocodable addresses
// here — the customer can save any address; the response just flags it
// as not_deliverable so the UI can grey it out and the order endpoint
// blocks placement against it. This is a conscious split:
//   - Address book = inventory of where the customer might receive things
//   - Deliverability = a *property* of an address, not a save-time gate
//
// If geocoding fails entirely (Nominatim down, vague address), lat/lng
// stay null and the annotator marks the row not_deliverable for the
// same reason an out-of-range row is.
async function applyGeofenceToAddress(data) {
  const settings = await prisma.businessSettings.findUnique({ where: { id: 1 } });
  const fence = getGeofence(settings);
  if (!fence) return;

  // Customer-granted device GPS wins over the geocoder — it's typically
  // accurate to ~10m vs the geocoder's pincode-centroid (~500m+) fallback.
  // We stamp captured_at server-side so the timestamp is trusted regardless
  // of the client's clock skew.
  if (data.location_source === 'device'
      && Number.isFinite(data.latitude) && Number.isFinite(data.longitude)) {
    data.location_captured_at = new Date();
    return;
  }

  const coords = await geocodeAddress({
    address_line1: data.address_line1,
    address_line2: data.address_line2,
    landmark: data.landmark,
    city: data.city,
    state: data.state,
    pincode: data.pincode,
  });
  if (coords) {
    data.latitude = coords.latitude;
    data.longitude = coords.longitude;
    data.location_source = 'geocode';
    data.location_accuracy = null;
    data.location_captured_at = null;
  } else {
    // Explicit null so a re-saved address that previously had coords
    // doesn't keep stale ones when geocoding now fails.
    data.latitude = null;
    data.longitude = null;
    data.location_source = null;
    data.location_accuracy = null;
    data.location_captured_at = null;
  }
}

// Wrap a fresh DB read of business settings + the per-address annotator
// so route handlers can decorate responses with one line.
async function withDeliverability(addressOrList) {
  const settings = await prisma.businessSettings.findUnique({ where: { id: 1 } });
  const fence = getGeofence(settings);
  if (Array.isArray(addressOrList)) {
    return addressOrList.map((a) => annotateDeliverability(a, fence));
  }
  return annotateDeliverability(addressOrList, fence);
}

// POST /api/users/{id}/addresses — FR-PROF-03 (max 5 per BRD §8.2)
router.post('/:id/addresses', validate(addressSchema), asyncHandler(async (req, res) => {
  const count = await prisma.address.count({ where: { customer_id: req.params.id } });
  if (count >= 5) badRequest('Maximum 5 addresses allowed');

  const isFirst = count === 0;
  const data = { ...req.body, customer_id: req.params.id };
  // First address is always default; explicit default flips others off.
  if (isFirst) data.is_default = true;
  await applyGeofenceToAddress(data);
  const address = await prisma.$transaction(async (tx) => {
    if (data.is_default && !isFirst) {
      await tx.address.updateMany({
        where: { customer_id: req.params.id },
        data: { is_default: false },
      });
    }
    return tx.address.create({ data });
  });
  const annotated = await withDeliverability(serializeAddress(address));
  res.status(201).json({ data: annotated });
}));

// PUT /api/users/{id}/addresses/{aid}
router.put('/:id/addresses/:aid', validate(addressSchema.partial()), asyncHandler(async (req, res) => {
  const data = { ...req.body };
  // Re-geocode + revalidate only when an address-shape field actually
  // changed. Toggling is_default by itself shouldn't pay the Nominatim
  // round-trip or fail because the firm moved since the row was saved.
  const addressFieldsChanged = ['address_line1', 'address_line2', 'landmark', 'city', 'state', 'pincode']
    .some((k) => k in data);
  // Fresh device GPS sent in this PUT (customer hit "Use my current
  // location" while editing) — accept it directly; no need to geocode.
  const freshDeviceCoords = data.location_source === 'device'
    && Number.isFinite(data.latitude) && Number.isFinite(data.longitude);
  if (freshDeviceCoords) {
    data.location_captured_at = new Date();
  } else if (addressFieldsChanged) {
    const existing = await prisma.address.findUnique({ where: { address_id: req.params.aid } });
    if (!existing || existing.customer_id !== req.params.id) notFound('Address not found');
    // Preserve a previously-captured device GPS pin across a text edit
    // (e.g. customer just fixes a typo in the landmark). Re-geocoding
    // would replace ~10m-accurate coords with a pincode centroid.
    if (existing.location_source === 'device') {
      data.latitude = existing.latitude == null ? null : Number(existing.latitude);
      data.longitude = existing.longitude == null ? null : Number(existing.longitude);
      data.location_source = 'device';
      data.location_accuracy = existing.location_accuracy ?? null;
      data.location_captured_at = existing.location_captured_at;
    } else {
      const merged = {
        address_line1: data.address_line1 ?? existing.address_line1,
        address_line2: data.address_line2 ?? existing.address_line2,
        landmark: data.landmark ?? existing.landmark,
        city: data.city ?? existing.city,
        state: data.state ?? existing.state,
        pincode: data.pincode ?? existing.pincode,
      };
      await applyGeofenceToAddress(merged);
      data.latitude = merged.latitude;
      data.longitude = merged.longitude;
      data.location_source = merged.location_source;
      data.location_accuracy = merged.location_accuracy;
      data.location_captured_at = merged.location_captured_at;
    }
  }
  const address = await prisma.$transaction(async (tx) => {
    const existing = await tx.address.findUnique({ where: { address_id: req.params.aid } });
    if (!existing || existing.customer_id !== req.params.id) notFound('Address not found');

    if (data.is_default) {
      await tx.address.updateMany({
        where: { customer_id: req.params.id, address_id: { not: req.params.aid } },
        data: { is_default: false },
      });
    }
    return tx.address.update({ where: { address_id: req.params.aid }, data });
  });
  const annotated = await withDeliverability(serializeAddress(address));
  res.json({ data: annotated });
}));

// ---------- Credit / Pay-Later (BRD §4 — customer-facing pending view) ----------

// GET /api/users/{id}/credit — outstanding, available, pending invoices,
// payment history. Single round-trip for the customer's "My Credit" page.
router.get('/:id/credit', asyncHandler(async (req, res) => {
  const [config, transactions, payments, state] = await Promise.all([
    prisma.customerCreditConfig.findUnique({ where: { customer_id: req.params.id } }),
    prisma.creditTransaction.findMany({
      where: { customer_id: req.params.id },
      orderBy: { created_at: 'asc' },
    }),
    prisma.paymentReceived.findMany({
      where: { customer_id: req.params.id },
      orderBy: { payment_date: 'desc' },
      take: 50,
    }),
    computeCreditState(req.params.id),
  ]);

  const decorated = decorateOverdue(transactions.map(serializeTransaction));
  // Pending invoices = unpaid DEBITs only. The full transactions list is
  // also returned so the customer can see receipts/adjustments in their
  // history; the pending list is the actionable subset.
  const pending = decorated.filter((t) => t.type === 'DEBIT' && t.status !== 'PAID');

  res.json({
    data: {
      config: serializeConfig(config),
      state,
      pending_invoices: pending,
      transactions: decorated,
      payments: payments.map(serializePayment),
      // Hint to the UI that "Pay now" should be active. The actual link
      // is minted on demand via the POST below.
      razorpay_enabled: isRazorpayEnabled(),
    },
  });
}));

// POST /api/users/{id}/credit/invoices/{txId}/payment-link
//
// Mints (or reuses) a Razorpay payment link for an unpaid DEBIT and returns
// the short URL. Reuses any link already attached to the row — Razorpay's
// `payment_link.fetch` confirms it's still in `created` status before we
// hand it back; if the stored link has been paid/cancelled/expired we mint
// a fresh one. Idempotent: a customer hammering "Pay now" never produces
// a fan-out of duplicate links on the Razorpay dashboard.
router.post('/:id/credit/invoices/:txId/payment-link', requireSelf,
  asyncHandler(async (req, res) => {
    if (!isRazorpayEnabled()) {
      return res.status(503).json({
        error: 'Online payment is not configured yet. Please contact us to settle this invoice.',
        code: 'RAZORPAY_NOT_CONFIGURED',
      });
    }

    const tx = await prisma.creditTransaction.findUnique({
      where: { id: req.params.txId },
    });
    if (!tx) notFound('Invoice not found');
    if (tx.customer_id !== req.params.id) notFound('Invoice not found');
    if (tx.type !== 'DEBIT') {
      badRequest('Only DEBIT entries can be paid via a payment link.');
    }

    const owed = Number(tx.amount) - Number(tx.amount_paid);
    if (owed <= 0 || tx.status === 'PAID') {
      return res.status(400).json({
        error: 'This invoice has no balance due.',
        code: 'INVOICE_ALREADY_PAID',
      });
    }

    // Reuse path — the row already carries a link id. Confirm with Razorpay
    // that it's still usable; if not, fall through and create a new one.
    if (tx.razorpay_payment_link_id && tx.razorpay_payment_link_url) {
      try {
        const existing = await fetchPaymentLink(tx.razorpay_payment_link_id);
        // Statuses Razorpay returns: 'created' | 'partially_paid' | 'paid'
        // | 'expired' | 'cancelled'. Reuse is safe in 'created' only.
        if (existing.status === 'created') {
          return res.json({
            data: {
              payment_link_id: tx.razorpay_payment_link_id,
              payment_link_url: tx.razorpay_payment_link_url,
              amount: owed,
              reused: true,
            },
          });
        }
      } catch (err) {
        // Network blip / Razorpay 404 / whatever — fall back to minting a
        // new link rather than failing the customer's click.
        console.warn(`[payment-link] reuse fetch failed for ${tx.razorpay_payment_link_id}:`, err.message);
      }
    }

    const customer = await prisma.customer.findUnique({
      where: { customer_id: req.params.id },
    });
    if (!customer) notFound('Customer not found');

    const settings = await prisma.businessSettings.findUnique({ where: { id: 1 } });
    const sellerName = settings?.company_name || 'Redlook';
    const description = `Payment for invoice ${tx.order_id || tx.id.slice(0, 8)} — ${sellerName}`;

    const link = await createPaymentLink({
      amountInRupees: owed,
      description,
      internalReference: tx.order_id || tx.id,
      internalCreditTransactionId: tx.id,
      customerName: customer.business_name || customer.full_name,
      customerEmail: customer.email,
      customerPhone: customer.phone,
    });

    await prisma.creditTransaction.update({
      where: { id: tx.id },
      data: {
        razorpay_payment_link_id: link.id,
        razorpay_payment_link_url: link.short_url,
      },
    });

    res.json({
      data: {
        payment_link_id: link.id,
        payment_link_url: link.short_url,
        amount: owed,
        reused: false,
      },
    });
  }));

// GET /api/users/{id}/credit/payments/{paymentId}/receipt
//
// Customer-facing receipt download. Returns a PDF of the PaymentReceived
// row and the invoices it allocated against. Same auth contract as the
// other /users/:id/* routes — must be the customer themselves.
router.get('/:id/credit/payments/:paymentId/receipt', requireSelf,
  asyncHandler(async (req, res) => {
    const payment = await prisma.paymentReceived.findUnique({
      where: { id: req.params.paymentId },
    });
    if (!payment || payment.customer_id !== req.params.id) {
      notFound('Receipt not found');
    }

    const [customer, settings] = await Promise.all([
      prisma.customer.findUnique({ where: { customer_id: req.params.id } }),
      prisma.businessSettings.findUnique({ where: { id: 1 } }),
    ]);
    if (!customer) notFound('Customer not found');

    // Hydrate the allocations stored as JSON on the PaymentReceived row
    // into full CreditTransaction rows so the receipt can show order id /
    // due date / running balance per allocation line.
    const allocs = Array.isArray(payment.applied_to_invoice_ids) ? payment.applied_to_invoice_ids : [];
    const txIds = allocs.map((a) => a?.credit_transaction_id).filter(Boolean);
    const txs = txIds.length
      ? await prisma.creditTransaction.findMany({ where: { id: { in: txIds } } })
      : [];
    const allocations = allocs.map((a) => ({
      applied_amount: Number(a?.applied_amount || 0),
      credit_transaction: txs.find((t) => t.id === a?.credit_transaction_id) || null,
    }));

    const pdf = await generatePaymentReceiptPDF({ payment, customer, allocations, settings });
    const filename = `receipt_${payment.id.slice(0, 8)}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', pdf.length);
    res.end(pdf);
  }));

// DELETE /api/users/{id}/addresses/{aid}
router.delete('/:id/addresses/:aid', asyncHandler(async (req, res) => {
  await prisma.$transaction(async (tx) => {
    const existing = await tx.address.findUnique({ where: { address_id: req.params.aid } });
    if (!existing || existing.customer_id !== req.params.id) notFound('Address not found');
    await tx.address.delete({ where: { address_id: req.params.aid } });
    // Promote the first remaining address to default if we just removed the default one.
    if (existing.is_default) {
      const next = await tx.address.findFirst({ where: { customer_id: req.params.id } });
      if (next) await tx.address.update({ where: { address_id: next.address_id }, data: { is_default: true } });
    }
  });
  res.json({ data: { ok: true } });
}));

// ---------- Wishlist (BRD §10.6) ----------

// GET /api/users/{id}/wishlist
router.get('/:id/wishlist', asyncHandler(async (req, res) => {
  const list = await prisma.wishlistItem.findMany({
    where: { customer_id: req.params.id },
    orderBy: { added_at: 'desc' },
  });
  res.json({ data: list.map((w) => w.product_id) });
}));

// GET /api/users/{id}/wishlist/items — hydrated wishlist for the wishlist page.
// Drops items whose product was deactivated; the wishlist page renders product
// cards, and a card with no name/price is worse than a quietly missing entry.
router.get('/:id/wishlist/items', asyncHandler(async (req, res) => {
  const list = await prisma.wishlistItem.findMany({
    where: { customer_id: req.params.id, product: { status: 'Active' } },
    include: { product: true },
    orderBy: { added_at: 'desc' },
  });
  const locale = resolveLocale(req);
  res.json({ data: list.map((w) => serializeProduct(w.product, null, locale)) });
}));

// POST /api/users/{id}/wishlist  body: { product_id }
router.post('/:id/wishlist', asyncHandler(async (req, res) => {
  const { product_id } = req.body || {};
  if (!product_id) badRequest('product_id is required');
  await prisma.wishlistItem.upsert({
    where: { customer_id_product_id: { customer_id: req.params.id, product_id } },
    update: {},
    create: { customer_id: req.params.id, product_id },
  });
  const list = await prisma.wishlistItem.findMany({
    where: { customer_id: req.params.id },
    orderBy: { added_at: 'desc' },
  });
  res.json({ data: list.map((w) => w.product_id) });
}));

// DELETE /api/users/{id}/wishlist/{pid}
router.delete('/:id/wishlist/:pid', asyncHandler(async (req, res) => {
  await prisma.wishlistItem.deleteMany({
    where: { customer_id: req.params.id, product_id: req.params.pid },
  });
  const list = await prisma.wishlistItem.findMany({
    where: { customer_id: req.params.id },
    orderBy: { added_at: 'desc' },
  });
  res.json({ data: list.map((w) => w.product_id) });
}));

export default router;
