// Admin portal routes (BRD §11.7). Foundation slice — only login/me/logout
// here. Domain endpoints (orders, products, coupons, reports, customers) get
// added under this router as Phase 4 progresses; each one declares the
// per-tile permissions it accepts via requirePermission(...).

import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { signToken, tokenExpiry } from '../lib/jwt.js';
import { asyncHandler, validate, unauthorized } from '../lib/http.js';
import { requireAdmin } from '../middleware/adminAuth.js';
import adminOrdersRouter from './adminOrders.js';
import adminUsersRouter from './adminUsers.js';
import adminProductsRouter from './adminProducts.js';
import adminCategoriesRouter from './adminCategories.js';
import adminCouponsRouter from './adminCoupons.js';
import adminCustomersRouter from './adminCustomers.js';
import adminReportsRouter from './adminReports.js';
import adminReviewsRouter from './adminReviews.js';
import adminSettingsRouter from './adminSettings.js';
import adminExportsRouter from './adminExports.js';
import adminUploadsRouter from './adminUploads.js';
import adminAccountingRouter from './adminAccounting.js';
import adminCustomerReportRouter from './adminCustomerReport.js';
import adminB2BCustomersRouter from './adminB2BCustomers.js';

const router = Router();

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

// Same complexity rule used elsewhere (FR-AUTH-03).
const passwordRule = z.string()
  .min(8, 'Min 8 characters')
  .regex(/[A-Z]/, 'Needs an uppercase letter')
  .regex(/\d/, 'Needs a number')
  .regex(/[^A-Za-z0-9]/, 'Needs a special character');

const updateMeSchema = z.object({ full_name: z.string().min(2).max(100) });

const changeOwnPasswordSchema = z.object({
  current_password: z.string().min(1),
  new_password: passwordRule,
});

// Strip password_hash before returning the admin payload. scoped_business_name
// is already a plain column on AdminUser so no joining is needed.
const safe = (admin) => {
  const { password_hash: _ph, ...rest } = admin;
  return rest;
};

// POST /api/admin/login
router.post('/login', validate(loginSchema), asyncHandler(async (req, res) => {
  const { email, password } = req.body;
  const admin = await prisma.adminUser.findUnique({ where: { email } });
  if (!admin) unauthorized('Invalid email or password');

  const ok = await bcrypt.compare(password, admin.password_hash);
  if (!ok) unauthorized('Invalid email or password');
  if (admin.status !== 'Active') unauthorized('Admin account is not active');

  // purpose: 'admin' so the same JWT can never be replayed against the
  // customer middleware. We deliberately do NOT embed permissions in the
  // JWT — requireAdmin re-fetches the admin row on every request (so a
  // permission revocation takes effect immediately without waiting for the
  // token to expire), and authorization checks read req.admin.permissions
  // from that fresh row. Embedding stale permissions here would just be a
  // footgun.
  const token = signToken({ sub: admin.admin_id, purpose: 'admin' });
  await prisma.adminSession.create({
    data: { token, admin_id: admin.admin_id, expires_at: tokenExpiry(token) },
  });
  await prisma.adminUser.update({
    where: { admin_id: admin.admin_id },
    data: { last_login: new Date() },
  });

  res.json({ data: { admin: safe(admin), token } });
}));

// GET /api/admin/me — quick "is this token still good?" check for the portal shell
router.get('/me', requireAdmin, (req, res) => {
  res.json({ data: { admin: req.admin } });
});

// PUT /api/admin/me — self-service: change own display name only.
// Role/status edits require the SuperAdmin endpoints in adminUsers.js.
router.put('/me', requireAdmin, validate(updateMeSchema), asyncHandler(async (req, res) => {
  const updated = await prisma.adminUser.update({
    where: { admin_id: req.admin.admin_id },
    data: { full_name: req.body.full_name },
  });
  res.json({ data: { admin: safe(updated) } });
}));

// PUT /api/admin/me/password — self-service password change.
// Requires current password to defend against stolen-token-but-not-password attacks.
// Other sessions for this admin are revoked so a leaked old token can't outlive the change.
router.put('/me/password', requireAdmin, validate(changeOwnPasswordSchema),
  asyncHandler(async (req, res) => {
    const me = await prisma.adminUser.findUnique({ where: { admin_id: req.admin.admin_id } });
    const ok = await bcrypt.compare(req.body.current_password, me.password_hash);
    if (!ok) unauthorized('Current password is incorrect');

    await prisma.adminUser.update({
      where: { admin_id: req.admin.admin_id },
      data: { password_hash: await bcrypt.hash(req.body.new_password, 10) },
    });
    // Keep the current session alive (the user just authenticated), kill the rest.
    await prisma.adminSession.deleteMany({
      where: { admin_id: req.admin.admin_id, NOT: { token: req.adminToken } },
    });

    res.json({ data: { ok: true } });
  }));

// POST /api/admin/logout
router.post('/logout', requireAdmin, asyncHandler(async (req, res) => {
  await prisma.adminSession.deleteMany({ where: { token: req.adminToken } });
  res.json({ data: { ok: true } });
}));

// Domain sub-routers — every endpoint under these is admin-only by virtue of
// requireAdmin running before they're mounted. Per-endpoint role checks live
// inside each sub-router.
router.use('/orders', requireAdmin, adminOrdersRouter);
router.use('/users', requireAdmin, adminUsersRouter);
router.use('/products', requireAdmin, adminProductsRouter);
router.use('/categories', requireAdmin, adminCategoriesRouter);
router.use('/coupons', requireAdmin, adminCouponsRouter);
router.use('/customers', requireAdmin, adminCustomersRouter);
router.use('/reports', requireAdmin, adminReportsRouter);
router.use('/reviews', requireAdmin, adminReviewsRouter);
router.use('/settings', requireAdmin, adminSettingsRouter);
router.use('/exports', requireAdmin, adminExportsRouter);
router.use('/uploads', requireAdmin, adminUploadsRouter);
// Credit / pay-later aggregate dashboard (BRD §6) — gated on 'reports'.
router.use('/credit', requireAdmin, adminAccountingRouter);
// Customer-wise sales + outstanding + credit limit report — gated on 'reports'.
router.use('/customer-report', requireAdmin, adminCustomerReportRouter);
// B2B-only customer extract with business-name / GSTIN filters + date-scoped
// orders count — gated on 'reports'.
router.use('/b2b-customers', requireAdmin, adminB2BCustomersRouter);

export default router;
