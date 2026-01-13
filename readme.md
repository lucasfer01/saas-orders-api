# saas-orders-api

Backend API multi-tenant (SaaS) para gestión de **productos** y (próximamente) **órdenes/pagos**, construido con **Node.js + TypeScript + Fastify + Prisma + PostgreSQL**.  
El foco actual del proyecto es tener un **core técnico completo** (UI/API/DB) y una base sólida para seguridad, multi-tenancy y escalabilidad.

---

## Estado actual (hasta hoy)

### Implementado
- **Servidor Fastify** con estructura modular (plugins + módulos por dominio).
- **PostgreSQL + Prisma (v7)** con migración baseline nueva (DB alineada al `schema.prisma`).
- **Auth completo** con:
  - `register` (crea tenant + user admin + rol admin)
  - `login`
  - `refresh` con **rotación de refresh tokens**
  - `logout` (revoca refresh token)
  - `me` (usuario actual)
- **Multi-tenancy real**: el `tenantId` ya **no depende de headers manuales**; se obtiene desde el **Access Token**.
- **RBAC** (roles) a nivel middleware:
  - `requireAuth`
  - `requireRole([...])`
- **Módulo Products** (protegido + tenant-scoped):
  - `POST /products` (ADMIN | MANAGER)
  - `GET /products` (ADMIN | MANAGER | STAFF)
  - `GET /products/:id` (ADMIN | MANAGER | STAFF)
  - `PATCH /products/:id` (ADMIN | MANAGER)
- **Healthcheck** con verificación DB.

### En progreso / pendiente
- Módulo **Orders** (CRUD + items + numeración + estados).
- **Payments** (idempotencia, provider mock, status transitions).
- **OrderStatusHistory** (auditoría automática al cambiar estado).
- **OutboxEvent** (eventos para integración asíncrona: pagos, notificaciones, etc.).
- Worker/cron para procesar outbox (y potencialmente Redis para locks/colas).

---

## Tech Stack

- **Runtime**: Node.js
- **Lenguaje**: TypeScript
- **Framework**: Fastify (v5)
- **ORM**: Prisma (v7)
- **DB**: PostgreSQL
- **Cache/Infra (base)**: Redis (plugin ya integrado/previsto)
- **Validación**: Zod
- **Lint/Format**: Biome
- **Dev runner**: tsx (watch)

---

## Arquitectura (alto nivel)

- `src/app.ts` arma la app (plugins, error handler, rutas).
- `src/server.ts` levanta el servidor.
- `src/plugins/*` registra integraciones (ej: prisma, redis).
- `src/auth/*` contiene jwt, hashing, middleware de auth.
- `src/modules/*` separa dominios (auth, products, orders, etc.).
- `types/fastify.d.ts` extiende tipos de Fastify (decorate `app.prisma`, `app.requireAuth`, `req.auth`, etc.).

---

## Requisitos

- Node.js (recomendado: LTS)
- PostgreSQL corriendo local (por ejemplo vía Docker)
- Redis (opcional por ahora; depende del plugin/uso)

---

## Variables de entorno

Crear un `.env` (o configurar variables del sistema). Mínimo:

```env
# DB
DATABASE_URL="postgresql://USER:PASSWORD@localhost:9876/app?schema=public"

# JWT
JWT_ACCESS_SECRET="your_access_secret"
JWT_REFRESH_SECRET="your_refresh_secret"
JWT_ACCESS_TTL_MIN=15
JWT_REFRESH_TTL_DAYS=14

# App
NODE_ENV=development
PORT=3001
