import { expect } from "vitest";
import type { FastifyInstance } from "fastify";

export type RegisterRes = {
  tenant: { id: string };
  accessToken: string;
  refreshToken: string;
  user: { id: string; email: string };
};

export async function registerTenantAndLogin(app: FastifyInstance, payload: {
  tenantName: string;
  email: string;
  password: string;
}) {
  const res = await app.inject({ method: "POST", url: "/auth/register", payload });
  expect(res.statusCode).toBe(201);
  return res.json() as RegisterRes;
}

export async function createProduct(app: FastifyInstance, token: string, data: { name: string; priceCents: number }) {
  const res = await app.inject({ method: "POST", url: "/products", headers: { Authorization: `Bearer ${token}` }, payload: data });
  expect(res.statusCode).toBe(201);
  return res.json() as { id: string; name: string; priceCents: number };
}

export async function createOrder(app: FastifyInstance, token: string) {
  const res = await app.inject({ method: "POST", url: "/orders", headers: { Authorization: `Bearer ${token}` } });
  expect(res.statusCode).toBe(201);
  return res.json() as { id: string };
}

export async function addOrderItem(app: FastifyInstance, token: string, orderId: string, productId: string, qty: number) {
  const res = await app.inject({ method: "POST", url: `/orders/${orderId}/items`, headers: { Authorization: `Bearer ${token}` }, payload: { productId, qty } });
  expect(res.statusCode).toBe(200);
}

export async function openOrder(app: FastifyInstance, token: string, orderId: string) {
  const res = await app.inject({ method: "PATCH", url: `/orders/${orderId}/status`, headers: { Authorization: `Bearer ${token}` }, payload: { toStatus: "OPEN" } });
  expect(res.statusCode).toBe(200);
}
