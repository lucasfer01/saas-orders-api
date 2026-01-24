import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { buildApp } from "../src/app";
import { metricsRegistry } from "../src/observability/metrics";

function getMetricSample(metrics: string, metric: string) {
  const re = new RegExp(`^${metric}\\{([^}]*)\\} (.+)$`, "m");
  return metrics.match(re);
}

describe("Observability /metrics", () => {
  beforeEach(() => {
    metricsRegistry.resetMetrics();
  });

  afterEach(() => {
    metricsRegistry.resetMetrics();
  });

  it("GET /metrics retorna 200 y contiene métricas core", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/metrics" });
    expect(res.statusCode).toBe(200);
    const body = res.body;
    expect(body).toMatch(/http_requests_total/);
    expect(body).toMatch(/http_request_duration_ms/);
    expect(body).toMatch(/payment_requests_total/);
    expect(body).toMatch(/payment_idempotent_replay_total/);
  });

  it("/metrics protegido con token: sin header da 401 y con header correcto da 200", async () => {
    process.env.METRICS_TOKEN = "test-token";
    const app = await buildApp();
    // Sin header
    const res1 = await app.inject({ method: "GET", url: "/metrics" });
    expect(res1.statusCode).toBe(401);
    expect(res1.body).toEqual(
      JSON.stringify({ error: { code: "UNAUTHORIZED", message: "Unauthorized" } })
    );
    // Con header correcto
    const res2 = await app.inject({
      method: "GET",
      url: "/metrics",
      headers: { "X-Metrics-Token": "test-token" },
    });
    expect(res2.statusCode).toBe(200);
    expect(res2.body).toMatch(/http_requests_total/);
    delete process.env.METRICS_TOKEN;
  });

  it("404 registra route='unmatched' y status=404, no el path crudo", async () => {
    const app = await buildApp();
    // Disparar 404
    await app.inject({ method: "GET", url: "/does-not-exist" });
    // Obtener métricas
    const res = await app.inject({ method: "GET", url: "/metrics" });
    expect(res.statusCode).toBe(200);
    const body = res.body;
    // Buscar sample con status=404 y route=unmatched
    expect(body).toMatch(/http_requests_total\{[^}]*route="unmatched"[^}]*status="404"[^}]*\}/);
    // No debe aparecer el path crudo como label
    expect(body).not.toMatch(/route="\/does-not-exist"/);
  });
});
