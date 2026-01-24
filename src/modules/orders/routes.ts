import { Prisma } from "@prisma/client";
import type { FastifyRequest } from "fastify";
import type { FastifyPluginAsync } from "fastify/types/plugin";
import { badRequest, notFound } from "../../http/errors.js";
import {
	AddItemBody,
	CreateOrderBody,
	ListOrdersQuery,
	OrderIdParams,
	OrderItemIdParams,
	UpdateItemBody,
	UpdateOrderStatusBody,
} from "./schemas.js";

export const ordersRoutes: FastifyPluginAsync = async (app) => {
	// Protege todo el módulo
	app.addHook("preHandler", async (req) => {
		await app.requireAuth(req);
	});

	type AuthContext = NonNullable<FastifyRequest["auth"]>;

	function getAuth(req: FastifyRequest): AuthContext {
		const auth = req.auth;
		// requireAuth debería garantizar esto, pero lo dejamos defensivo para tipos + runtime
		if (!auth) throw badRequest("Missing auth context");
		return auth;
	}

	async function getNextOrderNumber(tenantId: string) {
		const key = `tenant:${tenantId}:order_number`;

		// Evita exists+set (race). GET + seed con SET NX
		const current = await app.redis.get(key);
		if (current === null) {
			const agg = await app.prisma.order.aggregate({
				where: { tenantId },
				_max: { number: true },
			});
			const seed = String(agg._max.number ?? 0);
			// NX: si otro request lo setea antes, este no pisa el valor
			await app.redis.set(key, seed, "NX");
		}

		const next = await app.redis.incr(key);
		return next;
	}

	// “Lock” + validación de status dentro de la transacción para evitar carreras
	async function assertOrderEditable(
		tx: Prisma.TransactionClient,
		orderId: string,
		tenantId: string,
	) {
		const res = await tx.order.updateMany({
			where: { id: orderId, tenantId, status: { in: ["DRAFT", "OPEN"] } },
			// “touch” para forzar UPDATE y lock de fila en Postgres
			data: { updatedAt: new Date() },
		});

		if (res.count === 0) {
			throw badRequest("Cannot modify items in current status");
		}
	}

	async function recalcTotals(
		tx: Prisma.TransactionClient,
		orderId: string,
		tenantId: string,
	) {
		const sum = await tx.orderItem.aggregate({
			where: { orderId, tenantId },
			_sum: { lineTotalCents: true },
		});
		const subtotal = sum._sum.lineTotalCents ?? 0;
		const total = subtotal; // placeholder para impuestos/fees futuros

		await tx.order.update({
			where: { id: orderId },
			data: { subtotalCents: subtotal, totalCents: total },
		});
	}

	const orderDetailSelect = {
		id: true,
		tenantId: true,
		number: true,
		status: true,
		subtotalCents: true,
		totalCents: true,
		createdAt: true,
		updatedAt: true,
		items: {
			select: {
				id: true,
				productId: true,
				productName: true,
				qty: true,
				unitPriceCents: true,
				lineTotalCents: true,
				createdAt: true,
			},
			orderBy: { createdAt: "asc" as const },
		},
	} satisfies Prisma.OrderSelect;

	async function getOrderDetail(
		tx: Prisma.TransactionClient,
		id: string,
		tenantId: string,
	) {
		return tx.order.findFirst({
			where: { id, tenantId },
			select: orderDetailSelect,
		});
	}

	function isUniqueViolation(err: unknown) {
		return (
			err instanceof Prisma.PrismaClientKnownRequestError &&
			err.code === "P2002"
		);
	}

	async function createOrderWithRetry(tenantId: string, attempts = 3) {
		let lastErr: unknown;

		for (let i = 0; i < attempts; i++) {
			const number = await getNextOrderNumber(tenantId);

			try {
				const created = await app.prisma.order.create({
					data: { tenantId, number, status: "DRAFT" },
					select: orderDetailSelect,
				});
				return created;
			} catch (err) {
				lastErr = err;
				if (!isUniqueViolation(err)) throw err;
				// retry si el number chocó con el unique(tenantId, number)
			}
		}

		throw lastErr;
	}

	// POST /orders (ADMIN|MANAGER)
	app.post(
		"/orders",
		{ preHandler: async (req) => app.requireRole(["ADMIN", "MANAGER"])(req) },
		async (req, reply) => {
			const { tenantId } = getAuth(req);
			CreateOrderBody.parse(req.body ?? {});

			const order = await createOrderWithRetry(tenantId);
			return reply.status(201).send(order);
		},
	);

	// GET /orders (ADMIN|MANAGER|STAFF)
	app.get(
		"/orders",
		{
			preHandler: async (req) =>
				app.requireRole(["ADMIN", "MANAGER", "STAFF"])(req),
		},
		async (req) => {
			const { tenantId } = getAuth(req);
			const q = ListOrdersQuery.parse(req.query);

			const where: Prisma.OrderWhereInput = { tenantId };
			if (q.status) where.status = q.status;
			if (q.from || q.to)
				where.createdAt = {
					...(q.from ? { gte: q.from } : {}),
					...(q.to ? { lte: q.to } : {}),
				};

			const skip = (q.page - 1) * q.pageSize;
			const take = q.pageSize;

			const [items, total] = await Promise.all([
				app.prisma.order.findMany({
					where,
					orderBy: { createdAt: "desc" },
					skip,
					take,
					select: {
						id: true,
						tenantId: true,
						number: true,
						status: true,
						subtotalCents: true,
						totalCents: true,
						createdAt: true,
						updatedAt: true,
					},
				}),
				app.prisma.order.count({ where }),
			]);

			return { page: q.page, pageSize: q.pageSize, total, items };
		},
	);

	// GET /orders/:id (ADMIN|MANAGER|STAFF)
	app.get(
		"/orders/:id",
		{
			preHandler: async (req) =>
				app.requireRole(["ADMIN", "MANAGER", "STAFF"])(req),
		},
		async (req) => {
			const { tenantId } = getAuth(req);
			const { id } = OrderIdParams.parse(req.params);

			const order = await app.prisma.order.findFirst({
				where: { id, tenantId },
				select: {
					id: true,
					tenantId: true,
					number: true,
					status: true,
					subtotalCents: true,
					totalCents: true,
					createdAt: true,
					updatedAt: true,
					items: {
						select: {
							id: true,
							productId: true,
							productName: true,
							qty: true,
							unitPriceCents: true,
							lineTotalCents: true,
							createdAt: true,
						},
						orderBy: { createdAt: "asc" },
					},
				},
			});

			if (!order) throw notFound("Order not found");
			return order;
		},
	);

	// POST /orders/:id/items (ADMIN|MANAGER)
	app.post(
		"/orders/:id/items",
		{ preHandler: async (req) => app.requireRole(["ADMIN", "MANAGER"])(req) },
		async (req) => {
			const { tenantId } = getAuth(req);
			const { id } = OrderIdParams.parse(req.params);
			const body = AddItemBody.parse(req.body);

			const order = await app.prisma.order.findFirst({
				where: { id, tenantId },
				select: { id: true, status: true },
			});
			if (!order) throw notFound("Order not found");
			if (order.status !== "DRAFT" && order.status !== "OPEN")
				throw badRequest("Cannot add items in current status");

			const product = await app.prisma.product.findFirst({
				where: { id: body.productId, tenantId },
				select: { id: true, name: true, priceCents: true, active: true },
			});
			if (!product) throw notFound("Product not found");
			if (!product.active) throw badRequest("Product is inactive");

			const lineTotal = product.priceCents * body.qty;

			const result = await app.prisma.$transaction(
				async (tx: Prisma.TransactionClient) => {
					await assertOrderEditable(tx, id, tenantId);

					await tx.orderItem.create({
						data: {
							orderId: id,
							tenantId,
							productId: product.id,
							productName: product.name,
							qty: body.qty,
							unitPriceCents: product.priceCents,
							lineTotalCents: lineTotal,
						},
					});

					await recalcTotals(tx, id, tenantId);

					const updated = await tx.order.findFirst({
						where: { id, tenantId },
						select: {
							id: true,
							tenantId: true,
							number: true,
							status: true,
							subtotalCents: true,
							totalCents: true,
							createdAt: true,
							updatedAt: true,
							items: {
								select: {
									id: true,
									productId: true,
									productName: true,
									qty: true,
									unitPriceCents: true,
									lineTotalCents: true,
									createdAt: true,
								},
								orderBy: { createdAt: "asc" },
							},
						},
					});

					if (!updated) throw notFound("Order not found");
					return updated;
				},
			);

			return result;
		},
	);

	// PATCH /orders/:id/status (ADMIN|MANAGER)
	app.patch(
		"/orders/:id/status",
		{ preHandler: async (req) => app.requireRole(["ADMIN", "MANAGER"])(req) },
		async (req) => {
			const { tenantId, userId } = getAuth(req);
			const { id } = OrderIdParams.parse(req.params);
			const { toStatus } = UpdateOrderStatusBody.parse(req.body);

			const order = await app.prisma.order.findFirst({
				where: { id, tenantId },
				select: { id: true, status: true },
			});
			if (!order) throw notFound("Order not found");

			const from = order.status;

			const allowed: Record<string, string[]> = {
				DRAFT: ["OPEN", "CANCELED"],
				OPEN: ["PAID", "CANCELED"],
				PAID: [],
				CANCELED: [],
			};

			if (!allowed[from]?.includes(toStatus)) {
				throw badRequest("Invalid status transition");
			}

			const updated = await app.prisma.$transaction(
				async (tx: Prisma.TransactionClient) => {
					const res = await tx.order.updateMany({
						where: { id, tenantId, status: from },
						data: { status: toStatus },
					});

					if (res.count === 0) throw badRequest("Order status changed, retry");

					await tx.orderStatusHistory.create({
						data: {
							orderId: id,
							tenantId,
							fromStatus: from,
							toStatus,
							changedByUserId: userId,
						},
					});

					const o = await getOrderDetail(tx, id, tenantId);
					if (!o) throw notFound("Order not found");
					return o;
				},
			);

			return updated;
		},
	);

	// PATCH /orders/:id/items/:itemId (ADMIN|MANAGER)
	app.patch(
		"/orders/:id/items/:itemId",
		{ preHandler: async (req) => app.requireRole(["ADMIN", "MANAGER"])(req) },
		async (req) => {
			const { tenantId } = getAuth(req);
			const { id, itemId } = OrderItemIdParams.parse(req.params);
			const body = UpdateItemBody.parse(req.body);

			const order = await app.prisma.order.findFirst({
				where: { id, tenantId },
				select: { id: true, status: true },
			});
			if (!order) throw notFound("Order not found");
			if (order.status !== "DRAFT" && order.status !== "OPEN")
				throw badRequest("Cannot modify items in current status");

			const item = await app.prisma.orderItem.findFirst({
				where: { id: itemId, orderId: id, tenantId },
				select: { id: true, unitPriceCents: true },
			});
			if (!item) throw notFound("Order item not found");

			const newLineTotal = item.unitPriceCents * body.qty;

			const result = await app.prisma.$transaction(
				async (tx: Prisma.TransactionClient) => {
					await assertOrderEditable(tx, id, tenantId);

					const upd = await tx.orderItem.updateMany({
						where: { id: itemId, orderId: id, tenantId },
						data: { qty: body.qty, lineTotalCents: newLineTotal },
					});

					if (upd.count === 0) throw notFound("Order item not found");

					await recalcTotals(tx, id, tenantId);

					const updated = await getOrderDetail(tx, id, tenantId);
					if (!updated) throw notFound("Order not found");
					return updated;
				},
			);

			return result;
		},
	);

	// DELETE /orders/:id/items/:itemId (ADMIN|MANAGER)
	app.delete(
		"/orders/:id/items/:itemId",
		{ preHandler: async (req) => app.requireRole(["ADMIN", "MANAGER"])(req) },
		async (req) => {
			const { tenantId } = getAuth(req);
			const { id, itemId } = OrderItemIdParams.parse(req.params);

			const order = await app.prisma.order.findFirst({
				where: { id, tenantId },
				select: { id: true, status: true },
			});
			if (!order) throw notFound("Order not found");
			if (order.status !== "DRAFT" && order.status !== "OPEN")
				throw badRequest("Cannot modify items in current status");

			const exists = await app.prisma.orderItem.findFirst({
				where: { id: itemId, orderId: id, tenantId },
				select: { id: true },
			});
			if (!exists) throw notFound("Order item not found");

			const result = await app.prisma.$transaction(
				async (tx: Prisma.TransactionClient) => {
					await assertOrderEditable(tx, id, tenantId);

					const del = await tx.orderItem.deleteMany({
						where: { id: itemId, orderId: id, tenantId },
					});
					if (del.count === 0) throw notFound("Order item not found");

					await recalcTotals(tx, id, tenantId);

					const updated = await getOrderDetail(tx, id, tenantId);
					if (!updated) throw notFound("Order not found");
					return updated;
				},
			);

			return result;
		},
	);
};
