// Admin operational thresholds (BRD §11.7). Currently exposes
// minimum order value (₹) and minimum order quantity (item count) — the two
// gates the order placement endpoint enforces. Adding new fields means
// extending the schema row + this validator + the cart UI.
//
// Read: any admin role. Write: SuperAdmin + OperationsAdmin (Support is read-only).

import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { asyncHandler, validate } from '../lib/http.js';
import { requirePermission } from '../middleware/adminAuth.js';
import { invalidateCutoffCache } from '../lib/orderPolicy.js';

const router = Router();

// Empty string is treated as "clear this field" — converted to null before
// the Prisma write so the column actually nulls out instead of storing "".
const optionalString = (max) => z
  .string()
  .max(max)
  .transform((v) => (v.trim() === '' ? null : v.trim()))
  .nullable()
  .optional();

// Site-wide theme catalog. The frontend mirrors this list — keep them in sync.
// Adding a theme = update this enum + add CSS in src/index.css + add a swatch
// preview in the admin settings page.
export const THEME_KEYS = ['emerald', 'dark', 'sunrise', 'ocean', 'lavender', 'marvel', 'dc'];

// Cancellation cutoff: first order_status at which a customer (or admin)
// can no longer cancel. Mirrors Order.order_status values, omitting the
// terminal 'Cancelled' / 'ReturnRequested' which would never be valid
// cutoffs. Default ('Out for Delivery') matches the pre-existing policy.
export const CANCEL_CUTOFF_VALUES = ['Confirmed', 'Packed', 'Out for Delivery', 'Delivered'];

// Fixed catalog of badges/pills the admin can configure. Keys map to icons
// and rendering rules on the storefront — admins can edit copy and toggle
// visibility, but cannot add new entries. The returns badge is the only one
// that carries a second variant (title_alt/subtitle_alt) for the
// non-returnable case; the others use a single title + subtitle pair.
export const PRODUCT_BADGE_KEYS = ['delivery', 'returns', 'freshness', 'slot'];
// All home-hero copy lives in this one JSONB array so the admin manages it
// from a single Settings → Product details section, and so new entries can
// be added without forcing a Prisma client regen. Render path on the
// storefront branches per `key`:
//   announcement     — pulsing-dot pill above the headline
//   headline_top     — h1 line 1 (plain weight)
//   headline_bottom  — h1 line 2 (gradient text)
//   subheadline      — paragraph under the headline
//   background_image — URL applied as the hero section's background image
//                      (toggle off = fall back to the default gradient)
//   delivery/freshness/speed — icon+label trust pills under the CTAs
export const HOME_HERO_KEYS = [
  'announcement',
  'headline_top',
  'headline_bottom',
  'subheadline',
  'background_image',
  'delivery',
  'freshness',
  'speed',
];

const productBadgeSchema = z.object({
  key: z.enum(PRODUCT_BADGE_KEYS),
  enabled: z.boolean(),
  title: z.string().min(1).max(50),
  subtitle: z.string().max(100),
  title_alt: z.string().min(1).max(50).optional(),
  subtitle_alt: z.string().max(100).optional(),
});

const homeHeroFeatureSchema = z.object({
  key: z.enum(HOME_HERO_KEYS),
  enabled: z.boolean(),
  // Cap is 500 to cover the subheadline paragraph plus full image URLs.
  // Empty strings are allowed because the `background_image` entry stores
  // an empty `title` when no image is configured (disabled state) — the
  // Zod min(0) below permits that. The admin form prevents empty titles
  // for the other keys when their `enabled` flag is on.
  title: z.string().min(0).max(500),
});

// Strict catalog enforcement: the saved array must contain exactly one entry
// per key in PRODUCT_BADGE_KEYS / HOME_HERO_KEYS, in that order. Stops the
// admin (or a malformed client) from dropping a badge or duplicating keys —
// the storefront iterates the saved order, so a missing key would hide a
// badge that should be there.
const exactCatalog = (keys, label) => (arr, ctx) => {
  const got = arr.map((b) => b.key);
  if (got.length !== keys.length || keys.some((k, i) => got[i] !== k)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `${label} must contain exactly: ${keys.join(', ')}`,
    });
  }
};

const productBadgesSchema = z.array(productBadgeSchema)
  .superRefine(exactCatalog(PRODUCT_BADGE_KEYS, 'product_detail_badges'));

const homeHeroSchema = z.array(homeHeroFeatureSchema)
  .superRefine(exactCatalog(HOME_HERO_KEYS, 'home_hero_features'));

// Admin-configurable delivery slot catalog. The storefront reads this via
// /api/settings and renders the customer pick list at checkout. `id` is
// admin-stable so future order rows can reference a slot by id (we still
// store the rendered label on Order.delivery_slot for invoice history —
// editing a slot doesn't rewrite past orders).
//
// day_offset bounded to ~30 days so admins can pre-populate a holiday
// schedule but a fat-finger 1000 doesn't blow up the calendar math on
// the storefront. start_hour < end_hour enforced via superRefine so each
// slot is a valid forward-running window.
const deliverySlotSchema = z.object({
  id: z.string().min(1).max(60),
  day_offset: z.number().int().min(0).max(30),
  start_hour: z.number().int().min(0).max(23),
  end_hour: z.number().int().min(1).max(24),
  label: z.string().min(1).max(60),
  enabled: z.boolean(),
}).superRefine((s, ctx) => {
  if (s.end_hour <= s.start_hour) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['end_hour'],
      message: 'End hour must be greater than start hour',
    });
  }
});

const deliverySlotsSchema = z.array(deliverySlotSchema)
  .max(50, 'Maximum 50 delivery slots')
  .superRefine((arr, ctx) => {
    // Slot ids are the join key the storefront uses to remember the customer's
    // selection across navigation; duplicates would silently collide.
    const seen = new Set();
    for (let i = 0; i < arr.length; i++) {
      if (seen.has(arr[i].id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [i, 'id'],
          message: `Duplicate slot id "${arr[i].id}"`,
        });
      }
      seen.add(arr[i].id);
    }
  });

// Categorywise promotion marquee. `image_url` is whatever
// /admin/uploads/promo-image returned (or an external URL the admin
// pasted) — the storefront renders it as-is. `category_id` is a
// string fk to Category.category_id; not validated server-side as
// FK because admins commonly bind promos before the matching
// category is renamed/seeded — the storefront just falls back to
// not-clickable if the id is unknown. 12-entry cap is high enough
// for a full Diwali sale lineup but bounded for marquee performance.
// Optional per-banner pixel dimensions. Null/undefined = "use the
// storefront default" (h-24 on mobile, h-32 on desktop, width auto).
// Lower bound stops a fat-finger zero from hiding the banner; upper
// bound keeps a single banner from blowing past a reasonable viewport.
const promoDimensionPx = z.number().int().min(20).max(800).nullable().optional();
const categoryPromoSchema = z.object({
  id: z.string().min(1).max(60),
  image_url: z.string().min(1).max(500),
  category_id: z.string().min(1).max(60),
  alt: z.string().max(150).optional().nullable(),
  enabled: z.boolean(),
  height_mobile_px: promoDimensionPx,
  height_desktop_px: promoDimensionPx,
  width_mobile_px: promoDimensionPx,
  width_desktop_px: promoDimensionPx,
});
const categoryPromosSchema = z.array(categoryPromoSchema)
  .max(12, 'Maximum 12 promotions')
  .superRefine((arr, ctx) => {
    const seen = new Set();
    for (let i = 0; i < arr.length; i++) {
      if (seen.has(arr[i].id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [i, 'id'],
          message: `Duplicate promo id "${arr[i].id}"`,
        });
      }
      seen.add(arr[i].id);
    }
  });

// Frequently-Bought-Together / cross-sell rules. Each rule fires when a
// customer adds a product from `trigger_category_id`, popping a suggestions
// modal listing `product_ids`. Like the promo marquee, `trigger_category_id`
// and `product_ids` are NOT FK-validated server-side — admins routinely wire
// rules before a category is renamed/seeded, and the storefront simply skips
// any id it can't resolve (or hides the modal if nothing resolves). Caps keep
// the JSON blob and the modal a sane size.
const crossSellRuleSchema = z.object({
  id: z.string().min(1).max(60),
  trigger_category_id: z.string().min(1).max(60),
  title: z.string().max(80).optional().nullable(),
  subtitle: z.string().max(140).optional().nullable(),
  product_ids: z.array(z.string().min(1).max(60)).max(12, 'Up to 12 suggested products per rule'),
  enabled: z.boolean(),
});
const crossSellRulesSchema = z.array(crossSellRuleSchema)
  .max(30, 'Maximum 30 cross-sell rules')
  .superRefine((arr, ctx) => {
    const seen = new Set();
    for (let i = 0; i < arr.length; i++) {
      if (seen.has(arr[i].id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [i, 'id'],
          message: `Duplicate rule id "${arr[i].id}"`,
        });
      }
      seen.add(arr[i].id);
    }
  });

const updateSchema = z.object({
  // Decimal cap matches Decimal(10, 2) — 99,999,999.99 max — but a sane upper
  // bound here helps catch fat-finger errors before they hit checkout.
  min_order_value: z.number().min(0).max(100000),
  min_order_quantity: z.number().int().min(1).max(1000),
  delivery_charge: z.number().min(0).max(10000),
  // 0 means "free for everything"; large value means "never free".
  free_delivery_over: z.number().min(0).max(1000000),
  // Whole hours, 0–24. 0 = slots stay open until their start time;
  // higher = more lead time before each slot's cutoff.
  delivery_slot_buffer_hours: z.number().int().min(0).max(24),
  // Customer support contacts — all optional, blanks are persisted as NULL
  // so the storefront widget can hide channels the admin hasn't set up yet.
  support_phone: optionalString(20),
  support_whatsapp: optionalString(20),
  support_email: optionalString(150),
  support_message: optionalString(500),
  // Site-wide theme. Branding decision, applied to both customer storefront
  // and admin portal on next page load. Defaults stay 'emerald'.
  theme: z.enum(THEME_KEYS),
  // First order_status at which cancellation is blocked. Enforced by the
  // customer cancel endpoint and the admin status-transition endpoint.
  cancellation_cutoff_status: z.enum(CANCEL_CUTOFF_VALUES),
  // Hours after delivery during which a return can still be filed. 0
  // disables returns entirely; 168 (one week) is the practical upper
  // bound — anything longer is almost certainly a fat-finger.
  return_window_hours: z.number().int().min(0).max(168),
  // Customer-facing copy for the return policy. Blank = the policy line
  // is hidden on the storefront. Max length matches the column.
  return_window_message: optionalString(500),
  // Firm/company location used as the centre of the delivery geofence. Both
  // sent as numbers; null/undefined = "not configured" which disables the
  // radius check at order/address time. Lat ∈ [-90, 90], Lng ∈ [-180, 180].
  firm_latitude: z.number().min(-90).max(90).nullable().optional(),
  firm_longitude: z.number().min(-180).max(180).nullable().optional(),
  // Radius in km. 0.1 km lower bound stops a fat-finger zero from silently
  // disabling the gate. Upper bound is half Earth's circumference so the
  // admin can effectively pick any value while still rejecting nonsense
  // inputs (negative, NaN, absurd magnitudes that would break the UI).
  delivery_radius_km: z.number().min(0.1).max(20015),
  // Company branding — name and tagline are required (have defaults in DB
  // but never null). Address is optional free-form multi-line text used
  // on invoices and anywhere the admin chooses to display it.
  company_name: z.string().min(1).max(100),
  company_tagline: z.string().min(0).max(100),
  company_address: optionalString(500),
  product_detail_badges: productBadgesSchema,
  home_hero_features: homeHeroSchema,
  delivery_slots: deliverySlotsSchema,
  // Sale-promo marquee row scrolling above the storefront hero.
  category_promotions: categoryPromosSchema,
  // Frequently-Bought-Together cross-sell rules (Suggested items modal).
  cross_sell_rules: crossSellRulesSchema,
  // Storefront "Max price" filter cap. When auto, the manual cap is still
  // persisted (so switching back to manual restores the prior value) but
  // the public endpoint reports the live catalog max. Same 100,000 upper
  // bound the order-value field uses — way above any real produce price.
  max_price_filter_auto: z.boolean(),
  max_price_filter_cap: z.number().min(1).max(100000),
  // Platform-wide bulk discount. Stacks alongside product- and category-
  // level discounts via the pricing resolver (largest wins). The percent
  // is always stored even when disabled so flipping the toggle on/off
  // doesn't lose the configured value.
  global_discount_enabled: z.boolean(),
  global_discount_percent: z.number().min(0).max(100),
  // Per-field translations (Phase 2 i18n). Flat key shape so the admin form
  // can iterate without recursion: { company_name: { hi, bn }, hero_<key>: { hi, bn },
  // badge_<key>_title: { hi, bn }, etc. }. Empty strings = fall back to English.
  translations: z.record(z.record(z.string())).optional().nullable(),
});

const serialize = (s) => ({
  min_order_value: Number(s.min_order_value),
  min_order_quantity: s.min_order_quantity,
  delivery_charge: Number(s.delivery_charge),
  free_delivery_over: Number(s.free_delivery_over),
  delivery_slot_buffer_hours: s.delivery_slot_buffer_hours,
  support_phone: s.support_phone,
  support_whatsapp: s.support_whatsapp,
  support_email: s.support_email,
  support_message: s.support_message,
  theme: s.theme,
  cancellation_cutoff_status: s.cancellation_cutoff_status,
  return_window_hours: s.return_window_hours,
  return_window_message: s.return_window_message,
  firm_latitude: s.firm_latitude == null ? null : Number(s.firm_latitude),
  firm_longitude: s.firm_longitude == null ? null : Number(s.firm_longitude),
  delivery_radius_km: Number(s.delivery_radius_km),
  company_name: s.company_name,
  company_tagline: s.company_tagline,
  company_address: s.company_address,
  product_detail_badges: s.product_detail_badges,
  home_hero_features: s.home_hero_features,
  delivery_slots: s.delivery_slots || [],
  category_promotions: s.category_promotions || [],
  cross_sell_rules: s.cross_sell_rules || [],
  max_price_filter_auto: s.max_price_filter_auto,
  max_price_filter_cap: Number(s.max_price_filter_cap),
  global_discount_enabled: s.global_discount_enabled,
  global_discount_percent: Number(s.global_discount_percent ?? 0),
  // Per-field translations (Phase 2). Admin form reads + writes the same shape.
  translations: s.translations || {},
  updated_at: s.updated_at,
  updated_by: s.updated_by,
});

// Singleton row — created by seed; defensively upsert in case the row is
// missing in a new environment that hasn't been seeded yet.
async function getOrCreateSettings() {
  return prisma.businessSettings.upsert({
    where: { id: 1 },
    update: {},
    create: { id: 1 },
  });
}

router.get('/',
  requirePermission('settings'),
  asyncHandler(async (_req, res) => {
    const s = await getOrCreateSettings();
    res.json({ data: serialize(s) });
  }));

router.put('/',
  requirePermission('settings'),
  validate(updateSchema),
  asyncHandler(async (req, res) => {
    const fields = {
      min_order_value: req.body.min_order_value,
      min_order_quantity: req.body.min_order_quantity,
      delivery_charge: req.body.delivery_charge,
      free_delivery_over: req.body.free_delivery_over,
      delivery_slot_buffer_hours: req.body.delivery_slot_buffer_hours,
      support_phone: req.body.support_phone ?? null,
      support_whatsapp: req.body.support_whatsapp ?? null,
      support_email: req.body.support_email ?? null,
      support_message: req.body.support_message ?? null,
      theme: req.body.theme,
      cancellation_cutoff_status: req.body.cancellation_cutoff_status,
      return_window_hours: req.body.return_window_hours,
      return_window_message: req.body.return_window_message ?? null,
      firm_latitude: req.body.firm_latitude ?? null,
      firm_longitude: req.body.firm_longitude ?? null,
      delivery_radius_km: req.body.delivery_radius_km,
      company_name: req.body.company_name,
      company_tagline: req.body.company_tagline ?? '',
      company_address: req.body.company_address ?? null,
      product_detail_badges: req.body.product_detail_badges,
      home_hero_features: req.body.home_hero_features,
      delivery_slots: req.body.delivery_slots,
      category_promotions: req.body.category_promotions,
      cross_sell_rules: req.body.cross_sell_rules,
      max_price_filter_auto: req.body.max_price_filter_auto,
      max_price_filter_cap: req.body.max_price_filter_cap,
      global_discount_enabled: req.body.global_discount_enabled,
      global_discount_percent: req.body.global_discount_percent,
      // Phase 2 i18n — per-field Hindi/Bengali overlays. null clears entirely.
      translations: req.body.translations ?? null,
    };
    const updated = await prisma.businessSettings.upsert({
      where: { id: 1 },
      update: { ...fields, updated_by: req.admin.email },
      create: { id: 1, ...fields, updated_by: req.admin.email },
    });
    // Drop the in-process cache so the next cancel call sees the new cutoff
    // immediately. Without this, a 30-second window of stale enforcement.
    invalidateCutoffCache();

    // Audit log — same shape as other admin writes per BRD §8.4.
    prisma.auditLog.create({
      data: {
        action: 'admin.settings.update',
        meta: {
          ...fields,
          admin_id: req.admin.admin_id,
          admin_email: req.admin.email,
        },
        ip: req.ip,
      },
    }).catch((err) => console.error('[audit] failed:', err.message));

    res.json({ data: serialize(updated) });
  }));

export default router;
