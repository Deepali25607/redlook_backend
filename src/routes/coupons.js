// Customer-facing coupon validation. The single endpoint here lets the
// checkout page tell the customer "valid / invalid / already used" the
// moment they hit Apply, instead of waiting until Place Order.
//
// The authoritative check still runs again inside the order-placement
// transaction in routes/orders.js (with the unique index as the final
// gate). This endpoint intentionally mirrors that logic so previewed and
// applied discounts cannot diverge.

import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler, validate, badRequest } from '../lib/http.js';

const router = Router();

const validateSchema = z.object({
  code: z.string().min(1).max(30),
  subtotal: z.number().min(0),
});

router.post('/validate', requireAuth, validate(validateSchema), asyncHandler(async (req, res) => {
  const code = req.body.code.trim().toUpperCase();
  const c = await prisma.coupon.findUnique({ where: { code } });
  if (!c) badRequest('Invalid coupon');
  if (!c.is_active) badRequest('Coupon is no longer active');
  if (c.valid_until && c.valid_until < new Date()) badRequest('Coupon has expired');
  if (Number(c.min_order) > req.body.subtotal) {
    badRequest(`Coupon needs minimum order ₹${Number(c.min_order)}`);
  }
  if (c.max_uses && c.used_count >= c.max_uses) badRequest('Coupon usage limit reached');

  // Per-customer once gate. Same lookup as order placement so the messaging
  // matches what the customer would have seen at Place Order time.
  const prior = await prisma.couponRedemption.findUnique({
    where: { coupon_id_customer_id: { coupon_id: c.coupon_id, customer_id: req.user.customer_id } },
  });
  if (prior) badRequest('You have already used this coupon');

  const discount = c.type === 'PERCENT'
    ? Math.round(req.body.subtotal * (Number(c.value) / 100))
    : Math.min(Number(c.value), req.body.subtotal);

  res.json({
    data: {
      code: c.code,
      type: c.type,
      value: Number(c.value),
      discount,
    },
  });
}));

export default router;
