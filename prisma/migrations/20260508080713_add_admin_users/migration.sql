-- CreateTable
CREATE TABLE "Notification" (
    "notification_id" TEXT NOT NULL,
    "customer_id" TEXT,
    "channel" VARCHAR(20) NOT NULL,
    "to_address" VARCHAR(255) NOT NULL,
    "template" VARCHAR(100) NOT NULL,
    "subject" VARCHAR(200),
    "body" TEXT,
    "status" VARCHAR(20) NOT NULL DEFAULT 'queued',
    "provider" VARCHAR(50),
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sent_at" TIMESTAMP(3),

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("notification_id")
);

-- CreateTable
CREATE TABLE "AdminUser" (
    "admin_id" TEXT NOT NULL,
    "full_name" VARCHAR(100) NOT NULL,
    "email" VARCHAR(150) NOT NULL,
    "password_hash" VARCHAR(255) NOT NULL,
    "role" VARCHAR(30) NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'Active',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_login" TIMESTAMP(3),

    CONSTRAINT "AdminUser_pkey" PRIMARY KEY ("admin_id")
);

-- CreateTable
CREATE TABLE "AdminSession" (
    "token" TEXT NOT NULL,
    "admin_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdminSession_pkey" PRIMARY KEY ("token")
);

-- CreateIndex
CREATE INDEX "Notification_customer_id_idx" ON "Notification"("customer_id");

-- CreateIndex
CREATE INDEX "Notification_status_idx" ON "Notification"("status");

-- CreateIndex
CREATE UNIQUE INDEX "AdminUser_email_key" ON "AdminUser"("email");

-- AddForeignKey
ALTER TABLE "AdminSession" ADD CONSTRAINT "AdminSession_admin_id_fkey" FOREIGN KEY ("admin_id") REFERENCES "AdminUser"("admin_id") ON DELETE CASCADE ON UPDATE CASCADE;
