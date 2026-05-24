// Customer-facing product reviews (BRD FR-PROD-06).
// Mounted at /api/products/:id/reviews from products.js using mergeParams,
// so handlers see the product id as req.params.id.
//
// Eligibility (BRD: "Customers can rate and review purchased products"):
// the customer must have at least one order containing this product whose
// order_status is 'Delivered'. We don't relax this for Cancelled/Returned —
// you can only review what was actually delivered.
//
// Uniqueness: (product_id, customer_id) is unique in the schema, so each
// customer has at most one review per product. PUT is upsert, so editing
// is "submit again with the new rating/comment".

import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler, validate, badRequest, forbidden, notFound } from '../lib/http.js';

const router = Router({ mergeParams: true });

const reviewSchema = z.object({
  rating: z.number().int().min(1).max(5),
  comment: z.string().max(2000).optional().nullable(),
});

// Recompute the product's aggregate rating + reviews_count from the Review
// table. Called on every write so the customer-facing /api/products/:id
// stays consistent with what's actually stored. Uses the supplied tx so
// the aggregate update commits with the review write.
async function refreshProductAggregate(tx, productId) {
  const agg = await tx.review.aggregate({
    where: { product_id: productId },
    _avg: { rating: true },
    _count: { _all: true },
  });
  await tx.product.update({
    where: { product_id: productId },
    data: {
      rating: agg._avg.rating ?? 0,
      reviews_count: agg._count._all,
    },
  });
}

// Eligibility check — stays strict (only Delivered status counts).
async function canReview(customerId, productId) {
  const ord = await prisma.order.findFirst({
    where: {
      customer_id: customerId,
      order_status: 'Delivered',
      items: { some: { product_id: productId } },
    },
    select: { order_id: true },
  });
  return !!ord;
}

// ---------------------------------------------------------------
// GET /api/products/:id/reviews — public, paginated
// Includes customer name (first name + last initial) so reviews feel real
// without leaking the full identity.
// ---------------------------------------------------------------
router.get('/', asyncHandler(async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 10));
  const skip = (page - 1) * limit;

  const [total, rows] = await Promise.all([
    prisma.review.count({ where: { product_id: req.params.id } }),
    prisma.review.findMany({
      where: { product_id: req.params.id },
      include: { customer: { select: { full_name: true } } },
      orderBy: { created_at: 'desc' },
      skip,
      take: limit,
    }),
  ]);

  // First name + last-name initial — "Deepali G."
  const displayName = (full) => {
    if (!full) return 'Anonymous';
    const parts = full.trim().split(/\s+/);
    if (parts.length === 1) return parts[0];
    return `${parts[0]} ${parts[parts.length - 1][0]}.`;
  };

  res.json({
    data: rows.map((r) => ({
      review_id: r.review_id,
      rating: r.rating,
      comment: r.comment,
      created_at: r.created_at,
      customer_name: displayName(r.customer?.full_name),
    })),
    meta: { page, limit, total, totalPages: Math.ceil(total / limit) || 1 },
  });
}));

// ---------------------------------------------------------------
// GET /api/products/:id/reviews/me — the calling customer's own review
// (so the UI can show "you rated this 4 stars" + an Edit button)
// ---------------------------------------------------------------
router.get('/me', requireAuth, asyncHandler(async (req, res) => {
  const review = await prisma.review.findUnique({
    where: { product_id_customer_id: { product_id: req.params.id, customer_id: req.user.customer_id } },
  });
  // Also report eligibility so the form can decide whether to render at all.
  const eligible = review ? true : await canReview(req.user.customer_id, req.params.id);
  res.json({ data: { review, eligible } });
}));

// ---------------------------------------------------------------
// PUT /api/products/:id/reviews — upsert my review (create or update)
// ---------------------------------------------------------------
router.put('/', requireAuth, validate(reviewSchema), asyncHandler(async (req, res) => {
  const product = await prisma.product.findUnique({ where: { product_id: req.params.id } });
  if (!product) notFound('Product not found');

  const eligible = await canReview(req.user.customer_id, req.params.id);
  if (!eligible) forbidden('You can review a product only after it has been delivered to you');

  const review = await prisma.$transaction(async (tx) => {
    const r = await tx.review.upsert({
      where: { product_id_customer_id: { product_id: req.params.id, customer_id: req.user.customer_id } },
      create: {
        product_id: req.params.id,
        customer_id: req.user.customer_id,
        rating: req.body.rating,
        comment: req.body.comment ?? null,
      },
      update: {
        rating: req.body.rating,
        comment: req.body.comment ?? null,
      },
    });
    await refreshProductAggregate(tx, req.params.id);
    return r;
  });

  res.json({ data: review });
}));

// ---------------------------------------------------------------
// DELETE /api/products/:id/reviews — delete my own review
// ---------------------------------------------------------------
router.delete('/', requireAuth, asyncHandler(async (req, res) => {
  const existing = await prisma.review.findUnique({
    where: { product_id_customer_id: { product_id: req.params.id, customer_id: req.user.customer_id } },
  });
  if (!existing) notFound('You have not reviewed this product');

  await prisma.$transaction(async (tx) => {
    await tx.review.delete({ where: { review_id: existing.review_id } });
    await refreshProductAggregate(tx, req.params.id);
  });

  res.json({ data: { ok: true } });
}));

export default router;
