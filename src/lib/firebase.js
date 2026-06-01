// Firebase Admin SDK wrapper — verifies phone-auth ID tokens minted by
// the Firebase client SDK on the storefront. Used by the new
// /api/auth/firebase-* endpoints in routes/auth.js.
//
// Why: Firebase Phone Auth offloads OTP send + verify to Google
// (free up to 10k verifications/month for our volume). The frontend
// gets a verified ID token; our backend only needs to confirm the
// token is genuine and extract the phone number on it before issuing
// our own JWT.
//
// Credentials live in FIREBASE_SERVICE_ACCOUNT_JSON — paste the entire
// service-account JSON file contents into the env var (one line, no
// indentation). When unset, this module stays dormant and the
// /firebase-* endpoints return 503 so the legacy MSG91 flow keeps
// working as the fallback path.

import admin from 'firebase-admin';

let app = null;
let configured = false;
let initError = null;

const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON || '';

if (raw.trim().length > 0) {
  try {
    // Allow either raw JSON or base64-encoded JSON. Some hosts (Render
    // included) get cranky about embedded newlines in the private_key
    // value — base64 sidesteps that entirely.
    const decoded = raw.trim().startsWith('{')
      ? raw
      : Buffer.from(raw, 'base64').toString('utf8');
    const serviceAccount = JSON.parse(decoded);
    app = admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
    configured = true;
    console.log(`[firebase] initialised — project: ${serviceAccount.project_id}`);
  } catch (err) {
    initError = err;
    console.error('[firebase] failed to parse FIREBASE_SERVICE_ACCOUNT_JSON:', err.message);
  }
} else {
  console.warn('[firebase] FIREBASE_SERVICE_ACCOUNT_JSON not set — Firebase Phone Auth endpoints will return 503.');
}

export const firebaseConfigured = configured;

// Verifies a Firebase ID token and returns the trusted phone number on
// it. Throws on any failure (invalid signature, expired, revoked, no
// phone claim) — caller should catch and return 401.
//
// Note: Firebase Phone Auth tokens carry the verified phone in the
// standard `phone_number` claim in E.164 format (e.g. "+919876543210").
// We re-store these as-is in Customer.phone so app code never needs to
// re-normalise across providers.
export async function verifyFirebasePhoneToken(idToken) {
  if (!configured) {
    const e = new Error('Firebase Phone Auth is not configured on this server.');
    e.status = 503;
    throw e;
  }
  const decoded = await admin.auth(app).verifyIdToken(idToken, true);
  if (!decoded.phone_number) {
    const e = new Error('Firebase token does not contain a verified phone number.');
    e.status = 401;
    throw e;
  }
  return { phone: decoded.phone_number, firebase_uid: decoded.uid };
}

export { initError as firebaseInitError };
