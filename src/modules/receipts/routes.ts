import type { FastifyInstance } from "fastify";
import {
	receiptIssuedTotal,
	receiptVoidedTotal,
} from "../../observability/metrics";
import {
	createReceiptTransactional,
	findReceiptById,
	findReceiptByOrderId,
	listReceipts,
} from "./queries";
import {
	CreateReceiptBody,
	ListReceiptsQuery,
	ReceiptIdParams,
	ReceiptOrderIdParams,
} from "./schemas";
import { voidReceiptTransactional } from "./void-receipt";

// Asume helpers de error y autenticación ya existen en el repo

export default async function receiptsRoutes(app: FastifyInstance) {
	// Protege todo el módulo
	app.addHook("preHandler", async (req) => {
		await app.requireAuth(req);
	});

	// POST /orders/:id/receipt
	app.post(
		"/orders/:id/receipt",
		{ preHandler: async (req) => app.requireRole(["ADMIN", "MANAGER"])(req) },
		async (req, reply) => {
			const tenantId = req.auth?.tenantId ?? "";
			const { id: orderId } = ReceiptOrderIdParams.parse(req.params);
			const { currency = "USD" } = CreateReceiptBody.parse(req.body ?? {});

			// Buscar receipt existente (idempotencia)
			const existing = await findReceiptByOrderId(
				app.prisma,
				tenantId,
				orderId,
			);
			if (existing) return reply.code(200).send(existing);

			// Buscar orden y validar estado
			const order = await app.prisma.order.findFirst({
				where: { id: orderId, tenantId },
				include: { items: true },
			});
			if (!order) {
				return reply.code(404).send({
					error: { code: "ORDER_NOT_FOUND", message: "Order not found" },
				});
			}
			if (order.status !== "PAID") {
				return reply.code(400).send({
					error: { code: "ORDER_NOT_PAID", message: "Order not paid" },
				});
			}

			// Snapshot de items
			const orderSnapshot = {
				subtotalCents: order.subtotalCents,
				totalCents: order.totalCents,
				items: order.items.map(
					(item: {
						productId?: string;
						productName: string;
						unitPriceCents: number;
						qty: number;
						lineTotalCents: number;
					}) => ({
						productId: item.productId,
						name: item.productName,
						unitPriceCents: item.unitPriceCents,
						qty: item.qty,
						lineTotalCents: item.lineTotalCents,
					}),
				),
			};

			// Crear receipt transaccional
			const receipt = await createReceiptTransactional(
				app.prisma,
				tenantId,
				orderId,
				currency,
				orderSnapshot,
				{ orderId, tenantId },
			);
			// Solo incrementar métrica si es creación (no idempotente)
			receiptIssuedTotal.inc({ tenantId });
			return reply.code(200).send(receipt);
		},
	);

	// GET /orders/:id/receipt
	app.get(
		"/orders/:id/receipt",
		{
			preHandler: async (req) =>
				app.requireRole(["ADMIN", "MANAGER", "STAFF"])(req),
		},
		async (req, reply) => {
			const tenantId = req.auth?.tenantId ?? "";
			const { id: orderId } = ReceiptOrderIdParams.parse(req.params);
			const receipt = await findReceiptByOrderId(app.prisma, tenantId, orderId);
			if (!receipt) {
				return reply.code(404).send({
					error: { code: "RECEIPT_NOT_FOUND", message: "Receipt not found" },
				});
			}
			return receipt;
		},
	);

	// GET /receipts/:id
	app.get(
		"/receipts/:id",
		{
			preHandler: async (req) =>
				app.requireRole(["ADMIN", "MANAGER", "STAFF"])(req),
		},
		async (req, reply) => {
			const tenantId = req.auth?.tenantId ?? "";
			const { id } = ReceiptIdParams.parse(req.params);
			const receipt = await findReceiptById(app.prisma, tenantId, id);
			if (!receipt) {
				return reply.code(404).send({
					error: { code: "RECEIPT_NOT_FOUND", message: "Receipt not found" },
				});
			}
			return receipt;
		},
	);

	// GET /receipts
	app.get(
		"/receipts",
		{
			preHandler: async (req) =>
				app.requireRole(["ADMIN", "MANAGER", "STAFF"])(req),
		},
		async (req, _reply) => {
			const tenantId = req.auth?.tenantId ?? "";
			const { page, pageSize, from, to } = ListReceiptsQuery.parse(req.query);
			return listReceipts(app.prisma, tenantId, { page, pageSize, from, to });
		},
	);
	// PATCH /receipts/:id/void
	app.patch(
		"/receipts/:id/void",
		{ preHandler: async (req) => app.requireRole(["ADMIN", "MANAGER"])(req) },
		async (req, reply) => {
			const tenantId = req.auth?.tenantId ?? "";
			const { id } = ReceiptIdParams.parse(req.params);
			let reason = "voided by user";
			type ReasonBody = { reason?: string };
			const body: ReasonBody = req.body as ReasonBody;
			if (
				body &&
				typeof body === "object" &&
				body.reason &&
				typeof body.reason === "string"
			) {
				reason = body.reason;
			}
			try {
				const receipt = await app.prisma.receipt.findFirst({
					where: { id, tenantId },
					include: { items: true },
				});
				if (!receipt) {
					return reply.code(404).send({
						error: {
							code: "RECEIPT_NOT_FOUND",
							message: "Receipt not found",
						},
					});
				}
				if (receipt.status === "VOIDED") {
					return reply.code(200).send(receipt);
				}
				// Si no está voided, voidear
				const voided = await voidReceiptTransactional(
					app.prisma,
					tenantId,
					id,
					reason,
					{ receiptId: id, tenantId, reason },
				);
				receiptVoidedTotal.inc({ tenantId });
				return reply.code(200).send(voided);
			} catch (err) {
				app.log.error({ err }, "Error voiding receipt");
				return reply.code(500).send({
					error: { code: "INTERNAL_ERROR", message: "Unexpected error" },
				});
			}
		},
	);

	// POST /receipts/:id/void (compatibilidad test)
	app.post(
		"/receipts/:id/void",
		{ preHandler: async (req) => app.requireRole(["ADMIN", "MANAGER"])(req) },
		async (req, reply) => {
			const tenantId = req.auth?.tenantId ?? "";
			const { id } = ReceiptIdParams.parse(req.params);
			let reason = "voided by user";
			type ReasonBody = { reason?: string };
			const body: ReasonBody = req.body as ReasonBody;
			if (
				body &&
				typeof body === "object" &&
				body.reason &&
				typeof body.reason === "string"
			) {
				reason = body.reason;
			}
			try {
				const receipt = await app.prisma.receipt.findFirst({
					where: { id, tenantId },
					include: { items: true },
				});
				if (!receipt) {
					return reply.code(404).send({
						error: {
							code: "RECEIPT_NOT_FOUND",
							message: "Receipt not found",
						},
					});
				}
				if (receipt.status === "VOIDED") {
					return reply.code(200).send(receipt);
				}
				// Si no está voided, voidear
				const voided = await voidReceiptTransactional(
					app.prisma,
					tenantId,
					id,
					reason,
					{ receiptId: id, tenantId, reason },
				);
				receiptVoidedTotal.inc({ tenantId });
				return reply.code(200).send(voided);
			} catch (err) {
				app.log.error({ err }, "Error voiding receipt");
				return reply.code(500).send({
					error: { code: "INTERNAL_ERROR", message: "Unexpected error" },
				});
			}
		},
	);
}
