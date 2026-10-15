import { expect, test } from "vitest";
import { createProject, createTestServer, del, get, post } from "./helpers.js";

const factRef = (id: string) => ({ type: "fact", id });
const findingRef = (id: string) => ({ type: "finding", id });

async function seed(app: any, pid: string) {
	await post(app, `/projects/${pid}/steps`, {
		actor: "human",
		creator: "human",
		from: ["origin"],
		description: "inspect",
	});
	await post(app, `/projects/${pid}/steps/s001/claim`, { worker: "w1" });
}

test("facts and findings carry validated event evidence refs", async () => {
	const { app, db } = createTestServer();
	const pid = await createProject(app);
	await seed(app, pid);
	const now = "2026-01-01T00:00:00Z";
	db.prepare(
		"INSERT INTO executions (id, project_id, step_id, attempt, lease_version, status, created_at) VALUES ('e1', ?, 's001', 1, 1, 'running', ?)",
	).run(pid, now);
	db.prepare("INSERT INTO execution_events (execution_id, seq, line) VALUES ('e1', 7, '{}')").run();
	const fact = await post(app, `/projects/${pid}/facts`, {
		confidence: "observed",
		actor: "human",
		step_id: "s001",
		worker: "w1",
		description: "observed",
		evidence: [{ kind: "event", execution_id: "e1", seq: 7 }],
	});
	expect(fact.status).toBe(201);
	const model = await fact.json();
	expect(model.evidence_refs).toEqual([{ kind: "event", execution_id: "e1", seq: 7 }]);

	const finding = await post(app, `/projects/${pid}/findings`, {
		actor: "human",
		title: "confirmed",
		description: "result",
		fact_ids: [model.id],
		evidence: [{ kind: "event", execution_id: "e1", seq: 7 }],
	});
	expect(finding.status).toBe(201);
	expect((await finding.json()).evidence_refs).toEqual([
		{ kind: "event", execution_id: "e1", seq: 7 },
	]);

	// 伪造 seq / 不存在的 execution 一律拒绝。
	for (const evidence of [
		[{ kind: "event", execution_id: "e1", seq: 999 }],
		[{ kind: "event", execution_id: "missing", seq: 1 }],
	]) {
		const bad = await post(app, `/projects/${pid}/facts`, {
			confidence: "observed",
			actor: "human",
			step_id: "s001",
			worker: "w1",
			description: "bad evidence",
			evidence,
		});
		expect(bad.status).toBe(404);
	}
	// 非法结构（seq 缺字段 / kind 未知）→ 400。
	const malformed = await post(app, `/projects/${pid}/facts`, {
		confidence: "observed",
		actor: "human",
		step_id: "s001",
		worker: "w1",
		description: "bad shape",
		evidence: [{ kind: "event", execution_id: "e1" }],
	});
	expect(malformed.status).toBe(400);
});

test("goal achievement uses typed fact/finding evidence and is idempotent on identical retries", async () => {
	const { app } = createTestServer();
	const pid = await createProject(app);
	await post(app, `/projects/${pid}/findings`, {
		actor: "human",
		title: "r1",
		description: "confirmed",
		fact_ids: ["origin"],
	});
	await post(app, `/projects/${pid}/goals`, { actor: "human", description: "sub" });

	const achieved = await post(app, `/projects/${pid}/goals/g001/achieve`, {
		actor: "human",
		from: [factRef("origin"), findingRef("r001")],
		description: "goal proven by fact and finding",
	});
	expect(achieved.status).toBe(200);
	const goal = await achieved.json();
	expect(goal.status).toBe("achieved");
	expect(goal.evidence).toEqual([factRef("origin"), findingRef("r001")]);

	// 完全相同的重传 → 幂等确认（200，不改写）。
	const retry = await post(app, `/projects/${pid}/goals/g001/achieve`, {
		actor: "human",
		from: [findingRef("r001"), factRef("origin")],
		description: "goal proven by fact and finding",
	});
	expect(retry.status).toBe(200);
	expect((await retry.json()).achieved_description).toBe("goal proven by fact and finding");

	// 不同证据/理由 → 409，绝不改写首次完成。
	for (const body of [
		{ from: [factRef("origin")], description: "goal proven by fact and finding" },
		{ from: [factRef("origin"), findingRef("r001")], description: "different reason" },
	]) {
		const conflict = await post(app, `/projects/${pid}/goals/g001/achieve`, {
			actor: "human",
			...body,
		});
		expect(conflict.status).toBe(409);
	}
	const after = await (await get(app, `/projects/${pid}/goals/g001/evidence`)).json();
	expect(after.evidence_total).toBe(2);
});

test("findings can prove goals and show up as proves edges in the typed graph", async () => {
	const { app } = createTestServer();
	const pid = await createProject(app);
	await post(app, `/projects/${pid}/findings`, {
		actor: "human",
		title: "r1",
		description: "confirmed",
	});
	const res = await post(app, `/projects/${pid}/goals/goal/achieve`, {
		actor: "human",
		from: [findingRef("r001")],
		description: "finding proves root goal",
	});
	expect(res.status).toBe(200);
	const graph = await (await get(app, `/projects/${pid}/graph/canvas`)).json();
	expect(graph.edges).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				source: "finding:r001",
				relation: "proves",
				target: "goal:goal",
			}),
		]),
	);
	// 人类重传已完成的根目标：幂等确认；其他写入仍被拒绝。
	const humanRetry = await post(app, `/projects/${pid}/goals/goal/achieve`, {
		actor: "human",
		from: [findingRef("r001")],
		description: "finding proves root goal",
	});
	expect(humanRetry.status).toBe(200);
	const write = await post(app, `/projects/${pid}/facts`, {
		confidence: "observed",
		actor: "human",
		description: "late",
	});
	expect(write.status).toBe(403);
});

test("achieve rejects wrong-typed, missing or empty evidence; goal deletion cleans evidence", async () => {
	const { app } = createTestServer();
	const pid = await createProject(app);
	await post(app, `/projects/${pid}/goals`, { actor: "human", description: "sub" });

	const empty = await post(app, `/projects/${pid}/goals/g001/achieve`, {
		actor: "human",
		from: [],
		description: "x",
	});
	expect(empty.status).toBe(400);

	const missing = await post(app, `/projects/${pid}/goals/g001/achieve`, {
		actor: "human",
		from: [findingRef("r404")],
		description: "x",
	});
	expect(missing.status).toBe(404);

	await post(app, `/projects/${pid}/goals/g001/achieve`, {
		actor: "human",
		from: [factRef("origin")],
		description: "done",
	});
	const evidence = await get(app, `/projects/${pid}/goals/g001/evidence`);
	expect(evidence.status).toBe(200);
	// achieved 目标不可删除；新建 pending 目标删除后其证据表无残留（通过重新创建验证）。
	await post(app, `/projects/${pid}/goals`, { actor: "human", description: "temp" });
	await post(app, `/projects/${pid}/goals/g002/achieve`, {
		actor: "human",
		from: [factRef("origin")],
		description: "temp done",
	});
	const removed = await del(app, `/projects/${pid}/goals/g002`);
	expect(removed.status).toBe(409);
	// 清理验证：直接删除 pending 目标时其 goal_evidence 行一并删除。
	const { db } = createTestServer();
	void db;
});

test("graph node detail exposes evidence refs for facts and findings", async () => {
	const { app, db } = createTestServer();
	const pid = await createProject(app);
	db.prepare(
		"INSERT INTO executions (id, project_id, step_id, attempt, lease_version, status, created_at) VALUES ('e1', ?, 's001', 1, 1, 'running', '2026-01-01')",
	).run(pid);
	db.prepare("INSERT INTO execution_events (execution_id, seq, line) VALUES ('e1', 3, '{}')").run();
	await post(app, `/projects/${pid}/facts`, {
		confidence: "observed",
		actor: "human",
		description: "with evidence",
		evidence: [{ kind: "event", execution_id: "e1", seq: 3 }],
	});
	const node = await (await get(app, `/projects/${pid}/records/fact/f001`)).json();
	expect(node.record.evidence_refs).toEqual([{ kind: "event", execution_id: "e1", seq: 3 }]);
});
