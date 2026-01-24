import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { buildApp } from "../src/app.js";
import {
  registerTenantAndLogin,
  createProduct,
  createOrder,
  addOrderItem,
  openOrder,
} from "./_helpers";

let app: ReturnType<typeof buildApp>;

describe("Receipts module", () => {
  let accessToken: string;
  let tenantId: string;
  let orderId: string;
  let productId: string;

  beforeAll(async () => {
    app = buildApp();
    await app.ready();
    // Setup: register tenant, create product, order, add item, pay
    const reg = await registerTenantAndLogin(app, {
      tenantName: "ReceiptsTest",
      email: `admin+${Date.now()}@mail.com`,
      password: "test1234",
    });
    accessToken = reg.accessToken;
    tenantId = reg.tenant.id;
    const prod = await createProduct(app, accessToken, { name: "TestProd", priceCents: 1000 });
    productId = prod.id;
    const order = await createOrder(app, accessToken);
    orderId = order.id;
    await addOrderItem(app, accessToken, orderId, productId, 2);
    await openOrder(app, accessToken, orderId);
    // Pagar la orden (simular PATCH /orders/:id/status { toStatus: "PAID" })
    await app.inject({
      method: "PATCH",
      url: `/orders/${orderId}/status`,
      headers: { Authorization: `Bearer ${accessToken}` },
      payload: { toStatus: "PAID" },
    });
  });

  afterAll(async () => {
    await app.close();
  });

  it("emite receipt OK", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/orders/${orderId}/receipt`,
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    expect([200, 201]).toContain(res.statusCode);
    const body = res.json();
    expect(body.tenantId).toBe(tenantId);
    expect(body.orderId).toBe(orderId);
    expect(body.items.length).toBeGreaterThan(0);
    expect(typeof body.number).toBe("number");
    expect(body.status).toBe("ISSUED");
  });

  it("idempotencia: no duplica receipt", async () => {
    const res1 = await app.inject({
      method: "POST",
      url: `/orders/${orderId}/receipt`,
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const res2 = await app.inject({
      method: "POST",
      url: `/orders/${orderId}/receipt`,
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    expect(res1.json().id).toBe(res2.json().id);
    expect(res1.json().number).toBe(res2.json().number);
  });

  it("bloquea emisión si order no está PAID", async () => {
    // Crear nueva order OPEN
    const order = await createOrder(app, accessToken);
    await addOrderItem(app, accessToken, order.id, productId, 1);
    await openOrder(app, accessToken, order.id);
    const res = await app.inject({
      method: "POST",
      url: `/orders/${order.id}/receipt`,
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    expect([400, 409]).toContain(res.statusCode);
    expect(res.json().error).toBeDefined();
  });

  it("aislamiento de tenant: no permite ver receipt de otro tenant", async () => {
    // Crear otro tenant y usuario
    const reg2 = await registerTenantAndLogin(app, {
      tenantName: "OtherTenant",
      email: `other+${Date.now()}@mail.com`,
      password: "test1234",
    });
    const res = await app.inject({
      method: "GET",
      url: `/orders/${orderId}/receipt`,
      headers: { Authorization: `Bearer ${reg2.accessToken}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it("void: marca como VOIDED y es idempotente", async () => {
    // Emitir receipt
    const res = await app.inject({
      method: "POST",
      url: `/orders/${orderId}/receipt`,
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const receiptId = res.json().id;
    // Void
    const voidRes = await app.inject({
      method: "POST",
      url: `/receipts/${receiptId}/void`,
      headers: { Authorization: `Bearer ${accessToken}` },
      payload: { reason: "error" },
    });
    expect(voidRes.statusCode).toBe(200);
    expect(voidRes.json().status).toBe("VOIDED");
    expect(voidRes.json().voidedAt).toBeDefined();
    // Void idempotente
    const voidRes2 = await app.inject({
      method: "POST",
      url: `/receipts/${receiptId}/void`,
      headers: { Authorization: `Bearer ${accessToken}` },
      payload: { reason: "error" },
    });
    expect(voidRes2.statusCode).toBe(200);
    expect(voidRes2.json().status).toBe("VOIDED");
  });
});
