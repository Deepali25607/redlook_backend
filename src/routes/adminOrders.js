// Admin order endpoints (BRD §11.7 + FR-ADM-04). Mounted under /api/admin/orders
// from routes/admin.js, so requireAdmin is already applied to req here — but
// per-endpoint role checks still gate write actions to Super/Operations only.

import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { asyncHandler, validate, badRequest, notFound } from '../lib/http.js';
import { requirePermission, orderB2BScopeWhere, getAdminB2BScope } from '../middleware/adminAuth.js';
import { serializeOrder } from '../lib/serialize.js';
import { notify } from '../lib/notify.js';
import { canCancelOrder, getCancellationCutoff, cancellationBlockedMessage } from '../lib/orderPolicy.js';
import { checkEligibility, computeDueDate, recordCreditDebit, throwIfIneligible } from '../lib/credit.js';

const router = Router();

const fireNotify = (args) => notify(args).catch((err) => console.error('[notify] failed:', err.message));
const fmtINR = (n) => `Rs. ${Number(n).toFixed(2)}`;

// Legal status transitions. Anything not listed throws 400.
// Cancelled / Delivered / ReturnRequested are terminal for admin actions
// (return resolution would be a separate "approve/reject" endpoint later).
const LEGAL_TRANSITIONS = {
  'Placed':           ['Confirmed', 'Cancelled'],
  'Confirmed':        ['Packed', 'Cancelled'],
  'Packed':           ['Out for Delivery', 'Cancelled'],
  'Out for Delivery': ['Delivered'],
  'Delivered':        [],
  'Cancelled':        [],
  'ReturnRequested':  [],
};

// Map status → notification template. Order placed/cancelled/return_requested
// are fired from the customer-facing routes; here we only notify on admin-driven
// transitions.
const TEMPLATE_FOR_STATUS = {
  'Confirmed':        'order.confirmed',
  'Packed':           'order.packed',
  'Out for Delivery': 'order.out_for_delivery',
  'Delivered':        'order.delivered',
  'Cancelled':        'order.cancelled',
};

const STATUS_VALUES = Object.keys(LEGAL_TRANSITIONS);

// ---------------------------------------------------------------
// GET /api/admin/orders — list/filter/paginate
// Query params: status, payment_status, customer_email, from, to, q (order_id substring), page, limit
// All three roles can view.
// ---------------------------------------------------------------
router.get('/', requirePermission('orders'),
  asyncHandler(async (req, res) => {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const skip = (page - 1) * limit;

    // B2B-scoped admins see only orders belonging to their linked business.
    // The scope is applied first so any subsequent customer_email filter
    // narrows within scope rather than escaping it (Prisma ANDs the
    // top-level `customer: {...}` clause with `customer_id: {in:[...]}`).
    const where = { ...orderB2BScopeWhere(req.admin) };
    if (req.query.status) where.order_status = String(req.query.status);
    if (req.query.payment_status) where.payment_status = String(req.query.payment_status);
    if (req.query.q) where.order_id = { contains: String(req.query.q), mode: 'insensitive' };
    if (req.query.from || req.query.to) {
      where.order_date = {};
      if (req.query.from) where.order_date.gte = new Date(String(req.query.from));
      if (req.query.to) where.order_date.lte = new Date(String(req.query.to));
    }
    if (req.query.customer_email) {
      // Resolve customer ids matching the email substring; cheaper than a join filter.
      const matches = await prisma.customer.findMany({
        where: { email: { contains: String(req.query.customer_email), mode: 'insensitive' } },
        select: { customer_id: true },
        take: 500,
      });
      where.customer_id = { in: matches.map((m) => m.customer_id) };
    }

    const [total, rows] = await Promise.all([
      prisma.order.count({ where }),
      prisma.order.findMany({
        where,
        include: {
          items: true,
          // Admin list needs customer email/phone so support can call/email without
          // a second round-trip. Customer side never gets this serializer.
          customer: { select: { customer_id: true, full_name: true, email: true, phone: true } },
        },
        orderBy: { order_date: 'desc' },
        skip,
        take: limit,
      }),
    ]);

    res.json({
      data: rows.map((o) => ({ ...serializeOrder(o, { includeDeliveryPhotos: true }), customer: o.customer })),
      meta: { page, limit, total, totalPages: Math.ceil(total / limit) || 1 },
    });
  }));

// ---------------------------------------------------------------
// PUT /api/admin/orders/:id/status — transition order to a new status
// Only SuperAdmin + OperationsAdmin can write (Support is read-only here).
// ---------------------------------------------------------------
const transitionSchema = z.object({
  status: z.enum(STATUS_VALUES),
  note: z.string().max(500).optional(),
  // BRD §3 — admin's payment decision at delivery confirmation. Only
  // honoured when status === 'Delivered' AND order.payment_method === 'COD':
  //   'pay_now'        (default) — collect cash/UPI now, mark Paid
  //   'pay_on_credit'  — record a credit DEBIT, leave payment_status Pending
  // Other statuses ignore this field; pre-paid (UPI) orders ignore it too.
  credit_decision: z.enum(['pay_now', 'pay_on_credit']).optional(),
  // Open-box proof-of-delivery photos uploaded via
  // /api/admin/uploads/delivery-photo. Only honoured when target=Delivered;
  // ignored otherwise so a typo on an earlier transition can't poison the
  // gallery. Capped at 8 per delivery to keep storage bounded and the
  // admin gallery scannable; the rider only really needs 2–3 shots of
  // the opened box anyway.
  delivery_photos: z.array(z.object({
    url: z.string().min(1).max(500),
  })).max(8).optional(),
});

router.put('/:id/status',
  requirePermission('orders'),
  validate(transitionSchema),
  asyncHandler(async (req, res) => {
    const { status: target, note } = req.body;

    const order = await prisma.order.findUnique({
      where: { order_id: req.params.id },
      include: {
        items: true,
        // The customer's business_name is needed for the B2B scope check
        // below; selecting only what we need keeps the payload tight.
        customer: { select: { business_name: true } },
      },
    });
    if (!order) notFound('Order not found');
    // B2B scope check: a scoped admin cannot transition an order whose
    // customer belongs to a different business. 404 (not 403) so the URL
    // doesn't leak existence of out-of-scope orders.
    const scopedName = getAdminB2BScope(req.admin);
    if (scopedName && order.customer?.business_name !== scopedName) notFound('Order not found');

    const allowed = LEGAL_TRANSITIONS[order.order_status] || [];
    if (!allowed.includes(target)) {
      badRequest(`Cannot transition from ${order.order_status} to ${target}. Legal next states: ${allowed.join(', ') || 'none (terminal state)'}`);
    }

    // Admin-driven cancellation also respects the configurable cutoff.
    // LEGAL_TRANSITIONS still says Cancelled is allowed from Placed/Confirmed/
    // Packed in principle, but the admin's own setting can tighten that
    // further (e.g. cutoff='Packed' means even an admin can't cancel a Packed
    // order — operationally that order is committed). Without this guard the
    // admin could bypass the policy the customer sees.
    if (target === 'Cancelled') {
      const cutoff = await getCancellationCutoff();
      if (!canCancelOrder(order.order_status, cutoff)) {
        badRequest(cancellationBlockedMessage(order.order_status, cutoff));
      }
    }

    // BRD §3 — at delivery confirmation, admin can flip a COD order onto
    // credit, OR collect Pay Now. Default for COD is pay_now (preserves
    // the prior auto-Paid behaviour). 'pay_on_credit' requires the
    // customer to be credit-eligible — same gate as the customer-side
    // CREDIT path at checkout.
    const isDeliveredCOD = target === 'Delivered'
      && order.payment_method === 'COD'
      && order.payment_status === 'Pending';
    const decision = req.body.credit_decision
      || (isDeliveredCOD ? 'pay_now' : null);

    // pay_now COD: existing behaviour — mark Paid in the same transition.
    const codCollected = isDeliveredCOD && decision === 'pay_now';
    // pay_on_credit COD: stay Pending, append a DEBIT row (created below
    // inside the tx so the eligibility check, the order update, and the
    // DEBIT are atomic).
    const flippingToCredit = isDeliveredCOD && decision === 'pay_on_credit';

    if (flippingToCredit) {
      throwIfIneligible(await checkEligibility(order.customer_id, order.total_amount));
    }

    const autoNote = codCollected
      ? `Status updated by ${req.admin.email}. Cash on delivery collected.`
      : flippingToCredit
        ? `Status updated by ${req.admin.email}. Marked Pay on Credit at delivery.`
        : `Status updated by ${req.admin.email}`;

    // Cancelling = restore stock atomically with the status flip.
    const updated = await prisma.$transaction(async (tx) => {
      if (target === 'Cancelled') {
        for (const i of order.items) {
          await tx.product.update({
            where: { product_id: i.product_id },
            data: { stock_quantity: { increment: i.quantity } },
          });
        }
      }
      // Open-box photos: only honoured when transitioning to Delivered, and
      // appended onto whatever's already on the order (empty by default).
      // Each entry gets server-stamped uploaded_at + uploaded_by so the
      // gallery has trustworthy metadata regardless of client clock skew.
      const incomingPhotos = (target === 'Delivered' && Array.isArray(req.body.delivery_photos))
        ? req.body.delivery_photos
        : [];
      const newPhotos = incomingPhotos.map((p) => ({
        url: p.url,
        uploaded_at: new Date().toISOString(),
        uploaded_by: req.admin.email,
      }));
      const mergedPhotos = [...(Array.isArray(order.delivery_photos) ? order.delivery_photos : []), ...newPhotos];

      const result = await tx.order.update({
        where: { order_id: req.params.id },
        data: {
          order_status: target,
          ...(codCollected ? { payment_status: 'Paid' } : {}),
          // Flipping a COD order to "pay on credit" at delivery: the order is
          // now a credit obligation backed by a DEBIT row (recorded below),
          // so payment_method must reflect that. Without this, the order
          // detail UI keeps reading "COD - Pending" even though the customer's
          // ledger has a CREDIT debit attached — confusing for both the
          // customer and the support team. payment_status stays "Pending"
          // until the credit is actually paid off.
          ...(flippingToCredit ? { payment_method: 'CREDIT' } : {}),
          ...(newPhotos.length > 0 ? { delivery_photos: mergedPhotos } : {}),
          timeline: [
            ...order.timeline,
            {
              status: target,
              at: new Date().toISOString(),
              note: note || autoNote,
              admin_id: req.admin.admin_id,
              ...(codCollected ? { payment_collected: true } : {}),
              ...(flippingToCredit ? { converted_to_credit: true, payment_method_from: 'COD', payment_method_to: 'CREDIT' } : {}),
              ...(newPhotos.length > 0 ? { open_box_photo_count: newPhotos.length } : {}),
            },
          ],
        },
        include: {
          items: true,
          customer: { select: { customer_id: true, full_name: true, email: true, phone: true } },
        },
      });

      if (flippingToCredit) {
        const config = await tx.customerCreditConfig.findUnique({
          where: { customer_id: order.customer_id },
        });
        const dueDate = computeDueDate(
          config.terms_start_from,
          config.payment_terms_days,
          order.order_date,
          new Date(), // delivery date = now
        );
        await recordCreditDebit(tx, {
          customerId: order.customer_id,
          orderId: order.order_id,
          amount: order.total_amount,
          dueDate,
          createdBy: req.admin.email,
          notes: `Order ${order.order_id} converted to credit at delivery`,
        });
      } else if (target === 'Delivered' && order.payment_method === 'CREDIT') {
        // CREDIT order already has a DEBIT row stamped at placement with a
        // provisional due_date. If terms_start_from='delivery', re-anchor
        // it to the actual delivery date so the customer's clock is fair.
        const config = await tx.customerCreditConfig.findUnique({
          where: { customer_id: order.customer_id },
        });
        if (config?.terms_start_from === 'delivery') {
          const newDueDate = computeDueDate('delivery', config.payment_terms_days, order.order_date, new Date());
          await tx.creditTransaction.updateMany({
            where: { order_id: order.order_id, type: 'DEBIT' },
            data: { due_date: newDueDate },
          });
        }
      }

      return result;
    });

    // Audit log — sensitive admin action per BRD §8.4.
    // Best-effort; never blocks the response.
    prisma.auditLog.create({
      data: {
        customer_id: order.customer_id,
        action: 'admin.order.status_change',
        meta: {
          order_id: order.order_id,
          from: order.order_status,
          to: target,
          ...(codCollected ? { payment_status_flip: 'Pending->Paid (COD on delivery)' } : {}),
          ...(flippingToCredit ? { payment_method_flip: 'COD->CREDIT (pay on credit at delivery)' } : {}),
          admin_id: req.admin.admin_id,
          admin_email: req.admin.email,
          note: note || null,
        },
        ip: req.ip,
      },
    }).catch((err) => console.error('[audit] failed:', err.message));

    // Customer-facing notification for the new status. Need email/phone, which
    // are on the Customer record (not duplicated on Order).
    const customer = await prisma.customer.findUnique({
      where: { customer_id: order.customer_id },
      select: { email: true, phone: true, full_name: true, customer_id: true },
    });
    const template = TEMPLATE_FOR_STATUS[target];
    if (template && customer) {
      fireNotify({
        template,
        to: { email: customer.email, phone: customer.phone, customer_id: customer.customer_id },
        data: {
          order_id: updated.order_id,
          customer_name: customer.full_name,
          slot: updated.delivery_slot,
          total: fmtINR(updated.total_amount),
        },
      });
    }

    res.json({ data: { ...serializeOrder(updated, { includeDeliveryPhotos: true }), customer: updated.customer } });
  }));

export default router;
