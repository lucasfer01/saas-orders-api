import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { signAccessToken } from "../src/auth/jwt.js";

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
  return res.json() as { id: string; tenantId: string; name: string; priceCents: number; active: boolean };
}

async function createOrder(token: string) {
  const res = await app.inject({
    method: "POST",
    url: "/orders",
    headers: { Authorization: `Bearer ${token}` },
    payload: {},
  });
  expect(res.statusCode).toBe(201);
  return res.json() as { id: string; tenantId: string; number: number; status: string; subtotalCents: number; totalCents: number };
}

async function addItem(token: string, orderId: string, payload: { productId: string; qty: number }) {
  return app.inject({
    method: "POST",
    url: `/orders/${orderId}/items`,
    headers: { Authorization: `Bearer ${token}` },
    payload,
  });
}

async function updateStatus(token: string, orderId: string, toStatus: string) {
  return app.inject({
    method: "PATCH",
    url: `/orders/${orderId}/status`,
    headers: { Authorization: `Bearer ${token}` },
    payload: { toStatus },
  });
}

async function getOrder(token: string, orderId: string) {
  return app.inject({
    method: "GET",
    url: `/orders/${orderId}`,
    headers: { Authorization: `Bearer ${token}` },
  });
}

beforeAll(async () => {
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe("payments module", () => {
  it("happy path: OPEN order -> payment succeeds -> order PAID + history", async () => {
    const a = await registerTenant({
      tenantName: "Pay-A",
      email: "admin@paya.com",
      password: "secret12345",
    });

    const product = await createProduct(a.accessToken, { name: "Widget-P", priceCents: 500 });
    const order = await createOrder(a.accessToken);
    const addRes = await addItem(a.accessToken, order.id, { productId: product.id, qty: 2 });
    expect(addRes.statusCode).toBe(200);

    const toOpen = await updateStatus(a.accessToken, order.id, "OPEN");
    expect(toOpen.statusCode).toBe(200);

    const openOrder = (await getOrder(a.accessToken, order.id)).json() as any;
    const amount = openOrder.totalCents as number;

    const payRes = await app.inject({
      method: "POST",
      url: `/orders/${order.id}/payments`,
      headers: { Authorization: `Bearer ${a.accessToken}` },
      payload: { amountCents: amount, method: "CASH", idempotencyKey: "key-happy-12345" },
    });
    expect(payRes.statusCode).toBe(201);
    const payment = payRes.json() as any;
    expect(payment.status).toBe("SUCCEEDED");

    const after = await getOrder(a.accessToken, order.id);
    expect(after.statusCode).toBe(200);
    const afterOrder = after.json() as any;
    expect(afterOrder.status).toBe("PAID");

    const rows = await app.prisma.orderStatusHistory.findMany({
      where: { tenantId: a.tenant.id, orderId: order.id, toStatus: "PAID" },
    });
    expect(rows.length).toBe(1);
  });

  it("idempotencia: mismo idempotencyKey devuelve 200 y mismo payment.id sin duplicar history", async () => {
    const a = await registerTenant({
      tenantName: "Pay-Idem",
      email: "admin@idem.com",
      password: "secret12345",
    });

    const product = await createProduct(a.accessToken, { name: "Idem-Prod", priceCents: 1000 });
    const order = await createOrder(a.accessToken);
    await addItem(a.accessToken, order.id, { productId: product.id, qty: 1 });
    await updateStatus(a.accessToken, order.id, "OPEN");

    const current = (await getOrder(a.accessToken, order.id)).json() as any;
    const amount = current.totalCents as number;

    const idemKey = "key-idempotent-xxxxx";
    const first = await app.inject({
      method: "POST",
      url: `/orders/${order.id}/payments`,
      headers: { Authorization: `Bearer ${a.accessToken}` },
      payload: { amountCents: amount, method: "CARD", idempotencyKey: idemKey },
    });
    expect(first.statusCode).toBe(201);
    const p1 = first.json() as any;

    const second = await app.inject({
      method: "POST",
      url: `/orders/${order.id}/payments`,
      headers: { Authorization: `Bearer ${a.accessToken}` },
      payload: { amountCents: amount, method: "CARD", idempotencyKey: idemKey },
    });
    expect(second.statusCode).toBe(200);
    const p2 = second.json() as any;
    expect(p2.id).toBe(p1.id);

    const histories = await app.prisma.orderStatusHistory.findMany({
      where: { tenantId: a.tenant.id, orderId: order.id, toStatus: "PAID" },
    });
    expect(histories.length).toBe(1);
  });

  it("forbidden: STAFF no puede crear payment", async () => {
    const a = await registerTenant({
      tenantName: "Pay-Forbidden",
      email: "admin@pf.com",
      password: "secret12345",
    });

    const product = await createProduct(a.accessToken, { name: "PF-Prod", priceCents: 200 });
    const order = await createOrder(a.accessToken);
    await addItem(a.accessToken, order.id, { productId: product.id, qty: 1 });
    await updateStatus(a.accessToken, order.id, "OPEN");

    const open = (await getOrder(a.accessToken, order.id)).json() as any;
    const staffToken = signAccessToken({
      sub: a.user.id,
      tenantId: a.tenant.id,
      roles: ["STAFF"],
    });

    const res = await app.inject({
      method: "POST",
      url: `/orders/${order.id}/payments`,
      headers: { Authorization: `Bearer ${staffToken}` },
      payload: { amountCents: open.totalCents, method: "CASH", idempotencyKey: "key-staff-11111" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("tenant isolation: B no puede pagar order de A (404)", async () => {
    const a = await registerTenant({ tenantName: "Pay-Tenant-A", email: "admin@pta.com", password: "secret12345" });
    const b = await registerTenant({ tenantName: "Pay-Tenant-B", email: "admin@ptb.com", password: "secret12345" });

    const prodA = await createProduct(a.accessToken, { name: "A-Prod", priceCents: 100 });
    const orderA = await createOrder(a.accessToken);
    await addItem(a.accessToken, orderA.id, { productId: prodA.id, qty: 1 });
    await updateStatus(a.accessToken, orderA.id, "OPEN");

    const openA = (await getOrder(a.accessToken, orderA.id)).json() as any;

    const resB = await app.inject({
      method: "POST",
      url: `/orders/${orderA.id}/payments`,
      headers: { Authorization: `Bearer ${b.accessToken}` },
      payload: { amountCents: openA.totalCents, method: "CASH", idempotencyKey: "key-cross-1" },
    });
    expect(resB.statusCode).toBe(404);
  });

  it("amount mismatch => 400", async () => {
    const a = await registerTenant({ tenantName: "Pay-Amount", email: "admin@pam.com", password: "secret12345" });
    const product = await createProduct(a.accessToken, { name: "ProdA", priceCents: 300 });
    const order = await createOrder(a.accessToken);
    await addItem(a.accessToken, order.id, { productId: product.id, qty: 1 });
    await updateStatus(a.accessToken, order.id, "OPEN");

    const res = await app.inject({
      method: "POST",
      url: `/orders/${order.id}/payments`,
      headers: { Authorization: `Bearer ${a.accessToken}` },
      payload: { amountCents: 9999, method: "CARD", idempotencyKey: "key-mismatch-1" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("Order en PAID no permite pagar (400)", async () => {
    const a = await registerTenant({ tenantName: "Pay-State", email: "admin@pstate.com", password: "secret12345" });
    const product = await createProduct(a.accessToken, { name: "PS-Prod", priceCents: 150 });
    const order = await createOrder(a.accessToken);
    await addItem(a.accessToken, order.id, { productId: product.id, qty: 1 });
    await updateStatus(a.accessToken, order.id, "OPEN");
    await updateStatus(a.accessToken, order.id, "PAID");

    const res = await app.inject({
      method: "POST",
      url: `/orders/${order.id}/payments`,
      headers: { Authorization: `Bearer ${a.accessToken}` },
      payload: { amountCents: 150, method: "TRANSFER", idempotencyKey: "key-paid-1" },
    });
    expect([400, 409]).toContain(res.statusCode);
  });
});
