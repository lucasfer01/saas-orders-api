-- AlterTable (guarded: only if column exists)
DO $$
BEGIN
	IF EXISTS (
		SELECT 1
		FROM information_schema.columns
		WHERE table_schema = 'public'
			AND table_name = 'OutboxEvent'
			AND column_name = 'nextRunAt'
	) THEN
		ALTER TABLE "OutboxEvent" ALTER COLUMN "nextRunAt" SET DATA TYPE TIMESTAMP(3);
	END IF;
END $$;

-- AlterTable
ALTER TABLE "Payment" ALTER COLUMN "updatedAt" DROP DEFAULT,
ALTER COLUMN "method" DROP DEFAULT;
