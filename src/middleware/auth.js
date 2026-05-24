import { prisma } from '../lib/prisma.js';
import { verifyToken } from '../lib/jwt.js';
import { HttpError } from '../lib/http.js';

// requireAuth attaches req.user (full Customer record minus password_hash) and
// req.token. Rejects with 401 if header missing/invalid or session was logged out.
export async function requireAuth(req, _res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) throw new HttpError(401, 'Missing Authorization Bearer token');

    let payload;
    try { payload = verifyToken(token); }
    catch { throw new HttpError(401, 'Invalid or expired token'); }

    // Verify the session still exists (hasn't been revoked via logout).
    const session = await prisma.session.findUnique({ where: { token } });
    if (!session) throw new HttpError(401, 'Session no longer active');
    if (session.expires_at < new Date()) {
      await prisma.session.delete({ where: { token } });
      throw new HttpError(401, 'Session expired');
    }

    const user = await prisma.customer.findUnique({ where: { customer_id: payload.sub } });
    if (!user) throw new HttpError(401, 'User no longer exists');
    if (user.account_status !== 'Active') throw new HttpError(403, 'Account not active');

    const { password_hash: _ph, ...safeUser } = user;
    req.user = safeUser;
    req.token = token;
    next();
  } catch (err) {
    next(err);
  }
}

// Ensure the URL-bound user_id matches the authenticated user (or 403).
// Prevents user A from reading/updating user B's data via /api/users/{B}/...
export function requireSelf(paramName = 'id') {
  return (req, _res, next) => {
    if (req.params[paramName] !== req.user.customer_id) {
      return next(new HttpError(403, 'Cannot access another user\'s data'));
    }
    next();
  };
}
