-- OrderItem.mrp — snapshot of the pre-discount unit price at order
-- placement. unit_price already stores the price the customer was charged
-- (post-discount). Capturing MRP here lets the invoice and order-history
-- views show "you saved Rs. X" without recomputing against current product
-- pricing, which may have changed.
--
-- Defaults to 0 for existing rows; the invoice/savings logic treats
-- mrp <= unit_price as "no savings to display", so historical orders
-- placed before this column existed simply show no savings line.
ALTER TABLE "OrderItem"
  ADD COLUMN "mrp" DECIMAL(10, 2) NOT NULL DEFAULT 0;
