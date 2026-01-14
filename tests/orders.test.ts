import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { buildApp } from "../src/app.js";

let app = buildApp();
let tenantId: string;
let token: string;
let productId: string;
let orderId: string;

beforeAll(async () => {
  await app.ready();
  // register admin
  const reg = await app.inject({
    method: "POST",
    url: "/auth/register",
    payload: {
      tenantName: "OrdersCo",
      email: "admin@ordersco.com",
      password: "secret12345",
    },
  });
  const body = reg.json();
  tenantId = body.tenant.id;
  token = body.accessToken;
});

afterAll(async () => {
  await app.close();
});

describe("orders flow", () => {
  it("creates a product", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/products",
      headers: { Authorization: `Bearer ${token}` },
      payload: { name: "Widget", priceCents: 1999 },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    productId = body.id;
    expect(body.tenantId).toBe(tenantId);
  });

  it("creates an order", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/orders",
      headers: { Authorization: `Bearer ${token}` },
      payload: {},
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    orderId = body.id;
    expect(body.status).toBe("DRAFT");
    expect(body.subtotalCents).toBe(0);
  });

  it("adds an item to the order and recalculates totals", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/orders/${orderId}/items`,
      headers: { Authorization: `Bearer ${token}` },
      payload: { productId, qty: 2 },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items.length).toBe(1);
    expect(body.subtotalCents).toBe(1999 * 2);
    expect(body.totalCents).toBe(1999 * 2);
  });

  it("lists orders with pagination", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/orders?page=1&pageSize=10",
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.total).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(body.items)).toBe(true);
  });
});
