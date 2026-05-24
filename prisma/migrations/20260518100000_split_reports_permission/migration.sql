-- Split the bundled 'reports' permission into four per-tile permissions:
--   reports          → main Reports dashboards (sales/inventory/customers/revenue)
--   accounting       → BRD §6 credit-accounting dashboard
--   customer-report  → per-customer sales/quantity/outstanding/credit-limit
--   b2b-customers    → "My B2B Customers" extract (business name + GSTIN)
--
-- Every existing AdminUser holding 'reports' is auto-granted the three new
-- permissions so nobody loses access on deploy. After this migration, the
-- SuperAdmin can revoke any of the four independently from the Edit-admin
-- modal.
--
-- Idempotent: re-running this is a no-op because array_agg(DISTINCT) collapses
-- duplicates, and the WHERE filter only touches rows that have 'reports'.

UPDATE "AdminUser"
SET "permissions" = (
  SELECT array_agg(DISTINCT p ORDER BY p)
  FROM unnest("permissions" || ARRAY['accounting','customer-report','b2b-customers']::text[]) AS p
)
WHERE 'reports' = ANY("permissions");
