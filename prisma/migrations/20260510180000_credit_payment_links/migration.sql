-- BRD §7 Phase 3 — Razorpay payment links per credit invoice.
--
-- A "payment link" lets the customer click "Pay now" on an unpaid DEBIT and
-- complete payment via UPI / card / netbanking through Razorpay's hosted
-- page. The link id (`plink_xxx`) is the join key the webhook uses to find
-- which invoice was paid; the short URL is what we hand the customer.
--
-- Both columns are nullable: most DEBITs (including all historic ones) will
-- not have a link, and a link is only minted on demand when the customer
-- first clicks "Pay now". Re-clicks before expiry reuse the same link
-- instead of stacking duplicates.

ALTER TABLE "CreditTransaction"
  ADD COLUMN "razorpay_payment_link_id"  VARCHAR(50),
  ADD COLUMN "razorpay_payment_link_url" VARCHAR(500);

-- Webhook lookup hits this index on every payment_link.paid event.
CREATE INDEX "CreditTransaction_razorpay_payment_link_id_idx"
  ON "CreditTransaction"("razorpay_payment_link_id");
