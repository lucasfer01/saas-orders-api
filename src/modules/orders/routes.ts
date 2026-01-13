import type { FastifyPluginAsync } from "fastify/types/plugin";
import { badRequest, notFound } from "../../http/errors.js";
import {
  AddItemBody,
  CreateOrderBody,
  ListOrdersQuery,
  OrderIdParams,
  UpdateOrderStatusBody,
} from "./schemas.js";

export const ordersRoutes: FastifyPluginAsync = async (app) => {
  // Protege todo el módulo
  app.addHook("preHandler", async (req) => {
    await app.requireAuth(req);
  });

  async function getNextOrderNumber(tenantId: string) {
    const key = `tenant:${tenantId}:order_number`;
    const exists = await app.redis.exists(key);
    if (!exists) {
      const agg = await app.prisma.order.aggregate({
        where: { tenantId },
        _max: { number: true },
      });
      const current = agg._max.number ?? 0;
      await app.redis.set(key, String(current));
    }
    const next = await app.redis.incr(key);
    return next;
  }

  async function recalcTotals(tx: any, orderId: string, tenantId: string) {
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

  // POST /orders (ADMIN|MANAGER)
  app.post(
    "/orders",
    { preHandler: async (req) => app.requireRole(["ADMIN", "MANAGER"])(req) },
    async (req, reply) => {
      const { tenantId } = (req as any).auth;
      CreateOrderBody.parse(req.body ?? {});

      const number = await getNextOrderNumber(tenantId);

      const order = await app.prisma.order.create({
        data: { tenantId, number, status: "DRAFT" },
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
      });

      return reply.status(201).send(order);
    },
  );

  // GET /orders (ADMIN|MANAGER|STAFF)
  app.get("/orders", async (req) => {
    const { tenantId } = (req as any).auth;
    const q = ListOrdersQuery.parse(req.query);

    const where: any = { tenantId };
    if (q.status) where.status = q.status;
    if (q.from || q.to) where.createdAt = {
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
  });

  // GET /orders/:id (ADMIN|MANAGER|STAFF)
  app.get("/orders/:id", async (req) => {
    const { tenantId } = (req as any).auth;
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
  });

  // POST /orders/:id/items (ADMIN|MANAGER)
  app.post(
    "/orders/:id/items",
    { preHandler: async (req) => app.requireRole(["ADMIN", "MANAGER"])(req) },
    async (req) => {
      const { tenantId } = (req as any).auth;
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

      const result = await app.prisma.$transaction(async (tx) => {
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
        return updated!;
      });

      return result;
    },
  );

  // PATCH /orders/:id/status (ADMIN|MANAGER)
  app.patch(
    "/orders/:id/status",
    { preHandler: async (req) => app.requireRole(["ADMIN", "MANAGER"])(req) },
    async (req) => {
      const { tenantId, userId } = (req as any).auth;
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

      const updated = await app.prisma.$transaction(async (tx) => {
        const o = await tx.order.update({
          where: { id },
          data: { status: toStatus },
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
        });

        await tx.orderStatusHistory.create({
          data: {
            orderId: id,
            tenantId,
            fromStatus: from,
            toStatus,
            changedByUserId: userId,
          },
        });

        return o;
      });

      return updated;
    },
  );
};
