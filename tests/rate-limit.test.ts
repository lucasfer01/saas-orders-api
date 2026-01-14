import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { buildApp } from "../src/app.js";

const app = buildApp();

beforeAll(async () => {
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe("rate limiting", () => {
  it("superar límite de login devuelve 429 RATE_LIMITED", async () => {
    // Registrar tenant y usuario
    const reg = await app.inject({ method: "POST", url: "/auth/register", payload: { tenantName: `RL-${Date.now()}`, email: "admin@rl.com", password: "secret12345" } });
    expect(reg.statusCode).toBe(201);
    const tenantId = (reg.json() as any).tenant.id as string;

    // Intentar logins repetidos (algunos con credenciales inválidas)
    const attempts = 1 + Number(process.env.RATE_LIMIT_LOGIN_MAX ?? 10) + 2;
    let lastStatus = 200;
    let lastBody: any = null;
    for (let i = 0; i < attempts; i++) {
      // Usar email inexistente para evitar bcrypt compare y acelerar el test
      const res = await app.inject({ method: "POST", url: "/auth/login", payload: { tenantId, email: "unknown@rl.com", password: "wrong" } });
      lastStatus = res.statusCode;
      lastBody = res.json();
      if (lastStatus === 429) break;
    }
    expect(lastStatus).toBe(429);
    expect(lastBody?.error?.code).toBe("RATE_LIMITED");
  }, 10000);
});
