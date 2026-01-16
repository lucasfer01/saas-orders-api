-- Outbox hardening: attempts, lastError, nextRunAt
ALTER TABLE "OutboxEvent"
  ADD COLUMN IF NOT EXISTS "attempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "lastError" TEXT,
  ADD COLUMN IF NOT EXISTS "nextRunAt" TIMESTAMP;