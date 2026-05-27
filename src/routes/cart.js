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
  // Required when the product has 1+ active variants; ignored when
  // it doesn't. The route enforces both branches and returns 400 if
  // the customer tries to add a multi-variant product without picking
  // a colour, or picks a colour that belongs to a different product.
  variant_id: z.string().min(1).optional(),
  qty: z.number().positive(),
});
const updateItemSchema = z.object({ qty: z.number().nonnegative() });
const couponSchema = z.object({ code: z.string().min(1) });

async function getOrCreateCart(customerId) {
  return prisma.cart.upsert({
    where: { customer_id: customerId },
    update: {},
    create: { customer_id: customerId },
    // Category is required so the pricing resolver can apply category-
    // level discounts. variant lets the cart serializer surface colour
    // name + per-variant image without an extra round-trip.
    include: { items: { include: { product: { include: { category: true, variants: { where: { status: 'Active' } } } }, variant: true } } },
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
    // When a variant is selected, prefer its primary photo so cart
    // line thumbnails show the colour the customer actually picked,
    // not the parent product's default photo.
    const variantImage = ci.variant && Array.isArray(ci.variant.images) && ci.variant.images.length > 0
      ? ci.variant.images[0]
      : null;
    return {
      cart_item_id: ci.cart_item_id,
      qty: Number(ci.qty),
      product: serializeProduct(ci.product, settings, locale),
      // Flat variant fields keep the cart-line UI dumb — it doesn't
      // need to traverse product.variants[] to find which colour to
      // show next to the product name.
      variant_id: ci.variant_id,
      variant_color: ci.variant?.color || null,
      variant_color_hex: ci.variant?.color_hex || null,
      variant_image: variantImage,
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
// Variant rules (enforced server-side so the storefront can't bypass them):
//   - Product with 0 active variants → variant_id must be absent.
//                                      Stock check hits product.stock_quantity.
//   - Product with 1+ active variants → variant_id is REQUIRED.
//                                       Stock check hits the chosen variant's
//                                       stock; product.stock_quantity is ignored.
// Dedup of (cart, product, variant) is done explicitly because the old
// unique constraint was dropped (different colours of the same product
// need to live as separate cart lines).
router.post('/items', validate(addItemSchema), asyncHandler(async (req, res) => {
  const { product_id, variant_id, qty } = req.body;
  const product = await prisma.product.findUnique({
    where: { product_id },
    include: { variants: { where: { status: 'Active' } } },
  });
  if (!product) notFound('Product not found');

  const hasVariants = product.variants.length > 0;
  if (hasVariants && !variant_id) {
    badRequest('This product comes in multiple colours — please select one.');
  }
  if (!hasVariants && variant_id) {
    badRequest('This product does not support colour variants.');
  }

  let variant = null;
  if (variant_id) {
    variant = product.variants.find((v) => v.variant_id === variant_id);
    if (!variant) badRequest('Selected colour is no longer available for this product.');
    if (Number(variant.stock) < qty) badRequest(`Only ${Number(variant.stock)} of this colour in stock`);
  } else {
    if (Number(product.stock_quantity) < qty) badRequest('Insufficient stock');
  }

  const cart = await getOrCreateCart(req.user.customer_id);
  // Dedup: increment qty when the exact (product, variant) combo is
  // already in the cart, otherwise insert a new line. findFirst (not
  // findUnique) because the unique key was dropped to allow multiple
  // colour-variants of the same product to coexist in a cart.
  const existing = await prisma.cartItem.findFirst({
    where: { cart_id: cart.cart_id, product_id, variant_id: variant_id ?? null },
  });
  if (existing) {
    await prisma.cartItem.update({
      where: { cart_item_id: existing.cart_item_id },
      data: { qty: { increment: qty } },
    });
  } else {
    await prisma.cartItem.create({
      data: { cart_id: cart.cart_id, product_id, variant_id: variant_id ?? null, qty },
    });
  }

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
