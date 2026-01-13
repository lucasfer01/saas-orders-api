import { badRequest } from "./errors.js";

export function requireTenantId(headers: Record<string, unknown>) {
  const raw = headers["x-tenant-id"];
  const tenantId = typeof raw === "string" ? raw : Array.isArray(raw) ? raw[0] : undefined;

  if (!tenantId) throw badRequest("Missing x-tenant-id header");
  if (tenantId.length < 5) throw badRequest("Invalid x-tenant-id header");

  return tenantId;
}
