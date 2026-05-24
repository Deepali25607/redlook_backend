-- AlterTable: extend the singleton BusinessSettings row with delivery-side
-- thresholds. Defaults match the previous hardcoded values in routes/orders.js
-- so existing rows behave identically until the admin saves a change.
ALTER TABLE "BusinessSettings"
  ADD COLUMN "delivery_charge"    DECIMAL(10,2) NOT NULL DEFAULT 40,
  ADD COLUMN "free_delivery_over" DECIMAL(10,2) NOT NULL DEFAULT 299;
