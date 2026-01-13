import Fastify from "fastify";
import { ZodError } from "zod";
import { authPlugin } from "./auth/middleware.js";
import { env } from "./config/env.js";
import { ApiError } from "./http/errors.js";
import { authRoutes } from "./modules/auth/routes.js";
import { productsRoutes } from "./modules/products/routes.js";
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
		// Zod validation errors (si usás parse/parseAsync)
		if (err instanceof ZodError) {
			return reply.status(400).send({
				error: "BAD_REQUEST",
				message: "Validation error",
				details: err.flatten(),
			});
		}

		// ApiError controlado
		if (err instanceof ApiError) {
			return reply.status(err.statusCode).send({
				error: err.code,
				message: err.message,
				details: err.details,
			});
		}

		app.log.error({ err }, "Unhandled error");
		return reply.status(500).send({
			error: "INTERNAL_SERVER_ERROR",
			message: "Unexpected error",
		});
	});

	app.register(prismaPlugin);
	app.register(redisPlugin);

	app.register(authPlugin); // antes de rutas protegidas
	app.register(authRoutes);

	app.register(productsRoutes);

	app.register(healthRoutes);

	return app;
}
