// Email "genuineness" gate at registration time. The zod email() regex catches
// malformed inputs; this module catches the next class of fakes — addresses
// whose *domain* doesn't actually receive mail (gnail.com, yaho.com, made-up
// vanity domains). We do that with a DNS MX-record lookup: if the domain
// doesn't advertise any mail exchanger, the address can't possibly receive
// our verification OTP, so reject before creating the user.
//
// What this does NOT catch:
//   - real domains that happen to be disposable (mailinator.com has valid MX).
//     If we want to filter those, layer a domain blocklist on top.
//   - typos that *do* land at a real domain (e.g. user types "gmail.con"
//     and ".con" is a real TLD). Email-OTP verification is the backstop.
//
// Failure modes:
//   - DNS server unreachable / slow: we time out after 3s and treat it as a
//     soft pass (return ok). Reason: a transient DNS hiccup shouldn't block
//     a real customer's signup, and the OTP will fail to deliver if the
//     address is genuinely bogus, which is the same outcome.
//   - NXDOMAIN / ENODATA: hard reject with a clear message.

import { promises as dns } from 'node:dns';

const MX_LOOKUP_TIMEOUT_MS = 3000;

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('DNS lookup timed out')), ms)),
  ]);
}

// Returns { ok: true } when the domain has at least one MX record (or A/AAAA
// fallback per RFC 5321 §5), or when DNS itself is unavailable (soft pass).
// Returns { ok: false, reason } when the domain definitively has no mail
// receivers.
export async function validateEmailHasMx(email) {
  const domain = (email || '').split('@')[1];
  if (!domain) {
    return { ok: false, reason: 'Email is missing a domain' };
  }

  try {
    const mx = await withTimeout(dns.resolveMx(domain), MX_LOOKUP_TIMEOUT_MS);
    if (Array.isArray(mx) && mx.length > 0) return { ok: true };
    // resolveMx returned empty array — fall through to A-record fallback.
  } catch (err) {
    // ENOTFOUND  = NXDOMAIN (domain doesn't exist at all)
    // ENODATA    = domain exists but has no MX (try A/AAAA per RFC 5321)
    // ESERVFAIL / timeouts: be lenient (soft pass) so real customers aren't
    // blocked by transient DNS issues — verification OTP will still gate.
    if (err.code === 'ENOTFOUND') {
      return { ok: false, reason: `Email domain "${domain}" doesn't exist. Please check the spelling.` };
    }
    if (err.code !== 'ENODATA') {
      // Unknown error — log and soft-pass.
      console.warn(`[emailValidation] DNS error for ${domain}: ${err.message} (soft pass)`);
      return { ok: true };
    }
  }

  // No MX — check for A/AAAA so we don't reject domains that accept mail at
  // their root host (rare but RFC-allowed).
  try {
    const aRecords = await withTimeout(dns.resolve4(domain).catch(() => dns.resolve6(domain)), MX_LOOKUP_TIMEOUT_MS);
    if (Array.isArray(aRecords) && aRecords.length > 0) return { ok: true };
  } catch {
    // fall through
  }

  return {
    ok: false,
    reason: `"${domain}" doesn't appear to accept email. Please use a real email address you can receive messages at.`,
  };
}
