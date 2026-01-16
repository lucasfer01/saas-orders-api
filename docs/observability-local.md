# Observability (local)

Este proyecto expone métricas Prometheus en `GET /metrics` (via `prom-client`). Las métricas disponibles incluyen:

- `http_requests_total{method,route,status}`
- `http_request_duration_ms_bucket{method,route}` (histograma en milisegundos)
- `outbox_pending_count` y `outbox_events_total{type,status}`
- `payment_requests_total{status}` y `payment_idempotent_replay_total`

## Ejecutar stack local

1. Arrancar la API en tu host:

   - Comando: `npm run dev`
   - URL: `http://localhost:3001`

2. Arrancar Prometheus + Grafana con Docker Compose:

   - Comando: `docker compose -f docker-compose.observability.yml up -d`
   - Prometheus: `http://localhost:9090`
   - Grafana: `http://localhost:3000` (usuario: `admin`, password: `admin`)

El dashboard "SaaS Orders API" y el datasource se aprovisionan automáticamente desde `observability/grafana`.

## Configuración incluida

- Prometheus (`observability/prometheus/prometheus.yml`):
  - `scrape_interval: 5s`
  - Jobs: `prometheus` (self) y `saas-orders-api` en `host.docker.internal:3001/metrics`
- Grafana provisioning (`observability/grafana/provisioning`):
  - Datasource: Prometheus (`http://prometheus:9090`), por defecto
  - Dashboards: `observability/grafana/dashboards/*.json`
- Dashboard: `observability/grafana/dashboards/saas-orders-api.json` con RPS, error rate 4xx/5xx, latencias p95/p99 (ms), pagos y outbox

## Troubleshooting

- Windows/Mac: `host.docker.internal` funciona por defecto para llegar a la API del host.
- Linux: el `docker-compose.observability.yml` incluye `extra_hosts: host.docker.internal:host-gateway`.
  Alternativas:
  - Correr la API en Docker dentro de la misma red del compose.
  - Usar `network_mode: host` (solo Linux) o apuntar a la IP del host.

## Seguridad (producción)

Localmente `/metrics` puede estar sin protección. En producción, protegelo mediante reverse proxy, autenticación e IP allowlist. También podés activar `METRICS_TOKEN` y exigir el header `X-Metrics-Token`.
