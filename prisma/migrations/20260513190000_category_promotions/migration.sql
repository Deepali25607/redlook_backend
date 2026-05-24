-- Admin-managed sale promotion marquee. Each entry binds an uploaded
-- image to a category so clicking the image deep-links to that
-- category's product listing on the storefront. Empty default = the
-- banner is hidden on the storefront until the admin adds at least
-- one enabled entry.

ALTER TABLE "BusinessSettings"
  ADD COLUMN "category_promotions" JSONB NOT NULL DEFAULT '[]';
