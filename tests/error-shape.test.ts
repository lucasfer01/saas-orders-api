import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { buildApp } from "../src/app.js";

const app = buildApp();

beforeAll(async () => {
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe("error shape standardization", () => {
  it("Zod: POST /products sin name => 422 VALIDATION_ERROR shape", async () => {
    // Registrar tenant para tener token
    const reg = await app.inject({ method: "POST", url: "/auth/register", payload: { tenantName: `Err-${Date.now()}`, email: "admin@err.com", password: "secret12345" } });
    expect(reg.statusCode).toBe(201);
    const token = (reg.json() as any).accessToken as string;

    // Enviar payload inválido
    const res = await app.inject({ method: "POST", url: "/products", headers: { Authorization: `Bearer ${token}` }, payload: { priceCents: 1000 } });
    expect(res.statusCode).toBe(422);
    const body = res.json() as any;
    expect(body?.error?.code).toBe("VALIDATION_ERROR");
    expect(typeof body?.error?.message).toBe("string");
  });

  it("Unauthorized: GET /products sin token => 401 UNAUTHORIZED shape", async () => {
    const res = await app.inject({ method: "GET", url: "/products" });
    expect(res.statusCode).toBe(401);
    const body = res.json() as any;
    expect(body?.error?.code).toBe("UNAUTHORIZED");
    expect(typeof body?.error?.message).toBe("string");
  });
});
