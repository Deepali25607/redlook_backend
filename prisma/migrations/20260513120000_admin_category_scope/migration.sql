-- Per-admin category whitelist for the Products + Categories tiles.
-- Default '{}' means "unrestricted" — every existing admin keeps full access.
ALTER TABLE "AdminUser"
  ADD COLUMN "category_scope" TEXT[] NOT NULL DEFAULT '{}';
