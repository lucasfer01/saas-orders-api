import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";

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

		// Invalid: PAID -> OPEN
		const invalid = await updateStatus(a.accessToken, order.id, "OPEN");
		expect(invalid.statusCode).toBe(400);
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
