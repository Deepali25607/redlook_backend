-- Replace the per-customer FK scope with a string-based business-name
-- scope. A B2B account can have multiple Customer rows (different
-- contact/login users under the same company), so scoping by
-- customer_id missed contacts other than the chosen one. Scoping by
-- business_name covers every Customer row under that business name.
--
-- The previous FK column lived for under a day in any environment and
-- was never load-bearing for user-facing data, so we drop it cleanly.
-- Any admin whose scope was set under the FK model is dropped to
-- "unscoped" by this migration; the SuperAdmin re-points them via the
-- Edit modal with the new business-name dropdown.

ALTER TABLE "AdminUser"
  DROP CONSTRAINT IF EXISTS "AdminUser_scoped_customer_id_fkey";

DROP INDEX IF EXISTS "AdminUser_scoped_customer_id_idx";

ALTER TABLE "AdminUser"
  DROP COLUMN IF EXISTS "scoped_customer_id";

ALTER TABLE "AdminUser"
  ADD COLUMN "scoped_business_name" VARCHAR(150);

-- Index makes the WHERE business_name = X lookup cheap on every
-- list/report endpoint that applies the scope filter.
CREATE INDEX "AdminUser_scoped_business_name_idx"
  ON "AdminUser"("scoped_business_name");
