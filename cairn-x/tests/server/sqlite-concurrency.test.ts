import { expect, onTestFinished, test, vi } from "vitest";
import { openDatabase, type Db } from "../../src/server/db.js";
import {
	expireDecideLeases,
	expireWorkers,
	expireWorkersThrottled,
} from "../../src/server/core/lease-expiry.js";
import { createProject, createTestServer, post } from "./helpers.js";

/** Force a second connection to write after the expiry SELECT, before its UPDATE. */
function concurrentWriter(db: Db, other: Db, pid: string, query: string) {
	const prepare = db.prepare.bind(db);
	const attempted = vi.fn(() =>
		other.prepare("UPDATE projects SET title='concurrent writer' WHERE id=?").run(pid),
	);
	const blocked: string[] = [];
	const spy = vi.spyOn(db, "prepare").mockImplementation((sql) => {
		const statement = prepare(sql);
		if (sql.includes(query)) {
			const all = statement.all.bind(statement);
			vi.spyOn(statement, "all").mockImplementation((...args) => {
				const rows = all(...args);
				try {
					attempted();
				} catch (error) {
					if ((error as { code?: string }).code !== "SQLITE_BUSY") throw error;
					blocked.push("SQLITE_BUSY");
				}
				return rows;
			});
		}
		return statement;
	});
	onTestFinished(() => spy.mockRestore());
	return { attempted, blocked };
}

async function fixture() {
	const server = createTestServer();
	const pid = await createProject(server.app);
	const other = openDatabase(server.db.name);
	other.pragma("busy_timeout = 0");
	onTestFinished(() => {
		other.close();
	});
	return { ...server, other, pid };
}

test.each(["execution", "decide"] as const)(
	"%s lease expiry holds the writer lock before reading a WAL snapshot",
	async (kind) => {
		const { db, other, pid } = await fixture();
		if (kind === "decide")
			db.prepare(
				"UPDATE projects SET decide_worker='expired',decide_expires_at='2000-01-01T00:00:00Z' WHERE id=?",
			).run(pid);
		const writer = concurrentWriter(
			db,
			other,
			pid,
			kind === "execution" ? "SELECT id FROM executions" : "SELECT id, status, decide_worker",
		);
		expect(() =>
			kind === "execution" ? expireWorkers(db, pid) : expireDecideLeases(db, pid),
		).not.toThrow();
		expect(writer.attempted).toHaveBeenCalledOnce();
		expect(writer.blocked).toEqual(["SQLITE_BUSY"]);
		if (kind === "decide")
			expect(db.prepare("SELECT decide_worker FROM projects WHERE id=?").get(pid)).toEqual({
				decide_worker: null,
			});
		// Once expiry commits, the other writer can retry and commit normally.
		expect(() =>
			other.prepare("UPDATE projects SET title='retry' WHERE id=?").run(pid),
		).not.toThrow();
	},
);

test.each(["decide heartbeat", "step release", "project stop"] as const)(
	"%s also locks its outer transaction before nested expiry",
	async (action) => {
		const { app, db, other, pid } = await fixture();
		let url = `/projects/${pid}/status`;
		let body: Record<string, string> = { status: "stopped" };
		if (action === "decide heartbeat") {
			db.prepare(
				"UPDATE projects SET decide_worker='planner',decide_expires_at='2100-01-01T00:00:00Z' WHERE id=?",
			).run(pid);
			url = `/projects/${pid}/decide/heartbeat`;
			body = { worker: "planner" };
		} else if (action === "step release") {
			await post(app, `/projects/${pid}/steps`, {
				actor: "human",
				creator: "human",
				from: ["origin"],
				description: "test step",
			});
			await post(app, `/projects/${pid}/steps/s001/claim`, { worker: "executor" });
			url = `/projects/${pid}/steps/s001/release`;
			body = { worker: "executor" };
		}
		const writer = concurrentWriter(
			db,
			other,
			pid,
			action === "step release" ? "SELECT id FROM executions" : "SELECT id, status, decide_worker",
		);
		expect((await post(app, url, body)).status).toBe(200);
		expect(writer.attempted).toHaveBeenCalledOnce();
		expect(writer.blocked).toEqual(["SQLITE_BUSY"]);
	},
);

test("failed lease expiry is retried immediately rather than consuming the throttle window", async () => {
	const { app, db, other, pid } = await fixture();
	await post(app, `/projects/${pid}/steps`, {
		actor: "human",
		creator: "human",
		from: ["origin"],
		description: "expired step",
	});
	await post(app, `/projects/${pid}/steps/s001/claim`, { worker: "executor" });
	db.prepare("UPDATE steps SET lease_expires_at='2000-01-01T00:00:00Z' WHERE project_id=?").run(
		pid,
	);
	db.pragma("busy_timeout = 0");
	other
		.transaction(() => {
			expect(() => expireWorkersThrottled(db, pid)).toThrow("database is locked");
		})
		.immediate();
	expireWorkersThrottled(db, pid);
	expect(db.prepare("SELECT status,worker FROM steps WHERE project_id=?").get(pid)).toEqual({
		status: "open",
		worker: null,
	});
});
