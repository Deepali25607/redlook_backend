-- Promote the hardcoded hero copy (headline top + gradient bottom,
-- subheadline paragraph) and a new background-image override into the same
-- home_hero_features JSONB array that already powers the announcement pill
-- and trust pills. Keeping it as JSONB means no new typed columns, so the
-- Prisma client doesn't need regenerating — the previous round of fixed
-- columns kept tripping Windows file locks on the engine DLL.

-- Update DB-level DEFAULT so freshly seeded environments include all eight
-- entries in the canonical top-to-bottom page order. The Zod validator
-- enforces this exact ordering on save.
ALTER TABLE "BusinessSettings"
  ALTER COLUMN "home_hero_features" SET DEFAULT '[
    {"key":"announcement","enabled":true,"title":"Free delivery on orders above ₹299"},
    {"key":"headline_top","enabled":true,"title":"Fresh from the farm,"},
    {"key":"headline_bottom","enabled":true,"title":"to your kitchen."},
    {"key":"subheadline","enabled":true,"title":"Hand-picked vegetables delivered the same day. No middlemen, just fresh produce at honest prices."},
    {"key":"background_image","enabled":false,"title":""},
    {"key":"delivery","enabled":true,"title":"Same-day delivery"},
    {"key":"freshness","enabled":true,"title":"100% fresh guarantee"},
    {"key":"speed","enabled":true,"title":"Order in 2 minutes"}
  ]'::jsonb;

-- Rebuild the singleton row's home_hero_features so it contains all eight
-- canonical entries in the canonical order, while preserving any existing
-- customisations the admin has saved for keys that were already present.
-- Idempotent: re-running this migration on an already-migrated row keeps
-- whatever the admin most recently saved.
WITH existing AS (
  SELECT
    COALESCE(
      (SELECT elem FROM jsonb_array_elements("home_hero_features") elem WHERE elem->>'key' = 'announcement'),
      '{"key":"announcement","enabled":true,"title":"Free delivery on orders above ₹299"}'::jsonb
    ) AS announcement,
    COALESCE(
      (SELECT elem FROM jsonb_array_elements("home_hero_features") elem WHERE elem->>'key' = 'headline_top'),
      '{"key":"headline_top","enabled":true,"title":"Fresh from the farm,"}'::jsonb
    ) AS headline_top,
    COALESCE(
      (SELECT elem FROM jsonb_array_elements("home_hero_features") elem WHERE elem->>'key' = 'headline_bottom'),
      '{"key":"headline_bottom","enabled":true,"title":"to your kitchen."}'::jsonb
    ) AS headline_bottom,
    COALESCE(
      (SELECT elem FROM jsonb_array_elements("home_hero_features") elem WHERE elem->>'key' = 'subheadline'),
      '{"key":"subheadline","enabled":true,"title":"Hand-picked vegetables delivered the same day. No middlemen, just fresh produce at honest prices."}'::jsonb
    ) AS subheadline,
    COALESCE(
      (SELECT elem FROM jsonb_array_elements("home_hero_features") elem WHERE elem->>'key' = 'background_image'),
      '{"key":"background_image","enabled":false,"title":""}'::jsonb
    ) AS background_image,
    COALESCE(
      (SELECT elem FROM jsonb_array_elements("home_hero_features") elem WHERE elem->>'key' = 'delivery'),
      '{"key":"delivery","enabled":true,"title":"Same-day delivery"}'::jsonb
    ) AS delivery,
    COALESCE(
      (SELECT elem FROM jsonb_array_elements("home_hero_features") elem WHERE elem->>'key' = 'freshness'),
      '{"key":"freshness","enabled":true,"title":"100% fresh guarantee"}'::jsonb
    ) AS freshness,
    COALESCE(
      (SELECT elem FROM jsonb_array_elements("home_hero_features") elem WHERE elem->>'key' = 'speed'),
      '{"key":"speed","enabled":true,"title":"Order in 2 minutes"}'::jsonb
    ) AS speed
  FROM "BusinessSettings" WHERE id = 1
)
UPDATE "BusinessSettings"
SET "home_hero_features" = jsonb_build_array(
  (SELECT announcement     FROM existing),
  (SELECT headline_top     FROM existing),
  (SELECT headline_bottom  FROM existing),
  (SELECT subheadline      FROM existing),
  (SELECT background_image FROM existing),
  (SELECT delivery         FROM existing),
  (SELECT freshness        FROM existing),
  (SELECT speed            FROM existing)
)
WHERE id = 1;
