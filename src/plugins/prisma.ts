import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";

const prismaPluginImpl: FastifyPluginAsync = async (app) => {
	const databaseUrl = process.env.DATABASE_URL;
	if (!databaseUrl) {
		throw new Error("Missing DATABASE_URL in environment");
	}

	const adapter = new PrismaPg({ connectionString: databaseUrl });
	const prisma = new PrismaClient({ adapter });

	app.decorate("prisma", prisma);

	app.addHook("onClose", async () => {
		await prisma.$disconnect();
	});
};

export const prismaPlugin = fp(prismaPluginImpl, { name: "prisma" });
