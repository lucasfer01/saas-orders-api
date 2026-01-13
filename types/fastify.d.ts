import "fastify";
import type { PrismaClient } from "@prisma/client";
import type Redis from "ioredis";
import type { FastifyRequest } from "fastify";

declare module "fastify" {
	interface FastifyInstance {
		prisma: PrismaClient;
		redis: Redis;

		requireAuth: (req: FastifyRequest) => Promise<void>;
		requireRole: (roles: string[]) => (req: FastifyRequest) => Promise<void>;
	}

	interface FastifyRequest {
		auth?: {
			userId: string;
			tenantId: string;
			roles: string[];
		};
	}
}
