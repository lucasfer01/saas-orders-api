````md
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
````

Notas:

* En Prisma v7, el **datasource URL se configura desde `prisma.config.ts`** (no en el `schema.prisma`).
* `DATABASE_URL` debe coincidir con tu Postgres local.

---

## Setup local (desde cero)

### 1) Instalar dependencias

```bash
npm install
```

### 2) Levantar PostgreSQL

Asegurate de tener Postgres disponible en el host/puerto que corresponda (ej. `localhost:9876`).

### 3) Migraciones + generación de client

Si ya tenés la migración baseline (init) creada:

```bash
npx prisma migrate dev
npx prisma generate
```

Verificar estado:

```bash
npx prisma migrate status
```

### 4) Levantar el servidor

```bash
npm run dev
```

### 5) Healthcheck

```bash
GET http://localhost:3001/health
```

---

## Reset completo de DB (DEV)

Si querés borrar datos y recrear schema desde migraciones:

```bash
npx prisma migrate reset --force
```

Si además querés “borrón y cuenta nueva” de migraciones (solo dev), la práctica recomendada es:

1. eliminar `prisma/migrations`
2. dejar DB vacía
3. crear una nueva migration init con `npx prisma migrate dev --name init`

---

## Flujo de autenticación (cómo funciona)

### 1) Register (onboarding de tenant)

`POST /auth/register`

* Crea un **Tenant**
* Crea un **Role ADMIN** para ese tenant
* Crea un **User** y lo asigna a ADMIN
* Genera:

  * **Access Token** (JWT corto)
  * **Refresh Token** (JWT largo + registro en DB con hash)
* Devuelve `tenant`, `user`, `accessToken`, `refreshToken`

### 2) Login

`POST /auth/login`

* Busca el user por `(tenantId, email)`
* Verifica password
* Emite:

  * Access Token
  * Refresh Token (persistido en DB con hash)

### 3) Refresh (rotación)

`POST /auth/refresh`

* Verifica JWT del refresh token
* Busca el token en DB por `tokenId`
* Valida:

  * no revocado
  * no expirado
  * hash coincide
* Revoca el token anterior y crea uno nuevo
* Devuelve:

  * nuevo access token
  * nuevo refresh token

### 4) Logout

`POST /auth/logout`

* Revoca (marca `revokedAt`) el refresh token actual (idempotente)

### 5) Protección de rutas

* Las rutas protegidas requieren:

  * `Authorization: Bearer <accessToken>`
* El middleware completa `req.auth` con:

  * `userId`
  * `tenantId`
  * `roles[]`

---

## Multi-tenancy (regla principal)

* El `tenantId` se deriva del **token**, no de headers “manuales”.
* Toda query “de negocio” filtra por `tenantId`.
* El objetivo es evitar cross-tenant access por diseño.

---

## RBAC (Roles)

Helpers (decorators):

* `app.requireAuth(req)` valida token y completa `req.auth`
* `app.requireRole(["ADMIN", "MANAGER"])` valida autorización por roles

Ejemplo:

* `POST /products` requiere `ADMIN | MANAGER`
* `GET /products` permite `ADMIN | MANAGER | STAFF`

---

## Endpoints disponibles (hasta ahora)

### Health

* `GET /health`

### Auth

* `POST /auth/register`
* `POST /auth/login`
* `POST /auth/refresh`
* `POST /auth/logout`
* `GET /me` (protegido)

### Products (protegido, tenant-scoped)

* `POST /products` (ADMIN | MANAGER)
* `GET /products` (ADMIN | MANAGER | STAFF)
* `GET /products/:id` (ADMIN | MANAGER | STAFF)
* `PATCH /products/:id` (ADMIN | MANAGER)

### Orders (protegido, tenant-scoped)

* `POST /orders` (ADMIN | MANAGER)
* `GET /orders` (ADMIN | MANAGER | STAFF)
* `GET /orders/:id` (ADMIN | MANAGER | STAFF)
* `POST /orders/:id/items` (ADMIN | MANAGER)
* `PATCH /orders/:id/items/:itemId` (ADMIN | MANAGER)
* `DELETE /orders/:id/items/:itemId` (ADMIN | MANAGER)
* `PATCH /orders/:id/status` (ADMIN | MANAGER)

Headers esperados:

```http
Authorization: Bearer <accessToken>
```

---

## Prisma schema (resumen de modelos)

* `Tenant`
* `User` + `Role` + `UserRole` (RBAC por tenant)
* `RefreshToken` (rotación y revocación)
* `Product`
* `Order` + `OrderItem`
* `OrderStatusHistory` (auditoría)
* `Payment` (idempotencia por order)
* `OutboxEvent` (event-driven / integración asíncrona)

---

## Calidad (lint / typecheck)

Typecheck:

```bash
npm run typecheck
```

Lint:

```bash
npm run lint
```

Formato:

```bash
npx biome check . --write
```

---

## Próximo bloque de integración (lo que queda por construir)

### 1) Orders API (core)

Implementado:

* `POST /orders` (crea DRAFT con número por tenant)
* `POST /orders/:id/items` (agrega ítems desde productos con snapshot)
* `PATCH /orders/:id/items/:itemId` (actualiza qty del ítem y recalcula totales)
* `DELETE /orders/:id/items/:itemId` (elimina ítem y recalcula totales)
* `GET /orders` (paginación + filtros por status/fecha)
* `GET /orders/:id` (detalle con items)
* `PATCH /orders/:id/status` (transiciones válidas + auditoría)

Transiciones de estado:

* DRAFT → OPEN | CANCELED

* OPEN → PAID | CANCELED

* PAID → (sin transiciones)

* CANCELED → (sin transiciones)

### 2) Status History automático

* Insertar en `OrderStatusHistory` cada vez que el estado cambia
* `changedByUserId` desde `req.auth.userId`
* `fromStatus` y `toStatus`

### 3) Payments

* `POST /orders/:id/payments`
* Idempotencia con `idempotencyKey`
* Estados:

  * PENDING → SUCCEEDED / FAILED
* Si `SUCCEEDED`, mover Order a `PAID` (según regla)

### 4) Outbox Pattern

* Escribir eventos en `OutboxEvent` (ej: `ORDER_PAID`, `PAYMENT_SUCCEEDED`)
* Worker (cron/interval) para procesar outbox
* Opcional: Redis para locks y evitar doble procesamiento

### 5) Hardening

* Validación estricta de tipos (evitar `any` donde aplique)
* Rate limiting / security headers
* Observabilidad (tracing, métricas, logs por request)
* Tests (unit/integration) para auth + products + orders/payments

---

## Convenios sugeridos

* Nunca confiar en `tenantId` del cliente (solo token).
* Todas las queries de dominio deben estar tenant-scoped.
* Mutaciones sensibles (payments/status) deben ser transaccionales (`prisma.$transaction`).

---

## Licencia

Pendiente de definir.

```

Si querés, también te puedo dejar una sección adicional “**Colección Postman**” con ejemplos listos (requests + headers + bodies) para pegar tal cual, y un “**Roadmap por commits**” con nombres sugeridos para que el historial quede prolijo.
::contentReference[oaicite:0]{index=0}
```
