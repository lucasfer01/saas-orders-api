Actuá como senior backend engineer. Estoy en un repo llamado "saas-orders-api" (Node.js + TypeScript + Fastify v5 + Prisma v7 + Postgres + Redis). Ya existen módulos: auth, products, orders, payments, outbox, hardening, observability (/metrics prom-client). Errores estandarizados: { error: { code, message, details? } }. Multi-tenancy: tenantId viene SIEMPRE del access token (req.auth.tenantId). RBAC: app.requireAuth / app.requireRole.

Objetivo: Implementar un módulo nuevo "receipts" (recibos/facturas internas) completamente tenant-scoped, transaccional, con idempotencia y numeración incremental por tenant.

REGLAS IMPORTANTES:
- No usar `any`.
- Toda query de dominio debe filtrar por tenantId.
- Mutaciones críticas deben ser transaccionales con prisma.$transaction.
- Mantener el estilo del repo: Zod para validación, rutas en src/modules/<domain>/routes.ts, helpers/queries en archivos del módulo si corresponde.
- Respetar el hardening ya existente (rate limit opcional, headers etc).
- Respuestas de error deben usar los helpers existentes (unauthorized/forbidden/notFound/badRequest/conflict/validation etc), manteniendo el shape estándar.
- Si ya existe un receipt para una orden, devolver el mismo receipt (idempotencia).

FUNCIONALIDADES A IMPLEMENTAR:

A) Prisma schema + migration
1) Agregar modelos:
- Receipt:
  - id: String @id @default(cuid())
  - tenantId: String
  - orderId: String
  - number: Int (secuencial por tenant)
  - status: enum ReceiptStatus { ISSUED, VOIDED }
  - currency: String (default "USD" o configurable)
  - subtotalCents: Int
  - taxCents: Int @default(0)
  - totalCents: Int
  - issuedAt: DateTime @default(now())
  - voidedAt: DateTime?
  - voidReason: String?
  - createdAt: DateTime @default(now())
  - updatedAt: DateTime @updatedAt
  - items: ReceiptItem[]
  - order: relation opcional con Order (fields: [orderId], references: [id])
  - indexes/unique:
    - @@unique([tenantId, orderId])  // idempotencia por orden
    - @@unique([tenantId, number])   // número único por tenant
    - @@index([tenantId, issuedAt])

- ReceiptItem:
  - id: String @id @default(cuid())
  - tenantId: String
  - receiptId: String
  - productId: String? (opcional)
  - name: String (snapshot)
  - unitPriceCents: Int (snapshot)
  - qty: Int
  - lineTotalCents: Int
  - createdAt: DateTime @default(now())
  - receipt: relation (fields: [receiptId], references: [id], onDelete: Cascade)
  - @@index([tenantId, receiptId])

2) Agregar/usar un contador por tenant para numeración:
- Si ya tenés algo similar para orders, reutilizarlo.
- Si no existe, crear modelo TenantCounter:
  - tenantId: String
  - key: String  // e.g. "RECEIPT"
  - value: Int @default(0)
  - @@unique([tenantId, key])

La emisión de receipt debe obtener el próximo número de forma segura en concurrencia dentro de la transacción:
- upsert counter (value=0)
- update counter con increment: 1 y usar el value resultante como receipt.number

B) Endpoints (Fastify routes)
Implementar en src/modules/receipts/routes.ts y registrarlo desde el router principal.

1) POST /orders/:id/receipt  (ADMIN|MANAGER)
- Requiere order existente del tenant.
- Regla: sólo emitir si order.status === "PAID".
- Idempotencia:
  - si ya existe Receipt para (tenantId, orderId), devolverlo con status 200.
  - si no existe, crear Receipt + ReceiptItem[] snapshot de OrderItem.
- Snapshot:
  - receipt.subtotalCents = order.subtotalCents
  - receipt.totalCents = order.totalCents
  - receipt.taxCents = 0 por ahora (dejar campo preparado)
  - receipt.items: por cada OrderItem guardar name, unitPriceCents, qty, lineTotalCents, productId si existe.
- Transacción:
  - dentro del prisma.$transaction: validar order, generar number, crear receipt, crear items, insertar OutboxEvent type="RECEIPT_ISSUED" status PENDING (si tu outbox ya existe).
- Respuesta: receipt con items (incluyendo number, status, issuedAt, totals).

2) GET /orders/:id/receipt (ADMIN|MANAGER|STAFF)
- Devuelve receipt del order (404 si no existe o no pertenece al tenant).
- Incluir items.

3) GET /receipts/:id (ADMIN|MANAGER|STAFF)
- Tenant-scoped.
- Incluir items.

4) GET /receipts?page=&pageSize=&from=&to= (ADMIN|MANAGER|STAFF)
- Paginación consistente con el módulo orders.
- Filtros opcionales por rango de fechas (issuedAt).
- Orden: issuedAt desc.
- Respuesta: { total, items, page, pageSize }.

5) (Opcional recomendado) POST /receipts/:id/void (ADMIN|MANAGER)
- Body: { reason: string }
- Marca status=VOIDED, voidedAt=now, voidReason.
- No borrar filas.
- Idempotente: si ya estaba VOIDED, devolver 200 con receipt.
- (Opcional) OutboxEvent type="RECEIPT_VOIDED".

C) Observabilidad (prom-client)
- Incrementar counter `receipt_issued_total` cuando se emite (sólo en creación, no en replay idempotente).
- Incrementar `receipt_voided_total` cuando se void (sólo primera vez).

D) Tests (Vitest integración)
Crear tests/receipts.test.ts (o ampliar tests existentes) usando app.inject:
1) Setup: register -> token -> crear product -> crear order -> add item -> set status OPEN -> pay -> order PAID.
2) Emite receipt OK:
   - POST /orders/:id/receipt => 201 o 200 (si decidís) pero consistente.
   - validar que receipt.tenantId == tenantId, receipt.orderId == orderId, items length > 0, totals correctos, number es Int.
3) Bloqueo por estado:
   - Crear otra order NO PAID y POST /orders/:id/receipt => 400 (o 409) con code semántico (BAD_REQUEST/CONFLICT).
4) Idempotencia:
   - Llamar 2 veces POST /orders/:id/receipt => mismos id/number, y metric idempotency no crea duplicados (si validable desde DB).
5) Tenant isolation:
   - Crear segundo tenant, intentar GET receipt del primero => 404.
6) (Si void implementado) void:
   - POST /receipts/:id/void => status VOIDED y voidedAt existe.
   - Repetir void => idempotente.

E) Documentación
- Actualizar README: agregar sección "Receipts" en endpoints y reglas.
- Si existe colección Postman o docs, agregar ejemplos de request/response.

Criterio de aceptación final:
- npm run typecheck OK
- npm run lint OK
- npm run test OK
- Endpoints funcionan en Postman.
- No se usan `any`.
- Todo tenant-scoped.
- Outbox event creado al emitir (y opcional al void).
