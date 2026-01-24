import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { registerTenantAndLogin, createProduct, createOrder, addOrderItem, openOrder } from "./_helpers.js";
import { genIdempotencyKey } from "./test-utils.js";

const app = buildApp();

beforeAll(async () => { await app.ready(); });
afterAll(async () => { await app.close(); });

describe("multi-tenant isolation", () => {
  it("tenant B cannot access tenant A payment or order", async () => {
    const A = await registerTenantAndLogin(app, { tenantName: `A-${Date.now()}`, email: `a-${Date.now()}@ex.com`, password: "secret12345" });
    const B = await registerTenantAndLogin(app, { tenantName: `B-${Date.now()}`, email: `b-${Date.now()}@ex.com`, password: "secret12345" });

    const prodA = await createProduct(app, A.accessToken, { name: "AP", priceCents: 300 });
    const orderA = await createOrder(app, A.accessToken);
    await addOrderItem(app, A.accessToken, orderA.id, prodA.id, 1);
    await openOrder(app, A.accessToken, orderA.id);

    const payRes = await app.inject({ method: "POST", url: `/orders/${orderA.id}/payments`, headers: { Authorization: `Bearer ${A.accessToken}` }, payload: { amountCents: 300, method: "CARD", idempotencyKey: genIdempotencyKey("iso") } });
    expect([200,201]).toContain(payRes.statusCode);
    const payment = payRes.json() as any;

    const getOrderByB = await app.inject({ method: "GET", url: `/orders/${orderA.id}`, headers: { Authorization: `Bearer ${B.accessToken}` } });
    expect([403,404]).toContain(getOrderByB.statusCode);

    const getPaymentByB = await app.inject({ method: "GET", url: `/payments/${payment.id}`, headers: { Authorization: `Bearer ${B.accessToken}` } });
    expect([403,404]).toContain(getPaymentByB.statusCode);
  }, 15000);
});
