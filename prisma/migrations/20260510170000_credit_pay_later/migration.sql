-- ============================================================
-- Credit / Pay-Later system (BRD §9 Data Model)
-- ============================================================
-- Adds:
--   * Customer.customer_type / business_name / gstin (B2B vs B2C)
--   * BusinessSettings.credit_overdue_block_days (policy threshold)
--   * CustomerCreditConfig (per-customer credit setup)
--   * CreditTransaction (append-only ledger)
--   * PaymentReceived (incoming payments + FIFO allocation)
-- All money columns Decimal(12,2) — wider than the rest of the schema
-- (10,2) because a single B2B credit limit can plausibly run into seven
-- digits where order subtotals stay in five.

-- ---------- Customer additions ----------
ALTER TABLE "Customer"
  ADD COLUMN "customer_type" VARCHAR(10) NOT NULL DEFAULT 'B2C',
  ADD COLUMN "business_name" VARCHAR(150),
  ADD COLUMN "gstin"         VARCHAR(15);

-- ---------- BusinessSettings: overdue block threshold ----------
ALTER TABLE "BusinessSettings"
  ADD COLUMN "credit_overdue_block_days" INTEGER NOT NULL DEFAULT 15;

-- ---------- CustomerCreditConfig ----------
CREATE TABLE "CustomerCreditConfig" (
  "customer_id"        TEXT          NOT NULL PRIMARY KEY,
  "credit_enabled"     BOOLEAN       NOT NULL DEFAULT FALSE,
  "credit_limit"       DECIMAL(12,2) NOT NULL DEFAULT 0,
  "payment_terms_days" INTEGER       NOT NULL DEFAULT 30,
  "terms_start_from"   VARCHAR(20)   NOT NULL DEFAULT 'delivery',
  "status"             VARCHAR(20)   NOT NULL DEFAULT 'active',
  "notes"              VARCHAR(1000),
  "created_by"         VARCHAR(150),
  "updated_by"         VARCHAR(150),
  "created_at"         TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"         TIMESTAMP(3)  NOT NULL,
  CONSTRAINT "CustomerCreditConfig_customer_id_fkey"
    FOREIGN KEY ("customer_id") REFERENCES "Customer"("customer_id") ON DELETE CASCADE
);

-- ---------- CreditTransaction ----------
CREATE TABLE "CreditTransaction" (
  "id"              TEXT          NOT NULL PRIMARY KEY,
  "customer_id"     TEXT          NOT NULL,
  "order_id"        TEXT,
  "type"            VARCHAR(15)   NOT NULL,
  "amount"          DECIMAL(12,2) NOT NULL,
  "amount_paid"     DECIMAL(12,2) NOT NULL DEFAULT 0,
  "running_balance" DECIMAL(12,2) NOT NULL,
  "due_date"        TIMESTAMP(3),
  "status"          VARCHAR(20)   NOT NULL DEFAULT 'PENDING',
  "notes"           VARCHAR(500),
  "created_by"      VARCHAR(150),
  "created_at"      TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"      TIMESTAMP(3)  NOT NULL,
  CONSTRAINT "CreditTransaction_customer_id_fkey"
    FOREIGN KEY ("customer_id") REFERENCES "Customer"("customer_id") ON DELETE CASCADE,
  CONSTRAINT "CreditTransaction_order_id_fkey"
    FOREIGN KEY ("order_id") REFERENCES "Order"("order_id") ON DELETE SET NULL
);

CREATE INDEX "CreditTransaction_customer_id_idx" ON "CreditTransaction"("customer_id");
CREATE INDEX "CreditTransaction_status_idx"      ON "CreditTransaction"("status");
CREATE INDEX "CreditTransaction_due_date_idx"    ON "CreditTransaction"("due_date");

-- ---------- PaymentReceived ----------
CREATE TABLE "PaymentReceived" (
  "id"                     TEXT          NOT NULL PRIMARY KEY,
  "customer_id"            TEXT          NOT NULL,
  "amount"                 DECIMAL(12,2) NOT NULL,
  "payment_date"           TIMESTAMP(3)  NOT NULL,
  "mode"                   VARCHAR(20)   NOT NULL,
  "reference_no"           VARCHAR(100),
  "applied_to_invoice_ids" JSONB         NOT NULL,
  "notes"                  VARCHAR(500),
  "created_by"             VARCHAR(150),
  "created_at"             TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PaymentReceived_customer_id_fkey"
    FOREIGN KEY ("customer_id") REFERENCES "Customer"("customer_id") ON DELETE CASCADE
);

CREATE INDEX "PaymentReceived_customer_id_idx"  ON "PaymentReceived"("customer_id");
CREATE INDEX "PaymentReceived_payment_date_idx" ON "PaymentReceived"("payment_date");
