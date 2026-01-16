# saas-orders-api

Backend API multi-tenant (SaaS) para gestión de **productos**, **órdenes** y **pagos**, construido con **Node.js + TypeScript + Fastify + Prisma + PostgreSQL**.  
El foco del proyecto es tener un **core técnico completo** (seguridad, multi-tenancy, consistencia transaccional, y base operable para escalar).

---

## Estado actual (hasta hoy)

### Implementado
- **Servidor Fastify** con estructura modular (plugins + módulos por dominio).
- **PostgreSQL + Prisma (v7)** con migración baseline (DB alineada al `schema.prisma`).
- **Auth completo** con:
  - `register` (crea tenant + user admin + rol admin)
  - `login`
  - `refresh` con **rotación de refresh tokens**
  - `logout` (revoca refresh token)
  - `me` (usuario actual)
- **Multi-tenancy real**: `tenantId` se obtiene desde el **Access Token** (no headers manuales).
- **RBAC** (roles) a nivel middleware:
  - `requireAuth`
  - `requireRole([...])`
- **Módulo Products** (protegido + tenant-scoped):
  - `POST /products` (ADMIN | MANAGER)
  - `GET /products` (ADMIN | MANAGER | STAFF)
  - `GET /products/:id` (ADMIN | MANAGER | STAFF)
  - `PATCH /products/:id` (ADMIN | MANAGER)
- **Módulo Orders** (protegido + tenant-scoped):
  - CRUD + items (add/update/delete)
  - recalculo de totales
  - numeración incremental por tenant
  - transiciones de estado válidas
  - auditoría en `OrderStatusHistory`
- **Módulo Payments** (protegido + tenant-scoped):
  - `POST /orders/:id/payments` con **idempotencia** por `idempotencyKey`
  - procesamiento **transaccional**
  - transición atómica de `Order` a `PAID` cuando el pago `SUCCEEDED`
  - listado y detalle de pagos
- **Hardening v1**:
  - Headers de seguridad via `@fastify/helmet`
  - Rate limiting global y por rutas sensibles (`@fastify/rate-limit`)
  - Manejador de errores estandarizado: `{ error: { code, message, details? } }`
- **Outbox mínimo + worker**:
  - inserta `OutboxEvent` en la misma transacción que confirma el pago `SUCCEEDED`
  - worker que procesa `PENDING → PROCESSED` (publish mock)
  - lock global en Redis (`outbox:lock`)
- **CI (GitHub Actions)**:
  - Node 20 + servicios Postgres/Redis
  - `prisma generate` + `migrate deploy`
  - typecheck, lint y tests

### En progreso / pendiente
- Pulido de tests (helpers reutilizables + test de concurrencia de idempotencia).

---

## Tech Stack

- **Runtime**: Node.js
- **Lenguaje**: TypeScript
- **Framework**: Fastify (v5)
- **ORM**: Prisma (v7)
- **DB**: PostgreSQL
- **Cache/Infra**: Redis (usado por outbox lock; opcional si no ejecutás worker/outbox)
- **Validación**: Zod
- **Lint/Format**: Biome
- **Dev runner**: tsx (watch)
- **Tests**: Vitest

---

## Arquitectura (alto nivel)

- `src/app.ts`: arma la app (plugins, hardening, error handler, rutas).
- `src/server.ts`: levanta el servidor.
- `src/plugins/*`: integraciones (prisma, redis, etc.).
- `src/auth/*`: jwt, hashing, middleware/auth helpers.
- `src/modules/*`: dominios (auth, products, orders, payments, outbox).
- `types/fastify.d.ts`: module augmentation (decorate de `app.prisma`, `req.auth`, helpers, etc.).

---

## Observabilidad (P0)

- Logging estructurado: plugin `observability/logger.ts` agrega logs JSON por request con `requestId`, `method`, `route`, `statusCode`, `responseTimeMs` y, si existen, `tenantId`/`userId`. No se logean secretos.
- Métricas Prometheus: `GET /metrics` expone métricas estándar usando `prom-client`:
  - `http_requests_total{method,route,status}`
  - `http_request_duration_ms_bucket{method,route}` (histograma)
  - `outbox_events_total{type,status}` y `outbox_pending_count`
  - `payment_requests_total{status}` y `payment_idempotent_replay_total`
- Tracing (OpenTelemetry): `observability/tracing.ts` inicializa tracer con exporter de consola u OTLP (configurable). Controlado por `OTEL_ENABLED`.

Cómo activar tracing

1) Establecé `OTEL_ENABLED=true` en el entorno.
2) (Opcional) Configurá `OTEL_EXPORTER_OTLP_ENDPOINT` para enviar a un collector (por ejemplo `http://localhost:4318/v1/traces`).

Endpoint `/metrics`

- Sin autenticación por defecto. Integrá con Prometheus apuntando a `http://HOST:PORT/metrics`.

Outbox worker (hardening)

- `OutboxEvent` ahora tiene `attempts` (Int, default 0), `lastError` (String?) y `nextRunAt` (DateTime?).
- Reintentos hasta `OUTBOX_MAX_ATTEMPTS` (default 5). En cada fallo: `attempts++`, `lastError`, y transición a `FAILED` al superar el máximo; si no, queda `PENDING`.
- Lock global en Redis asegurando `finally` para liberar.
- Métricas y logs por batch/evento.

---

## Requisitos

- Node.js (recomendado: LTS / Node 20+)
- PostgreSQL corriendo local (por ejemplo vía Docker)
- Redis (recomendado si usás outbox/worker; en CI se usa)

---

## Variables de entorno

Crear un `.env` (o configurar variables del sistema). Mínimo:

```env
# DB
DATABASE_URL="postgresql://USER:PASSWORD@localhost:9876/app?schema=public"

# Redis (recomendado para outbox lock)
REDIS_URL="redis://localhost:6379"

# JWT
JWT_ACCESS_SECRET="your_access_secret"
JWT_REFRESH_SECRET="your_refresh_secret"
JWT_ACCESS_TTL_MIN=15
JWT_REFRESH_TTL_DAYS=14

# App
NODE_ENV=development
PORT=3001

# Rate limiting (ajustables por entorno)
RATE_LIMIT_GLOBAL_MAX=1000
RATE_LIMIT_GLOBAL_TIME_WINDOW=60000

RATE_LIMIT_LOGIN_MAX=10
RATE_LIMIT_LOGIN_TIME_WINDOW=60000

RATE_LIMIT_REGISTER_MAX=5
RATE_LIMIT_REGISTER_TIME_WINDOW=60000

RATE_LIMIT_REFRESH_MAX=20
RATE_LIMIT_REFRESH_TIME_WINDOW=60000

RATE_LIMIT_PAYMENTS_MAX=30
RATE_LIMIT_PAYMENTS_TIME_WINDOW=60000

# Observabilidad
# Tracing OpenTelemetry (P0)
OTEL_ENABLED=false
# Si querés exportar por OTLP (collector o APM)
# OTEL_EXPORTER_OTLP_ENDPOINT="http://localhost:4318/v1/traces"

# Outbox worker
OUTBOX_MAX_ATTEMPTS=5
