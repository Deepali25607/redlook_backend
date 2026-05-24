-- CreateTable
CREATE TABLE "BusinessSettings" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "min_order_value" DECIMAL(10,2) NOT NULL DEFAULT 150,
    "min_order_quantity" INTEGER NOT NULL DEFAULT 1,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "updated_by" TEXT,

    CONSTRAINT "BusinessSettings_pkey" PRIMARY KEY ("id")
);

-- Seed the singleton row so any GET against /api/settings returns the
-- defaults until the admin saves their first change.
INSERT INTO "BusinessSettings" ("id", "min_order_value", "min_order_quantity", "updated_at")
VALUES (1, 150, 1, NOW())
ON CONFLICT ("id") DO NOTHING;
