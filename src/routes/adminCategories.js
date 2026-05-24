// Admin category CRUD (BRD FR-ADM-01). Mounted at /api/admin/categories.
//
// Categories use human-readable IDs (slugs) — both the seed and the existing
// data follow this convention (leafy, root, exotic…). The admin UI lets the
// user supply a slug; if omitted we auto-generate from the name.

import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { asyncHandler, validate, badRequest, notFound, conflict } from '../lib/http.js';
import { requirePermission, getAdminCategoryScope, isCategoryInScope, categoryScopeWhere } from '../middleware/adminAuth.js';

const router = Router();

// Slug = lowercase, alphanumerics + hyphens. Used both as user-facing
// validation and as fallback when category_id is omitted on create.
const SLUG_RE = /^[a-z0-9-]+$/;

const createSchema = z.object({
  category_id: z.string().regex(SLUG_RE, 'lowercase letters, digits and hyphens only').max(40).optional(),
  name: z.string().min(2).max(50),
  icon: z.string().min(1).max(10),
  parent_category_id: z.string().optional().nullable(),
  // Group-level markdown (0-100). Applied to every product in the category;
  // combined with per-product and platform-wide discounts via the pricing
  // resolver — largest wins.
  discount_percent: z.number().min(0).max(100).optional(),
  // Per-field translations (Phase 2 i18n). Shape: { name: { hi, bn } }.
  // Empty strings fall back to the canonical English column.
  translations: z.record(z.record(z.string())).optional().nullable(),
});

const updateSchema = z.object({
  name: z.string().min(2).max(50).optional(),
  icon: z.string().min(1).max(10).optional(),
  parent_category_id: z.string().optional().nullable(),
  discount_percent: z.number().min(0).max(100).optional(),
  translations: z.record(z.record(z.string())).optional().nullable(),
}).refine((d) => Object.keys(d).length > 0, { message: 'No fields to update' });

const slugify = (s) => s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

const audit = (data) => prisma.auditLog.create({ data })
  .catch((err) => console.error('[audit] failed:', err.message));

// ---------------------------------------------------------------
// GET /api/admin/categories — list with product counts so the master view
// can show "10 products" / "warn before delete".
// ---------------------------------------------------------------
router.get('/', requirePermission('categories'), asyncHandler(async (req, res) => {
  const cats = await prisma.category.findMany({
    where: categoryScopeWhere(req.admin),
    orderBy: { name: 'asc' },
    include: { _count: { select: { products: true } } },
  });
  res.json({
    data: cats.map((c) => ({
      category_id: c.category_id,
      name: c.name,
      icon: c.icon,
      parent_category_id: c.parent_category_id,
      discount_percent: Number(c.discount_percent ?? 0),
      product_count: c._count.products,
      // Phase 2 i18n — admin form pre-fills the per-language inputs from here.
      translations: c.translations || {},
    })),
  });
}));

// ---------------------------------------------------------------
// POST /api/admin/categories — create
// ---------------------------------------------------------------
router.post('/', requirePermission('categories'), validate(createSchema),
  asyncHandler(async (req, res) => {
    // Scoped admins can't create new categories — a freshly-created row
    // wouldn't be in their whitelist, so they'd be locked out of it
    // immediately. Ask a super-admin (unrestricted) to add it.
    if (getAdminCategoryScope(req.admin) !== null) {
      return res.status(403).json({ error: 'Scoped admins cannot create new categories — ask a super-admin' });
    }

    const id = req.body.category_id?.trim() || slugify(req.body.name);
    if (!id || !SLUG_RE.test(id)) badRequest('Could not derive a valid slug from the name; provide category_id explicitly');

    const existing = await prisma.category.findUnique({ where: { category_id: id } });
    if (existing) conflict(`Category '${id}' already exists`);

    if (req.body.parent_category_id) {
      const parent = await prisma.category.findUnique({ where: { category_id: req.body.parent_category_id } });
      if (!parent) badRequest(`Parent category '${req.body.parent_category_id}' does not exist`);
    }

    const created = await prisma.category.create({
      data: {
        category_id: id,
        name: req.body.name,
        icon: req.body.icon,
        parent_category_id: req.body.parent_category_id || null,
        discount_percent: req.body.discount_percent ?? 0,
        translations: req.body.translations ?? null,
      },
    });

    audit({
      action: 'admin.category.create',
      meta: { category_id: created.category_id, name: created.name, by_admin_id: req.admin.admin_id, by_admin_email: req.admin.email },
      ip: req.ip,
    });

    res.status(201).json({
      data: {
        ...created,
        discount_percent: Number(created.discount_percent ?? 0),
        translations: created.translations || {},
        product_count: 0,
      },
    });
  }));

// ---------------------------------------------------------------
// PUT /api/admin/categories/:id — update name/icon/parent (slug is immutable)
// ---------------------------------------------------------------
router.put('/:id', requirePermission('categories'), validate(updateSchema),
  asyncHandler(async (req, res) => {
    const existing = await prisma.category.findUnique({ where: { category_id: req.params.id } });
    if (!existing) notFound('Category not found');
    if (!isCategoryInScope(req.admin, req.params.id)) {
      return res.status(403).json({ error: `Your account is not permitted to manage category '${req.params.id}'` });
    }

    if (req.body.parent_category_id) {
      if (req.body.parent_category_id === req.params.id) badRequest('Category cannot be its own parent');
      const parent = await prisma.category.findUnique({ where: { category_id: req.body.parent_category_id } });
      if (!parent) badRequest(`Parent category '${req.body.parent_category_id}' does not exist`);
    }

    const updated = await prisma.category.update({
      where: { category_id: req.params.id },
      data: req.body,
      include: { _count: { select: { products: true } } },
    });

    audit({
      action: 'admin.category.update',
      meta: { category_id: updated.category_id, changes: req.body, by_admin_id: req.admin.admin_id, by_admin_email: req.admin.email },
      ip: req.ip,
    });

    res.json({
      data: {
        category_id: updated.category_id,
        name: updated.name,
        icon: updated.icon,
        parent_category_id: updated.parent_category_id,
        discount_percent: Number(updated.discount_percent ?? 0),
        translations: updated.translations || {},
        product_count: updated._count.products,
      },
    });
  }));

// ---------------------------------------------------------------
// DELETE /api/admin/categories/:id — refuse if products reference it.
// Categories aren't soft-deletable (no status field), so this is a hard
// delete; the safety guard ensures we never break a product's FK.
// ---------------------------------------------------------------
router.delete('/:id', requirePermission('categories'), asyncHandler(async (req, res) => {
  const existing = await prisma.category.findUnique({
    where: { category_id: req.params.id },
    include: { _count: { select: { products: true } } },
  });
  if (!existing) notFound('Category not found');
  if (!isCategoryInScope(req.admin, req.params.id)) {
    return res.status(403).json({ error: `Your account is not permitted to manage category '${req.params.id}'` });
  }
  if (existing._count.products > 0) {
    conflict(`Cannot delete '${existing.name}': ${existing._count.products} product(s) still reference it. Reassign or disable those products first.`);
  }

  await prisma.category.delete({ where: { category_id: req.params.id } });

  audit({
    action: 'admin.category.delete',
    meta: { category_id: req.params.id, name: existing.name, by_admin_id: req.admin.admin_id, by_admin_email: req.admin.email },
    ip: req.ip,
  });

  res.json({ data: { ok: true } });
}));

export default router;
