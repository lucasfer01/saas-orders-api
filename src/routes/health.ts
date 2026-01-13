import type { FastifyPluginAsync } from "fastify";

export const healthRoutes: FastifyPluginAsync = async (app) => {
	app.get("/health", async () => {
		return { ok: true };
	});

	app.get("/ready", async () => {
		await app.prisma.$queryRaw`SELECT 1`;
		const pong = await app.redis.ping();

		return {
			ok: true,
			db: "ok",
			redis: pong === "PONG" ? "ok" : "unknown",
		};
	});
};
