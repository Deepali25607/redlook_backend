-- Redlook rebrand defaults
-- Updates BusinessSettings column defaults from FreshKart (grocery) values
-- to Redlook (apparel) values so a brand-new DB is born with the right copy.
-- Also rewrites the singleton row (id=1) so existing dev/staging DBs pick
-- up the apparel hero / badge copy without needing a manual override.
-- Seed (`npm run seed`) also force-overwrites the same fields, so this
-- migration is mainly important for environments that won't re-run seed.

-- ── Column defaults ───────────────────────────────────────────────────────
ALTER TABLE "BusinessSettings"
  ALTER COLUMN "min_order_value"        SET DEFAULT 499,
  ALTER COLUMN "delivery_charge"        SET DEFAULT 79,
  ALTER COLUMN "free_delivery_over"     SET DEFAULT 999,
  ALTER COLUMN "return_window_hours"    SET DEFAULT 168,
  ALTER COLUMN "company_name"           SET DEFAULT 'Redlook',
  ALTER COLUMN "company_tagline"        SET DEFAULT 'Curated style, delivered.',
  ALTER COLUMN "home_announcement_text" SET DEFAULT 'Free shipping on orders above ₹999',
  ALTER COLUMN "product_detail_badges"  SET DEFAULT '[{"key":"delivery","enabled":true,"title":"Free shipping","subtitle":"On orders ₹{free_delivery_over}+"},{"key":"returns","enabled":true,"title":"Easy returns","subtitle":"Within 7 days of delivery","title_alt":"Non-returnable","subtitle_alt":"No returns on this item"},{"key":"freshness","enabled":true,"title":"100% genuine","subtitle":"Authenticity guaranteed"},{"key":"slot","enabled":true,"title":"Next slot","subtitle":"{next_slot}"}]',
  ALTER COLUMN "home_hero_features"     SET DEFAULT '[{"key":"announcement","enabled":true,"title":"Free shipping on orders above ₹999"},{"key":"headline_top","enabled":true,"title":"Style that turns heads,"},{"key":"headline_bottom","enabled":true,"title":"delivered to your door."},{"key":"subheadline","enabled":true,"title":"Hand-picked drops from emerging Indian labels and trusted classics. Easy 7-day returns, no questions asked."},{"key":"background_image","enabled":false,"title":""},{"key":"delivery","enabled":true,"title":"Fast nationwide delivery"},{"key":"freshness","enabled":true,"title":"100% genuine guarantee"},{"key":"speed","enabled":true,"title":"Checkout in under 2 minutes"}]';

-- ── Backfill the singleton row to match. Rewrites brand-facing copy AND
-- ── the apparel-relevant numeric thresholds (₹150 / ₹40 / ₹299 / 24h are
-- ── grocery-era values; apparel norms are ₹499 / ₹79 / ₹999 / 168h).
-- ── This migration runs once, so it doesn't fight admin edits made later.
UPDATE "BusinessSettings"
SET
  "min_order_value"        = 499,
  "delivery_charge"        = 79,
  "free_delivery_over"     = 999,
  "return_window_hours"    = 168,
  "company_name"           = 'Redlook',
  "company_tagline"        = 'Curated style, delivered.',
  "home_announcement_text" = 'Free shipping on orders above ₹999',
  "product_detail_badges"  = '[{"key":"delivery","enabled":true,"title":"Free shipping","subtitle":"On orders ₹{free_delivery_over}+"},{"key":"returns","enabled":true,"title":"Easy returns","subtitle":"Within 7 days of delivery","title_alt":"Non-returnable","subtitle_alt":"No returns on this item"},{"key":"freshness","enabled":true,"title":"100% genuine","subtitle":"Authenticity guaranteed"},{"key":"slot","enabled":true,"title":"Next slot","subtitle":"{next_slot}"}]'::jsonb,
  "home_hero_features"     = '[{"key":"announcement","enabled":true,"title":"Free shipping on orders above ₹999"},{"key":"headline_top","enabled":true,"title":"Style that turns heads,"},{"key":"headline_bottom","enabled":true,"title":"delivered to your door."},{"key":"subheadline","enabled":true,"title":"Hand-picked drops from emerging Indian labels and trusted classics. Easy 7-day returns, no questions asked."},{"key":"background_image","enabled":false,"title":""},{"key":"delivery","enabled":true,"title":"Fast nationwide delivery"},{"key":"freshness","enabled":true,"title":"100% genuine guarantee"},{"key":"speed","enabled":true,"title":"Checkout in under 2 minutes"}]'::jsonb
WHERE "id" = 1;
