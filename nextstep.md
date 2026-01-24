Act as a senior backend engineer. We have a Fastify + TypeScript + Prisma API with Prometheus metrics exposed at GET /metrics using prom-client. We also have structured logging, outbox worker with Redis lock, and payments idempotency metrics.

Goal (this module): “Observability hardening v1.1” focused on securing /metrics for production, preventing Prometheus label cardinality explosions, and adding integration tests to prove correct behavior.

Constraints / context:
- Fastify v5 app with modular plugins and modules (src/app.ts composes plugins + routes).
- Observability files exist under src/observability/* (logger, metrics, tracing).
- Metrics currently include: http_requests_total{method,route,status}, http_request_duration_ms histogram, outbox metrics, payment metrics.
- Local docs say /metrics may be unprotected locally; in prod we want METRICS_TOKEN and X-Metrics-Token header.
- Keep error responses standardized: { error: { code, message, details? } }.
- Tests use Vitest with app.inject (integration style). CI runs tests.

Deliverables:
1) Secure /metrics with optional token:
   - If env METRICS_TOKEN is NOT set: /metrics is public (current behavior).
   - If env METRICS_TOKEN IS set:
     - Require header X-Metrics-Token to match METRICS_TOKEN.
     - If missing/invalid -> 401 with standardized body:
       { error: { code: "UNAUTHORIZED", message: "Unauthorized" } }
   - Do NOT require JWT auth for /metrics.
   - Ensure response content-type remains Prometheus text format and body remains the metrics output.

2) Prevent high-cardinality “route” labels:
   - For matched routes, label must be Fastify routerPath / routeOptions.url (e.g. "/orders/:id/payments"), not raw req.url.
   - For unmatched routes (404), set route label to a constant like "unmatched" (NOT the raw URL path).
   - Make sure metrics still record status codes for 404s.

3) Tests (create a new test file tests/observability.test.ts or similar):
   - Test A: GET /metrics returns 200 and contains at least one of each core metric names:
     http_requests_total, http_request_duration_ms, payment_requests_total, payment_idempotent_replay_total.
   - Test B: When METRICS_TOKEN is set (set process.env in test before buildApp()):
     - GET /metrics without header => 401 and standardized error body.
     - GET /metrics with X-Metrics-Token correct => 200.
   - Test C: Trigger a 404 by requesting GET /does-not-exist and then GET /metrics:
     - Assert there is a http_requests_total sample for status="404" and route="unmatched" (or whatever constant you chose).
     - Confirm it does NOT include raw path "/does-not-exist" as a route label.
   - Keep tests deterministic and fast.

4) Documentation updates:
   - Update docs (README or observability-local.md) explaining METRICS_TOKEN + X-Metrics-Token behavior.
   - Provide example commands for PowerShell and curl:
     - curl -H "X-Metrics-Token: ..." http://localhost:3001/metrics
     - Invoke-WebRequest with headers (and mention -UseBasicParsing or using Invoke-RestMethod to avoid parsing warnings).

Implementation hints:
- Prefer implementing token check inside the /metrics route handler or a tiny preHandler that only applies to /metrics.
- Keep metrics registry singleton (avoid double registration in tests).
- Ensure buildApp() can be created multiple times in tests without prom-client registry collisions (use a dedicated Registry or clear register in teardown).

Acceptance criteria:
- npm run lint, npm run typecheck, npm run test all pass.
- /metrics security works exactly as described.
- 404 route cardinality is constant (“unmatched”), not raw URL.
- Tests cover the new behaviors.
