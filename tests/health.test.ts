import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";

const app = buildApp();

beforeAll(async () => {
	await app.ready();
});

afterAll(async () => {
	await app.close();
});

describe("health routes", () => {
	it("GET /health returns ok", async () => {
		const res = await app.inject({ method: "GET", url: "/health" });
		expect(res.statusCode).toBe(200);
		const body = res.json();
		expect(body).toEqual({ ok: true });
	});

	it("GET /ready returns ok with services", async () => {
		const res = await app.inject({ method: "GET", url: "/ready" });
		expect(res.statusCode).toBe(200);
		const body = res.json();
		expect(body.ok).toBe(true);
		expect(body.db).toBe("ok");
		expect(["ok", "unknown"]).toContain(body.redis);
	});
});
