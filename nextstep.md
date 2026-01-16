
---

## 2) Prompt detallado para Copilot (módulo “Observabilidad + Operación (P0)”)

Copiá y pegá esto en Copilot. Está escrito para que Copilot “sepa” qué tocar, qué crear, y cuándo considerar el módulo terminado.

```text
Quiero implementar el módulo “Observabilidad + Operación (P0)” en este repo Fastify + TS + Prisma (multi-tenant). Ya existen: auth, products, orders, payments (idempotencia), hardening v1 (helmet/rate-limit/error shape), outbox mínimo + worker con lock redis, y CI.

Objetivo: convertir el servicio en “operable”: poder diagnosticar fallas/latencias y correlacionar flujos (request → DB → payment → outbox). No usar any, mantener tipado estricto y mantener el shape estándar de errores.

REQUERIMIENTOS FUNCIONALES (P0)

A) Logging estructurado + correlación
1) Cada request debe tener un requestId consistente:
   - Usar el request id de Fastify (req.id) o generar uno si no existe.
   - Incluirlo en logs de inicio/fin de request y en logs de errores.
2) Logging estructurado (JSON) con al menos estos campos:
   - requestId, method, url/route, statusCode, responseTimeMs
   - tenantId y userId si req.auth existe
   - errorCode (si hubo error) y message
3) En rutas sensibles (auth/login, payments), loggear eventos clave SIN filtrar secretos:
   - No loggear tokens, passwords, refreshTokens, ni Authorization headers completos.
4) En el worker de outbox:
   - Log por evento procesado: outboxEventId, type, attempt, status transition (PENDING->PROCESSED/FAILED)
   - Loggear duración por batch y cantidad procesada.
5) Mantener logs compatibles con CI (stdout).

Implementación sugerida:
- Un plugin o helper central para “request logging” usando hooks:
  - onRequest (marcar start)
  - onResponse (log de fin con latency)
  - onError (log de error)
- Función helper getLogContext(req) que derive tenantId/userId (si req.auth) y requestId.
- Asegurar que el error handler estándar agregue requestId opcional en response SOLO si lo decidimos (si no, mantener response actual).

B) Métricas (Prometheus-style)
1) Exponer endpoint GET /metrics (sin auth por ahora o protegido por env flag; elegir opción más simple).
2) Métricas mínimas:
   - http_requests_total{method, route, status}
   - http_request_duration_ms_bucket{method, route} (histograma o summary)
   - outbox_events_total{type, status} (processed/failed)
   - outbox_pending_count (gauge)
3) En payments:
   - payment_requests_total{status} (SUCCEEDED/FAILED)
   - payment_idempotent_replay_total
4) Implementar con librería estándar (prom-client) o alternativa ligera.
5) Agregar tests:
   - /metrics responde 200 y contiene al menos http_requests_total
   - Un request a /health incrementa el contador (si el test es determinístico; si no, testear solo existencia).

C) Tracing (OpenTelemetry) — mínimo viable (P0)
1) Instrumentar tracing para:
   - Requests HTTP (Fastify)
   - Prisma (si viable con instrumentación; si no, spans manuales alrededor de transacciones importantes: payments, status change, outbox insert)
   - Worker outbox (span por batch + span por evento)
2) Exporter:
   - Para P0 usar console exporter o OTLP configurable por env (OTEL_EXPORTER_OTLP_ENDPOINT)
3) Context propagation:
   - Cada request debe crear un root span con attributes: tenantId, userId, route, method.
4) No bloquear el performance: tracing debe poder apagarse por env (OTEL_ENABLED=false).

D) Outbox worker hardening (P0)
1) Extender OutboxEvent con:
   - attempts: Int default 0
   - lastError: String? (limitada o truncada)
   - nextRunAt: DateTime? (opcional)
   - status: PENDING | PROCESSED | FAILED
2) Procesamiento:
   - En cada intento fallido: attempts++, lastError set, y si attempts >= MAX_ATTEMPTS => status=FAILED, si no queda PENDING.
   - MAX_ATTEMPTS configurable por env (OUTBOX_MAX_ATTEMPTS default 5).
3) Lock:
   - Mantener lock redis global.
   - Asegurar release del lock en finally.
4) Métricas/logs:
   - Incrementar outbox_events_total{type,status} y loggear transitions.
5) Tests:
   - Caso “process ok”: marca PROCESSED.
   - Caso “process falla”: attempts incrementa y termina FAILED al superar max.
   - Testear que lock evita doble ejecución (si es complejo, al menos test de que si lock no se adquiere, no procesa).

E) Tests + helpers (P0)
1) Refactor tests existentes para usar helpers:
   - createApp() o buildApp() ya existe; crear helpers en tests/_helpers.ts:
     - registerTenantAndLogin(app) -> { tenantId, token, refreshToken? }
     - createProduct(app, token, {name, priceCents}) -> product
     - createOrder(app, token) -> order
     - addOrderItem(app, token, orderId, productId, qty) -> order detail
2) Test de concurrencia de idempotencia en payments:
   - Disparar 2 requests en paralelo al mismo endpoint POST /orders/:id/payments con MISMO idempotencyKey.
   - Esperar: misma respuesta (mismo paymentId) y en DB solo 1 Payment y 1 OutboxEvent (si aplica).
3) Test multi-tenant isolation mínimo:
   - Tenant A crea producto/orden/pago.
   - Tenant B no puede acceder: GET /payments/:paymentId => 404 (o 403 según estándar, pero consistente) y GET /orders/:id => 404/403.
4) Mantener Biome/lint sin any.

REQUERIMIENTOS NO FUNCIONALES
- Mantener error responses estándar.
- No introducir “console.log” sueltos; usar logger estándar.
- No loggear secretos.
- Código modular: plugins en src/plugins o src/observability.
- Todo debe pasar: typecheck, lint, tests.
- Actualizar README con:
  - Sección Observabilidad (logging, metrics, tracing)
  - Cómo activar/desactivar tracing
  - Variables de entorno nuevas:
    OTEL_ENABLED, OTEL_EXPORTER_OTLP_ENDPOINT (si aplica), OUTBOX_MAX_ATTEMPTS
  - Endpoint /metrics documentado
  - Nueva semántica de outbox attempts/FAILED

ENTREGABLES (Done Definition)
- /metrics funcionando y testeado
- logs con requestId + tenantId/userId visibles en requests protegidos
- tracing mínimo implementado y apagable por env
- outbox worker con attempts y FAILED
- tests refactorizados con helpers + test de concurrencia idempotencia + test multi-tenant access
- README actualizado con todo lo anterior

Implementá los cambios donde corresponda en este repo (plugins, app bootstrap, worker, schema/migrations, tests).
