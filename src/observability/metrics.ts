import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import promClient from "prom-client";
import { env } from "../config/env.js";

const register = new promClient.Registry();
promClient.collectDefaultMetrics({ register });

// HTTP metrics
export const httpRequestsTotal = new promClient.Counter({
	name: "http_requests_total",
	help: "Total HTTP requests",
	labelNames: ["method", "route", "status"] as const,
});
export const httpRequestDuration = new promClient.Histogram({
	name: "http_request_duration_ms",
	help: "HTTP request duration in ms",
	labelNames: ["method", "route"] as const,
	buckets: [5, 10, 25, 50, 100, 250, 500, 1000, 2000, 5000],
});

// Outbox metrics
export const outboxEventsTotal = new promClient.Counter({
	name: "outbox_events_total",
	help: "Outbox events processed",
	labelNames: ["type", "status"] as const,
});
export const outboxPendingCount = new promClient.Gauge({
	name: "outbox_pending_count",
	help: "Number of pending outbox events",
});

// Payments metrics
export const paymentRequestsTotal = new promClient.Counter({
	name: "payment_requests_total",
	help: "Payments requests by final status",
	labelNames: ["status"] as const,
});
export const paymentIdempotentReplayTotal = new promClient.Counter({
	name: "payment_idempotent_replay_total",
	help: "Idempotent replays for payments",
});

register.registerMetric(httpRequestsTotal);
register.registerMetric(httpRequestDuration);
register.registerMetric(outboxEventsTotal);
register.registerMetric(outboxPendingCount);
register.registerMetric(paymentRequestsTotal);
register.registerMetric(paymentIdempotentReplayTotal);

function routeLabel(req: FastifyRequest) {
	return (
		(req as FastifyRequest & { routerPath?: string }).routerPath ||
		req.routeOptions?.url ||
		req.url
	);
}

const metricsPluginImpl: FastifyPluginAsync = async (app) => {
	app.addHook("onRequest", async (req) => {
		const end = httpRequestDuration.startTimer({
			method: req.method,
			route: routeLabel(req),
		});
		(
			req as FastifyRequest & {
				__metricsEnd?: (labels?: Record<string, string>) => void;
			}
		).__metricsEnd = end;
	});

	app.addHook("onResponse", async (req, reply) => {
		const end = (
			req as FastifyRequest & {
				__metricsEnd?: (labels?: Record<string, string>) => void;
			}
		).__metricsEnd;
		try {
			httpRequestsTotal.inc({
				method: req.method,
				route: routeLabel(req),
				status: String(reply.statusCode),
			});
		} finally {
			if (end) end({});
		}
	});

	app.get("/metrics", async (_req, reply) => {
		// Protección opcional por token estático
		if (env.METRICS_TOKEN) {
			const token = _req.headers["x-metrics-token"];
			const tokenStr = Array.isArray(token) ? token[0] : token;
			if (tokenStr !== env.METRICS_TOKEN) {
				return reply.status(403).send({
					error: { code: "FORBIDDEN", message: "Invalid metrics token" },
				});
			}
		}

		const body = await register.metrics();
		reply.header("Content-Type", register.contentType);
		return reply.send(body);
	});
};

export const metricsPlugin = fp(metricsPluginImpl, {
	name: "observability-metrics",
});
export { register as metricsRegistry };
