-- AlterTable: phone-OTP replaces email-OTP as the registration-time
-- verification gate. The email_otp_* columns added in
-- 20260509180000_add_email_otp_columns are dropped; the equivalent
-- phone_otp_* columns are added.
--
-- Backfill phone_verified=true for every existing customer so we don't
-- lock anyone out the moment the gate flips from email_verified to
-- phone_verified at /auth/login. Some of these customers came in via the
-- pre-OTP mock path which already set phone_verified=true; some came in
-- during the email-OTP-only window with phone_verified still false.
-- Treating both groups as verified is a one-time safety net — every new
-- registration after this migration must verify a real phone OTP.

ALTER TABLE "Customer"
  DROP COLUMN "email_otp_hash",
  DROP COLUMN "email_otp_expires_at",
  DROP COLUMN "email_otp_attempts",
  DROP COLUMN "email_otp_issued_at";

ALTER TABLE "Customer"
  ADD COLUMN "phone_otp_hash"       VARCHAR(255),
  ADD COLUMN "phone_otp_expires_at" TIMESTAMP(3),
  ADD COLUMN "phone_otp_attempts"   INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "phone_otp_issued_at"  TIMESTAMP(3);

UPDATE "Customer" SET "phone_verified" = TRUE;
