import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { prisma } from './lib/prisma.js';

import authRoutes from './routes/auth.js';
import userRoutes from './routes/users.js';
import productRoutes from './routes/products.js';
import cartRoutes from './routes/cart.js';
import orderRoutes from './routes/orders.js';
import couponRoutes from './routes/coupons.js';
import adminRoutes from './routes/admin.js';
import paymentRoutes from './routes/payments.js';
import { errorHandler } from './middleware/error.js';
import { startCreditScheduler } from './lib/creditScheduler.js';

const app = express();

// Disable Express's automatic ETag generation. Admin GETs (e.g. /credit/accounting)
// otherwise trigger conditional revalidation: the browser sends If-None-Match,
// the server replies 304 with no body, and the fetch() layer surfaces it as a
// non-2xx response with an empty payload — which broke the Accounting tab.
// We never rely on ETag-based caching for API responses, so turning it off is
// strictly an improvement.
app.set('etag', false);

// CORS — allow the frontend dev origins from .env
const origins = (process.env.CORS_ORIGINS || 'http://localhost:5174').split(',').map((s) => s.trim());
app.use(cors({ origin: origins, credentials: true }));
// `verify` captures the raw bytes alongside the parsed JSON. The Razorpay
// webhook handler in routes/payments.js needs req.rawBody to recompute the
// HMAC signature — once the body is JSON.parsed the original byte order is
// gone, so this has to happen at parse time.
app.use(express.json({
  limit: '1mb',
  verify: (req, _res, buf) => { req.rawBody = buf; },
}));

// Static-serve uploaded product images. Files land here from
// routes/adminUploads.js (multer disk storage). Served at /uploads/...
// without /api prefix because they're plain static assets — frontend
// resolves via API_HOST + url path.
const UPLOADS_DIR = path.resolve(process.cwd(), 'uploads');
app.use('/uploads', express.static(UPLOADS_DIR, {
  // 1-day cache — admin re-uploads use a new filename (uuid) so cached
  // copies of an old file don't matter. Tighten if you ever reuse names.
  maxAge: '1d',
  // Defensive: never send dotfiles or directory listings.
  dotfiles: 'deny',
  index: false,
}));

// Health check — pings Postgres so platform health probes (Render) fail
// when the DB is unreachable, not just when the Node process is dead.
app.get('/api/health', async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ status: 'ok', service: 'redlook-api', db: 'ok' });
  } catch (err) {
    res.status(503).json({ status: 'error', service: 'redlook-api', db: 'error', message: err.message });
  }
});

// Routes — paths match BRD §11
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api', productRoutes); // exposes /products, /products/:id, /categories
app.use('/api/cart', cartRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/coupons', couponRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/admin', adminRoutes);

// 404 + error handler last
app.use((req, res) => res.status(404).json({ error: `Route ${req.method} ${req.path} not found` }));
app.use(errorHandler);

const PORT = Number(process.env.PORT) || 4001;
// Bind to 0.0.0.0 so cloud platforms (Render, Fly, Railway) can reach the
// container from their edge proxy. Default Node binding is localhost which
// works for `npm run dev` but blackholes external traffic in production —
// the platform's load balancer just sees `no-server` and returns 404.
const HOST = '0.0.0.0';
app.listen(PORT, HOST, () => {
  console.log(`✓ Redlook API listening on http://${HOST}:${PORT}`);
  console.log(`  Allowed CORS origins: ${origins.join(', ')}`);
  // BRD §8 + §10: in-process daily run that marks DEBITs OVERDUE and
  // dispatches the reminder cadence (5d before / on due / 1d after /
  // every 7d after). Single-instance only; gate behind a Redis lock if
  // the API is ever scaled horizontally.
  if (process.env.CREDIT_SCHEDULER_DISABLED !== 'true') {
    startCreditScheduler();
  }
});
