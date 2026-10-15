import { expect, test, vi } from "vitest";
import type { Db } from "../../src/server/db.js";
import { createApp } from "../../src/server/app.js";
import { schedulingCandidates } from "../../src/server/core/scheduling.js";
import { signalDecideExternal } from "../../src/server/core/decide.js";
import { createTestServer, createProject, get, post } from "./helpers.js";

const at = "2026-09-01T00:00:00.000Z";
function step(
	db: Db,
	pid: string,
	id: string,
	status = "open",
	dependencies: string[] = [],
	priority = 0,
	createdAt = at,
) {
	db.prepare(
		"INSERT INTO steps(id,project_id,description,creator,status,waiting_on,priority,created_at,worker) VALUES(?,?,'private long body','human',?,?,?,?,?)",
	).run(
		id,
		pid,
		status,
		JSON.stringify(dependencies),
		priority,
		createdAt,
		status === "claimed" ? "other" : null,
	);
}
const base = (pid: string) => `/internal/scheduling/projects/${pid}`;

test("scheduling views expose only authority fields and keep inactive project membership", async () => {
	const { db, app } = createTestServer();
	const pid = await createProject(app, {
		title: "private title",
		finding_schema: { secret: "schema" },
	});
	const stopped = await createProject(app);
	db.prepare("UPDATE projects SET status='stopped' WHERE id=?").run(stopped);
	db.transaction(() => {
		for (let i = 0; i < 1000; i++) {
			db.prepare("INSERT INTO facts(id,project_id,description,created_at) VALUES(?,?,?,?)").run(
				`f${i}`,
				pid,
				"material ".repeat(500),
				at,
			);
			step(db, pid, `s${i}`, "concluded");
		}
		step(db, pid, "ready");
		step(db, pid, "busy", "claimed");
	})();
	const response = await get(app, "/internal/scheduling/projects");
	expect(response.headers.get("cache-control")).toBe("no-store");
	const list = await response.json();
	expect(list).toContainEqual({
		id: pid,
		status: "active",
		decide_worker: null,
		has_open_steps: true,
		has_claimed_steps: true,
	});
	expect(list).toContainEqual({
		id: stopped,
		status: "stopped",
		decide_worker: null,
		has_open_steps: false,
		has_claimed_steps: false,
	});
	expect(JSON.stringify(list).length).toBeLessThan(350);
	expect(await (await get(app, `${base(pid)}/state`)).json()).toEqual({
		id: pid,
		status: "active",
	});
	const view = await (await get(app, `${base(pid)}/candidates`)).json();
	expect(view).toEqual({
		project: { id: pid, status: "active" },
		blocked_reason: null,
		candidates: [{ id: "ready", priority: 0, created_at: at }],
	});
});

test("SQL selection matches legacy JS eligibility and ordering with scoped IDs and exclusions", async () => {
	const { db, app } = createTestServer();
	const pid = await createProject(app);
	const other = await createProject(app);
	let seed = 9173;
	const random = () => {
		seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
		return seed / 2 ** 32;
	};
	const rows: Array<{
		id: string;
		status: string;
		worker: string | null;
		waiting_on: string[];
		priority: number;
		created_at: string;
	}> = [];
	db.transaction(() => {
		step(db, other, "missing", "concluded");
		for (let i = 0; i < 160; i++) {
			const id = `s${i}`;
			const status = ["open", "claimed", "concluded", "abandoned"][Math.floor(random() * 4)]!;
			const waiting_on =
				i > 0 && random() < 0.5
					? [random() < 0.3 ? "missing" : `s${Math.floor(random() * i)}`]
					: [];
			const priority = Math.floor(random() * 5);
			const created_at = new Date(Date.parse(at) + Math.floor(random() * 3) * 1000).toISOString();
			step(db, pid, id, status, waiting_on, priority, created_at);
			rows.push({
				id,
				status,
				worker: status === "claimed" ? "other" : null,
				waiting_on,
				priority,
				created_at,
			});
		}
		step(db, pid, "cross-project", "open", ["missing"], 99);
	})();
	const concluded = new Set(rows.filter((r) => r.status === "concluded").map((r) => r.id));
	for (let round = 0; round < 20; round++) {
		const exclude = rows.filter(() => random() < 0.2).map((r) => r.id);
		const expected = rows
			.filter(
				(r) =>
					r.status === "open" &&
					r.worker === null &&
					!exclude.includes(r.id) &&
					r.waiting_on.every((id) => concluded.has(id)),
			)
			.sort(
				(a, b) =>
					b.priority - a.priority ||
					b.created_at.localeCompare(a.created_at) ||
					b.id.localeCompare(a.id),
			)
			.slice(0, 20)
			.map(({ id, priority, created_at }) => ({ id, priority, created_at }));
		expect(schedulingCandidates(db, pid, 20, exclude).candidates).toEqual(expected);
	}
	const top = schedulingCandidates(db, pid).candidates[0]!;
	const excluded = await (await get(app, `${base(pid)}/candidates?exclude=${top.id}`)).json();
	expect(excluded.candidates[0]?.id).not.toBe(top.id);
	const original = db.prepare.bind(db);
	let query = "";
	const spy = vi.spyOn(db, "prepare").mockImplementation((sql) => {
		if (sql.includes("SELECT s.id,s.priority,s.created_at")) query = sql;
		return original(sql);
	});
	schedulingCandidates(db, pid);
	spy.mockRestore();
	const plan = JSON.stringify(db.prepare(`EXPLAIN QUERY PLAN ${query}`).all(pid, "[]", 1));
	expect(plan).toContain("idx_steps_dispatchable");
	expect(plan).not.toContain("USE TEMP B-TREE");
});

test("machine-only scheduling routes reject browser cookies and unrelated Bearer tokens", async () => {
	const { db, app } = createTestServer();
	const pid = await createProject(app);
	const secured = createApp(db, { user: "admin", password: "test", apiToken: "machine-secret" });
	const login = await secured.request("/login", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ username: "admin", password: "test" }),
	});
	const cookie = login.headers.get("set-cookie")!.match(/cairn_session=[^;]+/)![0];
	for (const path of [
		"/internal/scheduling/projects",
		`${base(pid)}/state`,
		`${base(pid)}/candidates`,
	]) {
		for (const headers of [{}, { cookie }, { authorization: "Bearer worker-token" }])
			expect((await secured.request(path, { headers })).status).toBe(401);
		expect(
			(await secured.request(path, { headers: { authorization: "Bearer machine-secret" } })).status,
		).toBe(200);
	}
});

test("candidate arguments are bounded and missing projects return 404", async () => {
	const { app } = createTestServer();
	const pid = await createProject(app);
	for (const query of [
		"limit=0",
		"limit=21",
		"limit=1.5",
		"limit=-1",
		"limit=no",
		"exclude=",
		new URLSearchParams(Array.from({ length: 129 }, () => ["exclude", "s1"])).toString(),
	])
		expect((await get(app, `${base(pid)}/candidates?${query}`)).status).toBe(400);
	expect((await get(app, `${base(pid)}/candidates?limit=20`)).status).toBe(200);
	for (const view of ["state", "candidates"])
		expect((await get(app, `${base("missing")}/${view}`)).status).toBe(404);
});

test.each([
	"stop",
	"dependency_abandoned",
	"dependency_deleted",
	"decide",
	"barrier",
	"other_claim",
])("claim rechecks authority after candidate read: %s", async (change) => {
	const { app, db } = createTestServer();
	const pid = await createProject(app);
	step(db, pid, "dep", "concluded");
	step(db, pid, "ready", "open", ["dep"]);
	expect((await (await get(app, `${base(pid)}/candidates`)).json()).candidates[0].id).toBe("ready");
	if (change === "stop") db.prepare("UPDATE projects SET status='stopped' WHERE id=?").run(pid);
	if (change === "dependency_abandoned")
		db.prepare("UPDATE steps SET status='abandoned' WHERE project_id=? AND id='dep'").run(pid);
	if (change === "dependency_deleted")
		db.prepare("DELETE FROM steps WHERE project_id=? AND id='dep'").run(pid);
	if (change === "decide")
		db.prepare(
			"UPDATE projects SET decide_worker='planner',decide_expires_at='2999-01-01T00:00:00Z' WHERE id=?",
		).run(pid);
	if (change === "barrier") signalDecideExternal(db, pid, "step_completed:dep");
	if (change === "other_claim")
		expect(
			(await post(app, `/projects/${pid}/steps/ready/claim`, { worker: "other" })).status,
		).toBe(200);
	expect((await post(app, `/projects/${pid}/steps/ready/claim`, { worker: "ours" })).status).toBe(
		change === "stop" ? 403 : 409,
	);
	const current = await (await get(app, `${base(pid)}/candidates`)).json();
	if (change === "stop") expect(current.blocked_reason).toBe("inactive");
	if (change === "decide") expect(current.blocked_reason).toBe("decide_running");
	if (change === "barrier") expect(current.blocked_reason).toBe("pending_step_result");
	expect(current.candidates).toEqual([]);
});

test("same-worker claim renewal preserves lease version despite later dependency and planning changes", async () => {
	const { app, db } = createTestServer();
	const pid = await createProject(app);
	step(db, pid, "dep", "concluded");
	step(db, pid, "ready", "open", ["dep"]);
	const first = await (
		await post(app, `/projects/${pid}/steps/ready/claim`, { worker: "ours" })
	).json();
	db.prepare("UPDATE steps SET status='open' WHERE project_id=? AND id='dep'").run(pid);
	signalDecideExternal(db, pid, "step_completed:dep");
	db.prepare(
		"UPDATE projects SET decide_worker='planner',decide_expires_at='2999-01-01T00:00:00Z' WHERE id=?",
	).run(pid);
	const again = await post(app, `/projects/${pid}/steps/ready/claim`, { worker: "ours" });
	expect(again.status).toBe(200);
	expect((await again.json()).lease_version).toBe(first.lease_version);
});

test("expiry is committed even when a subsequent claim is rejected by the planning barrier", async () => {
	const { app, db } = createTestServer();
	const pid = await createProject(app);
	step(db, pid, "expired", "claimed");
	step(db, pid, "ready");
	db.prepare(
		"UPDATE steps SET last_heartbeat_at='2000-01-01T00:00:00Z' WHERE project_id=? AND id='expired'",
	).run(pid);
	db.prepare(
		"UPDATE projects SET decide_worker='expired-planner',decide_last_heartbeat_at='2000-01-01T00:00:00Z' WHERE id=?",
	).run(pid);
	expect((await post(app, `/projects/${pid}/steps/ready/claim`, { worker: "ours" })).status).toBe(
		409,
	);
	expect(
		db
			.prepare("SELECT status,worker,lease_version FROM steps WHERE project_id=? AND id='expired'")
			.get(pid),
	).toEqual({ status: "open", worker: null, lease_version: 1 });
	expect(db.prepare("SELECT decide_worker FROM projects WHERE id=?").get(pid)).toEqual({
		decide_worker: null,
	});
	expect(
		db.prepare("SELECT external_signal FROM decide_checkpoints WHERE project_id=?").get(pid),
	).toEqual({ external_signal: "decide_interrupted" });
	const view = await (await get(app, `${base(pid)}/candidates`)).json();
	expect(view.blocked_reason).toBe("pending_step_result");
});
