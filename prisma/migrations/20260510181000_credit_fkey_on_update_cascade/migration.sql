-- DropForeignKey
ALTER TABLE "CreditTransaction" DROP CONSTRAINT "CreditTransaction_customer_id_fkey";

-- DropForeignKey
ALTER TABLE "CreditTransaction" DROP CONSTRAINT "CreditTransaction_order_id_fkey";

-- DropForeignKey
ALTER TABLE "CustomerCreditConfig" DROP CONSTRAINT "CustomerCreditConfig_customer_id_fkey";

-- DropForeignKey
ALTER TABLE "PaymentReceived" DROP CONSTRAINT "PaymentReceived_customer_id_fkey";

-- AddForeignKey
ALTER TABLE "CustomerCreditConfig" ADD CONSTRAINT "CustomerCreditConfig_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "Customer"("customer_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditTransaction" ADD CONSTRAINT "CreditTransaction_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "Customer"("customer_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditTransaction" ADD CONSTRAINT "CreditTransaction_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "Order"("order_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentReceived" ADD CONSTRAINT "PaymentReceived_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "Customer"("customer_id") ON DELETE CASCADE ON UPDATE CASCADE;
