import { expect, test } from "vitest";
import { createProject, createTestServer, get, post } from "./helpers.js";

test("a declared finding schema rejects missing/invalid data without allocating ids", async () => {
	const { app, db } = createTestServer();
	const pid = await createProject(app, {
		finding_schema: {
			type: "object",
			required: ["verified"],
			properties: { verified: { const: true } },
			additionalProperties: false,
		},
	});
	const body = { actor: "human", title: "verified", description: "probe result" };
	for (const data of [undefined, null, {}, { verified: false }]) {
		const response = await post(app, `/projects/${pid}/findings`, { ...body, data });
		expect(response.status).toBe(400);
	}
	expect(db.prepare("SELECT 1 FROM findings WHERE project_id=?").get(pid)).toBeUndefined();
	const valid = await post(app, `/projects/${pid}/findings`, { ...body, data: { verified: true } });
	const result = await valid.json();
	const retry = await post(app, `/projects/${pid}/findings`, {
		...body,
		data: { verified: true },
		client_event_id: "retryable-result",
	});
	const duplicate = await post(app, `/projects/${pid}/findings`, {
		...body,
		data: { verified: true },
		client_event_id: "retryable-result",
	});
	const firstRetry = await retry.json();
	expect(valid.status).toBe(201);
	expect(result).toMatchObject({ id: "r001", data: { verified: true } });
	expect(firstRetry.id).toBe("r002");
	expect(duplicate.status).toBe(200);
	expect(await duplicate.json()).toMatchObject({ id: firstRetry.id, duplicate: true });
});

test.each([undefined, null])(
	"schema %s preserves unstructured findings",
	async (finding_schema) => {
		const { app } = createTestServer();
		const pid = await createProject(app, { finding_schema });
		const response = await post(app, `/projects/${pid}/findings`, {
			actor: "human",
			title: "unstructured",
			description: "text-only result",
		});
		expect(response.status).toBe(201);
		expect(await response.json()).toMatchObject({ data: null });
	},
);

test("a JSON null payload is distinct from an omitted payload", async () => {
	const { app } = createTestServer();
	const pid = await createProject(app, { finding_schema: { type: "null" } });
	const body = { actor: "human", title: "null result", description: "explicit null" };
	expect((await post(app, `/projects/${pid}/findings`, body)).status).toBe(400);
	const explicit = await post(app, `/projects/${pid}/findings`, { ...body, data: null });
	expect(explicit.status).toBe(201);
	const record = await get(app, `/projects/${pid}/records/finding/r001`);
	expect((await record.json()).record.data).toBeNull();
});
