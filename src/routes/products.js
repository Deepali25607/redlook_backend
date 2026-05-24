// BRD §11.3 Product & Category APIs (read-only in customer scope; admin CRUD comes in Phase 5)
import { Router } from 'express';
import { prisma } from '../lib/prisma.js';
import { asyncHandler, notFound } from '../lib/http.js';
import { serializeProduct, serializeCategory } from '../lib/serialize.js';
import { resolveLocale, localizeSetting, DEFAULT_LOCALE } from '../lib/i18n.js';
import reviewsRouter from './reviews.js';

const router = Router();

// Customer-facing reviews live under /products/:id/reviews. The reviews
// router uses mergeParams so it can read req.params.id (the product id).
router.use('/products/:id/reviews', reviewsRouter);

// Settings holds the global discount toggle/percent; we load it alongside
// product reads so the resolver can include it without an extra round-trip
// on each callsite. Upsert-on-read so a fresh install always finds a row.
async function loadSettings() {
  return prisma.businessSettings.upsert({
    where: { id: 1 },
    update: {},
    create: { id: 1 },
  });
}

// GET /api/products  — supports ?category=&q=&organic=&max_price=
router.get('/products', asyncHandler(async (req, res) => {
  const { category, q, organic, max_price } = req.query;
  const locale = resolveLocale(req);
  const where = { status: 'Active' };
  if (category) where.category_id = category;
  if (q) where.name = { contains: q, mode: 'insensitive' };
  if (organic === 'true') where.is_organic = true;
  // max_price filters on the post-discount price the customer actually sees,
  // not on price_per_unit (the MRP). Discounted SKUs that fall under the
  // cap should show up even when their MRP is above it. Cheap enough to
  // filter in JS for the catalog sizes this app deals with.
  const [products, settings] = await Promise.all([
    prisma.product.findMany({
      where,
      include: { category: true },
      orderBy: { created_at: 'desc' },
    }),
    loadSettings(),
  ]);
  let serialized = products.map((p) => serializeProduct(p, settings, locale));
  if (max_price) {
    const cap = Number(max_price);
    if (Number.isFinite(cap)) serialized = serialized.filter((p) => p.price <= cap);
  }
  res.json({ data: serialized });
}));

// GET /api/products/{id}
router.get('/products/:id', asyncHandler(async (req, res) => {
  const locale = resolveLocale(req);
  const [product, settings] = await Promise.all([
    prisma.product.findUnique({
      where: { product_id: req.params.id },
      include: { category: true },
    }),
    loadSettings(),
  ]);
  if (!product) notFound('Product not found');
  res.json({ data: serializeProduct(product, settings, locale) });
}));

// GET /api/categories
router.get('/categories', asyncHandler(async (req, res) => {
  const locale = resolveLocale(req);
  const cats = await prisma.category.findMany({ orderBy: { name: 'asc' } });
  res.json({ data: cats.map((c) => serializeCategory(c, locale)) });
}));

// GET /api/settings — public read of operational thresholds the cart needs
// (minimum order value/quantity) so the customer-facing UI can preview "add ₹X
// more" hints without poking the admin endpoint. Only safe-to-expose fields.
router.get('/settings', asyncHandler(async (req, res) => {
  const locale = resolveLocale(req);
  const s = await prisma.businessSettings.upsert({
    where: { id: 1 },
    update: {},
    create: { id: 1 },
  });
  // Storefront "Max price" slider cap. In auto mode we resolve from the live
  // catalog so the slider always covers every Active SKU (and grows when the
  // admin adds a pricier vegetable). In manual mode the stored cap wins,
  // letting the admin clamp the slider below catalog max for promos. Round
  // up to the nearest ₹10 so the rail ends on a tidy mark, not ₹147.50.
  const manualCap = Number(s.max_price_filter_cap);
  let resolvedCap = manualCap;
  if (s.max_price_filter_auto) {
    const agg = await prisma.product.aggregate({
      _max: { price_per_unit: true },
      where: { status: 'Active' },
    });
    const catalogMax = agg._max.price_per_unit;
    // Empty catalog → fall back to the stored cap so the slider still
    // renders with a sane range.
    resolvedCap = catalogMax == null
      ? manualCap
      : Math.max(1, Math.ceil(Number(catalogMax) / 10) * 10);
  }

  // Per-locale overlays for the admin-editable copy. Empty translations
  // fall back to the canonical English column (localizeSetting handles it).
  // For the JSON catalogs (product_detail_badges + home_hero_features) we
  // walk the array and overlay each entry's title/subtitle via synthetic
  // keys (`badge_<key>_title`, `hero_<key>` etc.) — the admin form writes
  // the same flat key shape, so this stays in sync without recursion.
  const localizedBadges = (s.product_detail_badges || []).map((b) => ({
    ...b,
    title:    localizeSetting(s, `badge_${b.key}_title`,    b.title,    locale),
    subtitle: localizeSetting(s, `badge_${b.key}_subtitle`, b.subtitle, locale),
    // returns badge has alt variants for non-returnable products; localize
    // those when the field exists so both branches stay in sync.
    ...(b.title_alt    !== undefined && { title_alt:    localizeSetting(s, `badge_${b.key}_title_alt`,    b.title_alt,    locale) }),
    ...(b.subtitle_alt !== undefined && { subtitle_alt: localizeSetting(s, `badge_${b.key}_subtitle_alt`, b.subtitle_alt, locale) }),
  }));
  const localizedHero = (s.home_hero_features || []).map((f) => ({
    ...f,
    title: localizeSetting(s, `hero_${f.key}`, f.title, locale),
  }));

  res.json({
    data: {
      min_order_value: Number(s.min_order_value),
      min_order_quantity: s.min_order_quantity,
      delivery_charge: Number(s.delivery_charge),
      free_delivery_over: Number(s.free_delivery_over),
      delivery_slot_buffer_hours: s.delivery_slot_buffer_hours,
      support_phone: s.support_phone,
      support_whatsapp: s.support_whatsapp,
      support_email: s.support_email,
      support_message: localizeSetting(s, 'support_message', s.support_message, locale),
      theme: s.theme,
      cancellation_cutoff_status: s.cancellation_cutoff_status,
      return_window_hours: s.return_window_hours,
      return_window_message: localizeSetting(s, 'return_window_message', s.return_window_message, locale),
      // Public branding — drives the storefront navbar/footer and the
      // admin shell's title strip. Same admin-edited values used by the
      // invoice generator on the backend.
      company_name: localizeSetting(s, 'company_name', s.company_name, locale),
      company_tagline: localizeSetting(s, 'company_tagline', s.company_tagline, locale),
      company_address: localizeSetting(s, 'company_address', s.company_address, locale),
      // Admin-editable badge copy. Storefront resolves {free_delivery_over}
      // and {next_slot} template tokens at render time.
      product_detail_badges: localizedBadges,
      home_hero_features: localizedHero,
      // Admin-configured delivery slot catalog. Storefront filters by
      // `enabled` and applies the buffer-hours availability rule client-side
      // so the picker stays accurate as the customer's clock ticks across
      // a cutoff. Empty array = the catalog hasn't been seeded yet (fresh
      // install before migrate); storefront falls back to a default in
      // that case so checkout doesn't break.
      delivery_slots: s.delivery_slots || [],
      // Sale-promo marquee. Storefront filters by `enabled` before
      // rendering; we ship the full catalog so a disabled-but-saved
      // entry can be flipped back on without re-uploading.
      category_promotions: s.category_promotions || [],
      // Resolved cap the slider should render with. Raw fields stay
      // internal — the admin form fetches them from the authenticated
      // endpoint where it can edit them.
      max_price_filter_cap: resolvedCap,
      // Platform-wide discount is exposed so the storefront can render a
      // site-wide sale banner; the resolver already factored it into each
      // product's `price`, so consumers don't need to recompute.
      global_discount_enabled: s.global_discount_enabled,
      global_discount_percent: Number(s.global_discount_percent ?? 0),
    },
  });
}));

export default router;
