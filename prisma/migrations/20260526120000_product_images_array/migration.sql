-- Multi-image product support. The legacy `image` column stays
-- (it backs every list/cart/order thumbnail), and the new `images`
-- text array holds the full gallery shown on the product detail page.
--
-- Convention enforced by routes/adminProducts.js on every write:
--   images[0] === image
-- So clients that only read `image` keep working unchanged.
--
-- Backfill: copy each existing product's single image into images[]
-- so detail pages render the same image as before until an admin
-- uploads more. Emoji-only products (e.g. "🥻") also get backfilled
-- — that just means the gallery has one "image" which the customer
-- detail page renders as the emoji fallback.

ALTER TABLE "Product"
  ADD COLUMN "images" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

UPDATE "Product"
  SET "images" = ARRAY["image"]
  WHERE "image" IS NOT NULL
    AND "image" <> '';
