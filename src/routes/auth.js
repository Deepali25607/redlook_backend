// BRD §11.1 Authentication APIs
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { signToken, tokenExpiry } from '../lib/jwt.js';
import { asyncHandler, validate, badRequest, conflict, notFound, unauthorized, HttpError } from '../lib/http.js';
import { serializeUser } from '../lib/serialize.js';
import { notify } from '../lib/notify.js';
import { validateEmailHasMx } from '../lib/emailValidation.js';
import { verifyFirebasePhoneToken } from '../lib/firebase.js';

// Fire-and-forget wrapper — notify() must never break the user-facing response.
const fireNotify = (args) => notify(args).catch((err) => console.error('[notify] failed:', err.message));

// Phone-OTP knobs. 10 min TTL is long enough for an SMS to land on a slow
// network, short enough to limit how long a stolen handset is useful.
// 5 attempts caps brute force (1M codes ÷ 5 = 200K resends to expect a hit,
// defeated by the 60s resend throttle). The throttle also caps MSG91 spend
// per registered customer_id.
const PHONE_OTP_TTL_MINUTES = 10;
const PHONE_OTP_MAX_ATTEMPTS = 5;
const PHONE_OTP_RESEND_THROTTLE_SECONDS = 60;

// Dev convenience while real SMS isn't wired: echo the freshly-minted OTP
// in the API response so the frontend can surface it as a toast. Always
// off when MSG91 is configured (real SMS in flight). On in non-prod by
// default; in prod requires explicit OTP_ECHO_FOR_TESTING=true so the
// gate can't be tripped by accident — used during the pre-launch test
// window before MSG91 credentials arrive.
function devOtpEcho(otp) {
  if (process.env.MSG91_AUTH_KEY) return undefined;
  if (process.env.NODE_ENV !== 'production') return otp;
  if (process.env.OTP_ECHO_FOR_TESTING === 'true') return otp;
  return undefined;
}

function generateOtp() {
  // crypto.randomInt is uniform over the range; Math.random would skew slightly.
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

// Generates a fresh OTP, hashes it, persists it on the customer row, and
// dispatches the verification SMS. Returns the plaintext OTP only as the
// caller's confirmation hook — the DB only stores the hash, and the
// plaintext exists in memory just long enough to hand to notify().
//
// Used for the post-signup phone-CHANGE flow only — initial registration
// goes through PendingRegistration (issuePhoneOtpForPending below). A
// Customer row implies a phone that's been verified at least once already.
async function issuePhoneOtp(customer) {
  const otp = generateOtp();
  const otp_hash = await bcrypt.hash(otp, 10);
  const expires_at = new Date(Date.now() + PHONE_OTP_TTL_MINUTES * 60 * 1000);
  await prisma.customer.update({
    where: { customer_id: customer.customer_id },
    data: {
      phone_otp_hash: otp_hash,
      phone_otp_expires_at: expires_at,
      phone_otp_attempts: 0,
      phone_otp_issued_at: new Date(),
    },
  });
  fireNotify({
    template: 'auth.phone_verification',
    to: { phone: customer.phone, email: customer.email, customer_id: customer.customer_id },
    data: { otp, ttl_minutes: PHONE_OTP_TTL_MINUTES },
  });
  return otp;
}

// Same as issuePhoneOtp but operates on a PendingRegistration row — used
// for the initial signup verification, before any Customer row exists.
async function issuePhoneOtpForPending(pending) {
  const otp = generateOtp();
  const otp_hash = await bcrypt.hash(otp, 10);
  const expires_at = new Date(Date.now() + PHONE_OTP_TTL_MINUTES * 60 * 1000);
  await prisma.pendingRegistration.update({
    where: { pending_id: pending.pending_id },
    data: {
      phone_otp_hash: otp_hash,
      phone_otp_expires_at: expires_at,
      phone_otp_attempts: 0,
      phone_otp_issued_at: new Date(),
    },
  });
  fireNotify({
    template: 'auth.phone_verification',
    to: { phone: pending.phone, email: pending.email },
    data: { otp, ttl_minutes: PHONE_OTP_TTL_MINUTES },
  });
  return otp;
}

const router = Router();

const passwordRule = z.string()
  .min(8, 'Min 8 characters')
  .regex(/[A-Z]/, 'Needs an uppercase letter')
  .regex(/\d/, 'Needs a number')
  .regex(/[^A-Za-z0-9]/, 'Needs a special character');

const registerSchema = z.object({
  full_name: z.string().min(2).max(100),
  email: z.string().email().max(150),
  phone: z.string().regex(/^[6-9]\d{9}$/, 'Invalid Indian mobile'),
  password: passwordRule,
  date_of_birth: z.string().optional().nullable(),
  gender: z.string().optional().nullable(),
});

const loginSchema = z.object({
  identifier: z.string().min(1), // email OR phone
  password: z.string().min(1),
});

const verifyOtpSchema = z.object({
  customer_id: z.string().uuid(),
  otp: z.string().regex(/^\d{6}$/),
});

// `method` lets the user pick how the reset proof arrives:
//   - 'link'      → JWT reset token emailed (existing behaviour, default)
//   - 'email_otp' → 6-digit code emailed
//   - 'sms_otp'   → 6-digit code SMS'd
// Defaults to 'link' so old clients keep working unchanged.
const forgotSchema = z.object({
  email: z.string().min(1),
  method: z.enum(['link', 'email_otp', 'sms_otp']).optional(),
});
const verifyResetOtpSchema = z.object({
  customer_id: z.string().uuid(),
  otp: z.string().regex(/^\d{6}$/),
});
const resetSchema = z.object({ token: z.string().min(1), new_password: passwordRule });

// Reuse the phone-OTP TTL / attempts limits — same security profile (6-digit
// code, short window) so there's no reason to special-case password reset.
const PASSWORD_RESET_OTP_TTL_MINUTES = PHONE_OTP_TTL_MINUTES;
const PASSWORD_RESET_OTP_MAX_ATTEMPTS = PHONE_OTP_MAX_ATTEMPTS;

// Issue a token + persist a session record so we can revoke on logout.
async function issueSession(customer_id) {
  const token = signToken({ sub: customer_id });
  await prisma.session.create({
    data: { token, customer_id, expires_at: tokenExpiry(token) },
  });
  return token;
}

// POST /auth/register — FR-AUTH-01, FR-AUTH-03
//
// Writes ONLY to PendingRegistration; no Customer row is created here. The
// row is promoted to Customer when /auth/verify-otp succeeds with the correct
// OTP. Goal: an abandoned signup never pollutes the customer table or holds
// the email/phone unique slot indefinitely.
//
// Response shape preserves `data.user.customer_id` for backward compatibility
// — the value is actually the pending_id, but to the frontend it's just an
// opaque verification identifier passed to /verify-otp + /resend-phone-otp.
router.post('/register', validate(registerSchema), asyncHandler(async (req, res) => {
  const { full_name, email, phone, password, date_of_birth, gender } = req.body;

  // Reject fake / typo'd email domains BEFORE writing anything to the DB.
  // The MX check is a fast gate (3s timeout, soft-passes on DNS errors so a
  // transient hiccup never blocks a real signup).
  const mx = await validateEmailHasMx(email);
  if (!mx.ok) badRequest(mx.reason);

  // Email/phone collision with an EXISTING (verified) customer — hard reject.
  const existingCustomer = await prisma.customer.findFirst({
    where: { OR: [{ email }, { phone }] },
  });
  if (existingCustomer) {
    if (existingCustomer.email === email) conflict('Email already registered');
    if (existingCustomer.phone === phone) conflict('Phone already registered');
  }

  // Email/phone collision with a PENDING registration — overwrite. The
  // natural intent of "I'm typing my email/phone again" is "let me retry",
  // not "tell me my prior attempt is in the way". Drop any prior pending
  // rows for this email OR phone and start fresh.
  await prisma.pendingRegistration.deleteMany({
    where: { OR: [{ email }, { phone }] },
  });

  const password_hash = await bcrypt.hash(password, 10);
  const otp = generateOtp();
  const otp_hash = await bcrypt.hash(otp, 10);

  const pending = await prisma.pendingRegistration.create({
    data: {
      full_name,
      email,
      phone,
      password_hash,
      date_of_birth: date_of_birth ? new Date(date_of_birth) : null,
      gender,
      phone_otp_hash: otp_hash,
      phone_otp_expires_at: new Date(Date.now() + PHONE_OTP_TTL_MINUTES * 60 * 1000),
      phone_otp_issued_at: new Date(),
    },
  });

  // Fire-and-forget — never blocks the response on provider latency. Emails
  // the OTP (Gmail/Nodemailer) and, if MSG91 is configured, also SMSes it.
  fireNotify({
    template: 'auth.phone_verification',
    to: { phone: pending.phone, email: pending.email },
    data: { otp, ttl_minutes: PHONE_OTP_TTL_MINUTES },
  });

  res.status(201).json({
    data: {
      // `customer_id` here is the pending_id; the frontend treats it as an
      // opaque verification handle. A real customer_id is issued on verify.
      user: { customer_id: pending.pending_id, phone: pending.phone, full_name: pending.full_name },
      otp_sent_to: pending.phone,
    },
    dev_otp: devOtpEcho(otp),
  });
}));

// POST /auth/verify-otp — FR-AUTH-04
//
// Two flows live behind one endpoint, distinguished by what the input id
// matches:
//   1. PendingRegistration (initial signup) → on success, atomically create
//      Customer row + delete pending row + issue session + fire welcome.
//   2. Customer (post-signup phone CHANGE re-verification) → on success,
//      flip phone_verified=true, clear OTP slot, issue session.
//
// Failed-attempt accounting (5-strike, then OTP invalidated) is identical
// across both paths and lives in handlePendingVerify / handleCustomerVerify.
router.post('/verify-otp', validate(verifyOtpSchema), asyncHandler(async (req, res) => {
  const { customer_id, otp } = req.body;

  const pending = await prisma.pendingRegistration.findUnique({
    where: { pending_id: customer_id },
  });
  if (pending) return handlePendingVerify(req, res, pending, otp);

  const user = await prisma.customer.findUnique({ where: { customer_id } });
  if (user) return handleCustomerVerify(req, res, user, otp);

  notFound('Account not found');
}));

// Initial-signup verification path. Promotes the PendingRegistration row to
// a Customer in a single transaction so a partial failure never leaves a
// half-created account.
async function handlePendingVerify(_req, res, pending, otp) {
  if (pending.phone_otp_expires_at < new Date()) {
    badRequest('This verification code has expired. Please request a new code.');
  }
  if (pending.phone_otp_attempts >= PHONE_OTP_MAX_ATTEMPTS) {
    badRequest('Too many incorrect attempts. Please request a new code.');
  }

  const matches = await bcrypt.compare(otp, pending.phone_otp_hash);
  if (!matches) {
    const newAttempts = pending.phone_otp_attempts + 1;
    await prisma.pendingRegistration.update({
      where: { pending_id: pending.pending_id },
      // On the 5th miss we wipe the OTP hash so a later correct guess
      // (still within TTL) can't slip through. User has to resend.
      data: newAttempts >= PHONE_OTP_MAX_ATTEMPTS
        ? { phone_otp_attempts: newAttempts, phone_otp_hash: '', phone_otp_expires_at: new Date(0) }
        : { phone_otp_attempts: newAttempts },
    });
    const remaining = PHONE_OTP_MAX_ATTEMPTS - newAttempts;
    if (remaining <= 0) badRequest('Too many incorrect attempts. Please request a new code.');
    badRequest(`Incorrect code. ${remaining} attempt${remaining === 1 ? '' : 's'} remaining.`);
  }

  // Race-safe collision check — between /register and /verify-otp another
  // signup could in theory have completed for the same email/phone. Give
  // a friendly conflict instead of a Prisma P2002 surface.
  const collision = await prisma.customer.findFirst({
    where: { OR: [{ email: pending.email }, { phone: pending.phone }] },
  });
  if (collision) {
    // Drop the now-unusable pending row so a retry isn't blocked by it.
    await prisma.pendingRegistration.delete({ where: { pending_id: pending.pending_id } });
    if (collision.email === pending.email) conflict('Email already registered');
    if (collision.phone === pending.phone) conflict('Phone already registered');
  }

  // Atomic: create Customer, drop pending row. If either side fails we
  // don't want a verified-but-rowless account or a Customer with a
  // dangling pending row.
  const created = await prisma.$transaction(async (tx) => {
    const user = await tx.customer.create({
      data: {
        full_name:           pending.full_name,
        email:               pending.email,
        phone:               pending.phone,
        password_hash:       pending.password_hash,
        date_of_birth:       pending.date_of_birth,
        gender:              pending.gender,
        phone_verified:      true,
        notification_prefs:  { email: true, sms: true, push: false },
        last_login:          new Date(),
      },
    });
    await tx.pendingRegistration.delete({ where: { pending_id: pending.pending_id } });
    return user;
  });

  fireNotify({
    template: 'auth.welcome',
    to: { email: created.email, customer_id: created.customer_id },
    data: { full_name: created.full_name },
  });

  const token = await issueSession(created.customer_id);
  res.json({ data: { user: serializeUser(created), token } });
}

// Post-signup phone-CHANGE verification path. The Customer row already
// exists; we just flip phone_verified back on and clear the OTP slot.
async function handleCustomerVerify(_req, res, user, otp) {
  if (!user.phone_otp_hash || !user.phone_otp_expires_at) {
    badRequest('No verification code on file. Please request a new code.');
  }
  if (user.phone_otp_expires_at < new Date()) {
    badRequest('This verification code has expired. Please request a new code.');
  }
  if (user.phone_otp_attempts >= PHONE_OTP_MAX_ATTEMPTS) {
    badRequest('Too many incorrect attempts. Please request a new code.');
  }

  const matches = await bcrypt.compare(otp, user.phone_otp_hash);
  if (!matches) {
    const newAttempts = user.phone_otp_attempts + 1;
    await prisma.customer.update({
      where: { customer_id: user.customer_id },
      data: newAttempts >= PHONE_OTP_MAX_ATTEMPTS
        ? { phone_otp_hash: null, phone_otp_expires_at: null, phone_otp_attempts: newAttempts }
        : { phone_otp_attempts: newAttempts },
    });
    const remaining = PHONE_OTP_MAX_ATTEMPTS - newAttempts;
    if (remaining <= 0) badRequest('Too many incorrect attempts. Please request a new code.');
    badRequest(`Incorrect code. ${remaining} attempt${remaining === 1 ? '' : 's'} remaining.`);
  }

  const updated = await prisma.customer.update({
    where: { customer_id: user.customer_id },
    data: {
      phone_verified: true,
      phone_otp_hash: null,
      phone_otp_expires_at: null,
      phone_otp_attempts: 0,
      phone_otp_issued_at: null,
      last_login: new Date(),
    },
  });
  const token = await issueSession(updated.customer_id);
  res.json({ data: { user: serializeUser(updated), token } });
}

// POST /auth/resend-phone-otp — re-sends the verification code.
// Throttled to one send per PHONE_OTP_RESEND_THROTTLE_SECONDS so a bot
// can't trigger an unbounded SMS storm per id (also caps MSG91 spend).
//
// Same dual-lookup as /verify-otp: id might match a PendingRegistration
// (initial signup) or a Customer (post-signup phone-change reverify).
const resendSchema = z.object({ customer_id: z.string().uuid() });
router.post('/resend-phone-otp', validate(resendSchema), asyncHandler(async (req, res) => {
  const id = req.body.customer_id;

  const pending = await prisma.pendingRegistration.findUnique({ where: { pending_id: id } });
  if (pending) {
    if (pending.phone_otp_issued_at) {
      const elapsed = (Date.now() - pending.phone_otp_issued_at.getTime()) / 1000;
      if (elapsed < PHONE_OTP_RESEND_THROTTLE_SECONDS) {
        const wait = Math.ceil(PHONE_OTP_RESEND_THROTTLE_SECONDS - elapsed);
        throw new HttpError(429, `Please wait ${wait}s before requesting another code.`);
      }
    }
    const otp = await issuePhoneOtpForPending(pending);
    return res.json({ data: { ok: true, sent_to: pending.phone }, dev_otp: devOtpEcho(otp) });
  }

  const user = await prisma.customer.findUnique({ where: { customer_id: id } });
  if (!user) notFound('Account not found');
  if (user.phone_verified && !user.phone_otp_hash) {
    // Already verified and no pending re-verify — nothing to resend.
    return res.json({ data: { ok: true, already_verified: true } });
  }
  if (user.phone_otp_issued_at) {
    const elapsed = (Date.now() - user.phone_otp_issued_at.getTime()) / 1000;
    if (elapsed < PHONE_OTP_RESEND_THROTTLE_SECONDS) {
      const wait = Math.ceil(PHONE_OTP_RESEND_THROTTLE_SECONDS - elapsed);
      throw new HttpError(429, `Please wait ${wait}s before requesting another code.`);
    }
  }
  const otp = await issuePhoneOtp(user);
  res.json({ data: { ok: true, sent_to: user.phone }, dev_otp: devOtpEcho(otp) });
}));

// POST /auth/login — FR-AUTH-05, FR-AUTH-07
router.post('/login', validate(loginSchema), asyncHandler(async (req, res) => {
  const { identifier, password } = req.body;
  const user = await prisma.customer.findFirst({
    where: { OR: [{ email: identifier }, { phone: identifier }] },
  });
  if (!user) unauthorized('Invalid email/phone or password');

  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) unauthorized('Invalid email/phone or password');
  if (user.account_status !== 'Active') unauthorized('Account is not active');

  // Hard gate: no session token until the phone is verified. We surface
  // customer_id + phone in `details` so the FE can navigate to the
  // verify-otp page and call /resend-phone-otp without making the user
  // re-enter their phone. The 403 + structured `code` lets the FE
  // distinguish this from a generic auth error and show a "verify now" CTA.
  if (!user.phone_verified) {
    throw new HttpError(403, 'Please verify your account before signing in. Tap Resend on the next screen to get a code by email.', {
      code: 'PHONE_NOT_VERIFIED',
      customer_id: user.customer_id,
      phone: user.phone,
    });
  }

  await prisma.customer.update({
    where: { customer_id: user.customer_id },
    data: { last_login: new Date() },
  });

  const token = await issueSession(user.customer_id);
  res.json({ data: { user: serializeUser(user), token } });
}));

// POST /auth/logout — FR-AUTH-08
router.post('/logout', asyncHandler(async (req, res) => {
  const token = req.body?.token;
  if (token) await prisma.session.deleteMany({ where: { token } });
  res.json({ data: { ok: true } });
}));

// Mask an email/phone for the API response so a logged-out attacker can
// tell *that* a code was sent without seeing the full address. e.g.
// "ra***@example.com" or "98****1234". The frontend uses this in the UI
// to confirm to the real user which contact got the code.
function maskEmail(email) {
  if (!email) return '';
  const [local, domain] = email.split('@');
  if (!domain) return email;
  const head = local.slice(0, 2);
  return `${head}${'*'.repeat(Math.max(1, local.length - 2))}@${domain}`;
}
function maskPhone(phone) {
  if (!phone) return '';
  const s = String(phone);
  if (s.length <= 4) return s;
  return `${s.slice(0, 2)}${'*'.repeat(s.length - 6)}${s.slice(-4)}`;
}

// POST /auth/forgot-password — FR-AUTH-06
// `method` controls how the reset proof reaches the customer:
//   - 'link'      → emails a JWT reset token (legacy default)
//   - 'email_otp' → emails a 6-digit code; verify via /verify-reset-otp
//   - 'sms_otp'   → SMS's the same 6-digit shape via MSG91 OTP API
// All three converge on the existing /reset-password endpoint, which still
// accepts a single JWT — the OTP paths just exchange the code for that JWT.
router.post('/forgot-password', validate(forgotSchema), asyncHandler(async (req, res) => {
  const { email, method = 'link' } = req.body;
  const user = await prisma.customer.findFirst({
    where: { OR: [{ email }, { phone: email }] },
  });
  if (!user) notFound('No account with that email/phone');

  if (method === 'link') {
    const reset_token = signToken({ sub: user.customer_id, purpose: 'reset' });
    fireNotify({
      template: 'auth.password_reset',
      to: { email: user.email, customer_id: user.customer_id },
      data: { reset_token },
    });
    // Echo reset_token only while SendGrid is on console — frontend dev flow
    // needs it. Drop this once real email delivery is wired.
    return res.json({
      data: { method, reset_token, sent_to: user.email, masked_to: maskEmail(user.email) },
    });
  }

  // OTP path — same code value, different transport(s). channel decides
  // which to-address the dispatcher will fan out to.
  const channel = method === 'sms_otp' ? 'sms' : 'email';
  const otp = generateOtp();
  const otp_hash = await bcrypt.hash(otp, 10);
  const expires_at = new Date(Date.now() + PASSWORD_RESET_OTP_TTL_MINUTES * 60 * 1000);
  await prisma.customer.update({
    where: { customer_id: user.customer_id },
    data: {
      password_reset_otp_hash: otp_hash,
      password_reset_otp_expires_at: expires_at,
      password_reset_otp_attempts: 0,
      password_reset_otp_issued_at: new Date(),
      password_reset_otp_channel: channel,
    },
  });
  fireNotify({
    template: 'auth.password_reset_otp',
    to: channel === 'sms'
      ? { phone: user.phone, customer_id: user.customer_id }
      : { email: user.email, customer_id: user.customer_id },
    data: { otp, ttl_minutes: PASSWORD_RESET_OTP_TTL_MINUTES, full_name: user.full_name },
  });
  res.json({
    data: {
      method,
      customer_id: user.customer_id,
      channel,
      masked_to: channel === 'sms' ? maskPhone(user.phone) : maskEmail(user.email),
      ttl_minutes: PASSWORD_RESET_OTP_TTL_MINUTES,
      // Dev convenience — echo back only when no provider is configured.
      // Mirrors the registration OTP behavior (devOtpEcho).
      otp: devOtpEcho(otp),
    },
  });
}));

// POST /auth/verify-reset-otp — exchanges a valid OTP for a /reset-password
// JWT. Same shape the link flow returns, so the password-update step is
// identical across all three methods.
router.post('/verify-reset-otp', validate(verifyResetOtpSchema), asyncHandler(async (req, res) => {
  const { customer_id, otp } = req.body;
  const user = await prisma.customer.findUnique({ where: { customer_id } });
  if (!user || !user.password_reset_otp_hash || !user.password_reset_otp_expires_at) {
    badRequest('No active reset code — please request a new one');
  }
  if (user.password_reset_otp_expires_at < new Date()) {
    badRequest('Reset code expired — please request a new one');
  }
  if (user.password_reset_otp_attempts >= PASSWORD_RESET_OTP_MAX_ATTEMPTS) {
    badRequest('Too many wrong attempts — please request a new code');
  }

  const matches = await bcrypt.compare(otp, user.password_reset_otp_hash);
  if (!matches) {
    const newAttempts = user.password_reset_otp_attempts + 1;
    await prisma.customer.update({
      where: { customer_id },
      // On the final miss, scrub the hash so the lockout is enforced by data,
      // not just the attempts counter — defence in depth.
      data: newAttempts >= PASSWORD_RESET_OTP_MAX_ATTEMPTS
        ? { password_reset_otp_attempts: newAttempts, password_reset_otp_hash: null, password_reset_otp_expires_at: new Date(0) }
        : { password_reset_otp_attempts: newAttempts },
    });
    const remaining = Math.max(0, PASSWORD_RESET_OTP_MAX_ATTEMPTS - newAttempts);
    badRequest(remaining === 0
      ? 'Incorrect code. Too many attempts — please request a new code.'
      : `Incorrect code. ${remaining} attempt${remaining === 1 ? '' : 's'} left.`);
  }

  // Success — burn the OTP so it can't be replayed, then hand back a fresh
  // reset JWT. /reset-password already accepts this.
  await prisma.customer.update({
    where: { customer_id },
    data: {
      password_reset_otp_hash: null,
      password_reset_otp_expires_at: null,
      password_reset_otp_attempts: 0,
      password_reset_otp_issued_at: null,
      password_reset_otp_channel: null,
    },
  });
  const reset_token = signToken({ sub: customer_id, purpose: 'reset' });
  res.json({ data: { reset_token } });
}));

// POST /auth/reset-password — FR-AUTH-06
router.post('/reset-password', validate(resetSchema), asyncHandler(async (req, res) => {
  const { token, new_password } = req.body;
  let payload;
  try { payload = (await import('../lib/jwt.js')).verifyToken(token); }
  catch { badRequest('Invalid or expired reset token'); }
  if (payload.purpose !== 'reset') badRequest('Invalid reset token');

  const password_hash = await bcrypt.hash(new_password, 10);
  await prisma.customer.update({
    where: { customer_id: payload.sub },
    data: { password_hash },
  });
  // Invalidate all existing sessions on password change.
  await prisma.session.deleteMany({ where: { customer_id: payload.sub } });
  res.json({ data: { ok: true } });
}));

// ============================================================
// Firebase Phone Auth endpoints — additive, opt-in via frontend
// flag. The MSG91-backed /register, /login, /verify-otp,
// /forgot-password, /verify-reset-otp endpoints above keep working
// untouched so a Firebase outage or a flag flip can revert the
// storefront to the legacy SMS flow without any backend change.
//
// All three endpoints accept a Firebase ID token in `idToken`,
// verify it with the Admin SDK, and trust the `phone_number` claim
// on it as proof of phone ownership. Firebase returns the phone in
// E.164 (e.g. "+919876543210") — we strip the +91 prefix to keep
// the 10-digit format that Customer.phone has used since day one.
// ============================================================

// Firebase tokens carry verified phones in E.164. Our DB and the
// existing registerSchema expect 10-digit Indian mobiles. Normalise
// here so both providers feed the same shape into Customer.phone.
function normalizeIndianPhone(e164) {
  const stripped = e164.replace(/^\+91/, '');
  if (!/^[6-9]\d{9}$/.test(stripped)) {
    badRequest('Only Indian mobile numbers (+91, starting 6–9) are supported.');
  }
  return stripped;
}

const firebaseLoginSchema = z.object({ idToken: z.string().min(1) });

// POST /auth/firebase-login — passwordless login via a verified
// Firebase phone token. Finds the existing Customer by phone and
// issues a session JWT. 404 when no account exists (so the
// storefront can route to the register flow).
router.post('/firebase-login', validate(firebaseLoginSchema), asyncHandler(async (req, res) => {
  let phone;
  try {
    ({ phone } = await verifyFirebasePhoneToken(req.body.idToken));
  } catch (err) {
    return res.status(err.status || 401).json({ error: err.message || 'Firebase token verification failed' });
  }
  const tenDigit = normalizeIndianPhone(phone);

  const user = await prisma.customer.findFirst({ where: { phone: tenDigit } });
  if (!user) notFound('No account found for this phone number. Please register first.');

  // Flip phone_verified back on (in case an admin had reset it) and
  // bump last_login so the dashboard's "last seen" stays current.
  const updated = await prisma.customer.update({
    where: { customer_id: user.customer_id },
    data: { last_login: new Date(), phone_verified: true },
  });
  const token = await issueSession(updated.customer_id);
  res.json({ data: { user: serializeUser(updated), token } });
}));

const firebaseRegisterSchema = z.object({
  idToken: z.string().min(1),
  full_name: z.string().min(2).max(100),
  email: z.string().email().max(150),
  password: passwordRule,
  date_of_birth: z.string().optional().nullable(),
  gender: z.string().optional().nullable(),
});

// POST /auth/firebase-register — single-step registration. Phone is
// already verified by Firebase, so we skip the PendingRegistration
// dance entirely and create the Customer in one shot.
router.post('/firebase-register', validate(firebaseRegisterSchema), asyncHandler(async (req, res) => {
  const { idToken, full_name, email, password, date_of_birth, gender } = req.body;

  let phone;
  try {
    ({ phone } = await verifyFirebasePhoneToken(idToken));
  } catch (err) {
    return res.status(err.status || 401).json({ error: err.message || 'Firebase token verification failed' });
  }
  const tenDigit = normalizeIndianPhone(phone);

  // Same hygiene as the MSG91 /register path so the email check stays
  // consistent across providers (catches misspelled domains, etc.).
  await validateEmailHasMx(email);

  const collision = await prisma.customer.findFirst({
    where: { OR: [{ email }, { phone: tenDigit }] },
  });
  if (collision) {
    if (collision.email === email) conflict('Email already registered');
    if (collision.phone === tenDigit) conflict('Phone already registered');
  }

  const created = await prisma.customer.create({
    data: {
      full_name,
      email,
      phone: tenDigit,
      password_hash: await bcrypt.hash(password, 10),
      date_of_birth: date_of_birth || null,
      gender: gender || null,
      // Firebase already verified the phone — flip the column so the
      // post-signup phone-change re-verify flow doesn't kick in.
      phone_verified: true,
      notification_prefs: { email: true, sms: true, push: false },
      last_login: new Date(),
    },
  });

  fireNotify({
    template: 'auth.welcome',
    to: { email: created.email, customer_id: created.customer_id },
    data: { full_name: created.full_name },
  });

  const token = await issueSession(created.customer_id);
  res.json({ data: { user: serializeUser(created), token } });
}));

const firebaseResetSchema = z.object({
  idToken: z.string().min(1),
  new_password: passwordRule,
});

// POST /auth/firebase-reset-password — forgot-password flow via
// Firebase. Customer verifies phone ownership through the client SDK
// and we update password_hash directly. All existing sessions are
// invalidated, matching the legacy /reset-password behaviour.
router.post('/firebase-reset-password', validate(firebaseResetSchema), asyncHandler(async (req, res) => {
  let phone;
  try {
    ({ phone } = await verifyFirebasePhoneToken(req.body.idToken));
  } catch (err) {
    return res.status(err.status || 401).json({ error: err.message || 'Firebase token verification failed' });
  }
  const tenDigit = normalizeIndianPhone(phone);

  const user = await prisma.customer.findFirst({ where: { phone: tenDigit } });
  if (!user) notFound('No account found for this phone number.');

  await prisma.customer.update({
    where: { customer_id: user.customer_id },
    data: { password_hash: await bcrypt.hash(req.body.new_password, 10) },
  });
  await prisma.session.deleteMany({ where: { customer_id: user.customer_id } });

  // Issue a fresh session so the customer is logged in on the device
  // they just reset from — saves them an immediate second sign-in.
  const token = await issueSession(user.customer_id);
  res.json({ data: { ok: true, user: serializeUser(user), token } });
}));

export default router;
