import { expect, test } from "vitest";

import { createTestServer, get, patch } from "./helpers.js";

test("settings defaults and partial updates round-trip", async () => {
	const { app } = createTestServer();

	const initial = await get(app, "/settings");
	expect(initial.status).toBe(200);
	expect(await initial.json()).toEqual({ lease_timeout: 120, decide_timeout: 30 });

	const updated = await patch(app, "/settings", { lease_timeout: 45 });
	expect(updated.status).toBe(200);
	expect(await updated.json()).toEqual({ lease_timeout: 45, decide_timeout: 30 });
	expect(await (await get(app, "/settings")).json()).toEqual({
		lease_timeout: 45,
		decide_timeout: 30,
	});

	const both = await patch(app, "/settings", { lease_timeout: 60, decide_timeout: 90 });
	expect(await both.json()).toEqual({ lease_timeout: 60, decide_timeout: 90 });
});

test("settings reject invalid values with 400", async () => {
	const { app } = createTestServer();

	for (const body of [
		{ lease_timeout: 4 },
		{ decide_timeout: 0 },
		{ lease_timeout: 10.5 },
		{ lease_timeout: "30" },
		{},
	]) {
		const res = await patch(app, "/settings", body);
		expect(res.status).toBe(400);
		expect((await res.json()).detail).toBeTypeOf("string");
	}

	expect(await (await get(app, "/settings")).json()).toEqual({
		lease_timeout: 120,
		decide_timeout: 30,
	});
});
