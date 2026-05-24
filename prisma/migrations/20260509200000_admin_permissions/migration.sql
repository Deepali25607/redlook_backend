-- AlterTable: replace AdminUser.roles (text[]) with permissions (text[]).
-- Each existing admin's role membership is expanded into the tile-level
-- permissions they previously had implicit access to:
--   SuperAdmin       → every tile, including admin-users
--   OperationsAdmin  → every tile EXCEPT admin-users
--   SupportAdmin     → every tile EXCEPT admin-users (Support previously had
--                      read-only access across the portal; the new model has
--                      no read-only tier so we conservatively grant the same
--                      tiles and let SuperAdmin tighten per-account if needed)
-- This is a one-way migration. After it runs, the role distinction is gone
-- and authorization is per-tile.

ALTER TABLE "AdminUser"
  ADD COLUMN "permissions" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- Build the permission set per row from the existing roles array. Postgres
-- array operators (`@>` = "contains", `||` = concat) make the expansion
-- straightforward without a procedure.
UPDATE "AdminUser"
SET "permissions" = (
  SELECT ARRAY(
    SELECT DISTINCT unnest(p)
    FROM (
      SELECT
        CASE WHEN 'SuperAdmin' = ANY ("roles")
             THEN ARRAY['orders','products','categories','coupons','customers','reviews','reports','settings','admin-users']
             ELSE ARRAY[]::TEXT[] END
        ||
        CASE WHEN 'OperationsAdmin' = ANY ("roles")
             THEN ARRAY['orders','products','categories','coupons','customers','reviews','reports','settings']
             ELSE ARRAY[]::TEXT[] END
        ||
        CASE WHEN 'SupportAdmin' = ANY ("roles")
             THEN ARRAY['orders','products','categories','coupons','customers','reviews','reports','settings']
             ELSE ARRAY[]::TEXT[] END
        AS p
    ) sub
  )
);

ALTER TABLE "AdminUser"
  DROP COLUMN "roles";

-- Drop the default — new rows must specify permissions explicitly (the
-- application enforces min-1 at the route layer).
ALTER TABLE "AdminUser"
  ALTER COLUMN "permissions" DROP DEFAULT;
