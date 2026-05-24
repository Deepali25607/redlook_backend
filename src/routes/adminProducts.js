// Admin product CRUD (BRD FR-ADM-01) + inventory monitoring (FR-ADM-03).
// Mounted at /api/admin/products. requireAdmin runs at the parent.
//
// Read access: all three roles (Super / Operations / Support).
// Write access: Super + Operations only.
//
// Soft delete: DELETE flips status to 'Inactive' so the customer-facing
// /api/products endpoint stops returning it but historical orders still
// resolve their FK joins. Hard delete is intentionally not exposed.

import { Router } from 'express';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { prisma } from '../lib/prisma.js';
import { asyncHandler, validate, badRequest, notFound, conflict } from '../lib/http.js';
import { requirePermission, scopeWhere, isCategoryInScope, getAdminCategoryScope } from '../middleware/adminAuth.js';

const router = Router();

const createSchema = z.object({
  name: z.string().min(2).max(100),
  category_id: z.string().min(1),
  description: z.string().max(2000).optional().nullable(),
  price_per_unit: z.number().positive(),
  unit: z.string().min(1).max(10),
  stock_quantity: z.number().nonnegative(),
  is_organic: z.boolean().optional(),
  image: z.string().min(1).max(500),
  freshness: z.string().max(50).optional().nullable(),
  status: z.enum(['Active', 'Inactive']).optional(),
  // Per-product return eligibility. Defaults to true (everything returnable)
  // server-side via the schema column default; admins can toggle per SKU.
  is_returnable: z.boolean().optional(),
  // Per-SKU markdown (0-100). Combined with category and platform-wide
  // discounts in the pricing resolver — largest wins. 0 = no product-level
  // markdown; that is the default for new SKUs.
  discount_percent: z.number().min(0).max(100).optional(),
  // Per-field translations (Phase 2 i18n). Shape:
  //   { name: { hi: "…", bn: "…" }, description: { hi, bn }, freshness: { hi, bn } }
  // Empty strings are accepted — they signal "no translation" and the
  // public serializer falls back to the canonical English column.
  translations: z.record(z.record(z.string())).optional().nullable(),
});

const updateSchema = createSchema.partial().refine(
  (d) => Object.keys(d).length > 0,
  { message: 'No fields to update' },
);

// Admin view is richer than the customer-facing serializer — exposes
// status, created_at, and the joined category name in one call.
const adminView = (p) => ({
  product_id: p.product_id,
  name: p.name,
  category_id: p.category_id,
  category_name: p.category?.name || null,
  description: p.description,
  price_per_unit: Number(p.price_per_unit),
  unit: p.unit,
  stock_quantity: Number(p.stock_quantity),
  is_organic: p.is_organic,
  image: p.image,
  rating: Number(p.rating),
  reviews_count: p.reviews_count,
  freshness: p.freshness,
  status: p.status,
  is_returnable: p.is_returnable,
  discount_percent: Number(p.discount_percent ?? 0),
  category_discount_percent: Number(p.category?.discount_percent ?? 0),
  // Phase 2 i18n — per-field Hindi/Bengali overlays. Admin form reads this
  // to pre-fill the per-language inputs on edit.
  translations: p.translations || {},
  created_at: p.created_at,
});

const audit = (data) => prisma.auditLog.create({ data })
  .catch((err) => console.error('[audit] failed:', err.message));

// ---------------------------------------------------------------
// GET /api/admin/products — list with filters + paginate + low-stock summary
//   ?q=&category=&status=&organic=true|false&lowStock=true&threshold=10&page=&limit=
// summary.lowStockCount/outOfStockCount are computed independent of the
// current filter so the dashboard cards stay accurate while the table
// shows a narrowed view.
// ---------------------------------------------------------------
router.get('/', requirePermission('products'), asyncHandler(async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
  const threshold = Math.max(1, parseInt(req.query.threshold, 10) || 10);
  const skip = (page - 1) * limit;

  const scope = getAdminCategoryScope(req.admin);
  // Filter-by-category from the UI: if the requested category is out of the
  // admin's scope, short-circuit to an empty result so we don't accidentally
  // ignore the user's filter when merging with the scope clause below.
  if (req.query.category && scope && !scope.includes(String(req.query.category))) {
    return res.json({
      data: [],
      meta: { page, limit, total: 0, totalPages: 1 },
      summary: { lowStockCount: 0, outOfStockCount: 0, totalActive: 0, threshold },
    });
  }

  const where = { ...scopeWhere(req.admin) };
  if (req.query.category) where.category_id = String(req.query.category);
  if (req.query.status) where.status = String(req.query.status);
  if (req.query.organic === 'true') where.is_organic = true;
  else if (req.query.organic === 'false') where.is_organic = false;
  if (req.query.q) where.name = { contains: String(req.query.q), mode: 'insensitive' };
  // outOfStock takes precedence — frontend sends one or the other, never both.
  // Excluding zero from "low stock" matches summary.lowStockCount semantics so
  // the dashboard counts and the filtered table stay coherent.
  if (req.query.outOfStock === 'true') where.stock_quantity = 0;
  else if (req.query.lowStock === 'true') where.stock_quantity = { lte: threshold, gt: 0 };

  const scopeFilter = scopeWhere(req.admin);
  const [total, rows, lowStockCount, outOfStockCount, totalActive] = await Promise.all([
    prisma.product.count({ where }),
    prisma.product.findMany({
      where,
      include: { category: true },
      orderBy: { created_at: 'desc' },
      skip,
      take: limit,
    }),
    prisma.product.count({ where: { ...scopeFilter, stock_quantity: { lte: threshold, gt: 0 }, status: 'Active' } }),
    prisma.product.count({ where: { ...scopeFilter, stock_quantity: 0, status: 'Active' } }),
    prisma.product.count({ where: { ...scopeFilter, status: 'Active' } }),
  ]);

  res.json({
    data: rows.map(adminView),
    meta: { page, limit, total, totalPages: Math.ceil(total / limit) || 1 },
    summary: { lowStockCount, outOfStockCount, totalActive, threshold },
  });
}));

// ---------------------------------------------------------------
// POST /api/admin/products — create
// ---------------------------------------------------------------
router.post('/', requirePermission('products'), validate(createSchema),
  asyncHandler(async (req, res) => {
    // Verify category exists — Prisma would throw P2003 anyway, but a
    // friendlier 400 saves the admin a round-trip to the schema docs.
    const cat = await prisma.category.findUnique({ where: { category_id: req.body.category_id } });
    if (!cat) badRequest(`Category '${req.body.category_id}' does not exist`);
    if (!isCategoryInScope(req.admin, req.body.category_id)) {
      return res.status(403).json({ error: `Your account is not permitted to manage products in category '${req.body.category_id}'` });
    }

    const created = await prisma.product.create({
      data: { ...req.body, product_id: randomUUID() },
      include: { category: true },
    });

    audit({
      action: 'admin.product.create',
      meta: {
        product_id: created.product_id,
        name: created.name,
        by_admin_id: req.admin.admin_id,
        by_admin_email: req.admin.email,
      },
      ip: req.ip,
    });

    res.status(201).json({ data: adminView(created) });
  }));

// ---------------------------------------------------------------
// PUT /api/admin/products/:id — update any subset of fields
// ---------------------------------------------------------------
router.put('/:id', requirePermission('products'), validate(updateSchema),
  asyncHandler(async (req, res) => {
    const existing = await prisma.product.findUnique({ where: { product_id: req.params.id } });
    if (!existing) notFound('Product not found');

    // Scoped admin can only touch products whose CURRENT category is in scope.
    if (!isCategoryInScope(req.admin, existing.category_id)) {
      return res.status(403).json({ error: `Your account is not permitted to manage products in category '${existing.category_id}'` });
    }

    if (req.body.category_id && req.body.category_id !== existing.category_id) {
      const cat = await prisma.category.findUnique({ where: { category_id: req.body.category_id } });
      if (!cat) badRequest(`Category '${req.body.category_id}' does not exist`);
      // And cannot reassign a product to a category outside their scope —
      // otherwise they'd lose visibility of their own write.
      if (!isCategoryInScope(req.admin, req.body.category_id)) {
        return res.status(403).json({ error: `Your account is not permitted to move products into category '${req.body.category_id}'` });
      }
    }

    const updated = await prisma.product.update({
      where: { product_id: req.params.id },
      data: req.body,
      include: { category: true },
    });

    audit({
      action: 'admin.product.update',
      meta: {
        product_id: updated.product_id,
        changes: req.body,
        by_admin_id: req.admin.admin_id,
        by_admin_email: req.admin.email,
      },
      ip: req.ip,
    });

    res.json({ data: adminView(updated) });
  }));

// ---------------------------------------------------------------
// DELETE /api/admin/products/:id — soft-disable (status='Inactive')
// ---------------------------------------------------------------
router.delete('/:id', requirePermission('products'), asyncHandler(async (req, res) => {
  const existing = await prisma.product.findUnique({ where: { product_id: req.params.id } });
  if (!existing) notFound('Product not found');
  if (!isCategoryInScope(req.admin, existing.category_id)) {
    return res.status(403).json({ error: `Your account is not permitted to manage products in category '${existing.category_id}'` });
  }

  const updated = await prisma.product.update({
    where: { product_id: req.params.id },
    data: { status: 'Inactive' },
    include: { category: true },
  });

  audit({
    action: 'admin.product.disable',
    meta: {
      product_id: updated.product_id,
      name: updated.name,
      by_admin_id: req.admin.admin_id,
      by_admin_email: req.admin.email,
    },
    ip: req.ip,
  });

  res.json({ data: adminView(updated) });
}));

export default router;
