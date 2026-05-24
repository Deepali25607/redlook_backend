// Razorpay integration helper.
//
// Mirrors the same "real provider when keys present, fallback when absent"
// pattern as src/lib/notify.js. The difference: there is no console-log
// fallback for payments (you can't safely fake collecting money), so when
// keys are absent the public config endpoint reports `enabled: false` and
// orders.js refuses non-COD placements with a "coming soon" message.
//
// Env vars (.env):
//   RAZORPAY_KEY_ID         — public test/live key id (rzp_test_xxx / rzp_live_xxx)
//   RAZORPAY_KEY_SECRET     — server-only secret used to sign API calls + verify signatures
//   RAZORPAY_WEBHOOK_SECRET — separate secret configured on the Razorpay Webhooks page
//
// Get test keys at https://dashboard.razorpay.com → Settings → API Keys.
// Test mode lets you use UPI ID `success@razorpay` / `failure@razorpay`.

import crypto from 'node:crypto';
import Razorpay from 'razorpay';

let _client = null;

export function isRazorpayEnabled() {
  return Boolean(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET);
}

export function getKeyId() {
  return process.env.RAZORPAY_KEY_ID || null;
}

// Lazy singleton — only constructs once env vars are present, so an empty
// .env doesn't crash the server at import time.
function getClient() {
  if (!isRazorpayEnabled()) {
    throw new Error('Razorpay is not configured. Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET in .env.');
  }
  if (!_client) {
    _client = new Razorpay({
      key_id: process.env.RAZORPAY_KEY_ID,
      key_secret: process.env.RAZORPAY_KEY_SECRET,
    });
  }
  return _client;
}

// Razorpay deals in the smallest currency unit (paise for INR), so a ₹150
// order is 15000 here. We round to be safe against accumulated decimal drift.
export function toPaise(rupees) {
  return Math.round(Number(rupees) * 100);
}

// Create a Razorpay Order. The returned `id` (order_xxx) is what the client
// hands to the Checkout modal; pairing it with our internal order_id via the
// `notes` field gives us a way to reconcile webhook events.
export async function createRazorpayOrder({ amountInRupees, internalOrderId, customerEmail, customerPhone }) {
  const client = getClient();
  return client.orders.create({
    amount: toPaise(amountInRupees),
    currency: 'INR',
    receipt: internalOrderId,
    notes: {
      internal_order_id: internalOrderId,
      customer_email: customerEmail || '',
      customer_phone: customerPhone || '',
    },
  });
}

// Verify the signature returned by Razorpay Checkout on success. Per Razorpay
// docs, signature = HMAC_SHA256(rzp_order_id + '|' + rzp_payment_id, key_secret).
// Constant-time comparison prevents timing-attack signature guessing.
export function verifyCheckoutSignature({ rzpOrderId, rzpPaymentId, signature }) {
  if (!rzpOrderId || !rzpPaymentId || !signature) return false;
  const expected = crypto
    .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET || '')
    .update(`${rzpOrderId}|${rzpPaymentId}`)
    .digest('hex');
  // timingSafeEqual requires equal-length buffers; bail early on mismatch.
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(signature, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// Verify the signature on an inbound webhook request. Razorpay sends the
// signature in the X-Razorpay-Signature header; payload is the raw request
// body. We require the WEBHOOK_SECRET separately because Razorpay lets you
// rotate it independently of the API key secret.
export function verifyWebhookSignature({ rawBody, signature }) {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret || !signature || !rawBody) return false;
  const expected = crypto
    .createHmac('sha256', secret)
    .update(rawBody)
    .digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(signature, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// ------------------------------------------------------------
// Payment Links — Razorpay-hosted "Pay now" pages we can hand to a
// credit customer to settle a specific invoice without exposing them
// to our checkout flow. Each link encodes the customer (so it
// pre-fills) and the internal invoice id (in `notes`) so the inbound
// `payment_link.paid` webhook can find the matching CreditTransaction
// row and call applyPayment().
//
// Reference: https://razorpay.com/docs/payments/payment-links/apis/
// ------------------------------------------------------------

// Default link expiry: 7 days. Razorpay enforces a 15-minute minimum and
// generally accepts up to ~6 months. 7 days is long enough that the link
// in the customer's email/SMS isn't dead by the time they get to it, but
// short enough that an abandoned link doesn't sit there forever.
const DEFAULT_PAYMENT_LINK_TTL_SECONDS = 7 * 24 * 60 * 60;

export async function createPaymentLink({
  amountInRupees,
  description,
  internalReference,
  internalCreditTransactionId,
  customerName,
  customerEmail,
  customerPhone,
  expireSeconds = DEFAULT_PAYMENT_LINK_TTL_SECONDS,
  callbackUrl,
}) {
  const client = getClient();

  // Razorpay's `expire_by` is a Unix timestamp in seconds. We round to a
  // whole second so two links created in the same millisecond don't trip
  // their "duplicate timestamp" guard on the rare retry.
  const expireBy = Math.floor(Date.now() / 1000) + Math.max(900, expireSeconds);

  return client.paymentLink.create({
    amount: toPaise(amountInRupees),
    currency: 'INR',
    accept_partial: false,
    description: (description || 'Payment').slice(0, 2048),
    customer: {
      name: (customerName || 'Customer').slice(0, 100),
      // Razorpay rejects empty strings here — pass the field only when set.
      ...(customerEmail ? { email: customerEmail } : {}),
      ...(customerPhone ? { contact: customerPhone } : {}),
    },
    notify: {
      sms: !!customerPhone,
      email: !!customerEmail,
    },
    reminder_enable: true,
    expire_by: expireBy,
    notes: {
      // Stored on the Razorpay side; comes back on the webhook payload so
      // we can reconcile without needing a DB lookup by link id.
      internal_reference: String(internalReference || '').slice(0, 256),
      internal_credit_transaction_id: String(internalCreditTransactionId || '').slice(0, 64),
    },
    ...(callbackUrl
      ? { callback_url: callbackUrl, callback_method: 'get' }
      : {}),
  });
}

// Fetch a payment link to check its current status (created, paid,
// expired, cancelled, partially_paid). Used to decide whether a stored
// link is still good before serving it to the customer again.
export async function fetchPaymentLink(linkId) {
  const client = getClient();
  return client.paymentLink.fetch(linkId);
}
