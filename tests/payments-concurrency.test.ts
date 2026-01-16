import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { registerTenantAndLogin, createProduct, createOrder, addOrderItem, openOrder } from "./_helpers.js";
import { genIdempotencyKey } from "./test-utils.js";

const app = buildApp();

beforeAll(async () => {
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe("payments idempotency concurrency", () => {
  it("two parallel requests with same idempotencyKey return same payment", async () => {
    const reg = await registerTenantAndLogin(app, { tenantName: `C-${Date.now()}`, email: `c-${Date.now()}@ex.com`, password: "secret12345" });
    const product = await createProduct(app, reg.accessToken, { name: "P1", priceCents: 500 });
    const order = await createOrder(app, reg.accessToken);
    await addOrderItem(app, reg.accessToken, order.id, product.id, 2);
    await openOrder(app, reg.accessToken, order.id);

    const key = genIdempotencyKey("concurrent");

    const [r1, r2] = await Promise.all([
      app.inject({ method: "POST", url: `/orders/${order.id}/payments`, headers: { Authorization: `Bearer ${reg.accessToken}` }, payload: { amountCents: 1000, method: "CARD", idempotencyKey: key } }),
      app.inject({ method: "POST", url: `/orders/${order.id}/payments`, headers: { Authorization: `Bearer ${reg.accessToken}` }, payload: { amountCents: 1000, method: "CARD", idempotencyKey: key } }),
    ]);

    expect([200,201]).toContain(r1.statusCode);
    expect([200,201]).toContain(r2.statusCode);

    const p1 = r1.json() as any; const p2 = r2.json() as any;
    expect(p1.id).toBe(p2.id);

    // DB should have only one payment for that idempotencyKey
    const count = await app.prisma.payment.count({ where: { tenantId: reg.tenant.id, idempotencyKey: key } });
    expect(count).toBe(1);
  });
});
