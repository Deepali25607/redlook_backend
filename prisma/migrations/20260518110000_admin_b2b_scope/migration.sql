-- AdminUser.scoped_customer_id — FK to Customer, restricts the admin's
-- portal view to data belonging to that B2B customer. Null = unscoped
-- (default for internal staff and SuperAdmin).
--
-- ON DELETE SET NULL so deleting a B2B Customer downgrades any scoped
-- admin to "unscoped" rather than cascade-deleting their account. The
-- SuperAdmin can then re-point them or disable them as appropriate.

ALTER TABLE "AdminUser"
  ADD COLUMN "scoped_customer_id" TEXT;

ALTER TABLE "AdminUser"
  ADD CONSTRAINT "AdminUser_scoped_customer_id_fkey"
  FOREIGN KEY ("scoped_customer_id") REFERENCES "Customer"("customer_id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "AdminUser_scoped_customer_id_idx"
  ON "AdminUser"("scoped_customer_id");
