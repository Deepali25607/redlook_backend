// BRD §11.4 Cart APIs — server-side persistent cart per customer (FR-CART-03)
// The Phase 1 frontend uses client-side cart for UX speed; these endpoints exist
// so the contract is complete and Phase 3+ can switch over without backend work.
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler, validate, badRequest, notFound } from '../lib/http.js';
import { serializeProduct } from '../lib/serialize.js';
import { resolveProductPrice } from '../lib/pricing.js';
import { resolveLocale } from '../lib/i18n.js';

const router = Router();
router.use(requireAuth);

const addItemSchema = z.object({
  product_id: z.string().min(1),
  qty: z.number().positive(),
});
const updateItemSchema = z.object({ qty: z.number().nonnegative() });
const couponSchema = z.object({ code: z.string().min(1) });

async function getOrCreateCart(customerId) {
  return prisma.cart.upsert({
    where: { customer_id: customerId },
    update: {},
    create: { customer_id: customerId },
    // Category include is required so the pricing resolver can apply
    // category-level discounts to each line.
    include: { items: { include: { product: { include: { category: true } } } } },
  });
}

async function loadSettings() {
  return prisma.businessSettings.upsert({
    where: { id: 1 },
    update: {},
    create: { id: 1 },
  });
}

function serializeCart(cart, settings, locale) {
  const items = cart.items.map((ci) => {
    const { price } = resolveProductPrice(ci.product, ci.product.category, settings);
    return {
      cart_item_id: ci.cart_item_id,
      qty: Number(ci.qty),
      product: serializeProduct(ci.product, settings, locale),
      line_total: Number(ci.qty) * price,
    };
  });
  const subtotal = items.reduce((s, i) => s + i.line_total, 0);
  return { cart_id: cart.cart_id, items, subtotal };
}

// GET /api/cart
router.get('/', asyncHandler(async (req, res) => {
  const [cart, settings] = await Promise.all([
    getOrCreateCart(req.user.customer_id),
    loadSettings(),
  ]);
  res.json({ data: serializeCart(cart, settings, resolveLocale(req)) });
}));

// POST /api/cart/items
router.post('/items', validate(addItemSchema), asyncHandler(async (req, res) => {
  const { product_id, qty } = req.body;
  const product = await prisma.product.findUnique({ where: { product_id } });
  if (!product) notFound('Product not found');
  if (Number(product.stock_quantity) < qty) badRequest('Insufficient stock');

  const cart = await getOrCreateCart(req.user.customer_id);
  await prisma.cartItem.upsert({
    where: { cart_id_product_id: { cart_id: cart.cart_id, product_id } },
    update: { qty: { increment: qty } },
    create: { cart_id: cart.cart_id, product_id, qty },
  });
  const [updated, settings] = await Promise.all([
    getOrCreateCart(req.user.customer_id),
    loadSettings(),
  ]);
  res.json({ data: serializeCart(updated, settings, resolveLocale(req)) });
}));

// PUT /api/cart/items/{id}  body: { qty } — qty=0 deletes
router.put('/items/:id', validate(updateItemSchema), asyncHandler(async (req, res) => {
  const cart = await getOrCreateCart(req.user.customer_id);
  const item = await prisma.cartItem.findUnique({ where: { cart_item_id: req.params.id } });
  if (!item || item.cart_id !== cart.cart_id) notFound('Cart item not found');

  if (req.body.qty === 0) {
    await prisma.cartItem.delete({ where: { cart_item_id: req.params.id } });
  } else {
    await prisma.cartItem.update({ where: { cart_item_id: req.params.id }, data: { qty: req.body.qty } });
  }
  const [updated, settings] = await Promise.all([
    getOrCreateCart(req.user.customer_id),
    loadSettings(),
  ]);
  res.json({ data: serializeCart(updated, settings, resolveLocale(req)) });
}));

// DELETE /api/cart/items/{id}
router.delete('/items/:id', asyncHandler(async (req, res) => {
  const cart = await getOrCreateCart(req.user.customer_id);
  const item = await prisma.cartItem.findUnique({ where: { cart_item_id: req.params.id } });
  if (!item || item.cart_id !== cart.cart_id) notFound('Cart item not found');
  await prisma.cartItem.delete({ where: { cart_item_id: req.params.id } });
  const [updated, settings] = await Promise.all([
    getOrCreateCart(req.user.customer_id),
    loadSettings(),
  ]);
  res.json({ data: serializeCart(updated, settings, resolveLocale(req)) });
}));

// POST /api/cart/apply-coupon — preview discount without committing (commits at order placement)
router.post('/apply-coupon', validate(couponSchema), asyncHandler(async (req, res) => {
  const [cart, settings] = await Promise.all([
    getOrCreateCart(req.user.customer_id),
    loadSettings(),
  ]);
  const subtotal = serializeCart(cart, settings).subtotal;
  const c = await prisma.coupon.findUnique({ where: { code: req.body.code.toUpperCase() } });
  if (!c || !c.is_active) badRequest('Invalid coupon');
  if (c.valid_until && c.valid_until < new Date()) badRequest('Coupon has expired');
  if (Number(c.min_order) > subtotal) badRequest(`Coupon needs min order ₹${c.min_order}`);
  const discount = c.type === 'PERCENT'
    ? Math.round(subtotal * (Number(c.value) / 100))
    : Math.min(Number(c.value), subtotal);
  res.json({ data: { code: c.code, type: c.type, value: Number(c.value), discount } });
}));

export default router;
