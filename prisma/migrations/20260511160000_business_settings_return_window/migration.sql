-- BusinessSettings.return_window_hours — hours after delivery during which
-- a return can still be filed. Default 24 preserves the pre-existing
-- hardcoded policy that lived in routes/orders.js.
ALTER TABLE "BusinessSettings"
  ADD COLUMN "return_window_hours" INTEGER NOT NULL DEFAULT 24;
