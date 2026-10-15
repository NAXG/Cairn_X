import { expect, test } from "vitest";
import { createTestServer } from "./helpers.js";

test("configuration writes reject invalid JSON and fields without changing settings", async () => {
	const { app } = createTestServer();
	const before = (await (await app.request("/settings/runtime")).json()) as Record<string, unknown>;
	for (const body of ["{bad json", JSON.stringify({ ...before, max_workers: 0 })]) {
		const response = await app.request("/settings/runtime", {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body,
		});
		expect(response.status).toBe(400);
		expect(((await response.json()) as { detail: string }).detail).toContain(
			body.startsWith("{bad") ? "valid JSON" : "max_workers",
		);
	}
	expect(await (await app.request("/settings/runtime")).json()).toEqual(before);
});

test("invalid setting roles and plugin request bodies return client errors", async () => {
	const { app } = createTestServer();
	for (const url of [
		"/settings/agents/wrong",
		"/settings/agents/wrong/plugins",
		"/settings/agents/wrong/skills",
	]) {
		expect((await app.request(url)).status).toBe(400);
	}
	expect(
		(
			await app.request("/settings/agents/execute/plugins/operations", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ kind: "invalid" }),
			})
		).status,
	).toBe(400);
	expect(
		(
			await app.request("/settings/agents/execute/plugins/operations", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: "{bad json",
			})
		).status,
	).toBe(400);
});
