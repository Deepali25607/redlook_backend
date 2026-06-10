-- Frequently-Bought-Together / cross-sell rules on the singleton
-- BusinessSettings row. Additive, non-breaking: defaults to an empty array so
-- existing installs behave exactly as before (no suggestion modal) until an
-- admin configures a rule under Settings → Frequently Bought Together.
ALTER TABLE "BusinessSettings"
  ADD COLUMN "cross_sell_rules" JSONB NOT NULL DEFAULT '[]';
