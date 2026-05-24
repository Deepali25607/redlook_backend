-- BusinessSettings.return_window_message — admin-editable customer-facing
-- copy that explains the return policy. Surfaced on the order tracking
-- page alongside the Request Return CTA. Nullable: blank = no policy line.
ALTER TABLE "BusinessSettings"
  ADD COLUMN "return_window_message" VARCHAR(500);
