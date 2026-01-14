import "dotenv/config";
import { z } from "zod";

const EnvSchema = z.object({
	NODE_ENV: z
		.enum(["development", "test", "production"])
		.default("development"),
	PORT: z.coerce.number().int().min(1).max(65535).default(3001),
	DATABASE_URL: z.string().min(1),
	REDIS_URL: z.string().min(1),
	RATE_LIMIT_GLOBAL_MAX: z.coerce.number().int().min(1).default(1000),
	RATE_LIMIT_GLOBAL_TIME_WINDOW: z.coerce.number().int().min(1).default(60_000),
	RATE_LIMIT_LOGIN_MAX: z.coerce.number().int().min(1).default(10),
	RATE_LIMIT_LOGIN_TIME_WINDOW: z.coerce.number().int().min(1).default(60_000),
	RATE_LIMIT_REGISTER_MAX: z.coerce.number().int().min(1).default(5),
	RATE_LIMIT_REGISTER_TIME_WINDOW: z.coerce
		.number()
		.int()
		.min(1)
		.default(60_000),
	RATE_LIMIT_REFRESH_MAX: z.coerce.number().int().min(1).default(20),
	RATE_LIMIT_REFRESH_TIME_WINDOW: z.coerce
		.number()
		.int()
		.min(1)
		.default(60_000),
	RATE_LIMIT_PAYMENTS_MAX: z.coerce.number().int().min(1).default(30),
	RATE_LIMIT_PAYMENTS_TIME_WINDOW: z.coerce
		.number()
		.int()
		.min(1)
		.default(60_000),
});

const parsed = EnvSchema.parse(process.env);

// Ajustes para entorno de test para evitar flakiness global
if (parsed.NODE_ENV === "test") {
	// Elevar el límite global y de register para que los tests no caigan en 429
	parsed.RATE_LIMIT_GLOBAL_MAX = Math.max(parsed.RATE_LIMIT_GLOBAL_MAX, 100000);
	parsed.RATE_LIMIT_REGISTER_MAX = Math.max(
		parsed.RATE_LIMIT_REGISTER_MAX,
		10000,
	);

	// Reducir el límite de login y ventana para que el test de rate-limit
	// alcance 429 rápidamente y de forma determinística
	parsed.RATE_LIMIT_LOGIN_MAX = Math.min(parsed.RATE_LIMIT_LOGIN_MAX, 3);
	parsed.RATE_LIMIT_LOGIN_TIME_WINDOW = Math.min(
		parsed.RATE_LIMIT_LOGIN_TIME_WINDOW,
		2000,
	);
}

export const env = parsed;
