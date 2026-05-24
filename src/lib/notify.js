// Outbound notifications dispatcher (BRD §7.8 FR-NOT-01..03).
//
// Single notify() entry point used by route handlers. Per-channel adapters
// (email, sms) fall back to console.log when no provider keys are configured,
// so the call sites are correct *now* and only the adapter body needs to swap
// when SendGrid / MSG91 keys arrive. Every dispatch is persisted to the
// Notification table for admin audit (BRD §10.6).
//
// Always fire-and-forget from request handlers — never await; never throw.
//
// ============================================================
// Phase 3 — Per-locale templates
// ============================================================
// Templates are keyed by name × locale. Locale comes from Customer.language
// (looked up via to.customer_id) — call sites don't need to thread it
// through. The dispatcher does the lookup right before rendering.
//
// `en` is the canonical body — every template ships with one and the
// dispatcher falls back to it when a locale entry is missing or returns
// empty. Hindi (hi) and Bengali (bn) entries are intentionally left for
// User-supplied translations: filled in below as empty stubs that return
// `null` for both email + sms, which the fallback path treats as "use en".
//
// To localize a template into Hindi or Bengali, replace its stub function
// in the locale's block with one that returns the same { subject, email,
// sms } shape as `en`. Existing template data tokens (d.full_name,
// d.order_id, d.total, etc.) work in every locale — only the strings
// change.

import { prisma } from './prisma.js';

// English (canonical) bodies. These have always been here; they keep their
// exact wording. Anywhere a locale-specific stub returns null/empty, the
// dispatcher renders the `en` version of the same template instead — so a
// half-localized template never produces a blank email/SMS.
const en = {
  'auth.welcome': (d) => ({
    subject: 'Welcome to Redlook',
    email: `Hi ${d.full_name},\n\nYour Redlook account is verified and ready to shop. Discover hand-picked drops, classic essentials, and new arrivals every week.\n\n— Team Redlook`,
    sms: null,
  }),
  // Sent at registration AND every resend AND every time the customer
  // changes their phone in profile. The OTP is the single thing gating
  // account activation + checkout — both are blocked until this is consumed.
  // SMS-only; we don't echo the code by email so a stolen email account
  // can't pivot to a verified phone.
  'auth.phone_verification': (d) => ({
    subject: null,
    email: null,
    sms: `Redlook verification code: ${d.otp}. Valid for ${d.ttl_minutes} minutes. Do not share with anyone.`,
  }),
  'auth.password_reset': (d) => ({
    subject: 'Reset your Redlook password',
    email: `Use this token to reset your password: ${d.reset_token}\n\nIf you did not request this, ignore this email.`,
    sms: null,
  }),
  // 6-digit OTP path for forgot-password. Same code value goes to whichever
  // channel(s) the customer picked — the notify dispatcher gates each channel
  // on `to.email` / `to.phone` so a `sms_otp` request lands only on phone.
  'auth.password_reset_otp': (d) => ({
    subject: `Redlook password reset code: ${d.otp}`,
    email: `Your Redlook password reset code is ${d.otp}. It is valid for ${d.ttl_minutes} minutes.\n\nIf you did not request this, ignore this email — your password has not been changed.`,
    sms: `Redlook password reset code: ${d.otp}. Valid for ${d.ttl_minutes} minutes. Do not share with anyone.`,
  }),
  'order.placed': (d) => ({
    subject: `Order ${d.order_id} confirmed`,
    email: `Hi ${d.customer_name},\n\nYour Redlook order ${d.order_id} has been placed.\nTotal: ${d.total}\nDelivery slot: ${d.slot}\nPayment: ${d.payment_method}\n\nWe'll notify you as your order moves through packing and dispatch.`,
    sms: `Redlook: Order ${d.order_id} placed. Total ${d.total}. Delivery ${d.slot}.`,
  }),
  'order.confirmed': (d) => ({
    subject: `Order ${d.order_id} confirmed by Redlook`,
    email: `Hi,\n\nYour order ${d.order_id} has been confirmed and is being prepared. We'll let you know once it's packed.`,
    sms: `Redlook: Order ${d.order_id} confirmed and being prepared.`,
  }),
  'order.packed': (d) => ({
    subject: `Order ${d.order_id} is packed`,
    email: `Your order ${d.order_id} has been packed and is ready for dispatch in your chosen slot (${d.slot}).`,
    sms: `Redlook: Order ${d.order_id} packed. Out for delivery soon.`,
  }),
  'order.out_for_delivery': (d) => ({
    subject: `Order ${d.order_id} is out for delivery`,
    email: `Your order ${d.order_id} is out for delivery and will reach you in your slot: ${d.slot}.`,
    sms: `Redlook: Order ${d.order_id} out for delivery. Slot: ${d.slot}.`,
  }),
  'order.delivered': (d) => ({
    subject: `Order ${d.order_id} delivered`,
    email: `Your order ${d.order_id} has been delivered. We hope you love it! You can request a return within 7 days if anything isn't right — sizing, fit, or quality.`,
    sms: `Redlook: Order ${d.order_id} delivered. Thanks for shopping with us!`,
  }),
  'order.cancelled': (d) => ({
    subject: `Order ${d.order_id} cancelled`,
    email: `Your order ${d.order_id} has been cancelled. Refund (if any) will be processed in 5–7 business days.`,
    sms: `Redlook: Order ${d.order_id} cancelled.`,
  }),
  'order.return_requested': (d) => ({
    subject: `Return request received for ${d.order_id}`,
    email: `We've received your return request for order ${d.order_id}.\nReason: ${d.reason}\n\nOur team will review and contact you within 24 hours.`,
    sms: `Redlook: Return request for ${d.order_id} received. We'll reach out within 24h.`,
  }),

  // ---- Credit / Pay-Later (BRD §8) ----
  'credit.order_placed': (d) => ({
    subject: `Pay-on-credit confirmation — ${d.order_id}`,
    email: `Hi ${d.customer_name},\n\nYour order ${d.order_id} has been placed on credit.\nAmount due: ${d.amount}\nDue date: ${d.due_date}\n\nYou can view all your pending invoices and payment history under "My Credit" in your account.`,
    sms: `Redlook: Order ${d.order_id} on credit. ${d.amount} due ${d.due_date}.`,
  }),
  'credit.payment_reminder': (d) => ({
    subject: `Heads-up: ${d.amount} due in ${d.days_remaining} days`,
    email: `Hi ${d.customer_name},\n\nThis is a reminder that ${d.amount} for ${d.invoice_label} is due on ${d.due_date} — ${d.days_remaining} days away.\n\nYou can settle anytime via UPI, bank transfer, or by paying our team. Thanks for being a credit customer!`,
    sms: `Redlook: ${d.amount} due ${d.due_date} (${d.days_remaining}d). ${d.invoice_label}.`,
  }),
  'credit.payment_due': (d) => ({
    subject: `${d.amount} due today`,
    email: `Hi ${d.customer_name},\n\nYour invoice ${d.invoice_label} for ${d.amount} is due today (${d.due_date}). Please settle to keep your account in good standing.`,
    sms: `Redlook: ${d.amount} due today. ${d.invoice_label}.`,
  }),
  'credit.payment_overdue': (d) => ({
    subject: `Overdue: ${d.amount} (${d.oldest_days} days past due)`,
    email: `Hi ${d.customer_name},\n\nWe haven't received payment for ${d.invoices ? `${d.invoices} invoice${d.invoices === 1 ? '' : 's'} totalling ` : ''}${d.amount}. The oldest is ${d.oldest_days} days past due.\n\nPlease arrange payment to avoid your credit being temporarily blocked. Reply to this email if you need to discuss.`,
    sms: `Redlook: ${d.amount} overdue (${d.oldest_days}d). Please pay to avoid credit hold.`,
  }),
  'credit.payment_received': (d) => ({
    subject: `Payment received — thank you`,
    email: `Hi ${d.customer_name},\n\nWe've recorded your payment of ${d.amount} on ${d.payment_date} (${d.mode}${d.reference_no ? `, ref ${d.reference_no}` : ''}).${d.allocations ? `\n\nApplied to ${d.allocations} invoice${d.allocations === 1 ? '' : 's'}.` : ''}\n\nView your updated balance under "My Credit" in your account.`,
    sms: `Redlook: Payment of ${d.amount} received. Thanks!`,
  }),
};

// Hindi stubs — return null so the dispatcher falls back to `en`. Replace
// each function with the Hindi { subject, email, sms } shape to localize.
// Same template tokens work; only the strings change.
const hi = {
  'auth.welcome':              (_d) => ({ subject: null, email: null, sms: null }),
  'auth.phone_verification':   (_d) => ({ subject: null, email: null, sms: null }),
  'auth.password_reset':       (_d) => ({ subject: null, email: null, sms: null }),
  'auth.password_reset_otp':   (_d) => ({ subject: null, email: null, sms: null }),
  'order.placed':              (_d) => ({ subject: null, email: null, sms: null }),
  'order.confirmed':           (_d) => ({ subject: null, email: null, sms: null }),
  'order.packed':              (_d) => ({ subject: null, email: null, sms: null }),
  'order.out_for_delivery':    (_d) => ({ subject: null, email: null, sms: null }),
  'order.delivered':           (_d) => ({ subject: null, email: null, sms: null }),
  'order.cancelled':           (_d) => ({ subject: null, email: null, sms: null }),
  'order.return_requested':    (_d) => ({ subject: null, email: null, sms: null }),
  'credit.order_placed':       (_d) => ({ subject: null, email: null, sms: null }),
  'credit.payment_reminder':   (_d) => ({ subject: null, email: null, sms: null }),
  'credit.payment_due':        (_d) => ({ subject: null, email: null, sms: null }),
  'credit.payment_overdue':    (_d) => ({ subject: null, email: null, sms: null }),
  'credit.payment_received':   (_d) => ({ subject: null, email: null, sms: null }),
};

// Bengali stubs — same shape; fill in to localize. Until then, Bengali
// customers receive the canonical English bodies.
const bn = {
  'auth.welcome':              (_d) => ({ subject: null, email: null, sms: null }),
  'auth.phone_verification':   (_d) => ({ subject: null, email: null, sms: null }),
  'auth.password_reset':       (_d) => ({ subject: null, email: null, sms: null }),
  'auth.password_reset_otp':   (_d) => ({ subject: null, email: null, sms: null }),
  'order.placed':              (_d) => ({ subject: null, email: null, sms: null }),
  'order.confirmed':           (_d) => ({ subject: null, email: null, sms: null }),
  'order.packed':              (_d) => ({ subject: null, email: null, sms: null }),
  'order.out_for_delivery':    (_d) => ({ subject: null, email: null, sms: null }),
  'order.delivered':           (_d) => ({ subject: null, email: null, sms: null }),
  'order.cancelled':           (_d) => ({ subject: null, email: null, sms: null }),
  'order.return_requested':    (_d) => ({ subject: null, email: null, sms: null }),
  'credit.order_placed':       (_d) => ({ subject: null, email: null, sms: null }),
  'credit.payment_reminder':   (_d) => ({ subject: null, email: null, sms: null }),
  'credit.payment_due':        (_d) => ({ subject: null, email: null, sms: null }),
  'credit.payment_overdue':    (_d) => ({ subject: null, email: null, sms: null }),
  'credit.payment_received':   (_d) => ({ subject: null, email: null, sms: null }),
};

const localeBundles = { en, hi, bn };

// Renders a template in the customer's preferred locale, falling back to
// English per-field when the locale's stub returns null/empty. This means
// a Hindi customer with a fully-localized order.placed but no Hindi
// auth.welcome still gets the Hindi order body AND an English welcome —
// each template is independent.
function renderTemplate(templateName, locale, data) {
  const enRendered = en[templateName] ? en[templateName](data) : null;
  if (!enRendered) return null;
  const bundle = localeBundles[locale];
  const localeFn = bundle && bundle[templateName];
  if (!localeFn || locale === 'en') return enRendered;
  const localeRendered = localeFn(data) || {};
  // Per-field fallback: subject/email/sms can each independently fall
  // through to English when the locale entry is null/empty.
  const fallback = (loc, def) =>
    (typeof loc === 'string' && loc.trim() !== '') ? loc : def;
  return {
    subject: fallback(localeRendered.subject, enRendered.subject),
    email:   fallback(localeRendered.email,   enRendered.email),
    sms:     fallback(localeRendered.sms,     enRendered.sms),
  };
}

async function sendEmail({ to, subject, body }) {
  if (!process.env.SENDGRID_API_KEY) {
    console.log(`[notify:email] (dev) → ${to}\n  Subject: ${subject}\n  ${body.replace(/\n/g, '\n  ')}`);
    return { provider: 'console', sent: true };
  }
  // TODO: real SendGrid call via fetch when SENDGRID_API_KEY is configured.
  // No SDK dependency until then — keeps node_modules slim.
  return { provider: 'sendgrid', sent: false, error: 'sendgrid adapter not implemented' };
}

// MSG91 v5 OTP API. Used for the auth.phone_verification template only —
// it's the simplest path because MSG91 has a dedicated OTP endpoint that
// generates and signs the message from a DLT-approved template ID. Other
// SMS templates (order.placed, order.delivered, etc.) would each need their
// own DLT-approved template + a Flow API call; not wired yet, those still
// fall through to the console.
//
// India compliance reminder: every template_id MUST be registered and
// approved with DLT (Distributed Ledger Technology) by your sender entity
// before MSG91 will deliver. Approval typically takes 1–3 business days.
// Hindi + Bengali template bodies need their own DLT registrations — the
// MSG91_OTP_TEMPLATE_ID env var must point to the locale-matching template
// when sending non-English OTPs.
async function sendSmsViaMsg91Otp({ to, otp }) {
  const authKey = process.env.MSG91_AUTH_KEY;
  const templateId = process.env.MSG91_OTP_TEMPLATE_ID;
  if (!templateId) {
    return { provider: 'msg91', sent: false, error: 'MSG91_OTP_TEMPLATE_ID is not set' };
  }
  // MSG91 expects E.164-style mobile numbers with country code prefix.
  // Customer.phone is stored as a 10-digit Indian mobile per the zod
  // regex at registration; prepend 91 if it isn't already there.
  const mobile = /^\d{10}$/.test(to) ? `91${to}` : String(to).replace(/[^\d]/g, '');
  try {
    const res = await fetch('https://control.msg91.com/api/v5/otp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'authkey': authKey },
      body: JSON.stringify({ template_id: templateId, mobile, otp: String(otp) }),
    });
    const json = await res.json().catch(() => ({}));
    // MSG91 returns { type: 'success' } on success and { type: 'error', message } on failure.
    if (!res.ok || json.type === 'error') {
      return { provider: 'msg91', sent: false, error: json.message || `MSG91 returned ${res.status}` };
    }
    return { provider: 'msg91', sent: true };
  } catch (err) {
    return { provider: 'msg91', sent: false, error: err.message };
  }
}

async function sendSms({ to, body, template, data }) {
  // Real provider path: MSG91 is configured. Currently only the OTP
  // template has a wired adapter — the OTP API doesn't need a per-template
  // DLT setup beyond MSG91_OTP_TEMPLATE_ID.
  if (process.env.MSG91_AUTH_KEY) {
    if ((template === 'auth.phone_verification' || template === 'auth.password_reset_otp') && data?.otp) {
      return sendSmsViaMsg91Otp({ to, otp: data.otp });
    }
    // Other SMS templates aren't wired to MSG91 yet — log and skip rather
    // than failing the whole notify dispatch. Order receipts will resume
    // delivery once we add per-template Flow API mappings.
    console.log(`[notify:sms] (msg91 not wired for "${template}", skipped) → ${to}: ${body}`);
    return { provider: 'msg91', sent: false, error: `MSG91 adapter not wired for template "${template}"` };
  }

  // No real provider configured: print a single discrete line so a dev
  // can confirm the dispatcher fired. No OTP banner, no response echo —
  // real SMS is the only intended delivery path now.
  console.log(`[notify:sms] (dev, no MSG91_AUTH_KEY) → ${to}: ${body}`);
  return { provider: 'console', sent: true };
}

// Honor user notification_prefs (FR-PROF-05) AND read Customer.language so
// the notify dispatcher can pick the right locale automatically. Falls back
// to allow-all + 'en' when no customer_id is provided (e.g. password-reset
// to a logged-out user — there's no row to read from).
async function loadCustomerContext(customer_id) {
  const defaults = { prefs: { email: true, sms: true, push: false }, language: 'en' };
  if (!customer_id) return defaults;
  const u = await prisma.customer.findUnique({
    where: { customer_id },
    select: { notification_prefs: true, language: true },
  });
  if (!u) return defaults;
  return {
    prefs: { ...defaults.prefs, ...(u.notification_prefs ?? {}) },
    language: u.language || 'en',
  };
}

// notify({ template, to: { email, phone, customer_id, language? }, data })
// `to.language` is optional — when omitted we read it from Customer.language.
// Explicit language wins so admin-side flows that need to force a locale
// (e.g. an English-only reset link triggered by support) can do so.
export async function notify({ template, to, data }) {
  if (!en[template]) {
    console.warn(`[notify] unknown template: ${template}`);
    return;
  }
  const ctx = await loadCustomerContext(to.customer_id);
  const locale = to.language || ctx.language;
  const rendered = renderTemplate(template, locale, data);
  if (!rendered) return; // shouldn't happen since we guarded above, but defensive

  const tasks = [];
  if (rendered.email && to.email && ctx.prefs.email) {
    tasks.push({ channel: 'email', recipient: to.email, body: rendered.email, send: () => sendEmail({ to: to.email, subject: rendered.subject, body: rendered.email }) });
  }
  if (rendered.sms && to.phone && ctx.prefs.sms) {
    // Pass `template` + `data` through so the SMS adapter can reach for
    // structured fields (e.g. the OTP value for the MSG91 OTP API)
    // without re-parsing them out of the rendered body.
    tasks.push({
      channel: 'sms',
      recipient: to.phone,
      body: rendered.sms,
      send: () => sendSms({ to: to.phone, body: rendered.sms, template, data }),
    });
  }

  await Promise.all(tasks.map(async (t) => {
    let outcome;
    try { outcome = await t.send(); }
    catch (err) { outcome = { provider: 'unknown', sent: false, error: err.message }; }

    try {
      await prisma.notification.create({
        data: {
          customer_id: to.customer_id ?? null,
          channel: t.channel,
          to_address: t.recipient,
          template,
          subject: rendered.subject ?? null,
          body: t.body,
          status: outcome.sent ? 'sent' : 'failed',
          provider: outcome.provider,
          error: outcome.error ?? null,
          sent_at: outcome.sent ? new Date() : null,
        },
      });
    } catch (logErr) {
      console.error(`[notify] failed to persist log for ${template}:`, logErr.message);
    }
  }));
}
