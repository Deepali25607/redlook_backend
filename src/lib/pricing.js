// Single source of truth for "what does the customer pay for this product?".
// Used by:
//   - serializeProduct  → storefront card price + strikethrough MRP
//   - cart line totals  → /api/cart responses
//   - order placement   → unit_price + line_total snapshot at checkout
//
// Three discount sources, all expressed as a percentage (0-100):
//   1. Product.discount_percent
//   2. Category.discount_percent
//   3. BusinessSettings.global_discount_percent (only when global_discount_enabled)
//
// Effective discount = max of the three (capped at 100). "Best deal wins"
// — picking max means turning on a global sale never reduces a customer's
// existing per-product markdown, and stacking is intentional via the larger
// of the two rather than additive (additive would let admins accidentally
// give away product by combining a 60% category sale with a 60% product
// sale into a 120% loss).

const num = (v) => (v == null ? 0 : Number(v));

// Round to 2dp using HALF-UP to match what the customer sees on the card.
// Math.round in JS is half-up for positive values, which is what we want.
const round2 = (n) => Math.round(n * 100) / 100;

// Resolve effective price + discount % for a single product.
//
// `product` must include the Decimal `price_per_unit` and `discount_percent`
// columns. `category` is optional; pass null when the row was loaded without
// the include (the resolver treats it as a 0% category discount). `settings`
// must expose `global_discount_enabled` and `global_discount_percent` — pass
// null in the rare case where settings haven't been loaded (the resolver
// treats it as global off).
export function resolveProductPrice(product, category, settings) {
  const mrp = num(product.price_per_unit);
  const productPct = num(product.discount_percent);
  const categoryPct = category ? num(category.discount_percent) : 0;
  const globalPct = settings?.global_discount_enabled
    ? num(settings.global_discount_percent)
    : 0;
  const pct = Math.max(0, Math.min(100, Math.max(productPct, categoryPct, globalPct)));
  const price = round2(mrp * (1 - pct / 100));
  return {
    mrp,
    price,
    discountPercent: pct,
  };
}
