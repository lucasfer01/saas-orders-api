import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { signAccessToken } from "../src/auth/jwt.js";

const app = buildApp();

type RegisterRes = {
	tenant: { id: string };
	accessToken: string;
	refreshToken: string;
	user: { id: string; email: string };
};

async function registerTenant(payload: {
	tenantName: string;
	email: string;
	password: string;
}) {
	const res = await app.inject({
		method: "POST",
		url: "/auth/register",
		payload,
	});
	expect(res.statusCode).toBe(201);
	return res.json() as RegisterRes;
}

async function createProduct(token: string, data: { name: string; priceCents: number }) {
	const res = await app.inject({
		method: "POST",
		url: "/products",
		headers: { Authorization: `Bearer ${token}` },
		payload: data,
	});
	expect(res.statusCode).toBe(201);
	return res.json() as { id: string; tenantId: string; name: string; priceCents: number; active: boolean };
}

async function createOrder(token: string) {
	const res = await app.inject({
		method: "POST",
		url: "/orders",
		headers: { Authorization: `Bearer ${token}` },
		payload: {},
	});
	expect(res.statusCode).toBe(201);
	return res.json() as { id: string; tenantId: string; number: number; status: string; subtotalCents: number; totalCents: number };
}

async function addItem(token: string, orderId: string, payload: { productId: string; qty: number }) {
	const res = await app.inject({
		method: "POST",
		url: `/orders/${orderId}/items`,
		headers: { Authorization: `Bearer ${token}` },
		payload,
	});
	return res;
}

async function updateStatus(token: string, orderId: string, toStatus: string) {
	const res = await app.inject({
		method: "PATCH",
		url: `/orders/${orderId}/status`,
		headers: { Authorization: `Bearer ${token}` },
		payload: { toStatus },
	});
	return res;
}

async function getOrder(token: string, orderId: string) {
	const res = await app.inject({
		method: "GET",
		url: `/orders/${orderId}`,
		headers: { Authorization: `Bearer ${token}` },
	});
	return res;
}

async function listOrders(token: string, query = "") {
	const res = await app.inject({
		method: "GET",
		url: `/orders${query}`,
		headers: { Authorization: `Bearer ${token}` },
	});
	return res;
}

beforeAll(async () => {
	await app.ready();
});

afterAll(async () => {
	await app.close();
});

describe("orders module - hardening", () => {
	it("auth required: GET/POST /orders y GET /orders/:id => 401", async () => {
		const list = await app.inject({ method: "GET", url: "/orders" });
		expect(list.statusCode).toBe(401);

		const create = await app.inject({ method: "POST", url: "/orders", payload: {} });
		expect(create.statusCode).toBe(401);

		const detail = await app.inject({ method: "GET", url: "/orders/some-id" });
		expect(detail.statusCode).toBe(401);
	});

	it("rbac: ADMIN puede crear y STAFF no (403)", async () => {
		const reg = await app.inject({ method: "POST", url: "/auth/register", payload: { tenantName: `RBAC-Ord-${Date.now()}` , email: `admin+rbac@o.com`, password: "secret12345" } });
		expect(reg.statusCode).toBe(201);
		const { accessToken, user, tenant } = reg.json() as any;

		// ADMIN crea OK
		const ok = await app.inject({ method: "POST", url: "/orders", headers: { Authorization: `Bearer ${accessToken}` }, payload: {} });
		expect(ok.statusCode).toBe(201);

		// STAFF no puede
		const staffToken = signAccessToken({ sub: user.id, tenantId: tenant.id, roles: ["STAFF"] });
		const fail = await app.inject({ method: "POST", url: "/orders", headers: { Authorization: `Bearer ${staffToken}` }, payload: {} });
		expect(fail.statusCode).toBe(403);
	});

	it("happy path: create product -> create order -> add item -> list", async () => {
		const a = await registerTenant({
			tenantName: "OrdersCo-A",
			email: "admin@orderscoa.com",
			password: "secret12345",
		});

		const product = await createProduct(a.accessToken, { name: "Widget", priceCents: 1999 });
		expect(product.tenantId).toBe(a.tenant.id);

		const order = await createOrder(a.accessToken);
		expect(order.status).toBe("DRAFT");
		expect(order.subtotalCents).toBe(0);

		const addRes = await addItem(a.accessToken, order.id, { productId: product.id, qty: 2 });
		expect(addRes.statusCode).toBe(200);
		const updated = addRes.json() as any;
		expect(updated.items.length).toBe(1);
		expect(updated.subtotalCents).toBe(1999 * 2);
		expect(updated.totalCents).toBe(1999 * 2);

		const listRes = await listOrders(a.accessToken, "?page=1&pageSize=10");
		expect(listRes.statusCode).toBe(200);
		const list = listRes.json() as any;
		expect(list.total).toBeGreaterThanOrEqual(1);
		expect(Array.isArray(list.items)).toBe(true);
	});

	it("multi-tenant isolation: tenant B cannot read tenant A order (404)", async () => {
		const a = await registerTenant({
			tenantName: "Iso-A",
			email: "admin@isoa.com",
			password: "secret12345",
		});
		const b = await registerTenant({
			tenantName: "Iso-B",
			email: "admin@isob.com",
			password: "secret12345",
		});

		const productA = await createProduct(a.accessToken, { name: "A-Product", priceCents: 1000 });
		const orderA = await createOrder(a.accessToken);

		const addRes = await addItem(a.accessToken, orderA.id, { productId: productA.id, qty: 1 });
		expect(addRes.statusCode).toBe(200);

		const resB = await getOrder(b.accessToken, orderA.id);
		// Debe ser 404 para no filtrar existencia cross-tenant
		expect(resB.statusCode).toBe(404);
	});

	it("multi-tenant isolation: tenant B cannot mutate tenant A order (404)", async () => {
		const a = await registerTenant({
			tenantName: "Iso2-A",
			email: "admin@iso2a.com",
			password: "secret12345",
		});
		const b = await registerTenant({
			tenantName: "Iso2-B",
			email: "admin@iso2b.com",
			password: "secret12345",
		});

		const productA = await createProduct(a.accessToken, { name: "A-Product-2", priceCents: 1000 });
		const orderA = await createOrder(a.accessToken);

		const mutate = await addItem(b.accessToken, orderA.id, { productId: productA.id, qty: 1 });
		// Puede ser 404 (order not found) o 404 product not found (porque productA es tenant A)
		expect([404, 400]).toContain(mutate.statusCode);
	});

	it("status transitions: DRAFT -> OPEN -> PAID works, invalid transitions fail", async () => {
		const a = await registerTenant({
			tenantName: "Status-A",
			email: "admin@statusa.com",
			password: "secret12345",
		});

		const order = await createOrder(a.accessToken);

		const toOpen = await updateStatus(a.accessToken, order.id, "OPEN");
		expect(toOpen.statusCode).toBe(200);
		expect((toOpen.json() as any).status).toBe("OPEN");

		const toPaid = await updateStatus(a.accessToken, order.id, "PAID");
		expect(toPaid.statusCode).toBe(200);
		expect((toPaid.json() as any).status).toBe("PAID");

		// Invalid: DRAFT -> PAID directo
		const a2 = await registerTenant({ tenantName: "Status-Invalid", email: "admin@statusinvalid.com", password: "secret12345" });
		const oInv = await createOrder(a2.accessToken);
		const d2p = await updateStatus(a2.accessToken, oInv.id, "PAID");
		expect(d2p.statusCode).toBe(400);

		// Invalid: PAID -> OPEN
		const invalid = await updateStatus(a.accessToken, order.id, "OPEN");
		expect(invalid.statusCode).toBe(400);
		// Invalid: CANCELED -> OPEN
		const a3 = await registerTenant({ tenantName: "Status-Cancel", email: "admin@statuscancel.com", password: "secret12345" });
		const oc = await createOrder(a3.accessToken);
		const toCanceled = await updateStatus(a3.accessToken, oc.id, "CANCELED");
		expect(toCanceled.statusCode).toBe(200);
		const backOpen = await updateStatus(a3.accessToken, oc.id, "OPEN");
		expect(backOpen.statusCode).toBe(400);
	});

	it("items are blocked when status is PAID or CANCELED", async () => {
		const a = await registerTenant({
			tenantName: "Lock-A",
			email: "admin@locka.com",
			password: "secret12345",
		});

		const product = await createProduct(a.accessToken, { name: "LockedProduct", priceCents: 2500 });
		const order = await createOrder(a.accessToken);

		const open = await updateStatus(a.accessToken, order.id, "OPEN");
		expect(open.statusCode).toBe(200);

		// Add item still allowed in OPEN
		const addOk = await addItem(a.accessToken, order.id, { productId: product.id, qty: 1 });
		expect(addOk.statusCode).toBe(200);

		// Move to PAID
		const paid = await updateStatus(a.accessToken, order.id, "PAID");
		expect(paid.statusCode).toBe(200);

		// Now add item must fail
		const addFail = await addItem(a.accessToken, order.id, { productId: product.id, qty: 1 });
		expect(addFail.statusCode).toBe(400);

		// Y también PATCH/DELETE deben fallar
		const itemId = (paid.json() as any).items?.[0]?.id ?? (await (async () => {
			const list = await getOrder(a.accessToken, order.id); return (list.json() as any).items[0].id; })());
		const patchInPaid = await app.inject({ method: "PATCH", url: `/orders/${order.id}/items/${itemId}`, headers: { Authorization: `Bearer ${a.accessToken}` }, payload: { qty: 2 } });
		expect(patchInPaid.statusCode).toBe(400);
		const delInPaid = await app.inject({ method: "DELETE", url: `/orders/${order.id}/items/${itemId}`, headers: { Authorization: `Bearer ${a.accessToken}` } });
		expect(delInPaid.statusCode).toBe(400);

		// CANCELED también bloquea
		const aCancel = await registerTenant({ tenantName: "Lock-B", email: "admin@lockb.com", password: "secret12345" });
		const prodB = await createProduct(aCancel.accessToken, { name: "LockedProductB", priceCents: 1500 });
		const ordB = await createOrder(aCancel.accessToken);
		const addB = await addItem(aCancel.accessToken, ordB.id, { productId: prodB.id, qty: 1 });
		expect(addB.statusCode).toBe(200);
		const toCanceledB = await updateStatus(aCancel.accessToken, ordB.id, "CANCELED");
		expect(toCanceledB.statusCode).toBe(200);
		const addInCanceled = await addItem(aCancel.accessToken, ordB.id, { productId: prodB.id, qty: 1 });
		expect(addInCanceled.statusCode).toBe(400);
		const itemIdB = (await getOrder(aCancel.accessToken, ordB.id)).json().items[0].id as string;
		const patchCanceled = await app.inject({ method: "PATCH", url: `/orders/${ordB.id}/items/${itemIdB}`, headers: { Authorization: `Bearer ${aCancel.accessToken}` }, payload: { qty: 2 } });
		expect(patchCanceled.statusCode).toBe(400);
		const delCanceled = await app.inject({ method: "DELETE", url: `/orders/${ordB.id}/items/${itemIdB}`, headers: { Authorization: `Bearer ${aCancel.accessToken}` } });
		expect(delCanceled.statusCode).toBe(400);
	});

	it("filters: list orders by status", async () => {
		const a = await registerTenant({
			tenantName: "Filter-A",
			email: "admin@filtera.com",
			password: "secret12345",
		});

		const o1 = await createOrder(a.accessToken);
		const o2 = await createOrder(a.accessToken);

		// OPEN one of them
		const res = await updateStatus(a.accessToken, o2.id, "OPEN");
		expect(res.statusCode).toBe(200);

		const listDraft = await listOrders(a.accessToken, "?page=1&pageSize=50&status=DRAFT");
		expect(listDraft.statusCode).toBe(200);
		const draftBody = listDraft.json() as any;
		expect(draftBody.items.every((x: any) => x.status === "DRAFT")).toBe(true);

		const listOpen = await listOrders(a.accessToken, "?page=1&pageSize=50&status=OPEN");
		expect(listOpen.statusCode).toBe(200);
		const openBody = listOpen.json() as any;
		expect(openBody.items.every((x: any) => x.status === "OPEN")).toBe(true);
	});

	it("validation: qty must be >= 1 (if enforced by schema)", async () => {
		const a = await registerTenant({
			tenantName: "Val-A",
			email: "admin@vala.com",
			password: "secret12345",
		});
		const product = await createProduct(a.accessToken, { name: "ValProduct", priceCents: 100 });
		const order = await createOrder(a.accessToken);

		const res = await addItem(a.accessToken, order.id, { productId: product.id, qty: 0 });
		// Si tu Zod valida, debería ser 400
		expect(res.statusCode).toBe(400);
	});

	it("items: update qty recalculates totals", async () => {
		const a = await registerTenant({ tenantName: `Up-${Date.now()}`, email: `admin@up.com`, password: "secret12345" });
		const product = await createProduct(a.accessToken, { name: "U-Prod", priceCents: 300 });
		const order = await createOrder(a.accessToken);
		const add = await addItem(a.accessToken, order.id, { productId: product.id, qty: 2 });
		expect(add.statusCode).toBe(200);
		const itemId = (add.json() as any).items[0].id as string;

		const patch = await app.inject({ method: "PATCH", url: `/orders/${order.id}/items/${itemId}`, headers: { Authorization: `Bearer ${a.accessToken}` }, payload: { qty: 3 } });
		expect(patch.statusCode).toBe(200);
		const patched = patch.json() as any;
		expect(patched.items[0].lineTotalCents).toBe(300 * 3);
		expect(patched.totalCents).toBe(300 * 3);
	});

	it("items: delete recalculates totals a 0", async () => {
		const a = await registerTenant({ tenantName: `Del-${Date.now()}`, email: `admin@del.com`, password: "secret12345" });
		const product = await createProduct(a.accessToken, { name: "D-Prod", priceCents: 200 });
		const order = await createOrder(a.accessToken);
		const add = await addItem(a.accessToken, order.id, { productId: product.id, qty: 2 });
		expect(add.statusCode).toBe(200);
		const itemId = (add.json() as any).items[0].id as string;

		const del = await app.inject({ method: "DELETE", url: `/orders/${order.id}/items/${itemId}`, headers: { Authorization: `Bearer ${a.accessToken}` } });
		expect(del.statusCode).toBe(200);
		const after = del.json() as any;
		expect(after.items.length).toBe(0);
		expect(after.subtotalCents).toBe(0);
		expect(after.totalCents).toBe(0);
	});

	it("items validations: product not found, item not found PATCH/DELETE", async () => {
		const a = await registerTenant({ tenantName: `Val2-${Date.now()}`, email: `admin@val2.com`, password: "secret12345" });
		const order = await createOrder(a.accessToken);
		const add404 = await addItem(a.accessToken, order.id, { productId: "non-existent", qty: 1 });
		expect(add404.statusCode).toBe(404);

		const patch404 = await app.inject({ method: "PATCH", url: `/orders/${order.id}/items/some-item`, headers: { Authorization: `Bearer ${a.accessToken}` }, payload: { qty: 2 } });
		expect([404, 400]).toContain(patch404.statusCode);
		const del404 = await app.inject({ method: "DELETE", url: `/orders/${order.id}/items/some-item`, headers: { Authorization: `Bearer ${a.accessToken}` } });
		expect([404, 400]).toContain(del404.statusCode);
	});

	it("create order: fields defaults y number incrementa en el tenant", async () => {
		const a = await registerTenant({ tenantName: `Num-${Date.now()}`, email: `admin@num.com`, password: "secret12345" });
		const o1 = await createOrder(a.accessToken);
		const o2 = await createOrder(a.accessToken);
		expect(o1.status).toBe("DRAFT");
		expect(o1.subtotalCents).toBe(0);
		expect(o1.totalCents).toBe(0);
		expect(o2.number).toBe(o1.number + 1);
	});

	it("writes OrderStatusHistory audit rows on status change", async () => {
		const reg = await app.inject({
			method: "POST",
			url: "/auth/register",
			payload: {
				tenantName: "AuditCo",
				email: "admin@auditco.com",
				password: "secret12345",
			},
		});
		expect(reg.statusCode).toBe(201);
		const regBody = reg.json() as any;

		const tenantId = regBody.tenant.id as string;
		const token = regBody.accessToken as string;
		const userId = regBody.user.id as string;

		// create order
		const create = await app.inject({
			method: "POST",
			url: "/orders",
			headers: { Authorization: `Bearer ${token}` },
			payload: {},
		});
		expect(create.statusCode).toBe(201);
		const order = create.json() as any;
		const orderId = order.id as string;

		// DRAFT -> OPEN
		const toOpen = await app.inject({
			method: "PATCH",
			url: `/orders/${orderId}/status`,
			headers: { Authorization: `Bearer ${token}` },
			payload: { toStatus: "OPEN" },
		});
		expect(toOpen.statusCode).toBe(200);

		// OPEN -> PAID
		const toPaid = await app.inject({
			method: "PATCH",
			url: `/orders/${orderId}/status`,
			headers: { Authorization: `Bearer ${token}` },
			payload: { toStatus: "PAID" },
		});
		expect(toPaid.statusCode).toBe(200);

		// Assert audit
		const rows = await app.prisma.orderStatusHistory.findMany({
			where: { tenantId, orderId },
			orderBy: { createdAt: "asc" },
			select: {
				fromStatus: true,
				toStatus: true,
				changedByUserId: true,
				tenantId: true,
				orderId: true,
			},
		});

		expect(rows.length).toBe(2);

		expect(rows[0]).toMatchObject({
			tenantId,
			orderId,
			fromStatus: "DRAFT",
			toStatus: "OPEN",
			changedByUserId: userId,
		});

		expect(rows[1]).toMatchObject({
			tenantId,
			orderId,
			fromStatus: "OPEN",
			toStatus: "PAID",
			changedByUserId: userId,
		});
	});

});
