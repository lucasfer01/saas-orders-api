import { Prisma } from "@prisma/client";
import type { FastifyRequest } from "fastify";
import type { FastifyPluginAsync } from "fastify/types/plugin";
import { badRequest, notFound } from "../../http/errors.js";
import { CreatePaymentBody, PaymentParams } from "./schemas.js";

type AuthContext = NonNullable<FastifyRequest["auth"]>;

function isUniqueViolation(err: unknown) {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002"
  );
}

function getAuth(req: FastifyRequest): AuthContext {
  const auth = req.auth;
  if (!auth) throw badRequest("Missing auth context");
  return auth;
}

export const paymentsRoutes: FastifyPluginAsync = async (app) => {
  // Módulo protegido
  app.addHook("preHandler", async (req) => {
    await app.requireAuth(req);
  });

  // POST /orders/:id/payments (ADMIN | MANAGER)
  app.post(
    "/orders/:id/payments",
    { preHandler: async (req) => app.requireRole(["ADMIN", "MANAGER"])(req) },
    async (req, reply) => {
      const { tenantId, userId } = getAuth(req);
      const { id: orderId } = PaymentParams.parse(req.params);
      const body = CreatePaymentBody.parse(req.body);

      // Idempotencia fast-path: si ya existe por (tenantId, idempotencyKey), devolverlo sin validar estado de orden
      const existingFast = await app.prisma.payment.findFirst({
        where: { tenantId, idempotencyKey: body.idempotencyKey },
        select: {
          id: true,
          tenantId: true,
          orderId: true,
          amountCents: true,
          method: true,
          status: true,
          idempotencyKey: true,
          createdAt: true,
          updatedAt: true,
        },
      });
      if (existingFast) return reply.status(200).send(existingFast);

      const order = await app.prisma.order.findFirst({
        where: { id: orderId, tenantId },
        select: { id: true, tenantId: true, status: true, totalCents: true },
      });
      if (!order) throw notFound("Order not found");
      if (order.status !== "OPEN") throw badRequest("Order must be OPEN to pay");
      if (body.amountCents !== order.totalCents)
        throw badRequest("Amount must equal order total");

      const shouldFail =
        process.env.NODE_ENV === "test" &&
        (body.testFail === true || req.headers["x-test-fail"] === "1");

      // Idempotencia + transacción: crear PENDING y resolver dentro de la misma tx
      try {
        const created = await app.prisma.$transaction(
          async (tx: Prisma.TransactionClient) => {
            // Intentar crear Payment (PENDING)
            const payment = await tx.payment.create({
              data: {
                tenantId,
                orderId,
                amountCents: body.amountCents,
                method: body.method as Prisma.PaymentCreateInput["method"],
                provider: "MOCK",
                status: "PENDING",
                idempotencyKey: body.idempotencyKey,
              },
              select: {
                id: true,
                tenantId: true,
                orderId: true,
                amountCents: true,
                method: true,
                status: true,
                idempotencyKey: true,
                createdAt: true,
                updatedAt: true,
              },
            });

            const finalStatus = shouldFail ? "FAILED" : "SUCCEEDED";

            // Resolver estado
            await tx.payment.update({
              where: { id: payment.id },
              data: { status: finalStatus },
            });

            if (finalStatus === "SUCCEEDED") {
              // Mover orden a PAID (optimista)
              const upd = await tx.order.updateMany({
                where: { id: orderId, tenantId, status: "OPEN" },
                data: { status: "PAID" },
              });
              if (upd.count === 0)
                throw badRequest("Order status changed, retry");

              await tx.orderStatusHistory.create({
                data: {
                  orderId,
                  tenantId,
                  fromStatus: "OPEN",
                  toStatus: "PAID",
                  changedByUserId: userId,
                },
              });

              await tx.outboxEvent.create({
                data: {
                  tenantId,
                  type: "PAYMENT_SUCCEEDED",
                  payloadJson: {
                    tenantId,
                    orderId,
                    paymentId: payment.id,
                    amountCents: payment.amountCents,
                    method: payment.method,
                  },
                  status: "PENDING",
                },
              });
            }

            // Devolver el payment actualizado
            const result = await tx.payment.findUnique({
              where: { id: payment.id },
              select: {
                id: true,
                tenantId: true,
                orderId: true,
                amountCents: true,
                method: true,
                status: true,
                idempotencyKey: true,
                createdAt: true,
                updatedAt: true,
              },
            });
            if (!result) throw notFound("Payment not found");
            return result;
          },
        );

        return reply.status(201).send(created);
      } catch (err) {
        if (isUniqueViolation(err)) {
          // Idempotencia: buscar por (tenantId, idempotencyKey) y devolver 200
          const existing = await app.prisma.payment.findFirst({
            where: { tenantId, idempotencyKey: body.idempotencyKey },
            select: {
              id: true,
              tenantId: true,
              orderId: true,
              amountCents: true,
              method: true,
              status: true,
              idempotencyKey: true,
              createdAt: true,
              updatedAt: true,
            },
          });
          if (!existing) throw notFound("Payment not found");
          return reply.status(200).send(existing);
        }
        throw err;
      }
    },
  );
};
