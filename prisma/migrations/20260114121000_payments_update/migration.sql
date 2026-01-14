-- Alter Payment model to support tenant-scoped idempotency and method

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('CASH', 'CARD', 'TRANSFER', 'OTHER');

-- AddColumns
ALTER TABLE "Payment" ADD COLUMN "tenantId" TEXT;
ALTER TABLE "Payment" ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "Payment" ADD COLUMN "method" "PaymentMethod" NOT NULL DEFAULT 'CASH';

-- Backfill tenantId from Order if needed (assuming no existing rows or using join)
-- For safety, set tenantId via join
UPDATE "Payment" p
SET "tenantId" = o."tenantId"
FROM "Order" o
WHERE p."orderId" = o."id" AND p."tenantId" IS NULL;

-- Set NOT NULL after backfill
ALTER TABLE "Payment" ALTER COLUMN "tenantId" SET NOT NULL;

-- Drop old unique and create new unique by (tenantId, idempotencyKey)
DROP INDEX IF EXISTS "Payment_orderId_idempotencyKey_key";
CREATE UNIQUE INDEX "Payment_tenantId_idempotencyKey_key" ON "Payment"("tenantId", "idempotencyKey");

-- Indexes
CREATE INDEX IF NOT EXISTS "Payment_tenantId_idx" ON "Payment"("tenantId");

-- Foreign keys
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
