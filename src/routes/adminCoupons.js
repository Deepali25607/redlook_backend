// Admin coupon CRUD (BRD FR-ADM-05). Mounted at /api/admin/coupons.
//
// Coupon *redemption* lives in cart.js (preview) and orders.js (commit).
// This file is the authoring/management surface only.
//
// Delete policy: a coupon that has already been redeemed (used_count > 0) is
// historical evidence — refuse hard delete; admin must toggle is_active=false
// instead. Unused coupons can be hard-deleted.

import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { asyncHandler, validate, badRequest, notFound, conflict } from '../lib/http.js';
import { requirePermission } from '../middleware/adminAuth.js';

const router = Router();

// Match the redemption code's normalization: codes are stored upper-cased.
// Allow A-Z, 0-9, hyphen and underscore — common promo conventions.
const CODE_RE = /^[A-Z0-9_-]+$/;

const createSchema = z.object({
  code: z.string().min(3).max(30).regex(CODE_RE, 'A-Z, 0-9, hyphen and underscore only'),
  type: z.enum(['PERCENT', 'FLAT']),
  value: z.number().positive(),
  min_order: z.number().nonnegative().optional(),
  max_uses: z.number().int().positive().optional().nullable(),
  valid_from: z.string().datetime().optional().nullable(),
  valid_until: z.string().datetime().optional().nullable(),
  is_active: z.boolean().optional(),
}).superRefine((d, ctx) => {
  if (d.type === 'PERCENT' && d.value > 100) {
    ctx.addIssue({ path: ['value'], code: 'custom', message: 'Percent must be ≤ 100' });
  }
  if (d.valid_from && d.valid_until && new Date(d.valid_from) >= new Date(d.valid_until)) {
    ctx.addIssue({ path: ['valid_until'], code: 'custom', message: 'valid_until must be after valid_from' });
  }
});

const updateSchema = createSchema.innerType().partial().refine(
  (d) => Object.keys(d).length > 0,
  { message: 'No fields to update' },
);

// Compute display status from raw fields. Kept on the server so the badge
// rules stay consistent between admin UI, future reports, and any third-party
// integration that consumes this endpoint.
function deriveStatus(c, now = new Date()) {
  if (!c.is_active) return 'Inactive';
  if (c.valid_from && new Date(c.valid_from) > now) return 'Upcoming';
  if (c.valid_until && new Date(c.valid_until) < now) return 'Expired';
  if (c.max_uses != null && c.used_count >= c.max_uses) return 'Exhausted';
  return 'Active';
}

const adminView = (c) => ({
  coupon_id: c.coupon_id,
  code: c.code,
  type: c.type,
  value: Number(c.value),
  min_order: Number(c.min_order),
  max_uses: c.max_uses,
  used_count: c.used_count,
  valid_from: c.valid_from,
  valid_until: c.valid_until,
  is_active: c.is_active,
  status: deriveStatus(c),
});

const audit = (data) => prisma.auditLog.create({ data })
  .catch((err) => console.error('[audit] failed:', err.message));

// ---------------------------------------------------------------
// GET /api/admin/coupons — list (filters: q, type, status)
// status filter is computed in JS because deriveStatus depends on multiple
// fields; for the data we expect (~hundreds of coupons) this is fine.
// ---------------------------------------------------------------
router.get('/', requirePermission('coupons'), asyncHandler(async (req, res) => {
  const where = {};
  if (req.query.q) where.code = { contains: String(req.query.q).toUpperCase() };
  if (req.query.type) where.type = String(req.query.type);

  const rows = await prisma.coupon.findMany({ where, orderBy: { valid_from: 'desc' } });
  const enriched = rows.map(adminView);
  const filtered = req.query.status
    ? enriched.filter((c) => c.status === String(req.query.status))
    : enriched;

  res.json({
    data: filtered,
    summary: {
      total: enriched.length,
      active: enriched.filter((c) => c.status === 'Active').length,
      expired: enriched.filter((c) => c.status === 'Expired').length,
      exhausted: enriched.filter((c) => c.status === 'Exhausted').length,
    },
  });
}));

// ---------------------------------------------------------------
// POST /api/admin/coupons — create
// ---------------------------------------------------------------
router.post('/', requirePermission('coupons'), validate(createSchema),
  asyncHandler(async (req, res) => {
    const code = req.body.code.toUpperCase();
    const existing = await prisma.coupon.findUnique({ where: { code } });
    if (existing) conflict(`Coupon code '${code}' is already in use`);

    const created = await prisma.coupon.create({
      data: {
        code,
        type: req.body.type,
        value: req.body.value,
        min_order: req.body.min_order ?? 0,
        max_uses: req.body.max_uses ?? null,
        valid_from: req.body.valid_from ? new Date(req.body.valid_from) : new Date(),
        valid_until: req.body.valid_until ? new Date(req.body.valid_until) : null,
        is_active: req.body.is_active ?? true,
      },
    });

    audit({
      action: 'admin.coupon.create',
      meta: { coupon_id: created.coupon_id, code: created.code, type: created.type, value: Number(created.value),
        by_admin_id: req.admin.admin_id, by_admin_email: req.admin.email },
      ip: req.ip,
    });

    res.status(201).json({ data: adminView(created) });
  }));

// ---------------------------------------------------------------
// PUT /api/admin/coupons/:id — update (any subset; code editable but unique)
// ---------------------------------------------------------------
router.put('/:id', requirePermission('coupons'), validate(updateSchema),
  asyncHandler(async (req, res) => {
    const existing = await prisma.coupon.findUnique({ where: { coupon_id: req.params.id } });
    if (!existing) notFound('Coupon not found');

    const data = { ...req.body };
    if (data.code) {
      data.code = data.code.toUpperCase();
      if (data.code !== existing.code) {
        const collision = await prisma.coupon.findUnique({ where: { code: data.code } });
        if (collision) conflict(`Coupon code '${data.code}' is already in use`);
      }
    }
    if (data.valid_from !== undefined) data.valid_from = data.valid_from ? new Date(data.valid_from) : new Date();
    if (data.valid_until !== undefined) data.valid_until = data.valid_until ? new Date(data.valid_until) : null;

    const updated = await prisma.coupon.update({
      where: { coupon_id: req.params.id },
      data,
    });

    audit({
      action: 'admin.coupon.update',
      meta: { coupon_id: updated.coupon_id, code: updated.code, changes: req.body,
        by_admin_id: req.admin.admin_id, by_admin_email: req.admin.email },
      ip: req.ip,
    });

    res.json({ data: adminView(updated) });
  }));

// ---------------------------------------------------------------
// DELETE /api/admin/coupons/:id — hard delete only when unused.
// Used coupons must be retired by setting is_active=false (PUT) so the
// historical audit trail of "what discounts were issued" stays intact.
// ---------------------------------------------------------------
router.delete('/:id', requirePermission('coupons'), asyncHandler(async (req, res) => {
  const existing = await prisma.coupon.findUnique({ where: { coupon_id: req.params.id } });
  if (!existing) notFound('Coupon not found');

  if (existing.used_count > 0) {
    badRequest(`Cannot delete '${existing.code}' — it has been redeemed ${existing.used_count} time(s). Set it Inactive instead.`);
  }

  await prisma.coupon.delete({ where: { coupon_id: req.params.id } });

  audit({
    action: 'admin.coupon.delete',
    meta: { coupon_id: req.params.id, code: existing.code,
      by_admin_id: req.admin.admin_id, by_admin_email: req.admin.email },
    ip: req.ip,
  });

  res.json({ data: { ok: true } });
}));

export default router;
