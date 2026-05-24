-- Promote the home hero announcement pill ("Free delivery on orders above
-- ₹299") into the same JSONB array that already powers the trust pills
-- below the hero CTA. Storing it inside home_hero_features avoids adding
-- new typed columns — those would require a Prisma client regeneration,
-- which can't run while the Windows dev server is holding the engine DLL
-- open. The storefront renders the 'announcement' key as the pulsing-dot
-- pill at the top of the hero; the other three keys keep rendering as the
-- icon+label row under the buttons.

-- Update the DB-level DEFAULT so newly-seeded environments include the
-- announcement entry as the FIRST element (canonical order matters: the
-- backend Zod validator enforces exact array contents in this exact order).
ALTER TABLE "BusinessSettings"
  ALTER COLUMN "home_hero_features" SET DEFAULT '[
    {"key":"announcement","enabled":true,"title":"Free delivery on orders above ₹299"},
    {"key":"delivery","enabled":true,"title":"Same-day delivery"},
    {"key":"freshness","enabled":true,"title":"100% fresh guarantee"},
    {"key":"speed","enabled":true,"title":"Order in 2 minutes"}
  ]'::jsonb;

-- Backfill the singleton row: prepend the announcement entry if it isn't
-- already there. Idempotent — re-running this migration after manual edits
-- won't duplicate the entry.
UPDATE "BusinessSettings"
SET "home_hero_features" =
  '[{"key":"announcement","enabled":true,"title":"Free delivery on orders above ₹299"}]'::jsonb
  || "home_hero_features"
WHERE id = 1
  AND NOT EXISTS (
    SELECT 1
    FROM jsonb_array_elements("home_hero_features") AS elem
    WHERE elem->>'key' = 'announcement'
  );
