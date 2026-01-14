# Objetivo: cerrar Payments como "Done" + Outbox + Hardening + CI

Contexto:
- Repo: saas-orders-api (Node.js + TS + Fastify + Prisma + Postgres + Redis plugin disponible).
- Ya existen módulos: auth, products, orders y payments (payments ya funcionan en Postman).
- Ya existe setup de tests con Vitest y tests de integración usando `app.inject()` (health/auth/orders).
- Multi-tenancy: tenantId SIEMPRE viene desde `req.auth.tenantId` (token), nunca de headers.
- RBAC: `app.requireAuth(req)` y `app.requireRole([...])` ya existen.
- Prisma models ya incluyen: Order, OrderItem, OrderStatusHistory, Payment, OutboxEvent.

Quiero que implementes 4 bloques:
1) Tests de integración completos para Payments
2) Outbox pattern mínimo + Worker mínimo
3) Hardening P0: rate limit + helmet
4) CI mínimo: typecheck + lint + test + servicios

--------------------------------------------
1) PAYMENTS — Requerimientos funcionales (P0)
--------------------------------------------
A) Reglas de negocio
- El endpoint de crear pago debe ser transaccional.
- Solo se permite crear pago si la Order está en status permitido (regla recomendada):
  - Pagar solo si Order.status === "OPEN".
  - Si está DRAFT o CANCELED => 400/409 (usar el estándar del repo, preferir badRequest("...")).
  - Si ya está PAID => bloquear nuevo pago (400/409).
- Si el Payment queda `SUCCEEDED`:
  - La Order debe pasar a `PAID` en la MISMA transacción.
  - Debe insertarse un registro en `OrderStatusHistory` (fromStatus/toStatus/changedByUserId).
- Si el Payment queda `FAILED`:
  - La Order NO cambia de estado.

B) Idempotencia
- `idempotencyKey` es requerida para crear pago.
- Misma key para el mismo tenant:
  - Si se reintenta el mismo request (mismo orderId, amountCents, method) => devolver el mismo Payment existente (status 200 o 201 según el contrato actual; mantener consistente).
- Conflicto:
  - Si existe un Payment con esa misma (tenantId, idempotencyKey) pero el payload difiere (amountCents o method o orderId) => devolver error (preferir 409 Conflict si existe helper; si no, usar badRequest con mensaje "Idempotency key reused with different payload").
- Evitar doble cobro:
  - Si ya existe un SUCCEEDED para esa order (en el tenant) => bloquear nuevos pagos para esa order (400/409).
  - Esto debe contemplar concurrencia (hacer check dentro de transacción).

C) Tenant isolation
- Todas las queries filtran por tenantId.
- Cross-tenant access debe retornar notFound("...") (para no filtrar existencia).

D) Errores y respuestas
- Mantener estilo del repo (helpers: badRequest, notFound, forbidden, unauthorized).
- Zod schemas: validar body/params/query.
- No usar `any`. Usar tipos de Prisma/Fastify correctamente.

E) DB constraints (si no existen)
- Confirmar/crear índice único para idempotencia:
  - UNIQUE (tenantId, idempotencyKey) en Payment.
- (Opcional si aplica) Prevenir 2 SUCCEEDED por order:
  - Implementar check transaccional: si existe SUCCEEDED => bloquear.
  - Si querés agregar constraint DB parcial, solo si el repo ya usa migrations y es simple.

--------------------------------------------
2) OUTBOX PATTERN — mínimo (P0)
--------------------------------------------
Objetivo:
- Cuando un pago se confirma SUCCEEDED (y Order pasa a PAID), crear un OutboxEvent DURABLE en la misma transacción.
- Por ahora no integra con servicios externos: solo “publicar” con log/placeholder.

A) OutboxEvent al confirmar SUCCEEDED:
- type: "PAYMENT_SUCCEEDED"
- payload: JSON con { tenantId, orderId, paymentId, amountCents, method, occurredAt }
- status: "PENDING" (o equivalente según modelo)
- createdAt: now
- idempotente: si el pago es idempotente (mismo payment), NO duplicar eventos (evitar duplicado).
  - Solución sugerida: unique key en OutboxEvent por (tenantId, aggregateId, type) o (tenantId, paymentId, type). Si no hay constraint, hacer check en tx.

B) Worker mínimo:
- Crear un script/proceso: `src/workers/outbox-worker.ts` (o similar).
- Función principal:
  - Consulta batch de eventos PENDING (ej 50) ordenados por createdAt asc.
  - “Claim” seguro para evitar doble procesamiento:
    - Opción 1 (simple): updateMany con where status=PENDING y set status=PROCESSING + processingStartedAt.
    - Opción 2: usar Redis lock global `outbox:lock` (si ya hay redis plugin), con TTL corto.
  - Procesar:
    - Por ahora: `app.log.info({ eventId, type }, "outbox processed (mock)")`
  - Marcar PROCESSED con processedAt.
  - Si falla: marcar FAILED con errorMessage (si el modelo lo soporta) o reintentar.

C) Tests mínimos del outbox:
- Cuando Payment SUCCEEDED:
  - Se crea OutboxEvent PENDING con el payload esperado.
- Cuando se reintenta el mismo pago (misma idempotencyKey):
  - NO se duplica el evento.
- Worker:
  - Procesa 1 evento y lo marca PROCESSED.

Nota: si el worker necesita `buildApp()` para reutilizar prisma/log, podés crear una versión liviana que solo inicialice prisma (preferible). Mantener simple.

--------------------------------------------
3) HARDENING P0 — rate limit + helmet
--------------------------------------------
A) Helmet
- Agregar `@fastify/helmet` como plugin global en `src/app.ts`.
- Config default razonable (no romper local dev). No habilitar CSP estricta si no aplica.

B) Rate limit
- Agregar `@fastify/rate-limit` global con defaults suaves.
- Configurar overrides por ruta (preferible):
  - /auth/login, /auth/register, /auth/refresh => más estricto (ej 10 req/min por IP)
  - payments endpoint => moderado (ej 30 req/min)
- Mantener compat con tests:
  - En NODE_ENV=test, desactivar rate limit o subir límites para no romper tests.
  - Implementar la condición explícita en el registro del plugin.

Agregar tests (mínimos):
- No es obligatorio testear helmet.
- Para rate limit: opcional 1 test de smoke en test env para asegurar que no bloquea (si se desactiva en test, documentarlo).

--------------------------------------------
4) CI mínimo
--------------------------------------------
Objetivo:
- Pipeline que ejecute:
  1) npm ci
  2) npm run typecheck
  3) npm run lint
  4) npm run test
- Usar GitHub Actions (crear .github/workflows/ci.yml).
- Levantar servicios:
  - Postgres (requerido)
  - Redis (solo si tests/worker lo requieren; si no, opcional)
- Setear env vars en CI:
  - DATABASE_URL apuntando al service de Postgres
  - JWT secrets dummy
  - NODE_ENV=test
- Ejecutar Prisma:
  - `npx prisma migrate deploy` (si hay migrations)
  - o `npx prisma db push` (si el repo usa push en test). Elegir la estrategia consistente con el repo actual.
- Asegurar que tests corran determinísticamente.

--------------------------------------------
DÓNDE TOCAR CÓDIGO (guía)
--------------------------------------------
- Payments:
  - src/modules/payments/routes.ts (o el archivo equivalente actual)
  - src/modules/payments/schemas.ts
  - Reutilizar helpers de errors.
- Outbox:
  - src/modules/payments (en la tx de SUCCEEDED, crear outbox)
  - src/workers/outbox-worker.ts
  - Si hace falta: src/modules/outbox (opcional) — preferible NO crear módulo nuevo si no es necesario.
- Hardening:
  - src/app.ts (registrar helmet + rate-limit)
- Tests:
  - tests/payments.test.ts (nuevo)
  - tests/outbox.test.ts (nuevo o combinado)
  - Seguir el patrón de tests existentes con `buildApp()` y `app.inject()`.
  - Mantener imports ordenados (Biome).
  - Evitar `any`.

--------------------------------------------
TESTS DE PAYMENTS — Casos requeridos (mínimo para "Done")
--------------------------------------------
Crear `tests/payments.test.ts` con flujo real:

Setup:
- buildApp + app.ready()
- register tenant+admin => guardar tenantId y token
- crear product
- crear order
- agregar item
- mover order a OPEN (PATCH /orders/:id/status toStatus=OPEN)

Casos:
1) Happy path:
- POST /orders/:id/payments con { amountCents, method, idempotencyKey } => 201/200
- assert Payment.status === "SUCCEEDED" (o el status real que uses)
- GET /orders/:id => status "PAID"
- assert OrderStatusHistory insertado (si hay endpoint o consultar via prisma directo; si no hay endpoint, usar app.prisma dentro del test si está decorado y tipado)

2) Idempotencia:
- Repetir mismo POST con la misma idempotencyKey y mismo payload => devuelve mismo payment.id y no crea un segundo registro.

3) Idempotency conflict:
- Repetir POST con misma idempotencyKey pero amountCents diferente (o method distinto) => 409/400

4) Estado inválido:
- Intentar pagar una order DRAFT => error
- (Opcional) pagar CANCELED => error

5) Doble cobro:
- Con order ya PAID => intentar otro pago => error

6) Cross tenant:
- Crear segundo tenant/admin y token2
- Intentar pagar order del tenant1 con token2 => notFound (o 404)

--------------------------------------------
CRITERIOS DE ACEPTACIÓN
--------------------------------------------
- `npm run typecheck` pasa
- `npm run lint` pasa (Biome, sin any)
- `npm run test` pasa
- Payments cumple idempotencia y reglas de estado
- OutboxEvent se genera en SUCCEEDED y worker puede procesarlo
- Helmet + rate-limit integrados sin romper test env
- CI workflow agregado y coherente

Implementá todo en commits lógicos (si podés):
1) test(payments): add integration tests
2) feat(outbox): create event on payment success + worker
3) feat(security): helmet + rate-limit (test-safe)
4) ci: github actions pipeline

No preguntes, asumí convenciones existentes del repo y mantené estilo consistente.
