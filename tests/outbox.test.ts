import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { genIdempotencyKey } from "./test-utils.js";
import { runOutboxOnce } from "../src/workers/outbox-worker.js";

const app = buildApp();

type RegisterRes = {
  tenant: { id: string };
  accessToken: string;
  refreshToken: string;
  user: { id: string; email: string };
};

async function registerTenant(payload: {
  tenantName: string;
  email: string;
  password: string;
}) {
  const res = await app.inject({ method: "POST", url: "/auth/register", payload });
  expect(res.statusCode).toBe(201);
  return res.json() as RegisterRes;
}

async function createProduct(token: string, data: { name: string; priceCents: number }) {
  const res = await app.inject({
    method: "POST",
    url: "/products",
    headers: { Authorization: `Bearer ${token}` },
    payload: data,
  });
  expect(res.statusCode).toBe(201);
  return res.json() as { id: string; name: string; priceCents: number };
}

async function createOrder(token: string) {
  const res = await app.inject({ method: "POST", url: "/orders", headers: { Authorization: `Bearer ${token}` } });
  expect(res.statusCode).toBe(201);
  return res.json() as { id: string };
}

async function addItem(token: string, orderId: string, payload: { productId: string; qty: number }) {
  const res = await app.inject({ method: "POST", url: `/orders/${orderId}/items`, headers: { Authorization: `Bearer ${token}` }, payload });
  expect(res.statusCode).toBe(200);
}

async function updateStatus(token: string, orderId: string, toStatus: string) {
  const res = await app.inject({ method: "PATCH", url: `/orders/${orderId}/status`, headers: { Authorization: `Bearer ${token}` }, payload: { toStatus } });
  expect(res.statusCode).toBe(200);
}

async function getOrder(token: string, orderId: string) {
  const res = await app.inject({ method: "GET", url: `/orders/${orderId}`, headers: { Authorization: `Bearer ${token}` } });
  expect(res.statusCode).toBe(200);
  return res.json() as { totalCents: number };
}

beforeAll(async () => {
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe("outbox worker", () => {
  it("crea OutboxEvent PENDING al pagar y worker lo procesa", async () => {
    const reg = await registerTenant({ tenantName: `OB-${Date.now()}`, email: "admin@ob.com", password: "secret12345" });
    const product = await createProduct(reg.accessToken, { name: "OB-Prod", priceCents: 222 });
    const order = await createOrder(reg.accessToken);
    await addItem(reg.accessToken, order.id, { productId: product.id, qty: 2 });
    await updateStatus(reg.accessToken, order.id, "OPEN");

    const before = new Date();
    const current = await getOrder(reg.accessToken, order.id);
    const key = genIdempotencyKey("ob");
    const pay = await app.inject({
      method: "POST",
      url: `/orders/${order.id}/payments`,
      headers: { Authorization: `Bearer ${reg.accessToken}` },
      payload: { amountCents: current.totalCents, method: "CARD", idempotencyKey: key },
    });
    expect([200,201]).toContain(pay.statusCode);
    const p = pay.json() as any;
    expect(p.status).toBe("SUCCEEDED");

    // outbox pending
    const pending = await app.prisma.outboxEvent.findMany({
      where: { tenantId: reg.tenant.id, type: "PAYMENT_SUCCEEDED", status: "PENDING", createdAt: { gt: before } },
    });
    expect(pending.length).toBe(1);
    const ev = pending[0];
    expect((ev.payloadJson as any).paymentId).toBe(p.id);
    expect((ev.payloadJson as any).orderId).toBe(order.id);
    expect((ev.payloadJson as any).amountCents).toBe(current.totalCents);
    expect((ev.payloadJson as any).method).toBe("CARD");
    expect(typeof (ev.payloadJson as any).occurredAt).toBe("string");

    // idempotente: reenviar mismo pago no duplica evento
    const replay = await app.inject({ method: "POST", url: `/orders/${order.id}/payments`, headers: { Authorization: `Bearer ${reg.accessToken}` }, payload: { amountCents: current.totalCents, method: "CARD", idempotencyKey: key } });
    expect(replay.statusCode).toBe(200);

    const stillOne = await app.prisma.outboxEvent.count({ where: { tenantId: reg.tenant.id, type: "PAYMENT_SUCCEEDED", status: "PENDING", createdAt: { gt: before } } });
    expect(stillOne).toBe(1);

    // worker procesa (asegurar que no haya un lock residual de otras pruebas)
    await app.redis.del("outbox:lock");
    const res = await runOutboxOnce({ batchSize: 1000 });
    expect(res.locked).toBe(false);
    expect(res.processed).toBeGreaterThanOrEqual(1);

    const processed = await app.prisma.outboxEvent.findUnique({ where: { id: ev.id } });
    expect(processed?.status).toBe("PROCESSED");
  });
});
