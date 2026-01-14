import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { signAccessToken } from "../src/auth/jwt.js";
import { genIdempotencyKey } from "./test-utils.js";

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
  it("auth required: POST /orders/:id/payments, GET list, GET by id => 401", async () => {
    const post = await app.inject({ method: "POST", url: "/orders/some-order/payments", payload: { amountCents: 1, method: "CARD", idempotencyKey: genIdempotencyKey("auth") } });
    expect(post.statusCode).toBe(401);
    const list = await app.inject({ method: "GET", url: "/orders/some-order/payments" });
    expect(list.statusCode).toBe(401);
    const get = await app.inject({ method: "GET", url: "/payments/some-id" });
    expect(get.statusCode).toBe(401);
  });

  it("rbac: MANAGER puede crear payment; STAFF no", async () => {
    const reg = await app.inject({ method: "POST", url: "/auth/register", payload: { tenantName: `Pay-RBAC-${Date.now()}`, email: "admin@payrbac.com", password: "secret12345" } });
    expect(reg.statusCode).toBe(201);
    const { accessToken, tenant, user } = reg.json() as any;
    const product = await createProduct(accessToken, { name: "RB-Prod", priceCents: 123 });
    const order = await createOrder(accessToken);
    await addItem(accessToken, order.id, { productId: product.id, qty: 1 });
    await updateStatus(accessToken, order.id, "OPEN");
    const amount = (await getOrder(accessToken, order.id)).json().totalCents as number;

    const managerToken = signAccessToken({ sub: user.id, tenantId: tenant.id, roles: ["MANAGER"] });
    const ok = await app.inject({ method: "POST", url: `/orders/${order.id}/payments`, headers: { Authorization: `Bearer ${managerToken}` }, payload: { amountCents: amount, method: "CARD", idempotencyKey: genIdempotencyKey("mgr") } });
    expect([200, 201]).toContain(ok.statusCode);

    const staffToken = signAccessToken({ sub: user.id, tenantId: tenant.id, roles: ["STAFF"] });
    const fail = await app.inject({ method: "POST", url: `/orders/${order.id}/payments`, headers: { Authorization: `Bearer ${staffToken}` }, payload: { amountCents: amount, method: "CARD", idempotencyKey: genIdempotencyKey("staff-pay") } });
    expect(fail.statusCode).toBe(403);
  });

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
      payload: { amountCents: amount, method: "CASH", idempotencyKey: genIdempotencyKey("happy") },
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

    const idemKey = genIdempotencyKey("idempotent");
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
      payload: { amountCents: open.totalCents, method: "CASH", idempotencyKey: genIdempotencyKey("staff") },
    });
    expect(res.statusCode).toBe(403);
  });

  it("tenant isolation: B no puede pagar order de A (404)", async () => {
    const a = await registerTenant({ tenantName: "Pay-Tenant-A", email: "admin@pta.com", password: "secret12345" });
    const b = await registerTenant({ tenantName: "Pay-Tenant-B", email: "admin@ptb.com", password: "secret12345" });

    const prodA = await createProduct(a.accessToken, { name: "A-Prod", priceCents: 100 });
    const orderA = await createOrder(a.accessToken);
    await addItem(a.accessToken, orderA.id, { productId: prodA.id, qty: 1 });
    const toOpenA = await updateStatus(a.accessToken, orderA.id, "OPEN");
    expect(toOpenA.statusCode).toBe(200);

    const openA = (await getOrder(a.accessToken, orderA.id)).json() as any;
    expect(openA.status).toBe("OPEN");

    const resB = await app.inject({
      method: "POST",
      url: `/orders/${orderA.id}/payments`,
      headers: { Authorization: `Bearer ${b.accessToken}` },
      payload: { amountCents: openA.totalCents, method: "CASH", idempotencyKey: genIdempotencyKey("cross") },
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
      payload: { amountCents: 9999, method: "CARD", idempotencyKey: genIdempotencyKey("mismatch") },
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
      payload: { amountCents: 150, method: "TRANSFER", idempotencyKey: genIdempotencyKey("paid") },
    });
    expect([400, 409]).toContain(res.statusCode);
  });

  it("No paga si order está DRAFT o CANCELED (400)", async () => {
    const a = await registerTenant({ tenantName: `Pay-States-${Date.now()}`, email: "admin@pstates.com", password: "secret12345" });
    const product = await createProduct(a.accessToken, { name: "PST-Prod", priceCents: 200 });
    const order = await createOrder(a.accessToken);
    await addItem(a.accessToken, order.id, { productId: product.id, qty: 1 });
    // DRAFT => 400
    const draftAmount = (await getOrder(a.accessToken, order.id)).json().totalCents as number;
    const payDraft = await app.inject({ method: "POST", url: `/orders/${order.id}/payments`, headers: { Authorization: `Bearer ${a.accessToken}` }, payload: { amountCents: draftAmount, method: "CARD", idempotencyKey: genIdempotencyKey("draft") } });
    expect(payDraft.statusCode).toBe(400);
    // CANCELED => 400
    await updateStatus(a.accessToken, order.id, "OPEN");
    await updateStatus(a.accessToken, order.id, "CANCELED");
    const canceledAmount = (await getOrder(a.accessToken, order.id)).json().totalCents as number;
    const payCanceled = await app.inject({ method: "POST", url: `/orders/${order.id}/payments`, headers: { Authorization: `Bearer ${a.accessToken}` }, payload: { amountCents: canceledAmount, method: "CARD", idempotencyKey: genIdempotencyKey("canceled") } });
    expect(payCanceled.statusCode).toBe(400);
  });

  it("lists payments for an order and gets by id", async () => {
    const a = await registerTenant({ tenantName: "Pay-List", email: "admin@plist.com", password: "secret12345" });
    const product = await createProduct(a.accessToken, { name: "PL-Prod", priceCents: 250 });
    const order = await createOrder(a.accessToken);
    await addItem(a.accessToken, order.id, { productId: product.id, qty: 2 });
    await updateStatus(a.accessToken, order.id, "OPEN");

    const current = (await getOrder(a.accessToken, order.id)).json() as any;
    const amount = current.totalCents as number;

    const payRes = await app.inject({
      method: "POST",
      url: `/orders/${order.id}/payments`,
      headers: { Authorization: `Bearer ${a.accessToken}` },
      payload: { amountCents: amount, method: "CARD", idempotencyKey: genIdempotencyKey("list") },
    });
    expect(payRes.statusCode).toBe(201);
    const payment = payRes.json() as any;

    const listRes = await app.inject({
      method: "GET",
      url: `/orders/${order.id}/payments`,
      headers: { Authorization: `Bearer ${a.accessToken}` },
    });
    expect(listRes.statusCode).toBe(200);
    const list = listRes.json() as any;
    expect(list.total).toBeGreaterThanOrEqual(1);
    expect(list.items.find((p: any) => p.id === payment.id)).toBeTruthy();

    const getRes = await app.inject({
      method: "GET",
      url: `/payments/${payment.id}`,
      headers: { Authorization: `Bearer ${a.accessToken}` },
    });
    expect(getRes.statusCode).toBe(200);
    const got = getRes.json() as any;
    expect(got.id).toBe(payment.id);
    expect(got.orderId).toBe(order.id);
  });

  it("list payments is tenant-scoped (404 from other tenant)", async () => {
    const a = await registerTenant({ tenantName: `Pay-List-ISO-A-${Date.now()}`, email: "admin@plisoa.com", password: "secret12345" });
    const b = await registerTenant({ tenantName: `Pay-List-ISO-B-${Date.now()}`, email: "admin@plisob.com", password: "secret12345" });
    const prodA = await createProduct(a.accessToken, { name: "PLI-Prod", priceCents: 300 });
    const orderA = await createOrder(a.accessToken);
    await addItem(a.accessToken, orderA.id, { productId: prodA.id, qty: 1 });
    await updateStatus(a.accessToken, orderA.id, "OPEN");
    const amount = (await getOrder(a.accessToken, orderA.id)).json().totalCents as number;
    await app.inject({ method: "POST", url: `/orders/${orderA.id}/payments`, headers: { Authorization: `Bearer ${a.accessToken}` }, payload: { amountCents: amount, method: "CARD", idempotencyKey: genIdempotencyKey("iso-list") } });

    const listByB = await app.inject({ method: "GET", url: `/orders/${orderA.id}/payments`, headers: { Authorization: `Bearer ${b.accessToken}` } });
    expect(listByB.statusCode).toBe(404);
  });

  it("idempotency 409 when reusing key with different payload", async () => {
    const a = await registerTenant({ tenantName: "Pay-Conflict", email: "admin@pc.com", password: "secret12345" });
    const product = await createProduct(a.accessToken, { name: "PC-Prod", priceCents: 400 });
    const order = await createOrder(a.accessToken);
    await addItem(a.accessToken, order.id, { productId: product.id, qty: 1 });
    await updateStatus(a.accessToken, order.id, "OPEN");

    const current = (await getOrder(a.accessToken, order.id)).json() as any;
    const amount = current.totalCents as number;
    const key = genIdempotencyKey("conflict");

    const first = await app.inject({
      method: "POST",
      url: `/orders/${order.id}/payments`,
      headers: { Authorization: `Bearer ${a.accessToken}` },
      payload: { amountCents: amount, method: "CARD", idempotencyKey: key },
    });
    expect(first.statusCode).toBe(201);
    const p1 = first.json() as any;
    expect(p1.status).toBe("SUCCEEDED");

    const second = await app.inject({
      method: "POST",
      url: `/orders/${order.id}/payments`,
      headers: { Authorization: `Bearer ${a.accessToken}` },
      payload: { amountCents: amount, method: "CASH", idempotencyKey: key },
    });
    expect(second.statusCode).toBe(409);
  });

  it("failed payment does not transition order and is idempotent", async () => {
    const a = await registerTenant({ tenantName: "Pay-Fail", email: "admin@pfail.com", password: "secret12345" });
    const product = await createProduct(a.accessToken, { name: "PF-Prod", priceCents: 350 });
    const order = await createOrder(a.accessToken);
    await addItem(a.accessToken, order.id, { productId: product.id, qty: 1 });
    await updateStatus(a.accessToken, order.id, "OPEN");

    const current = (await getOrder(a.accessToken, order.id)).json() as any;
    const amount = current.totalCents as number;

    const key = genIdempotencyKey("fail");
    const failRes = await app.inject({
      method: "POST",
      url: `/orders/${order.id}/payments`,
      headers: { Authorization: `Bearer ${a.accessToken}` },
      payload: { amountCents: amount, method: "CARD", idempotencyKey: key, testFail: true },
    });
    expect(failRes.statusCode).toBe(201);
    const payment = failRes.json() as any;
    expect(payment.status).toBe("FAILED");

    const after = await getOrder(a.accessToken, order.id);
    expect(after.statusCode).toBe(200);
    const afterOrder = after.json() as any;
    expect(afterOrder.status).toBe("OPEN");

    const replay = await app.inject({
      method: "POST",
      url: `/orders/${order.id}/payments`,
      headers: { Authorization: `Bearer ${a.accessToken}` },
      payload: { amountCents: amount, method: "CARD", idempotencyKey: key, testFail: true },
    });
    expect(replay.statusCode).toBe(200);
    const p2 = replay.json() as any;
    expect(p2.id).toBe(payment.id);
    expect(p2.status).toBe("FAILED");
  });

  it("GET payment is tenant-scoped (404 from other tenant)", async () => {
    const a = await registerTenant({ tenantName: "Pay-Get-A", email: "admin@pga.com", password: "secret12345" });
    const b = await registerTenant({ tenantName: "Pay-Get-B", email: "admin@pgb.com", password: "secret12345" });

    const prodA = await createProduct(a.accessToken, { name: "A-Prod", priceCents: 120 });
    const orderA = await createOrder(a.accessToken);
    await addItem(a.accessToken, orderA.id, { productId: prodA.id, qty: 1 });
    await updateStatus(a.accessToken, orderA.id, "OPEN");

    const currentA = (await getOrder(a.accessToken, orderA.id)).json() as any;
    const amountA = currentA.totalCents as number; // usar total de la orden

    const payA = await app.inject({
      method: "POST",
      url: `/orders/${orderA.id}/payments`,
      headers: { Authorization: `Bearer ${a.accessToken}` },
      payload: { amountCents: amountA, method: "CARD", idempotencyKey: genIdempotencyKey("get") },
    });
    expect(payA.statusCode).toBe(201);
    const paymentA = payA.json() as any;

    const getByB = await app.inject({
      method: "GET",
      url: `/payments/${paymentA.id}`,
      headers: { Authorization: `Bearer ${b.accessToken}` },
    });
    expect(getByB.statusCode).toBe(404);
  });

  it("idempotency concurrency: 2 POST simultáneos con misma key -> mismo payment", async () => {
    const a = await registerTenant({ tenantName: `Pay-Con-${Date.now()}`, email: "admin@pcon.com", password: "secret12345" });
    const product = await createProduct(a.accessToken, { name: "PCON-Prod", priceCents: 450 });
    const order = await createOrder(a.accessToken);
    await addItem(a.accessToken, order.id, { productId: product.id, qty: 1 });
    await updateStatus(a.accessToken, order.id, "OPEN");
    const amount = (await getOrder(a.accessToken, order.id)).json().totalCents as number;
    const idem = genIdempotencyKey("race");

    const [r1, r2] = await Promise.all([
      app.inject({ method: "POST", url: `/orders/${order.id}/payments`, headers: { Authorization: `Bearer ${a.accessToken}` }, payload: { amountCents: amount, method: "CARD", idempotencyKey: idem } }),
      app.inject({ method: "POST", url: `/orders/${order.id}/payments`, headers: { Authorization: `Bearer ${a.accessToken}` }, payload: { amountCents: amount, method: "CARD", idempotencyKey: idem } }),
    ]);
    expect([200,201]).toContain(r1.statusCode);
    expect([200,201]).toContain(r2.statusCode);
    const p1 = r1.json() as any;
    const p2 = r2.json() as any;
    expect(p1.id).toBe(p2.id);

    const list = await app.inject({ method: "GET", url: `/orders/${order.id}/payments`, headers: { Authorization: `Bearer ${a.accessToken}` } });
    const body = list.json() as any;
    expect(body.total).toBeGreaterThanOrEqual(1);
    expect(body.items.filter((x: any) => x.id === p1.id).length).toBe(1);
  });
});
