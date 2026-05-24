import jwt from 'jsonwebtoken';

const SECRET = process.env.JWT_SECRET;
const EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';

if (!SECRET) {
  throw new Error('JWT_SECRET env var is required');
}

export function signToken(payload) {
  return jwt.sign(payload, SECRET, { expiresIn: EXPIRES_IN });
}

export function verifyToken(token) {
  return jwt.verify(token, SECRET);
}

// Best-effort decode of an exp claim into a Date (for storing alongside the session).
export function tokenExpiry(token) {
  const decoded = jwt.decode(token);
  return decoded?.exp ? new Date(decoded.exp * 1000) : new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
}
