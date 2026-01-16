import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import { trace, SpanStatusCode, SpanKind } from "@opentelemetry/api";
import { env } from "../config/env.js";

type AuthContext = NonNullable<FastifyRequest["auth"]>;

const startHrTime = Symbol("startHrTime");
const reqSpanSymbol = Symbol("reqSpan");

export type LogContext = {
	requestId: string | number;
	method: string;
	route: string;
	url: string;
	tenantId?: string;
	userId?: string;
};

export function getLogContext(req: FastifyRequest): LogContext {
	const auth = req.auth;
	const route = (req as any).routerPath || req.routeOptions?.url || req.url;
	return {
		requestId: req.id,
		method: req.method,
		route,
		url: req.url,
		tenantId: auth?.tenantId,
		userId: auth?.userId,
	};
}

function sanitizeError(err: unknown) {
	if (err && typeof err === "object") {
		return err;
	}
	return { message: String(err) };
}

const loggerPluginImpl: FastifyPluginAsync = async (app) => {
	app.addHook("onRequest", async (req) => {
		// marcar inicio de request
		(req as any)[startHrTime] = process.hrtime.bigint();
		// log de inicio minimal
		const ctx = getLogContext(req);
		app.log.info({ ...ctx }, "request start");

		// Tracing root span por request
		if (env.OTEL_ENABLED) {
			const tracer = trace.getTracer("saas-orders-api");
			const hostHeader =
				typeof req.headers.host === "string" ? req.headers.host : undefined;
			const [hostFromHeader, portFromHeader] = hostHeader?.includes(":")
				? ((): [string | undefined, number | undefined] => {
						const [h, p] = hostHeader.split(":");
						const n = Number(p);
						return [h, Number.isNaN(n) ? undefined : n];
					})()
				: [hostHeader, undefined];
			const serverAddress =
				hostFromHeader || (req as any).hostname || undefined;
			const serverPort =
				portFromHeader || (req.socket as any)?.localPort || undefined;
			const httpScheme = (req as any).protocol || undefined;
			const peerIp = (req as any).ip as string | undefined;
			const peerPort = (req.socket as any)?.remotePort as number | undefined;
			const userAgent =
				typeof req.headers["user-agent"] === "string"
					? req.headers["user-agent"]
					: undefined;

			const span = tracer.startSpan("http.request", {
				kind: SpanKind.SERVER,
				attributes: {
					"http.method": req.method,
					"http.route": ctx.route,
					"http.target": req.url,
					"http.scheme": httpScheme ?? "",
					"server.address": serverAddress ?? "",
					"server.port": serverPort ?? undefined,
					"net.peer.ip": peerIp ?? "",
					"net.peer.port": peerPort ?? undefined,
					"user_agent.original": userAgent ?? "",
					"saas.tenant_id": ctx.tenantId ?? "",
					"saas.user_id": ctx.userId ?? "",
				},
			});
			(req as any)[reqSpanSymbol] = span;
		}
	});

	app.addHook("onResponse", async (req, reply) => {
		const start = (req as any)[startHrTime] as bigint | undefined;
		const tookMs = start
			? Number((process.hrtime.bigint() - start) / 1_000_000n)
			: undefined;
		const ctx = getLogContext(req);
		app.log.info(
			{
				...ctx,
				statusCode: reply.statusCode,
				responseTimeMs: tookMs,
			},
			"request end",
		);

		const span = (req as any)[reqSpanSymbol];
		if (span) {
			try {
				span.setAttribute("http.status_code", reply.statusCode);
				span.end();
			} catch {
				// ignore
			}
		}
	});

	app.addHook("onError", async (req, _reply, error) => {
		const ctx = getLogContext(req);
		app.log.error(
			{
				...ctx,
				err: sanitizeError(error),
			},
			"request error",
		);

		const span = (req as any)[reqSpanSymbol];
		if (span) {
			try {
				span.setStatus({
					code: SpanStatusCode.ERROR,
					message: (error as Error)?.message,
				});
				span.recordException(error as Error);
			} catch {
				// ignore
			} finally {
				try {
					span.end();
				} catch {}
			}
		}
	});
};

export const loggerPlugin = fp(loggerPluginImpl, {
	name: "observability-logger",
});
