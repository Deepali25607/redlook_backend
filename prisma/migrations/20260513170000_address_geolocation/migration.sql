-- Capture customer-device GPS at address save / order placement so the
-- delivery person sees a precise map pin in admin order details. Three
-- new columns on Address; the existing latitude/longitude (which were
-- populated by server-side Nominatim geocoding) now coexist with
-- 'device'-sourced coords. Order.address_snapshot already carries
-- arbitrary JSON so no schema change is needed there — the snapshot just
-- starts including the new fields going forward.

ALTER TABLE "Address"
  ADD COLUMN "location_source"      VARCHAR(10),
  ADD COLUMN "location_accuracy"    DOUBLE PRECISION,
  ADD COLUMN "location_captured_at" TIMESTAMP(3);
