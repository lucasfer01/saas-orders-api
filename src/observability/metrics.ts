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
	// Si la respuesta será 404, devolver 'unmatched' como label
	const reply = (req as any).raw?.__metricsReply;
	if (reply && reply.statusCode === 404) return "unmatched";
	if ((req as FastifyRequest & { routerPath?: string }).routerPath) {
		return (req as FastifyRequest & { routerPath?: string }).routerPath;
	}
	if (req.routeOptions?.url) {
		return req.routeOptions.url;
	}
	return req.url;
}

const metricsPluginImpl: FastifyPluginAsync = async (app) => {
	app.addHook("onRequest", async (req, reply) => {
		// Guardar referencia a reply para saber el status en el label
		(req as any).raw.__metricsReply = reply;
		// Si la ruta no existe, usar 'unmatched' en el label del histograma
		const is404 = reply && reply.statusCode === 404;
		const route = is404 ? "unmatched" : routeLabel(req);
		const end = httpRequestDuration.startTimer({
			method: req.method,
			route,
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
			const is404 = reply.statusCode === 404;
			const route = is404 ? "unmatched" : routeLabel(req) || "unmatched";
			httpRequestsTotal.inc({
				method: req.method,
				route,
				status: String(reply.statusCode),
			});
			if (end) end({ route }); // Forzar el label correcto en el histograma
		} finally {
			// end ya llamado arriba
		}
	});

	app.get("/metrics", async (_req, reply) => {
		// Protección opcional por token estático
		const METRICS_TOKEN = process.env.METRICS_TOKEN;
		if (METRICS_TOKEN) {
			const token = _req.headers["x-metrics-token"];
			const tokenStr = Array.isArray(token) ? token[0] : token;
			if (tokenStr !== METRICS_TOKEN) {
				return reply.status(401).send({
					error: { code: "UNAUTHORIZED", message: "Unauthorized" },
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
