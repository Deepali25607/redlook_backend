// Prisma returns Decimal as a wrapper object (and Date as Date). Frontend wants
// plain JSON-friendly values that match the existing mock shapes. These helpers
// normalize before responding.

import { resolveProductPrice } from './pricing.js';
import { localize, DEFAULT_LOCALE } from './i18n.js';

const toNumber = (d) => (d == null ? null : Number(d));

// `settings` is optional — pass the BusinessSettings row when serializing for
// the storefront so platform-wide / category discounts factor into `price`.
// Callers that don't have access (or don't care about the discount layer,
// e.g. admin views that show the raw MRP) can omit it.
//
// `locale` (Phase 2 i18n) is optional and defaults to 'en'. When non-default
// it pulls translated values for name/description/freshness from
// product.translations; missing translations fall back to canonical English
// per-field so a half-localized product never renders blank.
//
// Output contract:
//   price            — what the customer pays (post-discount)
//   mrp              — original list price (pre-discount); equals price when no discount applies
//   discount_percent — effective discount %, 0 when nothing applies
//
// The product row's `category` join (when loaded via `include: { category: true }`)
// supplies the category-level discount. When the join is absent, only the
// product-level and global discounts factor in.
export function serializeProduct(p, settings = null, locale = DEFAULT_LOCALE) {
  if (!p) return null;
  const { mrp, price, discountPercent } = resolveProductPrice(p, p.category, settings);
  return {
    id: p.product_id,
    name: localize(p, 'name', locale),
    category: p.category_id,
    description: localize(p, 'description', locale),
    price,
    mrp,
    discount_percent: discountPercent,
    unit: p.unit,
    stock: toNumber(p.stock_quantity),
    isOrganic: p.is_organic,
    image: p.image,
    // Gallery URLs shown on the product detail page. Falls back to
    // [image] for pre-multi-image rows so the detail-page renderer can
    // always treat `images` as the source of truth without a null check.
    images: (Array.isArray(p.images) && p.images.length > 0)
      ? p.images
      : (p.image ? [p.image] : []),
    // Colour variants (when present). Each one is a distinct SKU with
    // its own stock and required photo gallery. Inactive variants are
    // filtered out so the storefront never offers a colour the admin
    // has retired. Products without variants serialise this as [] and
    // the storefront falls back to the single-SKU flow.
    variants: Array.isArray(p.variants)
      ? p.variants
          .filter((v) => v.status !== 'Inactive')
          .map((v) => ({
            variant_id: v.variant_id,
            color: v.color,
            color_hex: v.color_hex,
            stock: toNumber(v.stock),
            images: v.images || [],
          }))
      : [],
    rating: toNumber(p.rating),
    reviews: p.reviews_count,
    freshness: localize(p, 'freshness', locale),
    is_returnable: p.is_returnable,
  };
}

export function serializeCategory(c, locale = DEFAULT_LOCALE) {
  return {
    id: c.category_id,
    name: localize(c, 'name', locale),
    icon: c.icon,
    discount_percent: toNumber(c.discount_percent) ?? 0,
  };
}

export function serializeUser(u) {
  if (!u) return null;
  // Strip password_hash before responding.
  const { password_hash: _ph, ...rest } = u;
  return {
    ...rest,
    addresses: rest.addresses ? rest.addresses.map(serializeAddress) : undefined,
  };
}

export function serializeAddress(a) {
  if (!a) return null;
  return {
    address_id: a.address_id,
    label: a.label,
    recipient_name: a.recipient_name,
    recipient_phone: a.recipient_phone,
    address_line1: a.address_line1,
    address_line2: a.address_line2,
    landmark: a.landmark,
    city: a.city,
    state: a.state,
    pincode: a.pincode,
    latitude: toNumber(a.latitude),
    longitude: toNumber(a.longitude),
    location_source: a.location_source ?? null,
    location_accuracy: a.location_accuracy ?? null,
    location_captured_at: a.location_captured_at ?? null,
    is_default: a.is_default,
  };
}

// `opts.includeDeliveryPhotos` (default false) — admin routes pass true to
// expose the open-box gallery; customer-facing routes leave it off so the
// photos are admin-internal proof-of-delivery only.
export function serializeOrder(o, opts = {}) {
  if (!o) return null;
  // Sum of (mrp - unit_price) * qty across all lines. Pre-existing orders
  // placed before the mrp column existed have mrp = 0, which naturally
  // resolves to "no savings" via the > 0 guard inside the reduce.
  const productSavings = (o.items || []).reduce((s, i) => {
    const mrp = Number(i.mrp ?? 0);
    const paid = Number(i.unit_price ?? 0);
    const qty = Number(i.quantity ?? 0);
    return s + (mrp > paid ? (mrp - paid) * qty : 0);
  }, 0);
  return {
    order_id: o.order_id,
    customer_id: o.customer_id,
    address: o.address_snapshot,
    delivery_slot: o.delivery_slot,
    payment_method: o.payment_method,
    payment_status: o.payment_status,
    order_status: o.order_status,
    subtotal: toNumber(o.subtotal),
    discount: toNumber(o.discount),
    delivery_charge: toNumber(o.delivery_charge),
    tax: toNumber(o.tax),
    total_amount: toNumber(o.total_amount),
    // Product-level savings (MRP minus paid). Distinct from `discount`
    // which is the coupon discount applied to subtotal — those two stay
    // separate on the invoice so customers see both lines.
    product_savings: Math.round(productSavings * 100) / 100,
    order_date: o.order_date,
    timeline: o.timeline,
    items: (o.items || []).map((i) => ({
      id: i.product_id,
      name: i.name,
      image: i.image,
      unit: i.unit,
      qty: toNumber(i.quantity),
      mrp: toNumber(i.mrp) ?? 0,
      price: toNumber(i.unit_price),
      line_total: toNumber(i.line_total),
      // Optional — populated when the GET handler includes the Product join.
      // Defaults to true so callers that don't include the join still treat
      // items as returnable (matching the schema default).
      is_returnable: i.product?.is_returnable ?? true,
    })),
    ...(opts.includeDeliveryPhotos
      ? { delivery_photos: Array.isArray(o.delivery_photos) ? o.delivery_photos : [] }
      : {}),
  };
}
