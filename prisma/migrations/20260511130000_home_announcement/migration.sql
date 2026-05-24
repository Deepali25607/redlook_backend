-- Admin-editable announcement pill at the top of the home hero — the small
-- pulsing-dot strip that previously read "Free delivery on orders above ₹299".
-- Two columns instead of JSONB because there's only one announcement and it
-- only carries a toggle + a string (no nested shape worth schema-validating).
-- Defaults preserve the prior hardcoded copy so a fresh install looks the
-- same as before.
ALTER TABLE "BusinessSettings"
  ADD COLUMN "home_announcement_enabled" BOOLEAN      NOT NULL DEFAULT TRUE,
  ADD COLUMN "home_announcement_text"    VARCHAR(200) NOT NULL DEFAULT 'Free delivery on orders above ₹299';
