-- AlterTable: 5-hour lead time before a delivery slot opens, admin-editable
-- via /api/admin/settings. Default chosen to give kitchen + dispatch enough
-- runway; admin can tighten or relax it without a deploy.
ALTER TABLE "BusinessSettings"
  ADD COLUMN "delivery_slot_buffer_hours" INTEGER NOT NULL DEFAULT 5;
