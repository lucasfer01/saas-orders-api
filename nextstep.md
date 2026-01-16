# TASK: Observability P1 — Prometheus + Grafana (local) + minimal dashboards + docs

Context:
We already have in the API:
- GET /metrics (Prometheus exposition format via prom-client)
- Metrics include:
  - http_requests_total{method,route,status}
  - http_request_duration_ms_bucket{method,route}
  - outbox_pending_count
  - payment_requests_total{status}
  - payment_idempotent_replay_total
- Logging exists, tracing is optional (OTEL_ENABLED).

Goal:
Add a local observability stack so we can run Prometheus + Grafana and visualize:
- RPS global and per route
- Error rate (4xx/5xx)
- Latency p95/p99 by route
- Payments succeeded/failed rate
- Outbox pending gauge and processed rate (if there is a counter)
Additionally add docs and a smoke test (optional but recommended).

Constraints:
- No breaking changes to API runtime. Only add infra files + docs + (optionally) minor code improvements if needed.
- Keep everything simple and “demo-ready”: one command to boot API + prometheus + grafana locally.
- Use docker-compose. Prefer a new file to not affect other compose setups:
  - docker-compose.observability.yml (or compose/observability.yml).
- Assume API runs on host at http://host.docker.internal:3001 (Windows/Mac) OR run the API in docker too. Prefer the approach that works on Windows easily.
- Do NOT require Kubernetes.
- Keep dashboards and provisioning versioned in repo (no manual clicking needed).

Deliverables (files to create/modify):

1) docker-compose for Prometheus + Grafana
- File: docker-compose.observability.yml
- Services:
  - prometheus (prom/prometheus)
  - grafana (grafana/grafana)
- Add named volumes for persistence:
  - prometheus_data
  - grafana_data
- Expose ports:
  - Prometheus: 9090
  - Grafana: 3000
- Prometheus config mounted read-only.
- Grafana provisioning folders mounted read-only.
- Default Grafana admin creds for local only:
  - admin / admin (or admin / admin123, but document it)
- Network: a single bridge network is fine.

2) Prometheus config
- File: observability/prometheus/prometheus.yml
- Scrape interval: 5s or 10s.
- One scrape job named "saas-orders-api".
- Target should work on Windows:
  Option A (recommended): host.docker.internal:3001
  - metrics_path: /metrics
  - static_configs: targets: ["host.docker.internal:3001"]
  Add a note in README about Linux needing an alternative (or use extra_hosts on Linux).
- Also scrape prometheus itself.

3) Grafana provisioning (datasource + dashboards)
- Directory: observability/grafana/provisioning/
  - datasources/datasource.yml
  - dashboards/dashboards.yml
- Datasource:
  - name: Prometheus
  - type: prometheus
  - url: http://prometheus:9090
  - isDefault: true
- Dashboards provisioning:
  - point to observability/grafana/dashboards/*.json

4) Grafana dashboard JSON (minimal but useful)
- File: observability/grafana/dashboards/saas-orders-api.json
- Create ONE dashboard with panels for:
  A) RPS global:
     Query: sum(rate(http_requests_total[1m]))
  B) RPS per route (top routes):
     Query: topk(10, sum by (route) (rate(http_requests_total[1m])))
  C) Error rate 5xx (global):
     Query: sum(rate(http_requests_total{status=~"5.."}[5m])) / sum(rate(http_requests_total[5m]))
  D) Error rate 4xx (global) (optional but recommended):
     Query: sum(rate(http_requests_total{status=~"4.."}[5m])) / sum(rate(http_requests_total[5m]))
  E) Latency p95 by route:
     Query: histogram_quantile(0.95, sum by (le, route) (rate(http_request_duration_ms_bucket[5m])))
  F) Latency p99 by route:
     Query: histogram_quantile(0.99, sum by (le, route) (rate(http_request_duration_ms_bucket[5m])))
  G) Payments: SUCCEEDED rate:
     Query: sum(rate(payment_requests_total{status="SUCCEEDED"}[5m]))
  H) Payments: FAILED rate:
     Query: sum(rate(payment_requests_total{status="FAILED"}[5m]))
  I) Payment idempotent replays rate:
     Query: sum(rate(payment_idempotent_replay_total[5m]))
  J) Outbox pending gauge:
     Query: outbox_pending_count
  K) Outbox processed rate:
     If outbox_events_total exists with labels, prefer:
       sum(rate(outbox_events_total[5m]))
     Otherwise, document that it’s not available and leave the panel hidden or omit.

Dashboard quality requirements:
- Titles for panels must be clear.
- Units:
  - RPS: requests/sec
  - error rate: percent
  - latency: milliseconds (if the histogram is in ms; otherwise adjust)
- Use dashboard variables (optional) like route if easy, but not required.
- Ensure it loads automatically on Grafana startup via provisioning.

5) README updates
- Add a new section:
  ## Observability (local)
  - Explain what /metrics is
  - How to run:
    - Start API: npm run dev
    - Start stack: docker compose -f docker-compose.observability.yml up -d
  - Access:
    - Prometheus http://localhost:9090
    - Grafana http://localhost:3000 (credentials)
  - Troubleshooting:
    - Windows: host.docker.internal should work.
    - Linux: either run API in docker or set extra_hosts / use host network (mention briefly).
  - Mention that /metrics may be left unprotected locally but should be protected in prod (reverse proxy, auth, IP allowlist).

6) Optional: “metrics smoke test” in Vitest
- Create test file: tests/metrics.test.ts
- It should:
  - build app
  - call GET /metrics
  - assert status 200
  - assert body includes at least:
    - "http_requests_total"
    - "http_request_duration_ms"
    - "outbox_pending_count"
  - then call GET /health or another endpoint and re-fetch /metrics to ensure counters change:
    - e.g. after hitting /health, expect metrics contains a line with route="/health" and method="GET"
- Keep it robust (avoid flakiness): just check substring presence.

Acceptance criteria:
- Running:
  - npm run dev
  - docker compose -f docker-compose.observability.yml up -d
  Then:
  - Prometheus shows target "saas-orders-api" UP
  - Grafana auto-provisions datasource and dashboard (no manual setup)
  - Dashboard panels show data after making API requests
- README has clear instructions.
- Lint/test still pass.

Implementation notes:
- Ensure docker-compose YAML uses correct syntax (no deprecated version field).
- Keep paths consistent with repo structure.
- If http_request_duration_ms_bucket is in seconds instead of ms, adjust panel unit and queries accordingly and document it.
