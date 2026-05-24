// Admin review moderation (BRD FR-PROD-06 + admin oversight).
// Mounted at /api/admin/reviews. requireAdmin runs at the parent.
//
// Read access: all 3 roles (Support reps look at reviews to investigate
// complaints). Write access (delete) = Super + Operations.
//
// Delete flow refreshes the product's rating/reviews_count aggregate so a
// removed bad-faith review immediately stops dragging down the public score.

import { Router } from 'express';
import { prisma } from '../lib/prisma.js';
import { asyncHandler, notFound } from '../lib/http.js';
import { requirePermission } from '../middleware/adminAuth.js';

const router = Router();

const audit = (data) => prisma.auditLog.create({ data })
  .catch((err) => console.error('[audit] failed:', err.message));

async function refreshProductAggregate(tx, productId) {
  const agg = await tx.review.aggregate({
    where: { product_id: productId },
    _avg: { rating: true },
    _count: { _all: true },
  });
  await tx.product.update({
    where: { product_id: productId },
    data: { rating: agg._avg.rating ?? 0, reviews_count: agg._count._all },
  });
}

// ---------------------------------------------------------------
// GET /api/admin/reviews — list with filters: q (in comment), product_id,
// rating, customer_email; paginated. Always returns customer + product
// names so the moderation list is readable without per-row joins.
// ---------------------------------------------------------------
router.get('/', requirePermission('reviews'), asyncHandler(async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
  const skip = (page - 1) * limit;

  const where = {};
  if (req.query.product_id) where.product_id = String(req.query.product_id);
  if (req.query.rating) where.rating = Number(req.query.rating);
  if (req.query.q) where.comment = { contains: String(req.query.q), mode: 'insensitive' };
  if (req.query.customer_email) {
    const matches = await prisma.customer.findMany({
      where: { email: { contains: String(req.query.customer_email), mode: 'insensitive' } },
      select: { customer_id: true },
      take: 500,
    });
    where.customer_id = { in: matches.map((m) => m.customer_id) };
  }

  const [total, rows, ratingGroups] = await Promise.all([
    prisma.review.count({ where }),
    prisma.review.findMany({
      where,
      include: {
        customer: { select: { full_name: true, email: true } },
        product: { select: { name: true, image: true } },
      },
      orderBy: { created_at: 'desc' },
      skip,
      take: limit,
    }),
    // Rating distribution across ALL reviews (filter-independent) so the
    // moderation header always reflects the platform-wide picture.
    prisma.review.groupBy({ by: ['rating'], _count: { rating: true } }),
  ]);

  const distribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  for (const g of ratingGroups) distribution[g.rating] = g._count.rating;

  res.json({
    data: rows.map((r) => ({
      review_id: r.review_id,
      product_id: r.product_id,
      product_name: r.product?.name,
      product_image: r.product?.image,
      customer_id: r.customer_id,
      customer_name: r.customer?.full_name,
      customer_email: r.customer?.email,
      rating: r.rating,
      comment: r.comment,
      created_at: r.created_at,
    })),
    meta: { page, limit, total, totalPages: Math.ceil(total / limit) || 1 },
    summary: {
      total: Object.values(distribution).reduce((s, n) => s + n, 0),
      distribution,
      avg_rating: rows.length === 0
        ? 0
        : Object.entries(distribution).reduce((sum, [r, n]) => sum + Number(r) * n, 0) /
          Math.max(1, Object.values(distribution).reduce((s, n) => s + n, 0)),
    },
  });
}));

// ---------------------------------------------------------------
// DELETE /api/admin/reviews/:id — moderation delete. Refreshes the
// product aggregate so the public score updates immediately.
// ---------------------------------------------------------------
router.delete('/:id', requirePermission('reviews'), asyncHandler(async (req, res) => {
  const existing = await prisma.review.findUnique({ where: { review_id: req.params.id } });
  if (!existing) notFound('Review not found');

  await prisma.$transaction(async (tx) => {
    await tx.review.delete({ where: { review_id: req.params.id } });
    await refreshProductAggregate(tx, existing.product_id);
  });

  audit({
    customer_id: existing.customer_id,
    action: 'admin.review.delete',
    meta: {
      review_id: req.params.id,
      product_id: existing.product_id,
      rating: existing.rating,
      by_admin_id: req.admin.admin_id,
      by_admin_email: req.admin.email,
    },
    ip: req.ip,
  });

  res.json({ data: { ok: true } });
}));

export default router;
