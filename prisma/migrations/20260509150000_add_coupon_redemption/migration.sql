-- One-redemption-per-customer-per-coupon, enforced by a unique index. The
-- order placement transaction creates the row; the constraint guarantees the
-- second attempt fails with a 23505 even under concurrent submits.
CREATE TABLE "CouponRedemption" (
    "id"          TEXT NOT NULL,
    "coupon_id"   TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "order_id"    TEXT,
    "redeemed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CouponRedemption_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CouponRedemption_coupon_id_customer_id_key"
    ON "CouponRedemption"("coupon_id", "customer_id");

CREATE INDEX "CouponRedemption_customer_id_idx"
    ON "CouponRedemption"("customer_id");

ALTER TABLE "CouponRedemption" ADD CONSTRAINT "CouponRedemption_coupon_id_fkey"
    FOREIGN KEY ("coupon_id") REFERENCES "Coupon"("coupon_id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CouponRedemption" ADD CONSTRAINT "CouponRedemption_customer_id_fkey"
    FOREIGN KEY ("customer_id") REFERENCES "Customer"("customer_id") ON DELETE CASCADE ON UPDATE CASCADE;
