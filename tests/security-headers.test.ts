import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { buildApp } from "../src/app.js";

const app = buildApp();

beforeAll(async () => {
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe("security headers", () => {
  it("GET /health incluye headers de seguridad básicos", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    const headers = res.headers as Record<string, string>;
    // Verificar al menos dos headers típicos
    expect(headers["x-content-type-options"]).toBeDefined();
    expect(headers["x-frame-options"]).toBeDefined();
    // referrer-policy también debe estar
    expect(headers["referrer-policy"]).toBeDefined();
  });
});
