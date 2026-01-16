import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { env } from "../src/config/env.js";
import { registerTenantAndLogin } from "./_helpers.js";
import { runOutboxOnce } from "../src/workers/outbox-worker.js";

const app = buildApp();

beforeAll(async () => {
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe("outbox hardening", () => {
  it("increments attempts and marks FAILED after max attempts", async () => {
    // Crear tenant real para respetar FK
    const reg = await registerTenantAndLogin(app, { tenantName: `OH-${Date.now()}` , email: `oh-${Date.now()}@ex.com`, password: "secret12345" });
    const ev = await app.prisma.outboxEvent.create({
      data: {
        tenantId: reg.tenant.id,
        type: "TEST_FAIL",
        payloadJson: { testFail: true },
        status: "PENDING",
        attempts: 0,
      },
    });

    // Ejecutar OUTBOX_MAX_ATTEMPTS veces
    const max = env.OUTBOX_MAX_ATTEMPTS;
    for (let i = 0; i < max; i++) {
      await runOutboxOnce({ batchSize: 100 });
      // liberar lock para el próximo ciclo sin esperar TTL
      await app.redis.del("outbox:lock");
    }

    const updated = await app.prisma.outboxEvent.findUnique({ where: { id: ev.id } });
    expect(updated).toBeTruthy();
    expect(updated!.attempts).toBeGreaterThanOrEqual(max);
    expect(updated!.status).toBe("FAILED");
    expect(typeof updated!.lastError === "string").toBe(true);
  }, 20000);

  it("does not process when lock is held", async () => {
    // Crear tenant real para respetar FK
    const reg = await registerTenantAndLogin(app, { tenantName: `OH-${Date.now()}` , email: `oh2-${Date.now()}@ex.com`, password: "secret12345" });
    const ev = await app.prisma.outboxEvent.create({
      data: {
        tenantId: reg.tenant.id,
        type: "TEST_PENDING",
        payloadJson: { ok: true },
        status: "PENDING",
      },
    });

    // Tomar lock manualmente
    await app.redis.set("outbox:lock", "1", "EX", 5);
    try {
      const res = await runOutboxOnce({ batchSize: 10 });
      expect(res.locked).toBe(true);
      expect(res.processed).toBe(0);

      // Verificar que el evento sigue PENDING
      const still = await app.prisma.outboxEvent.findUnique({ where: { id: ev.id } });
      expect(still!.status).toBe("PENDING");
    } finally {
      // Liberar lock para no afectar otras pruebas
      await app.redis.del("outbox:lock");
    }
  }, 15000);
});
