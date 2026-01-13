import "dotenv/config";
import { z } from "zod";

const EnvSchema = z.object({
	NODE_ENV: z
		.enum(["development", "test", "production"])
		.default("development"),
	PORT: z.coerce.number().int().min(1).max(65535).default(3001),
	DATABASE_URL: z.string().min(1),
	REDIS_URL: z.string().min(1),
});

export const env = EnvSchema.parse(process.env);
