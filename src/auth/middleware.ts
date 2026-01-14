import type { FastifyRequest } from "fastify";
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

	app.decorate("requireAuth", async (req: FastifyRequest) => {
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

	type AuthContext = NonNullable<FastifyRequest["auth"]>;

	function mustAuth(req: FastifyRequest): AuthContext {
		const auth = req.auth;
		if (!auth) throw unauthorized("Missing auth context");
		return auth;
	}

	app.decorate("requireRole", (roles: string[]) => {
		return async (req: FastifyRequest) => {
			const auth = mustAuth(req);
			const ok = roles.some((r) => auth.roles.includes(r));
			if (!ok) throw forbidden("Missing required role");
		};
	});
};

export const authPlugin = fp(authPluginImpl, { name: "auth" });
