-- Company branding stored in BusinessSettings so the storefront and
-- invoice can render admin-controlled values instead of hardcoded
-- "FreshKart" / "Farm to Door" strings. Defaults preserve current
-- behaviour for any environment that doesn't have the values set yet.
ALTER TABLE "BusinessSettings"
  ADD COLUMN "company_name"    VARCHAR(100) NOT NULL DEFAULT 'FreshKart',
  ADD COLUMN "company_tagline" VARCHAR(100) NOT NULL DEFAULT 'Farm to Door',
  ADD COLUMN "company_address" VARCHAR(500);
