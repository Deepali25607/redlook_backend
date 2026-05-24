-- Open-box proof-of-delivery photo gallery captured by the rider/admin
-- at the Mark-Delivered step. Pre-existing orders default to an empty
-- array so the new column is always-readable JSON.

ALTER TABLE "Order"
  ADD COLUMN "delivery_photos" JSONB NOT NULL DEFAULT '[]';
