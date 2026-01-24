# Flujo de la aplicación

Este documento describe de forma detallada el flujo de la app, el patrón Outbox y la observabilidad.

---

## Resumen de módulos

- `src/app.ts`: compone plugins, hardening, error handler y rutas.
- `src/server.ts`: arranca el servidor HTTP.
- `src/plugins/*`: Prisma, Redis y utilidades compartidas.
- `src/auth/*`: JWT, hashing, middleware y helpers de autenticación.
- `src/modules/*`: dominios (auth, products, orders, payments).
- `src/workers/outbox-worker.ts`: worker de eventos Outbox.
- `src/observability/*`: logger, métricas y tracing.

---

## Flujo end-to-end

### 1) Autenticación y contexto
- El cliente registra un tenant y usuario admin vía `POST /auth/register`.
- Las rutas protegidas requieren `Authorization: Bearer <accessToken>`.
- `requireAuth` construye `req.auth` con `tenantId` y `userId`; `requireRole([...])` aplica RBAC por endpoint.

### 2) Productos y Órdenes
- `POST /products` crea productos tenant-scoped.
- `POST /orders` crea órdenes con numeración incremental por tenant (Redis + unique en DB).
- `POST /orders/:id/items` añade items; se recalculan totales en transacción.
- `PATCH /orders/:id/status` aplica transiciones válidas (`DRAFT → OPEN → PAID` o `CANCELED`).

### 3) Pagos con idempotencia
- `POST /orders/:id/payments` valida que la orden pertenece al `tenantId`, está `OPEN` y el monto coincide.
- Usa `idempotencyKey` para evitar duplicados; mismo payload → 200 con el mismo payment; distinto payload → 409.
- En una transacción Prisma:
  - Crea `Payment PENDING` y resuelve a `SUCCEEDED`/`FAILED`.
  - Si `SUCCEEDED`: actualiza `Order` a `PAID`, escribe `OrderStatusHistory` y crea `OutboxEvent PENDING` tipo `PAYMENT_SUCCEEDED`.

### 4) Patrón Outbox y Worker
- Outbox garantiza que el evento de negocio se inserte atómicamente con el pago.
- `src/workers/outbox-worker.ts` procesa eventos fuera del ciclo de request:
  - Lock global en Redis (`outbox:lock`, TTL 5s) para evitar competencia.
  - Lee `OutboxEvent PENDING` por `createdAt` y los procesa en batches.
  - Éxito: marca `PROCESSED` y actualiza métricas.
  - Error: incrementa `attempts`, guarda `lastError`; si supera `OUTBOX_MAX_ATTEMPTS`, marca `FAILED`.
  - Genera spans `outbox.batch` y `outbox.event` si `OTEL_ENABLED=true`.

### 5) Observabilidad
- `observability/logger.ts`: logs estructurados por request: inicio, fin y error, con `tenantId`, `userId`, ruta y latencia.
- `observability/metrics.ts`: endpoint `/metrics` con Prometheus:
  - HTTP: `http_requests_total`, `http_request_duration_ms`.
  - Payments: `payment_requests_total{status}`, `payment_idempotent_replay_total`.
  - Outbox: `outbox_events_total{type,status}`, `outbox_pending_count`.
- `observability/tracing.ts`: OpenTelemetry SDK; exporta a consola u OTLP (`OTEL_ENABLED`, `OTEL_EXPORTER_OTLP_ENDPOINT`).

---

## Secuencia Pago → Outbox → Worker

1. Cliente → API: `POST /orders/{id}/payments`.
2. API (transacción Prisma):
   - `Payment PENDING` → `SUCCEEDED`.
   - `Order OPEN` → `PAID` + `OrderStatusHistory`.
   - `OutboxEvent PENDING` (`PAYMENT_SUCCEEDED`).
3. API → Cliente: 201/200 con el `Payment` final.
4. Worker: `LOCK` → lee `PENDING` → procesa → `PROCESSED`/`FAILED` + métricas + tracing.

---

## Operación (local)

### Servicios
```powershell
docker-compose up -d
$env:DATABASE_URL = "postgresql://app:app@localhost:9876/app?schema=public"
$env:REDIS_URL = "redis://localhost:6379"
```

### Migraciones y servidor
```powershell
npm run prisma:migrate
npm run dev
```

### Worker (una pasada)
```powershell
npm run outbox:run
```

### Métricas
```powershell
Invoke-WebRequest http://localhost:3001/metrics | Select-Object -ExpandProperty Content
```

### Tracing
```powershell
$env:OTEL_ENABLED = "true"
# Opcional
$env:OTEL_EXPORTER_OTLP_ENDPOINT = "http://localhost:4318/v1/traces"
```

---

## Tests y cobertura
```powershell
npm test
npm run test:coverage
```
Cobertura HTML: `coverage/lcov-report/index.html`.

---

## Troubleshooting

- `locked: true` en el worker: otro proceso tomó el lock; reintenta tras el TTL.
- Timeouts bajo cobertura: algunos `it(..., 15000)` para instrumentación.
- `Order already has a successful payment`: protección contra doble cobro.
- `409` por idempotencia: key repetida con payload distinto.

---

## Próximos pasos

- Publicación real del outbox (Kafka/SQS/webhooks firmados).
- Backoff exponencial y DLQ para `FAILED`.
- Dashboards Prometheus/Grafana.
- Exportación OTLP a APM y correlación con logs.
