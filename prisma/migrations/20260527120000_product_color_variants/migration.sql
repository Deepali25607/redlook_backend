-- Per-colour SKUs for a Product. Products with zero rows here behave
-- exactly like before (single SKU, stock on Product.stock_quantity).
-- Products with one or more variants:
--   - Stock lives on ProductVariant.stock
--   - Each variant has its OWN required photo gallery (no fallback to
--     parent product's images — admin must upload per colour)
--   - Cart/Order rows carry variant_id pointing at the specific colour
--     the customer chose

CREATE TABLE "ProductVariant" (
  "variant_id"  TEXT         NOT NULL,
  "product_id"  TEXT         NOT NULL,
  "color"       VARCHAR(60)  NOT NULL,
  "color_hex"   VARCHAR(7)   NOT NULL DEFAULT '#cccccc',
  "stock"       DECIMAL(10, 2) NOT NULL DEFAULT 0,
  "images"      TEXT[]       NOT NULL DEFAULT ARRAY[]::TEXT[],
  "status"      VARCHAR(20)  NOT NULL DEFAULT 'Active',
  "created_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ProductVariant_pkey" PRIMARY KEY ("variant_id")
);

CREATE INDEX "ProductVariant_product_id_idx" ON "ProductVariant"("product_id");
CREATE INDEX "ProductVariant_status_idx"     ON "ProductVariant"("status");

ALTER TABLE "ProductVariant"
  ADD CONSTRAINT "ProductVariant_product_id_fkey"
  FOREIGN KEY ("product_id") REFERENCES "Product"("product_id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Cart line items track which colour the customer picked. Nullable so
-- legacy carts on single-SKU products keep working with zero migration.
-- The old (cart_id, product_id) UNIQUE goes away — multiple colours of
-- the same product can coexist in a cart as separate lines. Dedup on
-- add-to-cart is enforced in app code via findFirst on the full tuple.
ALTER TABLE "CartItem"
  ADD COLUMN "variant_id" TEXT;

ALTER TABLE "CartItem"
  ADD CONSTRAINT "CartItem_variant_id_fkey"
  FOREIGN KEY ("variant_id") REFERENCES "ProductVariant"("variant_id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- Drop the legacy unique on (cart_id, product_id) — variants of the
-- same product need to live as separate cart lines now.
DROP INDEX IF EXISTS "CartItem_cart_id_product_id_key";

-- Keep a non-unique index so cart lookups by (cart, product) stay fast.
CREATE INDEX "CartItem_cart_id_product_id_idx" ON "CartItem"("cart_id", "product_id");

-- Order line items snapshot which colour was shipped. The `color`
-- string is denormalised at order time so renaming or deleting a
-- variant later doesn't rewrite history (or break the invoice PDF).
ALTER TABLE "OrderItem"
  ADD COLUMN "variant_id" TEXT,
  ADD COLUMN "color"      VARCHAR(60);

ALTER TABLE "OrderItem"
  ADD CONSTRAINT "OrderItem_variant_id_fkey"
  FOREIGN KEY ("variant_id") REFERENCES "ProductVariant"("variant_id")
  ON DELETE SET NULL ON UPDATE CASCADE;
