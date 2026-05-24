-- Three-tier discount system.
--   Product.discount_percent       — per-SKU markdown (0-100)
--   Category.discount_percent      — applies to every product in the category
--   BusinessSettings.global_*      — platform-wide bulk discount with kill switch
-- Effective discount on a product = max of the three (best deal wins). The
-- storefront, cart, and order placement all run the same resolver so the
-- price the customer sees on the card is what they're charged at checkout.

ALTER TABLE "Product"
  ADD COLUMN "discount_percent" DECIMAL(5, 2) NOT NULL DEFAULT 0;

ALTER TABLE "Category"
  ADD COLUMN "discount_percent" DECIMAL(5, 2) NOT NULL DEFAULT 0;

ALTER TABLE "BusinessSettings"
  ADD COLUMN "global_discount_enabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "global_discount_percent" DECIMAL(5, 2) NOT NULL DEFAULT 0;
