-- Per-entity JSON translations for storefront-facing copy. Each row stores
-- a small object keyed by field name → locale → string. Missing locales
-- fall back to the canonical English column at serialize time.
ALTER TABLE "Product"          ADD COLUMN "translations" JSONB;
ALTER TABLE "Category"         ADD COLUMN "translations" JSONB;
ALTER TABLE "BusinessSettings" ADD COLUMN "translations" JSONB;
