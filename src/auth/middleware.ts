import type { FastifyPluginAsync } from "fastify/types/plugin";
import fp from "fastify-plugin";
import { ApiError } from "../http/errors.js";
import { verifyAccessToken } from "./jwt.js";

function unauthorized(message = "Unauthorized") {
	return new ApiError(401, "UNAUTHORIZED", message);
}

function forbidden(message = "Forbidden") {
	return new ApiError(403, "FORBIDDEN", message);
}

const authPluginImpl: FastifyPluginAsync = async (app) => {
	app.decorateRequest("auth", undefined);

	app.decorate("requireAuth", async (req: any) => {
		const header = req.headers.authorization;
		if (
			!header ||
			typeof header !== "string" ||
			!header.startsWith("Bearer ")
		) {
			throw unauthorized("Missing Bearer token");
		}

		const token = header.slice("Bearer ".length).trim();
		try {
			const payload = verifyAccessToken(token);
			req.auth = {
				userId: payload.sub,
				tenantId: payload.tenantId,
				roles: payload.roles ?? [],
			};
		} catch {
			throw unauthorized("Invalid or expired token");
		}
	});

	app.decorate("requireRole", (roles: string[]) => {
		return async (req: any) => {
			if (!req.auth) throw unauthorized("Missing auth context");
			const ok = roles.some((r) => req.auth.roles.includes(r));
			if (!ok) throw forbidden("Insufficient role");
		};
	});
};

declare module "fastify" {
	interface FastifyInstance {
		requireAuth: (req: unknown) => Promise<void>;
		requireRole: (roles: string[]) => (req: unknown) => Promise<void>;
	}
}

export const authPlugin = fp(authPluginImpl, { name: "auth" });
