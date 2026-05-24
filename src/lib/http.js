// Tiny helpers to keep route handlers focused on business logic.

export class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export const badRequest = (msg, details) => { throw new HttpError(400, msg, details); };
export const unauthorized = (msg = 'Unauthorized') => { throw new HttpError(401, msg); };
export const forbidden = (msg = 'Forbidden') => { throw new HttpError(403, msg); };
export const notFound = (msg = 'Not found') => { throw new HttpError(404, msg); };
export const conflict = (msg) => { throw new HttpError(409, msg); };

// Wrap async route handlers so thrown errors flow into Express's error middleware.
export const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Validate req.body against a zod schema; throws HttpError(400) with field details on failure.
export function validate(schema) {
  return (req, _res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      const details = result.error.flatten();
      return next(new HttpError(400, 'Invalid request body', details));
    }
    req.body = result.data;
    next();
  };
}
