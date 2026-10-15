import { expect, test } from "vitest";
import { stringify } from "yaml";

import { GRAPH_PAGE_MAX_CHARS } from "../../src/contracts/graph.js";
import { createBenchmarkBinding } from "../../src/tsecbench/store.js";
import { getCheckpoint } from "../../src/server/core/decide.js";
import { getDecideRead } from "../../src/server/core/decide-changes.js";
import {
	claimDecideForRead,
	createProject,
	createTestServer,
	post,
	readPlanningGraph,
} from "./helpers.js";

test("planning pages are bounded, gate writes, reject forged cursors and preserve late changes", async () => {
	const { app, db } = createTestServer();
	const pid = await createProject(app);
	const insert = db.prepare(
		"INSERT INTO facts (id,project_id,description,confidence,created_at) VALUES (?,?,?,'observed',?)",
	);
	const now = new Date().toISOString();
	for (let i = 1; i <= 240; i++)
		insert.run(`f${String(i).padStart(3, "0")}`, pid, `evidence-${i} ${"x".repeat(900)}`, now);
	expect((await post(app, `/projects/${pid}/decide/claim`, { worker: "reader" })).status).toBe(200);

	const firstResponse = await post(app, `/projects/${pid}/decide/graph`, {
		worker: "reader",
		view: "planning",
	});
	expect(firstResponse.status).toBe(200);
	const first = await firstResponse.json();
	expect(first.coverage.required_complete).toBe(false);
	expect(stringify(first).length).toBeLessThanOrEqual(GRAPH_PAGE_MAX_CHARS);
	expect(first.coverage.next_cursor).toMatch(/^[0-9a-f-]{36}$/);

	const gated = await post(app, `/projects/${pid}/steps`, {
		decide_worker: "reader",
		creator: "reader",
		from: ["origin"],
		description: "must wait for complete planning coverage",
	});
	expect(gated.status).toBe(409);
	expect((await gated.json()).detail).toContain(first.coverage.next_cursor);
	expect(
		(
			await post(app, `/projects/${pid}/decide/graph`, {
				worker: "reader",
				view: "planning",
				cursor: "forged",
			})
		).status,
	).toBe(409);

	// Arrives after snapshot creation and must remain unread by this planning run.
	insert.run("f999", pid, "late evidence", now);
	let cursor = first.coverage.next_cursor as string;
	let last = first;
	for (let page = 0; page < 100 && !last.coverage.required_complete; page++) {
		const response = await post(app, `/projects/${pid}/decide/graph`, {
			worker: "reader",
			view: "planning",
			cursor,
		});
		expect(response.status).toBe(200);
		last = await response.json();
		expect(stringify(last).length).toBeLessThanOrEqual(GRAPH_PAGE_MAX_CHARS);
		cursor = last.coverage.next_cursor;
	}
	expect(last.coverage.required_complete).toBe(true);
	// 水位不再进模型上下文，但仍是服务端记账：读完后只推进到 snapshot，
	// snapshot 之后到达的 f999 留给下一轮。
	expect(getDecideRead(db, pid, "reader")?.observed_seq).toBeLessThan(
		(db.prepare("SELECT MAX(seq) seq FROM decide_changes WHERE project_id=?").get(pid) as any).seq,
	);
	expect(
		(
			await post(app, `/projects/${pid}/decide/complete`, {
				worker: "reader",
				planning_version: 0,
			})
		).status,
	).toBe(200);
	expect(getCheckpoint(db, pid)?.unread_changes).toBe(1);
});

test("planning pagination does not skip changes when a frontier step concludes between pages", async () => {
	const { app, db } = createTestServer();
	const pid = await createProject(app);
	const step = await (
		await post(app, `/projects/${pid}/steps`, {
			actor: "human",
			creator: "human",
			from: ["origin"],
			description: "running while planning pages are read",
		})
	).json();
	expect(
		(await post(app, `/projects/${pid}/steps/${step.id}/claim`, { worker: "ex" })).status,
	).toBe(200);
	expect((await post(app, `/projects/${pid}/decide/signal`, { signal: "inspect" })).status).toBe(
		204,
	);
	const insert = db.prepare(
		"INSERT INTO facts (id,project_id,description,confidence,created_at) VALUES (?,?,?,'observed',?)",
	);
	const now = new Date().toISOString();
	for (let i = 1; i <= 240; i++)
		insert.run(`f${String(i).padStart(3, "0")}`, pid, `evidence-${i} ${"x".repeat(900)}`, now);
	expect((await post(app, `/projects/${pid}/decide/claim`, { worker: "reader" })).status).toBe(200);
	const first = await (
		await post(app, `/projects/${pid}/decide/graph`, { worker: "reader", view: "planning" })
	).json();
	expect(first.coverage.required_complete).toBe(false);
	expect(
		(
			await post(app, `/projects/${pid}/steps/${step.id}/conclude`, {
				worker: "ex",
				description: "done",
			})
		).status,
	).toBe(200);
	const pages = [first];
	for (let page = 0; page < 100 && !pages.at(-1)!.coverage.required_complete; page++) {
		const response = await post(app, `/projects/${pid}/decide/graph`, {
			worker: "reader",
			view: "planning",
			cursor: pages.at(-1)!.coverage.next_cursor,
		});
		expect(response.status).toBe(200);
		pages.push(await response.json());
	}
	expect(pages.at(-1)!.coverage.required_complete).toBe(true);
	const factIds = pages
		.flatMap((page) => page.changes)
		.filter((change: any) => change.kind === "fact")
		.map((change: any) => change.subject_id);
	// 还没有任何一轮 Decide 完成过，origin 同样是未读变更。
	expect(factIds).toEqual([
		"origin",
		...Array.from({ length: 240 }, (_, i) => `f${String(i + 1).padStart(3, "0")}`),
	]);
	expect(
		(
			await post(app, `/projects/${pid}/decide/complete`, {
				worker: "reader",
				planning_version: 0,
			})
		).status,
	).toBe(200);
});

test("planning frontier retains source facts and direct record reads avoid full export semantics", async () => {
	const { app, db } = createTestServer();
	const pid = await createProject(app);
	db.prepare(
		"INSERT INTO facts (id,project_id,description,confidence,created_at) VALUES ('f001',?,?,'observed',?)",
	).run(pid, `old but relevant ${"证据".repeat(40000)}`, new Date().toISOString());
	expect(
		(
			await post(app, `/projects/${pid}/steps`, {
				actor: "human",
				creator: "human",
				from: ["f001"],
				description: "validate the old evidence",
			})
		).status,
	).toBe(201);
	expect((await post(app, `/projects/${pid}/decide/signal`, { signal: "inspect" })).status).toBe(
		204,
	);
	expect((await post(app, `/projects/${pid}/decide/claim`, { worker: "reader" })).status).toBe(200);
	const pages = await readPlanningGraph(app, pid, "reader");
	const steps = pages.flatMap((page) => page.frontier.steps);
	// 来源事实要么作为未读变更带完整记录出现，要么出现在证据区；两处去重，只出现一次。
	const facts = [
		...pages.flatMap((page) => page.evidence.facts),
		...pages
			.flatMap((page) => page.changes)
			.filter((change: any) => change.kind === "fact" && change.record?.description)
			.map((change: any) => change.record),
	];
	expect(steps.find((step: any) => step.id === "s001")?.from).toEqual(["f001"]);
	expect(facts.map((fact: any) => fact.id)).toContain("f001");

	const first = await post(app, `/projects/${pid}/decide/graph`, {
		worker: "reader",
		view: "record",
		section: "facts",
		id: "f001",
	});
	expect(first.status).toBe(200);
	const fragment = await first.json();
	expect(fragment.record).toBeUndefined();
	expect(fragment.text.length).toBeGreaterThan(0);
	expect(fragment.next_offset).toBeGreaterThan(0);

	const changedRevision = fragment.revision;
	db.prepare("UPDATE facts SET description='changed' WHERE project_id=? AND id='f001'").run(pid);
	expect(
		(
			await post(app, `/projects/${pid}/decide/graph`, {
				worker: "reader",
				view: "record",
				section: "facts",
				id: "f001",
				offset: fragment.next_offset,
				revision: changedRevision,
			})
		).status,
	).toBe(409);
});

/** 超长记录必须能无损拼回，且分片受 60k 预算约束、不能跨项目越权读取。 */
test("record fragments reconstruct oversized unicode records and stay project scoped", async () => {
	const { app } = createTestServer();
	const pid = await createProject(app);
	const description = "proof 中文\u0000😀\n".repeat(1000);
	const created = await (
		await post(app, `/projects/${pid}/facts`, {
			confidence: "observed",
			actor: "human",
			description,
		})
	).json();
	await post(app, `/projects/${pid}/decide/claim`, { worker: "reader" });

	let offset = 0;
	let revision: string | undefined;
	let text = "";
	for (let page = 0; page < 500; page++) {
		const response = await post(app, `/projects/${pid}/decide/graph`, {
			worker: "reader",
			view: "record",
			section: "facts",
			id: created.id,
			...(offset === 0 ? {} : { offset, revision }),
		});
		expect(response.status).toBe(200);
		const body = await response.json();
		expect(stringify(body).length).toBeLessThanOrEqual(GRAPH_PAGE_MAX_CHARS);
		if (body.record !== undefined) {
			text = JSON.stringify(body.record);
			break;
		}
		text += body.text;
		revision = body.revision;
		if (body.next_offset === null) break;
		expect(body.next_offset).toBeGreaterThan(offset);
		offset = body.next_offset;
	}
	// 服务端会按输入 schema trim 描述，比较以写入后的响应为准。
	expect((JSON.parse(text) as { description: string }).description).toBe(created.description);

	// offset > 0 必须带 revision，否则拒绝而不是静默返回错位内容。
	expect(
		(
			await post(app, `/projects/${pid}/decide/graph`, {
				worker: "reader",
				view: "record",
				section: "facts",
				id: created.id,
				offset: 1,
			})
		).status,
	).toBe(400);
	// 记录按项目隔离：别的项目读同一个 id 是 404。
	const other = await createProject(app);
	await post(app, `/projects/${other}/decide/claim`, { worker: "reader" });
	expect(
		(
			await post(app, `/projects/${other}/decide/graph`, {
				worker: "reader",
				view: "record",
				section: "facts",
				id: created.id,
			})
		).status,
	).toBe(404);
});

/**
 * 并发/边界信号必须以结构化 step id 进入 changes，并带上当前投影。
 * 否则 Decide 只能看到 "step_completed:s001" 这条字符串，又要自己回图里找结果。
 */
test("step completion changes carry the bounded structured result", async () => {
	const { app, db } = createTestServer();
	const pid = await createProject(app);
	// 先收尾一轮规划，让后续的 Step 完成属于「本轮新增变化」。
	await post(app, `/projects/${pid}/decide/claim`, { worker: "w1" });
	await readPlanningGraph(app, pid, "w1");
	await post(app, `/projects/${pid}/decide/complete`, { worker: "w1", planning_version: 0 });
	await post(app, `/projects/${pid}/decide/release`, { worker: "w1" });

	expect(
		(
			await post(app, `/projects/${pid}/steps`, {
				actor: "human",
				creator: "human",
				from: ["origin"],
				description: "inspect the endpoint",
			})
		).status,
	).toBe(201);
	expect((await post(app, `/projects/${pid}/steps/s001/claim`, { worker: "ex" })).status).toBe(200);

	const now = new Date().toISOString();
	const unresolved = Array.from({ length: 10 }, (_, i) => `未决问题${i + 1}：${"u".repeat(400)}`);
	db.prepare(
		"INSERT INTO executions (id,project_id,step_id,attempt,lease_version,status,created_at) VALUES ('e001',?,'s001',1,1,'succeeded',?)",
	).run(pid, now);
	db.prepare(
		"INSERT INTO execution_results (execution_id,schema_version,payload,created_at) VALUES ('e001',1,?,?)",
	).run(
		JSON.stringify({
			schema_version: 1,
			task_status: "inconclusive",
			summary: "s".repeat(5000),
			unresolved,
			produced: { fact_ids: ["origin"], finding_ids: [] },
		}),
		now,
	);
	expect(
		(
			await post(app, `/projects/${pid}/steps/s001/conclude`, {
				worker: "ex",
				description: "done",
			})
		).status,
	).toBe(200);

	expect((await post(app, `/projects/${pid}/decide/claim`, { worker: "w2" })).status).toBe(200);
	const pages = await readPlanningGraph(app, pid, "w2");
	const change = pages
		.flatMap((page) => page.changes)
		.find((entry: any) => entry.kind === "signal" && entry.subject_id === "s001") as any;
	expect(change).toBeDefined();
	expect(change.record).toMatchObject({ id: "s001", status: "concluded" });
	expect(change.record.result.task_status).toBe("inconclusive");
	expect(change.record.result.produced).toEqual({ fact_ids: ["origin"], finding_ids: [] });
	// 有界载荷：summary 截断（并给出取全文的方式），unresolved 最多 8 条 + 计数。
	expect(change.record.result.summary).toContain('"view":"record"');
	expect(change.record.result.summary.length).toBeLessThan(500);
	expect(change.record.result.unresolved).toHaveLength(8);
	expect(change.record.result.omitted_unresolved).toBe(2);
	// 这里的 summary 是收尾接口写下的说明，与 result.summary 不同，必须保留；
	// result.schema_version 则不参与决策。
	expect(change.record.summary).toBe("done");
	expect(change.record.result.schema_version).toBeUndefined();
});

/** worker 收尾路径把 result.summary 直接写进 steps.summary：同一段正文只渲染一次。 */
test("a step summary identical to its result summary is rendered once", async () => {
	const { app, db } = createTestServer();
	const pid = await createProject(app);
	await claimDecideForRead(app, pid, "w1");
	await readPlanningGraph(app, pid, "w1");
	await post(app, `/projects/${pid}/decide/complete`, { worker: "w1", planning_version: 0 });
	await post(app, `/projects/${pid}/decide/release`, { worker: "w1" });

	const step = await (
		await post(app, `/projects/${pid}/steps`, {
			actor: "human",
			creator: "human",
			from: ["origin"],
			description: "worker-concluded step",
		})
	).json();
	const now = new Date().toISOString();
	const summary = "worker wrote this summary";
	db.prepare(
		"INSERT INTO executions (id,project_id,step_id,attempt,lease_version,status,created_at) VALUES ('e001',?,?,1,1,'succeeded',?)",
	).run(pid, step.id, now);
	db.prepare(
		"INSERT INTO execution_results (execution_id,schema_version,payload,created_at) VALUES ('e001',1,?,?)",
	).run(
		JSON.stringify({
			schema_version: 1,
			task_status: "satisfied",
			summary,
			unresolved: [],
			produced: { fact_ids: [], finding_ids: [] },
		}),
		now,
	);
	await post(app, `/projects/${pid}/steps/${step.id}/claim`, { worker: "ex" });
	await post(app, `/projects/${pid}/steps/${step.id}/conclude`, {
		worker: "ex",
		description: summary,
	});

	await claimDecideForRead(app, pid, "w2");
	const pages = await readPlanningGraph(app, pid, "w2");
	const change = pages
		.flatMap((page) => page.changes)
		.find((entry: any) => entry.kind === "signal" && entry.subject_id === step.id) as any;
	expect(change.record.result.summary).toBe(summary);
	expect(change.record.summary).toBeUndefined();
});

/**
 * 规划页只保留决策输入：字段必须能回答「这一步该怎么做」。
 * 结构性为空的字段（永远为空的 evidence.findings/hints、pending 目标不可能有的完成
 * 证据与达成描述、首个消息已给过的标题、覆盖全部页面的序号）都不进上下文。
 */
test("planning page projects only decision-relevant fields", async () => {
	const { app } = createTestServer();
	const pid = await createProject(app);
	await post(app, `/projects/${pid}/facts`, {
		actor: "human",
		description: "a fact",
		confidence: "observed",
	});
	await post(app, `/projects/${pid}/hints`, { creator: "human", content: "a hint" });
	await post(app, `/projects/${pid}/findings`, {
		actor: "human",
		title: "a finding",
		description: "finding details",
	});
	await post(app, `/projects/${pid}/steps`, {
		actor: "human",
		creator: "human",
		from: ["origin"],
		description: "a step",
	});
	await post(app, `/projects/${pid}/routes`, { actor: "human", description: "a route" });
	await claimDecideForRead(app, pid, "reader");

	const pages = await readPlanningGraph(app, pid, "reader");
	const page = pages.at(-1) as Record<string, any>;
	expect(Object.keys(page).sort()).toEqual([
		"changes",
		"coverage",
		"evidence",
		"frontier",
		"history",
		"project",
		"schema_version",
		"view",
	]);
	expect(Object.keys(page.coverage).sort()).toEqual(["next_cursor", "required_complete"]);
	expect(Object.keys(page.project).sort()).toEqual(["finding_schema", "goal", "origin", "status"]);
	expect(Object.keys(page.frontier.goals.find((goal: any) => goal.id === "goal")).sort()).toEqual([
		"description",
		"id",
		"parent_goal_id",
		"status",
	]);
	expect(Object.keys(page.evidence).sort()).toEqual(["facts"]);
	expect(Object.keys(page.changes[0] as object).sort()).toEqual([
		"detail",
		"kind",
		"operation",
		"record",
		"subject_id",
	]);
	// 没有 execution result 的步骤：没有可省的 result，也没有 null summary 占位。
	expect(Object.keys(page.frontier.steps[0] as object).sort()).toEqual([
		"attempts",
		"description",
		"from",
		"goal_id",
		"id",
		"last_error",
		"last_outcome",
		"priority",
		"route_id",
		"status",
		"waiting_on",
	]);
	// 历史索引只给 id（goal/step/route 另带 status）。
	for (const rows of Object.values(page.history) as Array<Array<Record<string, unknown>>>)
		for (const row of rows)
			expect(Object.keys(row).sort()).toEqual(row.status === undefined ? ["id"] : ["id", "status"]);
	// 没有截断就不带这个键：false 只是占字数，不是决策信息。
	expect(page.history_truncated).toBeUndefined();
});

/** 历史索引按分区封顶，完整索引永远可以用 view:"section" 翻出来。 */
test("planning history index is bounded to the newest rows per section", async () => {
	const { app, db } = createTestServer();
	const pid = await createProject(app);
	const insert = db.prepare(
		"INSERT INTO facts (id,project_id,description,confidence,created_at) VALUES (?,?,?,'observed',?)",
	);
	const now = new Date().toISOString();
	for (let i = 1; i <= 30; i++) insert.run(`f${String(i).padStart(3, "0")}`, pid, `fact ${i}`, now);
	// 第一轮把 30 条新事实作为变更读掉，第二轮它们才降级为历史。
	await post(app, `/projects/${pid}/decide/claim`, { worker: "w1" });
	await readPlanningGraph(app, pid, "w1");
	await post(app, `/projects/${pid}/decide/complete`, { worker: "w1", planning_version: 0 });
	await post(app, `/projects/${pid}/decide/release`, { worker: "w1" });
	await claimDecideForRead(app, pid, "w2");

	const pages = await readPlanningGraph(app, pid, "w2");
	const lastPage = pages.at(-1) as any;
	const ids = (lastPage.history.facts as Array<{ id: string }>).map((row) => row.id);
	expect(ids).toHaveLength(20);
	expect(ids).toContain("f030");
	expect(ids).not.toContain("f001");
	// 被截断时必须显式提示，否则模型不知道还有历史可翻。
	expect(lastPage.history_truncated).toBe(true);

	const section = await post(app, `/projects/${pid}/decide/graph`, {
		worker: "w2",
		view: "section",
		section: "facts",
	});
	const records = (await section.json()).records as Array<Record<string, unknown>>;
	expect(records.map((row) => row.id)).toContain("f001");
	expect(records.every((row) => Object.keys(row).join() === "id")).toBe(true);
});

/** 历史只留索引行；不静默丢内容——全文仍可精确取回。 */
test("closed-out history is index-only while full records stay retrievable", async () => {
	const { app, db } = createTestServer();
	const pid = await createProject(app);
	await post(app, `/projects/${pid}/decide/claim`, { worker: "w1" });
	await readPlanningGraph(app, pid, "w1");
	await post(app, `/projects/${pid}/decide/complete`, { worker: "w1", planning_version: 0 });
	await post(app, `/projects/${pid}/decide/release`, { worker: "w1" });

	await post(app, `/projects/${pid}/steps`, {
		actor: "human",
		creator: "human",
		from: ["origin"],
		description: `historical investigation ${"x".repeat(300)}`,
	});
	const now = new Date().toISOString();
	db.prepare(
		"INSERT INTO executions (id,project_id,step_id,attempt,lease_version,status,created_at) VALUES ('e001',?,'s001',1,1,'succeeded',?)",
	).run(pid, now);
	db.prepare(
		"INSERT INTO execution_results (execution_id,schema_version,payload,created_at) VALUES ('e001',1,?,?)",
	).run(
		JSON.stringify({
			schema_version: 1,
			task_status: "blocked",
			summary: "blocked on credentials",
			unresolved: ["A valid credential is required"],
			produced: { fact_ids: [], finding_ids: [] },
		}),
		now,
	);
	await post(app, `/projects/${pid}/steps/s001/claim`, { worker: "ex" });
	await post(app, `/projects/${pid}/steps/s001/conclude`, { worker: "ex", description: "done" });

	// 第二轮把这次完成读掉；第三轮它就不再是「新变化」，只能作为历史出现。
	await post(app, `/projects/${pid}/decide/claim`, { worker: "w2" });
	await readPlanningGraph(app, pid, "w2");
	await post(app, `/projects/${pid}/decide/complete`, { worker: "w2", planning_version: 1 });
	await post(app, `/projects/${pid}/decide/release`, { worker: "w2" });
	await claimDecideForRead(app, pid, "w3");
	const pages = await readPlanningGraph(app, pid, "w3");

	const historyStep = pages
		.flatMap((page) => page.history.steps ?? [])
		.find((step: any) => step.id === "s001") as any;
	// 历史索引只剩 id 与状态：正文（含 result / description）一律用 view:record 取。
	expect(historyStep).toEqual({ id: "s001", status: "concluded" });

	const record = await post(app, `/projects/${pid}/decide/graph`, {
		worker: "w3",
		view: "record",
		section: "steps",
		id: "s001",
	});
	expect(record.status).toBe(200);
	expect((await record.json()).record.result.unresolved).toEqual([
		"A valid credential is required",
	]);
});

/** Decide 没有 benchmark 工具，进度只能靠规划快照带出来；未绑定则完全不出现。 */
test("planning snapshot carries TSecBench progress and omits it when unbound", async () => {
	const { app, db } = createTestServer();
	const pid = await createProject(app);
	createBenchmarkBinding(db, {
		projectId: pid,
		uniqueCode: "b-01",
		title: "Web Login",
		flagCount: 3,
		containerStatus: "available",
		containerAddr: ["10.0.0.7:8080"],
	});
	db.prepare(
		"UPDATE benchmark_tasks SET correct_flag_count = 2, hint_used = 1 WHERE project_id = ?",
	).run(pid);

	await post(app, `/projects/${pid}/decide/claim`, { worker: "reader" });
	const bound = await readPlanningGraph(app, pid, "reader");
	const project = bound[0].project as { benchmark?: unknown };
	expect(project.benchmark).toEqual({
		unique_code: "b-01",
		correct_flag_count: 2,
		flag_count: 3,
		is_completed: false,
		container_status: "available",
		container_addr: ["10.0.0.7:8080"],
		hint_used: true,
	});

	const plain = await createProject(app);
	await post(app, `/projects/${plain}/decide/claim`, { worker: "reader" });
	const unbound = await readPlanningGraph(app, plain, "reader");
	expect((unbound[0].project as { benchmark?: unknown }).benchmark).toBeUndefined();
});

/** 变更行的 kind → 该记录的归属分区（与 planning-graph 的投影表同源）。 */
const CHANGE_SECTION: Record<string, string> = {
	fact: "facts",
	goal: "goals",
	finding: "findings",
	hint: "hints",
	signal: "steps",
};

/**
 * 页面内每条记录至多由一个承载区渲染正文。
 *
 * 返回 (分区: id) 的重复项：同一个 id 出现在两个承载区意味着同一份正文被计入
 * 两遍预算 —— 在 60k 页里就是实打实挤掉需要的内容。
 */
function duplicateCarriers(pages: any[]): string[] {
	const seen = new Set<string>();
	const duplicates = new Set<string>();
	const claim = (section: string, id: unknown) => {
		if (typeof id !== "string") return;
		const key = `${section}:${id}`;
		if (seen.has(key)) duplicates.add(key);
		seen.add(key);
	};
	for (const page of pages) {
		for (const goal of page.frontier?.goals ?? []) claim("goals", goal.id);
		for (const step of page.frontier?.steps ?? []) claim("steps", step.id);
		for (const route of page.frontier?.routes ?? []) claim("routes", route.id);
		for (const change of page.changes ?? []) {
			const record = change.record;
			// tombstone 与指针都不渲染正文，只有完整投影才占用承载区。
			if (!record || record.deleted === true || record.carried_by !== undefined) continue;
			claim(CHANGE_SECTION[change.kind] ?? "unknown", record.id);
		}
		for (const fact of page.evidence?.facts ?? []) claim("facts", fact.id);
		for (const finding of page.evidence?.findings ?? []) claim("findings", finding.id);
		for (const hint of page.evidence?.hints ?? []) claim("hints", hint.id);
		for (const [section, rows] of Object.entries(page.history ?? {}))
			for (const row of rows as Array<{ id: string }>) claim(section, row.id);
	}
	return [...duplicates];
}

test("a record never renders its body in two carriers on the same page", async () => {
	const { app } = createTestServer();
	const pid = await createProject(app);
	// 第一次规划页：项目创建写入的根目标变更，与 frontier 的 pending goal 是同一
	// 条记录（此前必现重复）。
	await post(app, `/projects/${pid}/decide/claim`, { worker: "w0" });
	const firstPage = await readPlanningGraph(app, pid, "w0");
	const goalChange = (firstPage[0].changes as Array<{ kind: string; record: unknown }>).find(
		(change) => change.kind === "goal",
	)!;
	expect(goalChange.record).toEqual({ id: "goal", carried_by: "frontier" });
	await post(app, `/projects/${pid}/decide/complete`, { worker: "w0", planning_version: 0 });
	await post(app, `/projects/${pid}/decide/release`, { worker: "w0" });

	// 新事实 + 引用它的活跃步骤：事实既是「待处理变更」，又落在 evidence 的引用闭包里。
	await post(app, `/projects/${pid}/facts`, {
		actor: "human",
		description: "fresh fact that an active step depends on",
		confidence: "observed",
	});
	await post(app, `/projects/${pid}/steps`, {
		actor: "human",
		creator: "human",
		from: ["origin", "f001"],
		description: "consume the fresh fact",
	});
	await claimDecideForRead(app, pid, "w1");
	const withOpenStep = await readPlanningGraph(app, pid, "w1");

	await post(app, `/projects/${pid}/decide/complete`, { worker: "w1", planning_version: 1 });
	await post(app, `/projects/${pid}/decide/release`, { worker: "w1" });

	// 步骤完成信号：subject 是 step id，既进 changes（完整投影）又可能重复进 history 索引。
	await post(app, `/projects/${pid}/steps/s001/claim`, { worker: "ex" });
	await post(app, `/projects/${pid}/steps/s001/conclude`, { worker: "ex", description: "done" });
	await claimDecideForRead(app, pid, "w2");
	const afterSignal = await readPlanningGraph(app, pid, "w2");
	expect({
		// 根目标同时是 pending goal 与 goal 变更。
		firstPage: duplicateCarriers(firstPage),
		// 新事实同时被活跃步骤引用：changes 与 evidence 各渲染一份。
		openStep: duplicateCarriers(withOpenStep),
		// 步骤完成信号：changes 的完整投影与 history 索引行重复。
		afterSignal: duplicateCarriers(afterSignal),
	}).toEqual({ firstPage: [], openStep: [], afterSignal: [] });

	// project.origin 已经承载 origin 事实的正文（且比 evidence 的 500 字上限更长），
	// 活跃步骤 from 里的 origin 与历史索引都不再重复渲染它。
	for (const page of [...firstPage, ...withOpenStep, ...afterSignal] as any[]) {
		expect(page.evidence.facts.map((fact: { id: string }) => fact.id)).not.toContain("origin");
		expect((page.history.facts ?? []).map((fact: { id: string }) => fact.id)).not.toContain(
			"origin",
		);
	}
});

/**
 * 规划器要判断「再试一次还是换路」，需要两样由控制端算出、不在执行者自述里的
 * 信息：这次为什么失败（确定性归类），以及已经花了多少。两者都物化/聚合后随
 * 前沿一起返回，Decide 不必自己去翻轨迹或用量。
 */
test("planning frontier carries the failure classification and step cost", async () => {
	const { app, db } = createTestServer();
	const pid = await createProject(app);
	const step = await (
		await post(app, `/projects/${pid}/steps`, {
			actor: "human",
			from: ["origin"],
			description: "probe the import endpoint",
			creator: "human",
		})
	).json();

	const iso = (offsetSeconds: number) => new Date(Date.now() + offsetSeconds * 1000).toISOString();
	db.prepare(
		"INSERT INTO executions " +
			"(id, project_id, step_id, attempt, lease_version, status, created_at, started_at, finished_at, error, dropped_events) " +
			"VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
	).run(
		"exec-fail",
		pid,
		step.id,
		1,
		0,
		"failed",
		iso(-120),
		iso(-120),
		iso(-60),
		"worker reported failure",
		0,
	);
	// 事件流显示模型调用了一个不存在的工具：类比 tool_selection，而不是环境故障。
	const insertEvent = db.prepare(
		"INSERT INTO execution_events (execution_id, seq, line) VALUES (?, ?, ?)",
	);
	insertEvent.run(
		"exec-fail",
		1,
		JSON.stringify({
			type: "message",
			id: "e1",
			parentId: null,
			timestamp: iso(-119),
			message: {
				role: "assistant",
				content: [{ type: "toolCall", id: "c1", name: "nmap", arguments: {} }],
				usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 },
				stopReason: "toolUse",
			},
		}),
	);
	insertEvent.run(
		"exec-fail",
		2,
		JSON.stringify({
			type: "message",
			id: "e2",
			parentId: "e1",
			timestamp: iso(-118),
			message: {
				role: "toolResult",
				toolCallId: "c1",
				toolName: "nmap",
				isError: true,
				content: [{ type: "text", text: "unknown tool: nmap" }],
			},
		}),
	);
	db.prepare(
		"INSERT INTO usage_events " +
			"(project_id, activity, step_id, execution_id, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, created_at) " +
			"VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
	).run(pid, "execute", step.id, "exec-fail", "qwen", 1000, 200, 30, 0, iso(-60));

	await claimDecideForRead(app, pid, "reader");
	const pages = (await readPlanningGraph(app, pid, "reader")) as any[];
	const projected = pages
		.flatMap((page) => page.frontier.steps)
		.find((entry: { id: string }) => entry.id === step.id);
	expect(projected).toBeDefined();
	expect(projected.failure_class).toBe("tool_selection");
	expect(projected.failure_component).toBe("tool:nmap");
	expect(projected.cost).toEqual({
		executions: 1,
		input_tokens: 1000,
		output_tokens: 200,
		cache_read_tokens: 30,
		cache_write_tokens: 0,
	});

	// 归类物化在 executions 上：第二次读取直接命中列，不再重扫事件流。
	expect(
		db
			.prepare("SELECT failure_class, failure_component FROM executions WHERE id = 'exec-fail'")
			.get(),
	).toEqual({ failure_class: "tool_selection", failure_component: "tool:nmap" });
});
