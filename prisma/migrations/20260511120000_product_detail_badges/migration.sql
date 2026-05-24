-- Admin-controlled badge copy for the product detail page (four-badge row
-- under the buy buttons) and the home hero's trust pills. Stored as JSONB
-- so the catalog of badges is fixed by key but their title/subtitle/visibility
-- are editable without a schema migration each time.
--
-- Defaults preserve the pre-existing hardcoded copy. The returns badge has
-- two variants (returnable / non-returnable) keyed by per-product
-- is_returnable; both pairs of strings live in the same row.
--
-- Template tokens the storefront resolves at render time:
--   {free_delivery_over}  → BusinessSettings.free_delivery_over (₹)
--   {next_slot}           → label of the next available delivery slot

ALTER TABLE "BusinessSettings"
  ADD COLUMN "product_detail_badges" JSONB NOT NULL DEFAULT '[
    {"key":"delivery","enabled":true,"title":"Free delivery","subtitle":"On orders ₹{free_delivery_over}+"},
    {"key":"returns","enabled":true,"title":"Returnable","subtitle":"Within 24h of delivery","title_alt":"Non-returnable","subtitle_alt":"No returns on this item"},
    {"key":"freshness","enabled":true,"title":"Fresh guarantee","subtitle":"100% or refund"},
    {"key":"slot","enabled":true,"title":"Next slot","subtitle":"{next_slot}"}
  ]'::jsonb,
  ADD COLUMN "home_hero_features" JSONB NOT NULL DEFAULT '[
    {"key":"delivery","enabled":true,"title":"Same-day delivery"},
    {"key":"freshness","enabled":true,"title":"100% fresh guarantee"},
    {"key":"speed","enabled":true,"title":"Order in 2 minutes"}
  ]'::jsonb;
