-- Forgot-password OTP storage, separate from the phone_otp_* columns so a
-- mid-verification user can still receive a reset code without clobbering
-- their verification state (and vice versa). bcrypt hash of the 6-digit
-- code; expires_at + attempts + issued_at mirror the phone_otp shape so
-- the lockout-after-5-misses / resend-throttle helpers can be reused.
-- channel records whether the user picked email_otp or sms_otp so the
-- verify endpoint can audit the path the code took.
ALTER TABLE "Customer"
  ADD COLUMN "password_reset_otp_hash"       VARCHAR(255),
  ADD COLUMN "password_reset_otp_expires_at" TIMESTAMP(3),
  ADD COLUMN "password_reset_otp_attempts"   INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "password_reset_otp_issued_at"  TIMESTAMP(3),
  ADD COLUMN "password_reset_otp_channel"    VARCHAR(10);
