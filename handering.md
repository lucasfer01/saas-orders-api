Objetivo: Hardening mínimo (v1) para saas-orders-api (Fastify + TS + Prisma).
Implementar:
1) Rate limiting
2) Security headers
3) Error responses estandarizadas (shape + códigos)
4) Tests de regresión mínimos (Vitest + app.inject)

Contexto actual:
- App Fastify modular con plugins + módulos (auth/products/orders/payments).
- Autenticación JWT con requireAuth + RBAC requireRole.
- Prisma + Postgres, Redis opcional (puede existir plugin).
- Tests de integración ya existentes con Vitest + app.inject, env .env.test.

RESTRICCIONES:
- No romper los endpoints existentes ni sus status codes principales, salvo que sea para estandarizar errores.
- Evitar introducir dependencias innecesarias; si agregás deps, justificarlas en README y mantenerlo mínimo.
- No usar `any`. Mantener tipos correctos (Fastify module augmentation ya existe en types/fastify.d.ts).
- Los errores deben quedar consistentes en todos los módulos.

ENTREGABLES / CHECKLIST (Definition of Done):
A) Security headers
- Agregar un plugin global de security headers:
  - Usar @fastify/helmet (preferido).
  - Configurar: hidePoweredBy, frameguard (deny o sameorigin), noSniff, xssFilter si aplica, referrerPolicy, etc.
  - Mantener CORS ya configurado (no romperlo).
- Aceptación:
  - En un request a /health, la respuesta incluye headers razonables de seguridad (p. ej. x-content-type-options, x-frame-options, referrer-policy, etc.).

B) Rate limiting (global + específico por endpoint)
- Implementar rate limit con @fastify/rate-limit.
- Estrategia:
  1) Global suave (por IP): p.ej. 300 req/min (ajustable por env)
  2) Endpoints sensibles más estrictos:
     - POST /auth/login (p.ej. 10/min por IP)
     - POST /auth/register (p.ej. 5/min por IP)
     - POST /auth/refresh (p.ej. 20/min por IP)
     - POST /orders/:id/payments (p.ej. 30/min por IP)
- Usar `keyGenerator` para:
  - Por defecto IP (req.ip) para públicos (login/register)
  - Para rutas autenticadas, si existe req.auth.tenantId, preferir `tenant:<tenantId>:ip:<ip>` o `tenant:<tenantId>:user:<userId>` (elegí uno consistente). Debe ser determinístico.
- El mensaje de rate limit excedido debe ser un error estandarizado (ver sección C).
- Aceptación:
  - Superar el límite de login devuelve 429 con el JSON de error estandarizado.
  - No afecta flujos normales de tests existentes (ajustar límites en env test si hace falta).

C) Error handling estandarizado (shape + mapping)
- Implementar un error handler global (setErrorHandler) o refactor del existente para devolver SIEMPRE:
  {
    "error": {
      "code": string,        // ej: "UNAUTHORIZED", "FORBIDDEN", "NOT_FOUND", "VALIDATION_ERROR", "RATE_LIMITED", "CONFLICT", "INTERNAL_ERROR"
      "message": string,     // mensaje humano
      "details"?: any        // opcional, sólo para validación o debugging controlado
    }
  }
- Reglas:
  - Zod errors -> 422 VALIDATION_ERROR con details (issues) minimalistas
  - Errores de auth -> 401 UNAUTHORIZED
  - RBAC -> 403 FORBIDDEN
  - notFound -> 404 NOT_FOUND
  - Prisma unique constraint (P2002) -> 409 CONFLICT
  - Rate limit -> 429 RATE_LIMITED
  - Resto -> 500 INTERNAL_ERROR (sin filtrar stack en prod; en test/dev se puede loguear)
- Asegurar que los helpers actuales badRequest/notFound/etc. (src/http/errors.ts o similar) encajen en este estándar:
  - Si ya existe ApiError, adaptarlo para incluir statusCode + code + message (+ optional details).
  - Reemplazar casts `(err as any).code === "P2002"` por type guard real con PrismaClientKnownRequestError.
- Aceptación:
  - Un request inválido por Zod devuelve 422 con shape estándar.
  - Un request sin token a ruta protegida devuelve 401 con shape estándar.
  - Un not found devuelve 404 con shape estándar.

D) Configuración por entorno
- Agregar variables env (con defaults seguros):
  - RATE_LIMIT_GLOBAL_MAX, RATE_LIMIT_GLOBAL_TIME_WINDOW
  - RATE_LIMIT_LOGIN_MAX, RATE_LIMIT_LOGIN_TIME_WINDOW
  - RATE_LIMIT_REGISTER_MAX, RATE_LIMIT_REGISTER_TIME_WINDOW
  - RATE_LIMIT_REFRESH_MAX, RATE_LIMIT_REFRESH_TIME_WINDOW
  - RATE_LIMIT_PAYMENTS_MAX, RATE_LIMIT_PAYMENTS_TIME_WINDOW
- En .env.test usar límites altos o timeWindow corto para no flake.
- Documentar en README (sección “Hardening / Security”).

E) Tests (Vitest, integración con app.inject)
Agregar tests nuevos (o extender existentes) en tests/:
1) rate-limit.login.test.ts (o dentro de auth.test.ts):
   - Ejecutar N requests a POST /auth/login con credenciales inválidas o válidas hasta superar el límite
   - Verificar que la última respuesta es 429 y tiene error.code === "RATE_LIMITED"
   - Nota: para no depender del tiempo, poner timeWindow test grande pero N pequeño, o al revés.
2) error-shape.test.ts:
   - Zod: POST /products con payload inválido (sin name) con token => 422 y shape estándar
   - Unauthorized: GET /products sin token => 401 y shape estándar
3) security-headers.test.ts:
   - GET /health y verificar presencia de al menos 2 headers típicos (x-content-type-options, x-frame-options o referrer-policy).
- Mantener los tests existentes funcionando.

DÓNDE TOCAR (orientativo, ajustá al repo):
- src/app.ts: registro de plugins globales (helmet, rate-limit) + setErrorHandler.
- src/http/errors.ts (o donde esté ApiError): estandarizar.
- src/auth/middleware.ts: que las excepciones usen ApiError estándar.
- src/modules/*/routes.ts: eliminar casts any innecesarios, usar getAuth(req) tipado.
- types/fastify.d.ts: si hace falta ampliar tipos para rate-limit o error handler (sin romper).
- .env.test y README.md.

PASOS IMPLEMENTACIÓN (orden sugerido):
1) Crear/ajustar ApiError estándar + helpers (badRequest, unauthorized, forbidden, notFound, conflict, tooManyRequests).
2) Implementar setErrorHandler global que mapea Zod, Prisma P2002, rate-limit y ApiError.
3) Agregar @fastify/helmet como plugin global.
4) Agregar @fastify/rate-limit global y overrides por ruta (route config: { config: { rateLimit: {...} } } o equivalente).
5) Tests + ajustar env test.
6) biome check --write + npm run typecheck + npm run test.

CRITERIOS DE ACEPTACIÓN FINAL:
- npm run typecheck -> OK
- npm run lint -> OK (sin any)
- npm run test -> OK
- Todos los errores relevantes devuelven el mismo JSON shape.
- Rate limit activo en login/register/refresh/payments.
- Security headers presentes en /health.

Implementá con commits lógicos:
- feat(security): add helmet
- feat(rate-limit): add global and per-route limits
- refactor(errors): standardize error responses and prisma/zod mapping
- test(hardening): add integration tests for rate limit, error shape, headers
