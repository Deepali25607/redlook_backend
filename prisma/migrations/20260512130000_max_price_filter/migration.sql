-- BusinessSettings.max_price_filter_* — admin controls for the storefront
-- "Max price" slider on the All vegetables / category shop pages.
--   max_price_filter_auto = true  → backend resolves the cap from
--     MAX(price_per_unit) over Active products at request time, so the
--     slider always covers everything in the catalog without manual
--     bookkeeping. The stored max_price_filter_cap is ignored in this mode.
--   max_price_filter_auto = false → use the admin-entered cap verbatim
--     (lets the admin clamp the visible price range below catalog max,
--     useful for promos or to hide an outlier SKU from the slider).
ALTER TABLE "BusinessSettings"
  ADD COLUMN "max_price_filter_auto" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "max_price_filter_cap" DECIMAL(10, 2) NOT NULL DEFAULT 150;
