import { z } from "zod";

export const RegisterBody = z.object({
	tenantName: z.string().min(1).max(120),
	email: z.string().email().max(200),
	password: z.string().min(8).max(200),
});

export const LoginBody = z.object({
	email: z.string().email().max(200),
	password: z.string().min(1).max(200),
	tenantId: z.string().min(1),
});

export const RefreshBody = z.object({
	refreshToken: z.string().min(1),
});
