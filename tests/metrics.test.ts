import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";

const app = buildApp();

beforeAll(async () => {
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe("metrics", () => {
  it("exposes /metrics and includes key metrics + route labels", async () => {
    // Primer fetch para validar endpoint y contenido base
    const res1 = await app.inject({ method: "GET", url: "/metrics" });
    expect(res1.statusCode).toBe(200);
    const body1 = res1.body as string;
    expect(body1).toContain("http_requests_total");
    expect(body1).toContain("http_request_duration_ms");
    expect(body1).toContain("outbox_pending_count");

    // Ejecutamos /health para generar métricas etiquetadas por ruta
    const health = await app.inject({ method: "GET", url: "/health" });
    expect(health.statusCode).toBe(200);

    // Segundo fetch para observar etiquetas de la request previa
    const res2 = await app.inject({ method: "GET", url: "/metrics" });
    expect(res2.statusCode).toBe(200);
    const body2 = res2.body as string;
    // Presencia de etiquetas method y route; comprobación robusta por substring
    expect(body2).toContain('method="GET"');
    expect(body2).toContain('route="/health"');
  });
});
