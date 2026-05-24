-- AlterTable: customer support contact fields, admin-editable via the
-- Settings page. All nullable so an admin can leave a channel blank
-- (e.g. no WhatsApp yet) and the storefront widget will simply not render
-- that button.
ALTER TABLE "BusinessSettings"
  ADD COLUMN "support_phone"    VARCHAR(20),
  ADD COLUMN "support_whatsapp" VARCHAR(20),
  ADD COLUMN "support_email"    VARCHAR(150),
  ADD COLUMN "support_message"  VARCHAR(500);
