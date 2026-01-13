import type { FastifyPluginAsync } from "fastify/types/plugin";
import {
	signAccessToken,
	signRefreshToken,
	verifyRefreshToken,
} from "../../auth/jwt.js";
import { hashPassword, verifyPassword } from "../../auth/password.js";
import { sha256 } from "../../auth/token-hash.js";
import { badRequest, conflict, notFound } from "../../http/errors.js";
import { LoginBody, RefreshBody, RegisterBody } from "./schema.js";

export const authRoutes: FastifyPluginAsync = async (app) => {
	// POST /auth/register
	app.post("/auth/register", async (req, reply) => {
		const body = RegisterBody.parse(req.body);

		const result = await app.prisma.$transaction(async (tx) => {
			const tenant = await tx.tenant.create({
				data: { name: body.tenantName },
				select: { id: true, name: true, createdAt: true },
			});

			// crear rol ADMIN por tenant
			const adminRole = await tx.role.create({
				data: { tenantId: tenant.id, name: "ADMIN" },
				select: { id: true, name: true },
			});

			// evitar email duplicado por tenant
			const existing = await tx.user.findUnique({
				where: { tenantId_email: { tenantId: tenant.id, email: body.email } },
				select: { id: true },
			});
			if (existing) throw conflict("Email already exists in tenant");

			const user = await tx.user.create({
				data: {
					tenantId: tenant.id,
					email: body.email,
					passwordHash: await hashPassword(body.password),
					status: "ACTIVE",
					roles: { create: [{ roleId: adminRole.id }] },
				},
				select: { id: true, email: true },
			});

			return { tenant, user, roles: ["ADMIN"] };
		});

		// Crear refresh token (DB + JWT)
		const refreshRow = await app.prisma.refreshToken.create({
			data: {
				userId: result.user.id,
				tokenHash: "pending", // se setea después
				expiresAt: new Date(
					Date.now() +
						Number(process.env.JWT_REFRESH_TTL_DAYS ?? 14) * 86400_000,
				),
			},
			select: { id: true, expiresAt: true },
		});

		const refreshToken = signRefreshToken({
			sub: result.user.id,
			tenantId: result.tenant.id,
			tokenId: refreshRow.id,
		});

		await app.prisma.refreshToken.update({
			where: { id: refreshRow.id },
			data: { tokenHash: sha256(refreshToken) },
		});

		const accessToken = signAccessToken({
			sub: result.user.id,
			tenantId: result.tenant.id,
			roles: result.roles,
		});

		return reply.status(201).send({
			tenant: result.tenant,
			user: result.user,
			accessToken,
			refreshToken,
		});
	});

	// POST /auth/login
	app.post("/auth/login", async (req) => {
		const body = LoginBody.parse(req.body);

		const user = await app.prisma.user.findFirst({
			where: { tenantId: body.tenantId, email: body.email, status: "ACTIVE" },
			select: {
				id: true,
				tenantId: true,
				email: true,
				passwordHash: true,
				roles: { select: { role: { select: { name: true } } } },
			},
		});

		if (!user) throw notFound("Invalid credentials");

		const ok = await verifyPassword(body.password, user.passwordHash);
		if (!ok) throw notFound("Invalid credentials");

		const roles = user.roles.map((r) => r.role.name);

		const refreshRow = await app.prisma.refreshToken.create({
			data: {
				userId: user.id,
				tokenHash: "pending",
				expiresAt: new Date(
					Date.now() +
						Number(process.env.JWT_REFRESH_TTL_DAYS ?? 14) * 86400_000,
				),
			},
			select: { id: true },
		});

		const refreshToken = signRefreshToken({
			sub: user.id,
			tenantId: user.tenantId,
			tokenId: refreshRow.id,
		});

		await app.prisma.refreshToken.update({
			where: { id: refreshRow.id },
			data: { tokenHash: sha256(refreshToken) },
		});

		const accessToken = signAccessToken({
			sub: user.id,
			tenantId: user.tenantId,
			roles,
		});

		return { accessToken, refreshToken };
	});

	// POST /auth/refresh (rotación)
	app.post("/auth/refresh", async (req) => {
		const body = RefreshBody.parse(req.body);

		let payload: { tokenId: string };
		try {
			payload = verifyRefreshToken(body.refreshToken);
		} catch {
			throw badRequest("Invalid refresh token");
		}

		const tokenHash = sha256(body.refreshToken);

		const row = await app.prisma.refreshToken.findUnique({
			where: { id: payload.tokenId },
			select: {
				id: true,
				userId: true,
				tokenHash: true,
				expiresAt: true,
				revokedAt: true,
			},
		});

		if (!row) throw badRequest("Refresh token not found");
		if (row.revokedAt) throw badRequest("Refresh token revoked");
		if (row.expiresAt.getTime() < Date.now())
			throw badRequest("Refresh token expired");
		if (row.tokenHash !== tokenHash) throw badRequest("Refresh token mismatch");

		// Obtener roles actuales del usuario
		const user = await app.prisma.user.findUnique({
			where: { id: row.userId },
			select: {
				id: true,
				tenantId: true,
				status: true,
				roles: { select: { role: { select: { name: true } } } },
			},
		});
		if (!user || user.status !== "ACTIVE") throw badRequest("User inactive");
		const roles = user.roles.map((r) => r.role.name);

		// Rotar: revocar token anterior y emitir nuevo
		await app.prisma.refreshToken.update({
			where: { id: row.id },
			data: { revokedAt: new Date() },
		});

		const newRow = await app.prisma.refreshToken.create({
			data: {
				userId: user.id,
				tokenHash: "pending",
				expiresAt: new Date(
					Date.now() +
						Number(process.env.JWT_REFRESH_TTL_DAYS ?? 14) * 86400_000,
				),
			},
			select: { id: true },
		});

		const newRefreshToken = signRefreshToken({
			sub: user.id,
			tenantId: user.tenantId,
			tokenId: newRow.id,
		});

		await app.prisma.refreshToken.update({
			where: { id: newRow.id },
			data: { tokenHash: sha256(newRefreshToken) },
		});

		const newAccessToken = signAccessToken({
			sub: user.id,
			tenantId: user.tenantId,
			roles,
		});

		return { accessToken: newAccessToken, refreshToken: newRefreshToken };
	});

	// POST /auth/logout (revoca el refresh actual)
	app.post("/auth/logout", async (req) => {
		const body = RefreshBody.parse(req.body);

		let payload: { tokenId: string };
		try {
			payload = verifyRefreshToken(body.refreshToken);
		} catch {
			// logout idempotente
			return { ok: true };
		}

		await app.prisma.refreshToken.updateMany({
			where: { id: payload.tokenId, revokedAt: null },
			data: { revokedAt: new Date() },
		});

		return { ok: true };
	});

	// GET /me
	app.get(
		"/me",
		{ preHandler: async (req) => app.requireAuth(req) },
		async (req) => {
			const auth = (req as any).auth;

			const user = await app.prisma.user.findUnique({
				where: { id: auth.userId },
				select: {
					id: true,
					email: true,
					tenantId: true,
					status: true,
					roles: { select: { role: { select: { name: true } } } },
				},
			});

			if (!user) throw notFound("User not found");

			return {
				id: user.id,
				email: user.email,
				tenantId: user.tenantId,
				status: user.status,
				roles: user.roles.map((r) => r.role.name),
			};
		},
	);
};
