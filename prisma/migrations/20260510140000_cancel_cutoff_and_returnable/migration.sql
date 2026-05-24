-- BusinessSettings.cancellation_cutoff_status — first order_status at which
-- cancellation becomes blocked. Default 'Out for Delivery' preserves the
-- prior policy (cancel allowed up to and including 'Packed').
ALTER TABLE "BusinessSettings"
  ADD COLUMN "cancellation_cutoff_status" VARCHAR(20) NOT NULL DEFAULT 'Out for Delivery';

-- Product.is_returnable — per-product return eligibility. Default true
-- preserves the prior (everything returnable) behaviour for existing rows.
ALTER TABLE "Product"
  ADD COLUMN "is_returnable" BOOLEAN NOT NULL DEFAULT true;
