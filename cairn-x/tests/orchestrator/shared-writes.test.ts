import { inspectClientProject } from "../support/project-state.js";
import type { FactModel, StepModel } from "../../src/contracts/models.js";
import { randomUUID } from "node:crypto";
import { expect, test } from "vitest";
import {
	addStep,
	claimExecutionWithProjectWorker,
	createProject,
	startExecutorTestServer,
} from "./helpers.js";

async function setup() {
	const server = await startExecutorTestServer({
		api: "openai-completions",
		base_url: "http://unused",
		api_key: "test",
	});
	const pid = await createProject(server.client);
	const sid = await addStep(server.client, pid);
	const eid = randomUUID();
	expect((await server.client.claimStep(pid, sid, eid)).ok).toBe(true);
	const created = await server.client.createExecution({
		project_id: pid,
		step_id: sid,
		execution_id: eid,
	});
	expect(created.ok).toBe(true);
	const claimed = await claimExecutionWithProjectWorker(server, pid, eid);
	const post = (path: string, token: string, body: unknown) =>
		fetch(`${server.url}${path}`, {
			method: "POST",
			headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
	const worker = (suffix: string, body: unknown) =>
		post(`/internal/executions/${eid}/${suffix}`, claimed.task.token, body);
	const human = (suffix: string, body: unknown) =>
		post(`/projects/${pid}/${suffix}`, "test-token", body);
	return { ...server, pid, sid, eid, worker, human };
}

test.each(["public", "worker"] as const)(
	"facts created through %s are idempotent across both interfaces",
	async (first) => {
		const s = await setup();
		const payload = { description: "confirmed", confidence: "inferred", client_event_id: "fact-1" };
		const human = (body: typeof payload) =>
			s.human("facts", { ...body, actor: "human", step_id: s.sid, execution_id: s.eid });
		const worker = (body: typeof payload) => s.worker("facts", body);
		const create = await (first === "public" ? human : worker)(payload);
		expect(create.status).toBe(201);
		const fact = (await create.json()) as FactModel;
		expect(fact).toEqual({
			id: expect.any(String),
			...{ description: "confirmed", confidence: "inferred" },
			step_id: s.sid,
			evidence_refs: [],
			created_at: expect.any(String),
			duplicate: false,
		});
		const replay = await (first === "public" ? worker : human)({
			...payload,
			description: "must not replace original",
		});
		expect(replay.status).toBe(200);
		expect(await replay.json()).toEqual({ id: fact.id, duplicate: true });
		const facts = s.db
			.prepare(
				"SELECT description, step_id, execution_id FROM facts WHERE project_id = ? AND client_event_id = ?",
			)
			.all(s.pid, payload.client_event_id);
		expect(facts).toEqual([{ description: "confirmed", step_id: s.sid, execution_id: s.eid }]);
	},
);

test.each(["public", "worker"] as const)(
	"findings created through %s preserve response shapes and cross-interface idempotency",
	async (first) => {
		const s = await setup();
		const payload = {
			title: "Finding",
			description: "confirmed",
			data: { severity: "high" },
			fact_ids: ["origin"],
			client_event_id: "finding-1",
		};
		const human = () =>
			s.human("findings", { ...payload, actor: "human", step_id: s.sid, execution_id: s.eid });
		const worker = () => s.worker("findings", payload);
		const initial = await (first === "public" ? human : worker)();
		expect(initial.status).toBe(201);
		const created = (await initial.json()) as { id: string };
		const replay = await (first === "public" ? worker : human)();
		expect(replay.status).toBe(200);
		const repeated = await replay.json();
		const publicData = first === "public" ? created : repeated;
		const workerData = first === "worker" ? created : repeated;
		expect(publicData).toEqual({
			id: created.id,
			title: payload.title,
			description: payload.description,
			data: payload.data,
			fact_ids: payload.fact_ids,
			evidence_refs: [],
			created_at: expect.any(String),
			duplicate: first !== "public",
		});
		expect(workerData).toEqual({ id: created.id, duplicate: first !== "worker" });
		expect(
			s.db.prepare("SELECT step_id, execution_id FROM findings WHERE project_id = ?").all(s.pid),
		).toEqual([{ step_id: s.sid, execution_id: s.eid }]);
	},
);

test.each(["public", "worker"] as const)(
	"%s conclusion persists the same Step state and repeats are rejected or idempotent",
	async (kind) => {
		const s = await setup();
		const conclude = () =>
			kind === "public"
				? s.human(`steps/${s.sid}/conclude`, { worker: s.eid, description: "done" })
				: s.worker("result", {
						outcome: "succeeded",
						result: {
							schema_version: 1,
							task_status: "satisfied",
							summary: "done",
							unresolved: [],
						},
					});
		const response = await conclude();
		expect(response.status).toBe(200);
		const body = (await response.json()) as { step: StepModel | string };
		if (kind === "public")
			expect(body.step).toMatchObject({ id: s.sid, status: "concluded", summary: "done" });
		else expect(body).toMatchObject({ committed: true, status: "succeeded" });
		expect(
			s.db
				.prepare("SELECT status, summary FROM steps WHERE project_id = ? AND id = ?")
				.get(s.pid, s.sid),
		).toEqual({ status: "concluded", summary: "done" });
		if (kind === "public") {
			expect((await conclude()).status).toBe(409);
		} else {
			// Worker 结果幂等：重试不得改写首次提交的 Step 总结。
			const retry = await s.worker("result", {
				outcome: "succeeded",
				result: { schema_version: 1, task_status: "satisfied", summary: "changed", unresolved: [] },
			});
			expect(await retry.json()).toMatchObject({ committed: false, status: "succeeded" });
			expect(
				s.db.prepare("SELECT summary FROM steps WHERE project_id = ? AND id = ?").get(s.pid, s.sid),
			).toEqual({ summary: "done" });
		}
	},
);

test.each(["public", "worker"] as const)(
	"%s usage preserves its response shape and contributes to the same totals",
	async (kind) => {
		const s = await setup();
		const payload = { model: "test", input_tokens: 12, output_tokens: 7 };
		if (kind === "public") {
			const response = await s.human("usage", {
				...payload,
				activity: "execute",
				step_id: s.sid,
			});
			expect(response.status).toBe(201);
			expect(await response.json()).toEqual({
				...payload,
				id: expect.any(Number),
				project_id: s.pid,
				activity: "execute",
				step_id: s.sid,
				execution_id: null,
				cache_read_tokens: 0,
				cache_write_tokens: 0,
				created_at: expect.any(String),
			});
		} else {
			// Worker 用量与最终结果同事务提交，不再有独立端点。
			const response = await s.worker("result", {
				outcome: "succeeded",
				result: { schema_version: 1, task_status: "satisfied", summary: "done", unresolved: [] },
				usage: payload,
			});
			expect(response.status).toBe(200);
			expect(await response.json()).toMatchObject({ committed: true, status: "succeeded" });
		}
		const detail = await inspectClientProject(s.client, s.pid);
		expect(detail.usage.execute).toEqual({
			events: 1,
			input_tokens: 12,
			output_tokens: 7,
			cache_read_tokens: 0,
			cache_write_tokens: 0,
		});
	},
);

test("shared writes retain public actor checks and reject writes to stopped projects", async () => {
	const s = await setup();
	expect((await s.human("facts", { description: "no actor", confidence: "observed" })).status).toBe(
		400,
	);
	expect((await s.human("findings", { title: "no actor", description: "no actor" })).status).toBe(
		400,
	);
	await s.client.setProjectStatus(s.pid, "stopped");
	for (const [suffix, payload] of [
		["facts", { description: "stopped", confidence: "observed", client_event_id: "stopped-fact" }],
		["findings", { title: "stopped", description: "stopped", client_event_id: "stopped-finding" }],
	] as const) {
		expect((await s.human(suffix, { ...payload, actor: "human" })).status).toBe(403);
		// 停止项目会先取消在途执行，Worker 凭据随之吊销 —— 两条入口都是 403，
		// 到不了 Step 租约冲突那条 409。
		expect((await s.worker(suffix, payload)).status).toBe(403);
	}
});
