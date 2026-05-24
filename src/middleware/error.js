import { HttpError } from '../lib/http.js';

// Centralized error handler — converts thrown HttpError or known Prisma errors
// into JSON responses matching what the frontend expects.
export function errorHandler(err, _req, res, _next) {
  if (err instanceof HttpError) {
    return res.status(err.status).json({
      error: err.message,
      ...(err.details ? { details: err.details } : {}),
    });
  }

  // Prisma-specific known codes
  if (err.code === 'P2002') {
    const field = err.meta?.target?.[0] || 'value';
    return res.status(409).json({ error: `${field} already in use` });
  }
  if (err.code === 'P2025') {
    return res.status(404).json({ error: 'Record not found' });
  }

  console.error('[unhandled]', err);
  return res.status(500).json({ error: 'Internal server error' });
}
