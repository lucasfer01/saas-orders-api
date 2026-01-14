import Redis from "ioredis";
import { PrismaClient, type OutboxEvent } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { env } from "../config/env.js";

export type RunOutboxResult = {
  locked: boolean;
  processed: number;
  tookMs: number;
};

const LOCK_KEY = "outbox:lock";
const LOCK_TTL_SEC = 5;

export async function runOutboxOnce(options?: { batchSize?: number }): Promise<RunOutboxResult> {
  const start = Date.now();
  const batchSize = options?.batchSize ?? 50;

  const adapter = new PrismaPg({ connectionString: env.DATABASE_URL });
  const prisma = new PrismaClient({ adapter });
  const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 2 });

  try {
    const lock = await redis.set(LOCK_KEY, "1", "EX", LOCK_TTL_SEC, "NX");
    if (lock !== "OK") {
      return { locked: true, processed: 0, tookMs: Date.now() - start };
    }

    const events: OutboxEvent[] = await prisma.outboxEvent.findMany({
      where: { status: "PENDING" },
      orderBy: { createdAt: "asc" },
      take: batchSize,
    });

    if (events.length === 0) {
      return { locked: false, processed: 0, tookMs: Date.now() - start };
    }

    let processed = 0;
    for (const ev of events) {
      try {
        // Mock publish: for ahora solo loguear
        // eslint-disable-next-line no-console
        console.info({ eventId: ev.id, type: ev.type }, "outbox processed (mock)");

        await prisma.outboxEvent.update({
          where: { id: ev.id },
          data: { status: "PROCESSED" },
        });
        processed += 1;
      } catch (err) {
        await prisma.outboxEvent.update({
          where: { id: ev.id },
          data: { status: "FAILED" },
        });
      }
    }

    return { locked: false, processed, tookMs: Date.now() - start };
  } finally {
    // Dejar expirar el lock por TTL; best-effort cleanup
    try {
      await redis.quit();
    } catch {
      redis.disconnect();
    }
    await prisma.$disconnect();
  }
}

// Ejecutable manual
if (import.meta.url === `file://${process.argv[1]}`) {
  runOutboxOnce().then((r) => {
    // eslint-disable-next-line no-console
    console.log("Outbox run:", r);
  });
}
