import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import Redis from "ioredis";
import { env } from "../config/env.js";

const redisPluginImpl: FastifyPluginAsync = async (app) => {
	const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 2 });

	app.decorate("redis", redis);

	app.addHook("onClose", async () => {
		try {
			await redis.quit();
		} catch {
			redis.disconnect();
		}
	});
};

export const redisPlugin = fp(redisPluginImpl, { name: "redis" });
