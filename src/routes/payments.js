// BRD §11.5 (FR-PAY-01..05) Payment APIs — Razorpay integration.
//
// Two endpoints:
//   POST /api/payments/verify  (auth required) — called by the customer's
//     browser after Razorpay Checkout returns a successful payment. Validates
//     the HMAC signature against (rzp_order_id|rzp_payment_id) using KEY_SECRET.
//     Only when the signature checks out do we mark the order Paid.
//
//   POST /api/payments/webhook (no auth) — called by Razorpay's servers on
//     payment.captured / payment.failed / order.paid. Validates the webhook
//     signature using WEBHOOK_SECRET (separate from KEY_SECRET). Idempotent —
//     it's safe for the webhook to land before or after the verify call.
//
// We trust the verify call for fast UX (browser gets immediate confirmation),
// but the webhook is the source of truth for reconciliation: if the customer
// closes their browser between paying and our /verify call landing, the
// webhook still flips the order to Paid.

import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler, validate, badRequest, notFound, forbidden } from '../lib/http.js';
import { serializeOrder } from '../lib/serialize.js';
import { notify } from '../lib/notify.js';
import {
  isRazorpayEnabled,
  getKeyId,
  verifyCheckoutSignature,
  verifyWebhookSignature,
} from '../lib/razorpay.js';
import { applyPayment } from '../lib/credit.js';

const fireNotify = (args) => notify(args).catch((err) => console.error('[notify] failed:', err.message));
const formatINR = (n) => `Rs. ${Number(n).toFixed(2)}`;

const router = Router();

// ------------------------------------------------------------
// GET /api/payments/config — public, no auth.
// Lets the frontend decide whether to show the UPI tile on checkout. Returns
// the public key_id (safe to expose; it's the same value every Checkout SDK
// caller embeds) so the FE doesn't need a second round-trip when placing the
// order. Mirrors the same key-presence check the order route uses, so the FE
// can never show UPI when the BE will reject it.
// ------------------------------------------------------------
router.get('/config', (_req, res) => {
  res.json({
    data: {
      razorpay_enabled: isRazorpayEnabled(),
      key_id: getKeyId(),
    },
  });
});

// ------------------------------------------------------------
// POST /api/payments/verify — customer-facing success callback.
// ------------------------------------------------------------
const verifySchema = z.object({
  order_id: z.string().min(1),
  razorpay_order_id: z.string().min(1),
  razorpay_payment_id: z.string().min(1),
  razorpay_signature: z.string().min(1),
});

router.post('/verify', requireAuth, validate(verifySchema), asyncHandler(async (req, res) => {
  const { order_id, razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;

  // 1. Validate signature first — bail before any DB work if it's bogus.
  // This is the single guard that prevents anyone from forging a "Paid" flip
  // by calling /verify directly with made-up payment ids.
  const valid = verifyCheckoutSignature({
    rzpOrderId: razorpay_order_id,
    rzpPaymentId: razorpay_payment_id,
    signature: razorpay_signature,
  });
  if (!valid) badRequest('Payment signature verification failed');

  // 2. Fetch the order, confirm ownership + that the rzp_order_id matches.
  const order = await prisma.order.findUnique({
    where: { order_id },
    include: { items: true },
  });
  if (!order) notFound('Order not found');
  if (order.customer_id !== req.user.customer_id) forbidden();
  if (order.razorpay_order_id !== razorpay_order_id) {
    badRequest('Razorpay order id does not match this order');
  }

  // 3. Idempotency — if the webhook beat the FE callback, the order is
  // already Paid and we just return the current state.
  if (order.payment_status === 'Paid') {
    return res.json({ data: serializeOrder(order) });
  }

  // 4. Mark Paid + persist the rzp_payment_id (used by admin reconciliation +
  // refunds when those are wired).
  const updated = await prisma.order.update({
    where: { order_id },
    data: {
      payment_status: 'Paid',
      razorpay_payment_id,
    },
    include: { items: true },
  });

  // 5. Fire the welcome notification now (deferred from order placement —
  // see orders.js). At this point the customer has actually paid, so the
  // "order placed" message reflects reality.
  fireNotify({
    template: 'order.placed',
    to: { email: req.user.email, phone: req.user.phone, customer_id: req.user.customer_id },
    data: {
      order_id: updated.order_id,
      customer_name: req.user.full_name,
      total: formatINR(updated.total_amount),
      slot: updated.delivery_slot,
      payment_method: updated.payment_method,
    },
  });

  res.json({ data: serializeOrder(updated) });
}));

// ------------------------------------------------------------
// POST /api/payments/webhook — Razorpay-to-server webhook.
//
// Note on raw body: signature is over the raw bytes, so index.js attaches
// req.rawBody via express.json's `verify` callback. We still get the parsed
// body via req.body for convenience.
// ------------------------------------------------------------
router.post('/webhook', asyncHandler(async (req, res) => {
  const signature = req.get('x-razorpay-signature') || req.get('X-Razorpay-Signature');
  const valid = verifyWebhookSignature({
    rawBody: req.rawBody,
    signature,
  });
  if (!valid) {
    // Don't reveal whether we have the webhook secret configured — same 400
    // for both "no secret set" and "bad signature".
    return res.status(400).json({ error: 'Invalid webhook signature' });
  }

  const event = req.body?.event;

  // ---- payment_link.paid — credit-invoice payments (BRD §7 Phase 3) ----
  // Razorpay sends both `payment_link.entity` and `payment.entity` on
  // these events. We use the link's `notes.internal_credit_transaction_id`
  // (round-tripped from createPaymentLink) to find the DEBIT and apply
  // the payment via the same FIFO allocator the admin "Record payment"
  // form uses, so a webhook-driven payment looks identical in the ledger
  // to a manually-recorded one.
  if (event === 'payment_link.paid') {
    const link = req.body?.payload?.payment_link?.entity;
    const linkPayment = req.body?.payload?.payment?.entity;
    if (!link || !linkPayment) {
      // Misshapen payload — acknowledge so Razorpay doesn't retry forever.
      return res.json({ ok: true });
    }

    // Idempotency — if we've already recorded a PaymentReceived row whose
    // reference matches this Razorpay payment id, ignore the redelivery.
    const existing = await prisma.paymentReceived.findFirst({
      where: { reference_no: linkPayment.id },
    });
    if (existing) {
      console.log(`[razorpay-webhook] payment_link.paid ignored — already recorded as ${existing.id}`);
      return res.json({ ok: true });
    }

    const txId = link.notes?.internal_credit_transaction_id
      || (await prisma.creditTransaction.findFirst({
        where: { razorpay_payment_link_id: link.id },
        select: { id: true },
      }))?.id;
    if (!txId) {
      console.warn(`[razorpay-webhook] payment_link.paid for ${link.id} — no matching CreditTransaction; ignoring`);
      return res.json({ ok: true });
    }

    const tx = await prisma.creditTransaction.findUnique({ where: { id: txId } });
    if (!tx) {
      console.warn(`[razorpay-webhook] payment_link.paid — CreditTransaction ${txId} disappeared`);
      return res.json({ ok: true });
    }

    const amountInRupees = Number(linkPayment.amount) / 100;
    const result = await prisma.$transaction((db) => applyPayment(db, {
      customerId: tx.customer_id,
      amount: amountInRupees,
      paymentDate: new Date(linkPayment.created_at ? linkPayment.created_at * 1000 : Date.now()),
      mode: 'UPI', // Razorpay payment links default to UPI on the hosted page; broaden later if we want method-aware mapping.
      referenceNo: linkPayment.id,
      targetIds: [tx.id],
      createdBy: 'razorpay.webhook',
      notes: `Razorpay payment link ${link.id}`,
    }));

    // Fire the same receipt notification the admin "Record payment" path uses.
    const customer = await prisma.customer.findUnique({ where: { customer_id: tx.customer_id } });
    if (customer) {
      notify({
        template: 'credit.payment_received',
        to: { email: customer.email, phone: customer.phone, customer_id: customer.customer_id },
        data: {
          customer_name: customer.full_name,
          amount: `Rs. ${amountInRupees.toFixed(2)}`,
          payment_date: new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }),
          mode: 'razorpay payment link',
          reference_no: linkPayment.id,
          allocations: result.allocations.length,
        },
      }).catch((err) => console.error('[notify] credit.payment_received failed:', err.message));
    }

    console.log(`[razorpay-webhook] payment_link.paid → applied ${amountInRupees} to ${tx.id} (${result.allocations.length} alloc)`);
    return res.json({ ok: true });
  }

  // ---- payment.captured / order.paid — checkout flow (existing path) ----
  const payment = req.body?.payload?.payment?.entity;
  const rzpOrderId = payment?.order_id;
  const rzpPaymentId = payment?.id;

  if (!rzpOrderId || !rzpPaymentId) {
    // Acknowledge non-payment events (refunds, settlements, etc.) so Razorpay
    // doesn't keep retrying. We just don't act on them yet.
    return res.json({ ok: true });
  }

  // Only act on success events. payment.failed leaves the order Pending so
  // the customer (or admin) can retry; we log for visibility.
  if (event === 'payment.captured' || event === 'order.paid') {
    const order = await prisma.order.findFirst({
      where: { razorpay_order_id: rzpOrderId },
    });
    if (order && order.payment_status !== 'Paid') {
      await prisma.order.update({
        where: { order_id: order.order_id },
        data: {
          payment_status: 'Paid',
          razorpay_payment_id: rzpPaymentId,
        },
      });
      console.log(`[razorpay-webhook] order ${order.order_id} marked Paid via ${event}`);
    }
  } else if (event === 'payment.failed') {
    console.log(`[razorpay-webhook] payment failed for rzp_order=${rzpOrderId}: ${payment?.error_description || 'no description'}`);
  }

  res.json({ ok: true });
}));

export default router;
