-- AlterTable: Razorpay handles on Order. Both nullable — COD orders never
-- populate them, and online-payment orders get razorpay_order_id at creation
-- time and razorpay_payment_id only after /api/payments/verify confirms the
-- HMAC signature.
ALTER TABLE "Order"
  ADD COLUMN "razorpay_order_id"   VARCHAR(40),
  ADD COLUMN "razorpay_payment_id" VARCHAR(40);
