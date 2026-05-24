-- AlterTable: convert AdminUser.role (single string) to AdminUser.roles
-- (text[]). Each existing admin gets their current single role wrapped into
-- a one-element array so authorization keeps working without manual cleanup.
-- Done in three steps so the backfill runs against a populated 'role' column
-- before we drop it.

ALTER TABLE "AdminUser"
  ADD COLUMN "roles" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

UPDATE "AdminUser"
SET "roles" = ARRAY["role"]
WHERE "role" IS NOT NULL;

ALTER TABLE "AdminUser"
  DROP COLUMN "role";

-- Drop the default once backfill is in place. New rows must specify roles
-- explicitly (the application enforces min-1 at the route level).
ALTER TABLE "AdminUser"
  ALTER COLUMN "roles" DROP DEFAULT;
