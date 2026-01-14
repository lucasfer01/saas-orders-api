import type { FastifyPluginAsync } from "fastify/types/plugin";
import { notFound } from "../../http/errors.js";
import {
	CreateProductBody,
	ListProductsQuery,
	ProductIdParams,
	UpdateProductBody,
} from "./schemas.js";

export const productsRoutes: FastifyPluginAsync = async (app) => {
	// Protege todo el módulo
	app.addHook("preHandler", async (req) => {
		await app.requireAuth(req);
	});

	// POST /products (ADMIN|MANAGER)
	app.post(
		"/products",
		{ preHandler: async (req) => app.requireRole(["ADMIN", "MANAGER"])(req) },
		async (req, reply) => {
			const { tenantId } = (req as any).auth;
			const body = CreateProductBody.parse(req.body);

			const product = await app.prisma.product.create({
				data: {
					tenantId,
					name: body.name,
					priceCents: body.priceCents,
					active: body.active ?? true,
				},
				select: {
					id: true,
					tenantId: true,
					name: true,
					priceCents: true,
					active: true,
					createdAt: true,
				},
			});

			return reply.status(201).send(product);
		},
	);

	// GET /products (ADMIN|MANAGER|STAFF)
	app.get(
		"/products",
		{
			preHandler: async (req) =>
				app.requireRole(["ADMIN", "MANAGER", "STAFF"])(req),
		},
		async (req) => {
			const { tenantId } = (req as any).auth;
			const q = ListProductsQuery.parse(req.query);

			const where = {
				tenantId,
				...(q.active !== undefined ? { active: q.active } : {}),
				...(q.search
					? { name: { contains: q.search, mode: "insensitive" as const } }
					: {}),
			};

			const skip = (q.page - 1) * q.pageSize;
			const take = q.pageSize;

			const [items, total] = await Promise.all([
				app.prisma.product.findMany({
					where,
					orderBy: { createdAt: "desc" },
					skip,
					take,
					select: {
						id: true,
						tenantId: true,
						name: true,
						priceCents: true,
						active: true,
						createdAt: true,
					},
				}),
				app.prisma.product.count({ where }),
			]);

			return { page: q.page, pageSize: q.pageSize, total, items };
		},
	);

	// GET /products/:id (ADMIN|MANAGER|STAFF)
	app.get(
		"/products/:id",
		{
			preHandler: async (req) =>
				app.requireRole(["ADMIN", "MANAGER", "STAFF"])(req),
		},
		async (req) => {
			const { tenantId } = (req as any).auth;
			const { id } = ProductIdParams.parse(req.params);

			const product = await app.prisma.product.findFirst({
				where: { id, tenantId },
				select: {
					id: true,
					tenantId: true,
					name: true,
					priceCents: true,
					active: true,
					createdAt: true,
				},
			});

			if (!product) throw notFound("Product not found");
			return product;
		},
	);

	// PATCH /products/:id (ADMIN|MANAGER)
	app.patch(
		"/products/:id",
		{ preHandler: async (req) => app.requireRole(["ADMIN", "MANAGER"])(req) },
		async (req) => {
			const { tenantId } = (req as any).auth;
			const { id } = ProductIdParams.parse(req.params);
			const body = UpdateProductBody.parse(req.body);

			// updateMany: asegura tenantId en la operación (no solo en un pre-check)
			const result = await app.prisma.product.updateMany({
				where: { id, tenantId },
				data: body,
			});

			if (result.count === 0) throw notFound("Product not found");

			// devolver el actualizado (opcional, pero útil)
			const updated = await app.prisma.product.findFirst({
				where: { id, tenantId },
				select: {
					id: true,
					tenantId: true,
					name: true,
					priceCents: true,
					active: true,
					createdAt: true,
				},
			});

			// Por seguridad: si count>0 debería existir
			if (!updated) throw notFound("Product not found");

			return updated;
		},
	);
};
