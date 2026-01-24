import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";

const app = buildApp();
let tenantId: string;
let accessToken: string;
let refreshToken: string;

beforeAll(async () => {
	await app.ready();
});

afterAll(async () => {
	await app.close();
});

describe("auth flow", () => {
	it("registers a tenant and admin user", async () => {
		const res = await app.inject({
			method: "POST",
			url: "/auth/register",
			payload: {
				tenantName: "TestCo",
				email: "admin@testco.com",
				password: "supersecret123",
			},
		});
		expect(res.statusCode).toBe(201);
		const body = res.json();
		expect(body.tenant?.id).toBeDefined();
		expect(body.user?.id).toBeDefined();
		expect(typeof body.accessToken).toBe("string");
		expect(typeof body.refreshToken).toBe("string");
		tenantId = body.tenant.id;
		accessToken = body.accessToken;
		refreshToken = body.refreshToken;
	});

	it("logs in with the created user", async () => {
		const res = await app.inject({
			method: "POST",
			url: "/auth/login",
			payload: {
				tenantId,
				email: "admin@testco.com",
				password: "supersecret123",
			},
		});
		expect(res.statusCode).toBe(200);
		const body = res.json();
		expect(typeof body.accessToken).toBe("string");
		expect(typeof body.refreshToken).toBe("string");
		accessToken = body.accessToken;
		refreshToken = body.refreshToken;
	});

	it("returns current user on /me", async () => {
		const res = await app.inject({
			method: "GET",
			url: "/me",
			headers: { Authorization: `Bearer ${accessToken}` },
		});
		expect(res.statusCode).toBe(200);
		const body = res.json();
		expect(body.tenantId).toBe(tenantId);
		expect(body.roles).toContain("ADMIN");
	});

	it("refreshes tokens via /auth/refresh", async () => {
		const res = await app.inject({
			method: "POST",
			url: "/auth/refresh",
			payload: { refreshToken },
		});
		expect(res.statusCode).toBe(200);
		const body = res.json();
		expect(typeof body.accessToken).toBe("string");
		expect(typeof body.refreshToken).toBe("string");
		accessToken = body.accessToken;
		refreshToken = body.refreshToken;
	});

	it("logout is idempotent", async () => {
		const res = await app.inject({
			method: "POST",
			url: "/auth/logout",
			payload: { refreshToken },
		});
		expect(res.statusCode).toBe(200);
		expect(res.json()).toEqual({ ok: true });
	});
});
