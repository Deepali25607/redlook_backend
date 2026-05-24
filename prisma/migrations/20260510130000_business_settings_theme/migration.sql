-- Add the active site-wide theme to BusinessSettings.
-- Existing rows get 'emerald' (the default theme matching the prior look).
ALTER TABLE "BusinessSettings"
  ADD COLUMN "theme" VARCHAR(20) NOT NULL DEFAULT 'emerald';
