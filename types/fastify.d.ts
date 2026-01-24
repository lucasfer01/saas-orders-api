// src/types/fastify.d.ts
import "fastify";

declare module "fastify" {
	interface AuthContext {
		userId: string;
		tenantId: string;
		roles: string[];
	}

	interface FastifyRequest {
		auth?: AuthContext;
	}

	interface FastifyInstance {
		prisma: PrismaClient;
		redis: Redis;
		requireAuth(this: FastifyInstance, req: FastifyRequest): Promise<void>;
		requireRole(
			this: FastifyInstance,
			roles: string[],
		): (req: FastifyRequest) => Promise<void>;
	}
}
