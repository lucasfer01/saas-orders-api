// ...existing code...
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import fastifyCors from '@fastify/cors';
import { Prisma } from "@prisma/client";
import type { FastifyRequest } from "fastify";
import Fastify from "fastify";
import { ZodError } from "zod";
import { authPlugin } from "./auth/middleware.js";
import { env } from "./config/env.js";
import { ApiError, validationError } from "./http/errors.js";
import { authRoutes } from "./modules/auth/routes.js";
import { ordersRoutes } from "./modules/orders/routes.js";
import { paymentsRoutes } from "./modules/payments/routes.js";
import { productsRoutes } from "./modules/products/routes.js";
import receiptsRoutes from "./modules/receipts/routes.js";
import { loggerPlugin } from "./observability/logger.js";
import { metricsPlugin } from "./observability/metrics.js";
import { prismaPlugin } from "./plugins/prisma.js";
import { redisPlugin } from "./plugins/redis.js";
import { healthRoutes } from "./routes/health.js";

export function buildApp() {
	const app = Fastify({
		logger: {
			level: env.NODE_ENV === "production" ? "info" : "debug",
			transport:
				env.NODE_ENV === "production"
					? undefined
					: {
							target: "pino-pretty",
							options: {
								colorize: true,
								translateTime: "SYS:standard",
								ignore: "pid,hostname",
							},
						},
		},
	});

	app.setErrorHandler((err, _req, reply) => {
		// Zod validation errors
		if (err instanceof ZodError) {
			const details = {
				issues: err.issues.map((i) => ({
					path: i.path,
					message: i.message,
					code: i.code,
				})),
			};
			const apiErr = validationError("Validation error", details);
			return reply.status(apiErr.statusCode).send({
				error: {
					code: apiErr.code,
					message: apiErr.message,
					details: apiErr.details,
				},
			});
		}

		// Prisma unique constraint -> 409 CONFLICT
		if (
			err instanceof Prisma.PrismaClientKnownRequestError &&
			err.code === "P2002"
		) {
			const apiErr = new ApiError(
				409,
				"CONFLICT",
				"Unique constraint violation",
			);
			return reply.status(apiErr.statusCode).send({
				error: { code: apiErr.code, message: apiErr.message },
			});
		}

		// Rate limit standardized object from errorResponseBuilder
		if (typeof err === "object" && err !== null) {
			const maybe = err as {
				error?: { code?: string; message?: string; details?: unknown };
			};
			if (maybe.error?.code === "RATE_LIMITED") {
				return reply.status(429).send({ error: maybe.error });
			}
		}

		// ApiError controlado
		if (err instanceof ApiError) {
			return reply.status(err.statusCode).send({
				error: { code: err.code, message: err.message, details: err.details },
			});
		}

		app.log.error({ err }, "Unhandled error");
		return reply.status(500).send({
			error: { code: "INTERNAL_ERROR", message: "Unexpected error" },
		});
	});

	// CORS
	app.register(fastifyCors, {
		origin: 'http://localhost:8080',
		methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
		credentials: true
	});

	// Security headers
	app.register(helmet, {
		global: true,
		frameguard: { action: "deny" },
		hidePoweredBy: true,
		noSniff: true,
		xssFilter: true,
		referrerPolicy: { policy: "no-referrer" },
	});

	// Rate limiting
	app.register(rateLimit, {
		global: true,
		max: env.RATE_LIMIT_GLOBAL_MAX,
		timeWindow: env.RATE_LIMIT_GLOBAL_TIME_WINDOW,
		keyGenerator: (req: FastifyRequest) => req.ip,
		errorResponseBuilder: (_req: FastifyRequest, context: unknown) => {
			const ctx = context as { max?: number; timeWindow?: number };
			return {
				error: {
					code: "RATE_LIMITED",
					message: "Too many requests",
					details: { max: ctx.max, timeWindow: ctx.timeWindow },
				},
			};
		},
	});

	app.register(prismaPlugin);
	app.register(redisPlugin);

	// Observability plugins
	app.register(loggerPlugin);
	app.register(metricsPlugin);

	app.register(authPlugin); // antes de rutas protegidas
	app.register(authRoutes);

	app.register(productsRoutes);

	app.register(ordersRoutes);
	app.register(receiptsRoutes);

	app.register(paymentsRoutes);

	app.register(healthRoutes);

	return app;
}
