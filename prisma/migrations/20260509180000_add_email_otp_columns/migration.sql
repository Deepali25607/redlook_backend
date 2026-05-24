-- AlterTable: real email-OTP storage. Replaces the previous mock where any
-- 6-digit code passed verify-otp. Hash is bcrypt of the code; expires_at +
-- attempts + issued_at give us TTL, lockout after 5 misses, and resend
-- throttling respectively. All nullable so existing rows (created during
-- the mock period) keep working — they simply have no live OTP and will
-- need a fresh resend before they can verify.
ALTER TABLE "Customer"
  ADD COLUMN "email_otp_hash"       VARCHAR(255),
  ADD COLUMN "email_otp_expires_at" TIMESTAMP(3),
  ADD COLUMN "email_otp_attempts"   INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "email_otp_issued_at"  TIMESTAMP(3);
