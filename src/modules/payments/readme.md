Objetivo: Implementar el módulo Payments para la API multi-tenant saas-orders-api (Fastify v5 + Prisma v7 + Postgres + Zod + RBAC). El módulo debe ser production-grade en consistencia (transacciones), multi-tenancy (tenant-scoped), e idempotencia.

Contexto existente:
- Auth: JWT access + refresh rotativo. req.auth = { userId, tenantId, roles[] }
- Decorators: app.requireAuth(req), app.requireRole([...])(req)
- Orders: Order (DRAFT/OPEN/PAID/CANCELED) + OrderItem + recalculo de totales + status transitions + OrderStatusHistory.
- Products: CRUD tenant-scoped.
- Tests: Vitest con app.inject() ya funcionando.

Objetivos del módulo Payments:
1) Endpoint principal:
   - POST /orders/:id/payments  (ADMIN | MANAGER)
   - Header requerido: Authorization: Bearer <accessToken>
   - Body: { amountCents: number, method: "CASH"|"CARD"|"TRANSFER"|"OTHER", idempotencyKey: string }
     - amountCents > 0
     - idempotencyKey requerido (string, 10..200 chars aprox)
   - Multi-tenant: todo debe filtrar por tenantId del token; nunca confiar en inputs de cliente.

2) Modelo / Prisma:
   - Usar el modelo Payment existente en schema (si no está, crear migration).
   - Requerimientos mínimos de Payment:
     - id, tenantId, orderId
     - amountCents, currency (opcional por ahora si ya existe)
     - method
     - status: PENDING | SUCCEEDED | FAILED
     - idempotencyKey (único por tenant; ideal: @@unique([tenantId, idempotencyKey]))
     - createdAt, updatedAt
   - Sugerido: guardar changedByUserId (si el modelo lo tiene) o en Outbox.

3) Idempotencia (requisito crítico):
   - Si llega un POST con la misma (tenantId, idempotencyKey):
     - Debe devolver exactamente el mismo Payment previamente creado (200 OK) sin duplicar nada.
     - No debe volver a mutar el Order ni reinsertar history/outbox.
   - Implementar con UNIQUE en DB + transacción:
     - Intentar crear Payment.
     - Si Prisma arroja P2002 por unique constraint => buscar el Payment existente por (tenantId, idempotencyKey) y devolverlo.
   - Evitar “any”: usar type-guards con Prisma.PrismaClientKnownRequestError.

4) Reglas de negocio mínimas:
   - Solo se puede pagar una Order con status OPEN (opcional permitir DRAFT->OPEN automático, pero preferible: exigir OPEN).
   - Si la Order está PAID o CANCELED => 400 (o 409) con mensaje claro.
   - amountCents debe ser == order.totalCents (para MVP). Si querés soportar pagos parciales, dejarlo fuera por ahora.
   - Si Payment termina SUCCEEDED => la Order debe pasar a PAID en la MISMA transacción y debe registrarse OrderStatusHistory (OPEN->PAID) con changedByUserId = req.auth.userId.
   - Si Payment FAILED => NO mover Order a PAID.

5) “Provider mock” (simulación):
   - Para MVP, simular procesamiento sin integración externa:
     - Crear Payment inicialmente en PENDING.
     - Inmediatamente “resolver” dentro del mismo request:
       - SUCCEEDED por defecto.
       - Permitir forzar FAILED con un flag opcional de test (ej body.testFail === true) SOLO en NODE_ENV=test, o vía header "x-test-fail: 1" en entorno de test.
   - Alternativa aceptable: crear directamente en SUCCEEDED (más simple), pero mantener status enum y estructura.

6) OutboxEvent (si está el modelo):
   - Al SUCCEEDED, insertar OutboxEvent con type = "PAYMENT_SUCCEEDED" y payload JSON conteniendo { tenantId, orderId, paymentId, amountCents, method }.
   - Opcional: también insertar "ORDER_PAID".
   - Hacerlo dentro de la misma transacción.
   - Marcar status inicial de Outbox (PENDING) si aplica.

7) Estructura de archivos (consistente con el repo):
   - src/modules/payments/routes.ts (FastifyPluginAsync)
   - src/modules/payments/schemas.ts (Zod: params + body)
   - src/modules/payments/index.ts (export plugin)
   - Registrar el plugin en src/app.ts / routes root (igual que orders/products)
   - Reutilizar helper getAuth(req) (o patrón equivalente) sin usar casts a any.

8) Errores y status codes:
   - 201 Created cuando se crea un Payment nuevo.
   - 200 OK cuando se devuelve por idempotencia (ya existía).
   - 401 si falta/expira token.
   - 403 si rol inválido.
   - 404 si Order no existe (o no pertenece al tenant).
   - 400/409 para reglas de negocio (Order no OPEN, amount mismatch, etc.)
   - Mensajes consistentes con http/errors.js (badRequest, notFound, forbidden, unauthorized).

9) Tests (Vitest integration con app.inject):
   Crear tests nuevos tests/payments.test.ts que cubran:
   - Happy path: register -> crear product -> crear order -> add item -> cambiar status a OPEN -> POST payment (SUCCEEDED) -> order pasa a PAID -> history creado.
   - Idempotencia: repetir POST con mismo idempotencyKey => 200 y mismo payment.id, y NO duplicar history/outbox.
   - Forbidden: STAFF no puede crear payment.
   - Tenant isolation: tenant B no puede pagar order de tenant A (404).
   - amount mismatch => 400/409.
   - Order en PAID/CANCELED => error.

Criterios de aceptación (Definition of Done):
- Lint Biome sin warnings “noExplicitAny”.
- Typecheck ok.
- Tests verdes.
- Todas las queries y mutaciones tenant-scoped en el WHERE final (no solo pre-check).
- Cambios de estado y creación de Payment en una misma transacción.
