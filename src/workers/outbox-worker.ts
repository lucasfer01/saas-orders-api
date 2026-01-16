import { PrismaPg } from "@prisma/adapter-pg";
import { type OutboxEvent, PrismaClient } from "@prisma/client";
import Redis from "ioredis";
import pino from "pino";
import { env } from "../config/env.js";
import {
	outboxEventsTotal,
	outboxPendingCount,
} from "../observability/metrics.js";
import { trace } from "@opentelemetry/api";
import { setupTracing, shutdownTracing } from "../observability/tracing.js";
import { pathToFileURL } from "node:url";

export type RunOutboxResult = {
	locked: boolean;
	processed: number;
	tookMs: number;
};

const LOCK_KEY = "outbox:lock";
const LOCK_TTL_SEC = 5;

export async function runOutboxOnce(options?: {
	batchSize?: number;
}): Promise<RunOutboxResult> {
	const start = Date.now();
	const batchSize = options?.batchSize ?? 50;

	const adapter = new PrismaPg({ connectionString: env.DATABASE_URL });
	const prisma = new PrismaClient({ adapter });
	const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 2 });
	const logger = pino({
		level: env.NODE_ENV === "production" ? "info" : "debug",
	});

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

		// update pending gauge
		try {
			const pending = await prisma.outboxEvent.count({
				where: { status: "PENDING" },
			});
			outboxPendingCount.set(pending);
		} catch {}

		let processed = 0;
		const tracer = trace.getTracer("saas-orders-api");
		const batchSpan = tracer.startSpan("outbox.batch");
		for (const ev of events) {
			try {
				const evSpan = tracer.startSpan("outbox.event", {
					attributes: { type: ev.type },
				});
				const attempts = (ev as unknown as { attempts?: number }).attempts ?? 0;
				logger.info(
					{ outboxEventId: ev.id, type: ev.type, attempt: attempts },
					"outbox: processing event",
				);
				await prisma.outboxEvent.update({
					where: { id: ev.id },
					data: { status: "PROCESSED" },
				});
				outboxEventsTotal.inc({ type: ev.type, status: "PROCESSED" });
				logger.info(
					{ outboxEventId: ev.id, type: ev.type },
					"outbox: PENDING->PROCESSED",
				);
				processed += 1;
				evSpan.end();
			} catch (error_) {
				const err = error_ as Error;
				const currAttempts =
					(ev as unknown as { attempts?: number }).attempts ?? 0;
				const nextAttempts = currAttempts + 1;
				const max = env.OUTBOX_MAX_ATTEMPTS;
				const failed = nextAttempts >= max;
				await prisma.outboxEvent.update({
					where: { id: ev.id },
					data: {
						attempts: nextAttempts,
						lastError: (err?.message || String(err)).slice(0, 1000),
						status: failed ? "FAILED" : "PENDING",
					} as any,
				});
				outboxEventsTotal.inc({
					type: ev.type,
					status: failed ? "FAILED" : "PENDING",
				});
				logger.error(
					{
						outboxEventId: ev.id,
						type: ev.type,
						attempt: nextAttempts,
						failed,
					},
					"outbox: process failed",
				);
			}
		}
		batchSpan.end();

		return { locked: false, processed, tookMs: Date.now() - start };
	} finally {
		try {
			await redis.quit();
		} catch {
			redis.disconnect();
		}
		await prisma.$disconnect();
	}
}

// Ejecutable manual
if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	setupTracing();
	runOutboxOnce()
		.then((r) => {
			// eslint-disable-next-line no-console
			console.log("Outbox run:", r);
		})
		.finally(async () => {
			await shutdownTracing();
		});
}
