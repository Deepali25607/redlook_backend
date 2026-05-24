-- Holds a sign-up in flight while we wait for OTP verification. Customer
-- row is created only after verify-otp succeeds, so the email/phone unique
-- slot isn't held by abandoned registrations.
CREATE TABLE "PendingRegistration" (
    "pending_id" TEXT NOT NULL,
    "full_name" VARCHAR(100) NOT NULL,
    "email" VARCHAR(150) NOT NULL,
    "phone" VARCHAR(15) NOT NULL,
    "password_hash" VARCHAR(255) NOT NULL,
    "date_of_birth" DATE,
    "gender" VARCHAR(10),
    "phone_otp_hash" VARCHAR(255) NOT NULL,
    "phone_otp_expires_at" TIMESTAMP(3) NOT NULL,
    "phone_otp_attempts" INTEGER NOT NULL DEFAULT 0,
    "phone_otp_issued_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PendingRegistration_pkey" PRIMARY KEY ("pending_id")
);

CREATE UNIQUE INDEX "PendingRegistration_email_key" ON "PendingRegistration"("email");
CREATE UNIQUE INDEX "PendingRegistration_phone_key" ON "PendingRegistration"("phone");
CREATE INDEX "PendingRegistration_created_at_idx" ON "PendingRegistration"("created_at");
