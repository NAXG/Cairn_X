import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import type { BenchmarkConfig } from "../../src/scheduler/config.js";
import { openDatabase, type Db } from "../../src/server/db.js";
import type { BenchmarkPlatformClient } from "../../src/tsecbench/client.js";
import { createBenchmarkService } from "../../src/tsecbench/service.js";
import { getBenchmarkBinding } from "../../src/tsecbench/store.js";
import type {
	BenchmarkError,
	BenchmarkResult,
	Challenge,
	CloseChallengeResult,
	HintResult,
	StartChallengeResult,
	SubmitFlagResult,
} from "../../src/tsecbench/types.js";

function makeDb(): Db {
	const dir = mkdtempSync(path.join(tmpdir(), "cairn-bench-"));
	const db = openDatabase(path.join(dir, "cairn.db"));
	return db;
}

function insertProject(db: Db, id: string): void {
	db.prepare("INSERT INTO projects (id, title, status, created_at) VALUES (?, ?, 'active', ?)").run(
		id,
		`project ${id}`,
		new Date().toISOString(),
	);
}

const baseConfig: BenchmarkConfig = {
	base_url: "https://tsecbench.example.com",
	token: "test-token",
	max_active: 3,
	auto_start: true,
	auto_close: true,
	challenge_timeout: 7200,
};

function challenge(overrides: Partial<Challenge> = {}): Challenge {
	return {
		unique_code: "web_01",
		description: "SQL injection",
		difficulty: "easy",
		level: 1,
		total_score: 100,
		flag_count: 2,
		correct_flag_count: 0,
		is_completed: false,
		container_status: "stopped",
		container_addr: [],
		...overrides,
	};
}

/** 可脚本化的平台假实现，状态在自身 challenges 数组里演进。 */
class FakePlatform implements BenchmarkPlatformClient {
	challenges: Challenge[] = [challenge()];
	started: string[] = [];
	closed: string[] = [];
	hintText: string | null = "look at the username field";
	nextSubmit: BenchmarkResult<SubmitFlagResult> | null = null;
	submitError: { code: BenchmarkError["code"]; message: string } | null = null;

	private find(code: string): Challenge | undefined {
		return this.challenges.find((c) => c.unique_code === code);
	}

	async listChallenges(): Promise<BenchmarkResult<Challenge[]>> {
		return { ok: true, data: this.challenges.map((c) => ({ ...c })) };
	}

	async startChallenge(code: string): Promise<BenchmarkResult<StartChallengeResult>> {
		const target = this.find(code);
		if (target === undefined) {
			return { ok: false, error: { code: "challenge_not_found", message: "no", status: 404 } };
		}
		this.started.push(code);
		target.container_status = "available";
		target.container_addr = ["10.0.1.5:8080"];
		return { ok: true, data: { unique_code: code, container_addr: target.container_addr } };
	}

	async getHint(code: string): Promise<BenchmarkResult<HintResult>> {
		const target = this.find(code);
		if (target === undefined) {
			return { ok: false, error: { code: "challenge_not_found", message: "no", status: 404 } };
		}
		if (target.is_completed) {
			return { ok: false, error: { code: "invalid_state", message: "done", status: 409 } };
		}
		return { ok: true, data: { unique_code: code, hint: this.hintText } };
	}

	async submitFlag(code: string, _flag: string): Promise<BenchmarkResult<SubmitFlagResult>> {
		if (this.submitError !== null) {
			return { ok: false, error: { ...this.submitError, status: 409 } };
		}
		if (this.nextSubmit !== null) {
			const result = this.nextSubmit;
			this.nextSubmit = null;
			if (result.ok) {
				const target = this.find(code);
				if (target !== undefined) {
					target.correct_flag_count = result.data.correct_flag_count;
					target.is_completed = result.data.correct_flag_count >= target.flag_count;
				}
			}
			return result;
		}
		return {
			ok: true,
			data: {
				correct: false,
				awarded: 0,
				cumulative_score: 0,
				correct_flag_count: 0,
				total_flag_count: 2,
				matched_flag_index: null,
			},
		};
	}

	async closeChallenge(code: string): Promise<BenchmarkResult<CloseChallengeResult>> {
		const target = this.find(code);
		this.closed.push(code);
		if (target !== undefined) {
			target.container_status = "stopped";
			target.container_addr = [];
		}
		return { ok: true, data: { unique_code: code, closed: true } };
	}
}

function accept(n: number, total: number): BenchmarkResult<SubmitFlagResult> {
	return {
		ok: true,
		data: {
			correct: true,
			awarded: 50,
			cumulative_score: n * 50,
			correct_flag_count: n,
			total_flag_count: total,
			matched_flag_index: n - 1,
		},
	};
}

describe("benchmark service", () => {
	it("releases a failed start binding so the challenge can be retried", async () => {
		const db = makeDb();
		insertProject(db, "p1");
		insertProject(db, "p2");
		const platform = new FakePlatform();
		const start = platform.startChallenge.bind(platform);
		platform.startChallenge = async () => ({
			ok: false,
			error: { code: "invalid_state", message: "capacity", status: 409 },
		});
		const service = createBenchmarkService({ client: platform, config: baseConfig, db });
		expect((await service.bind({ projectId: "p1", uniqueCode: "web_01" })).ok).toBe(false);
		expect(service.listTasks()).toEqual([]);
		platform.startChallenge = start;
		expect((await service.bind({ projectId: "p2", uniqueCode: "web_01" })).ok).toBe(true);
		db.close();
	});
	it("binds a project, starts the container and records the target address", async () => {
		const db = makeDb();
		insertProject(db, "p1");
		const platform = new FakePlatform();
		const service = createBenchmarkService({ client: platform, config: baseConfig, db });

		const result = await service.bind({ projectId: "p1", uniqueCode: "web_01" });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.data.project_id).toBe("p1");
		expect(result.data.title).toBe("[web_01]");
		expect(result.data.description).toBe("SQL injection");
		expect(result.data.flag_count).toBe(2);
		expect(result.data.container_status).toBe("available");
		expect(result.data.container_addr).toEqual(["10.0.1.5:8080"]);
		expect(platform.started).toEqual(["web_01"]);
		db.close();
	});

	it("rejects a second binding and unknown challenges", async () => {
		const db = makeDb();
		insertProject(db, "p1");
		insertProject(db, "p2");
		const platform = new FakePlatform();
		const service = createBenchmarkService({ client: platform, config: baseConfig, db });
		await service.bind({ projectId: "p1", uniqueCode: "web_01" });

		const again = await service.bind({ projectId: "p1", uniqueCode: "web_01" });
		expect(again.ok).toBe(false);
		if (!again.ok) expect(again.error.code).toBe("already_bound");

		const unknown = await service.bind({ projectId: "p2", uniqueCode: "nope" });
		expect(unknown.ok).toBe(false);
		if (!unknown.ok) expect(unknown.error.code).toBe("challenge_not_found");
		db.close();
	});

	it("does not start the container when auto_start is disabled", async () => {
		const db = makeDb();
		insertProject(db, "p1");
		const platform = new FakePlatform();
		const service = createBenchmarkService({
			client: platform,
			config: { ...baseConfig, auto_start: false },
			db,
		});
		const result = await service.bind({ projectId: "p1", uniqueCode: "web_01" });
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.data.container_status).toBe("stopped");
		expect(platform.started).toEqual([]);
		db.close();
	});

	it("advances progress on submit and marks the challenge completed", async () => {
		const db = makeDb();
		insertProject(db, "p1");
		const platform = new FakePlatform();
		const service = createBenchmarkService({ client: platform, config: baseConfig, db });
		await service.bind({ projectId: "p1", uniqueCode: "web_01" });

		platform.nextSubmit = accept(1, 2);
		const first = await service.submit("p1", "flag{a}");
		expect(first.ok).toBe(true);
		expect(getBenchmarkBinding(db, "p1")?.correct_flag_count).toBe(1);
		expect(getBenchmarkBinding(db, "p1")?.is_completed).toBe(false);

		platform.nextSubmit = accept(2, 2);
		const second = await service.submit("p1", "flag{b}");
		expect(second.ok).toBe(true);
		expect(getBenchmarkBinding(db, "p1")?.is_completed).toBe(true);

		const third = await service.submit("p1", "flag{c}");
		expect(third.ok).toBe(false);
		if (!third.ok) expect(third.error.code).toBe("already_completed");
		db.close();
	});

	it("serializes concurrent flag submissions for the same project", async () => {
		const db = makeDb();
		insertProject(db, "p1");
		const platform = new FakePlatform();
		const service = createBenchmarkService({ client: platform, config: baseConfig, db });
		await service.bind({ projectId: "p1", uniqueCode: "web_01" });

		let calls = 0;
		let inFlight = 0;
		let maxInFlight = 0;
		let releaseFirst!: () => void;
		const firstBlocked = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		let firstEntered!: () => void;
		const firstStarted = new Promise<void>((resolve) => {
			firstEntered = resolve;
		});
		platform.submitFlag = async () => {
			calls += 1;
			const call = calls;
			inFlight += 1;
			maxInFlight = Math.max(maxInFlight, inFlight);
			if (call === 1) {
				firstEntered();
				await firstBlocked;
			}
			inFlight -= 1;
			platform.challenges[0]!.correct_flag_count = call;
			platform.challenges[0]!.is_completed = call >= 2;
			return accept(call, 2);
		};

		const first = service.submit("p1", "flag{a}");
		await firstStarted;
		const second = service.submit("p1", "flag{b}");
		await Promise.resolve();
		expect(calls).toBe(1);

		releaseFirst();
		const results = await Promise.all([first, second]);
		expect(results.every((result) => result.ok)).toBe(true);
		expect(calls).toBe(2);
		expect(maxInFlight).toBe(1);
		expect(getBenchmarkBinding(db, "p1")?.correct_flag_count).toBe(2);
		expect(getBenchmarkBinding(db, "p1")?.is_completed).toBe(true);
		db.close();
	});

	it("allows submissions for different projects to run concurrently", async () => {
		const db = makeDb();
		insertProject(db, "p1");
		insertProject(db, "p2");
		const platform = new FakePlatform();
		platform.challenges.push(challenge({ unique_code: "web_02" }));
		const service = createBenchmarkService({ client: platform, config: baseConfig, db });
		await service.bind({ projectId: "p1", uniqueCode: "web_01" });
		await service.bind({ projectId: "p2", uniqueCode: "web_02" });

		let inFlight = 0;
		let maxInFlight = 0;
		let entered = 0;
		let bothEntered!: () => void;
		const bothStarted = new Promise<void>((resolve) => {
			bothEntered = resolve;
		});
		let release!: () => void;
		const blocked = new Promise<void>((resolve) => {
			release = resolve;
		});
		platform.submitFlag = async () => {
			inFlight += 1;
			maxInFlight = Math.max(maxInFlight, inFlight);
			entered += 1;
			if (entered === 2) bothEntered();
			await blocked;
			inFlight -= 1;
			return accept(1, 2);
		};

		const first = service.submit("p1", "flag{a}");
		const second = service.submit("p2", "flag{b}");
		await bothStarted;
		expect(maxInFlight).toBe(2);
		release();
		await Promise.all([first, second]);
		db.close();
	});

	it("surfaces duplicate submissions as a business error", async () => {
		const db = makeDb();
		insertProject(db, "p1");
		const platform = new FakePlatform();
		const service = createBenchmarkService({ client: platform, config: baseConfig, db });
		await service.bind({ projectId: "p1", uniqueCode: "web_01" });
		platform.submitError = { code: "duplicate", message: "already submitted" };
		const result = await service.submit("p1", "flag{a}");
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("duplicate");
		db.close();
	});

	it("marks hints as used and refuses hints on completed challenges", async () => {
		const db = makeDb();
		insertProject(db, "p1");
		const platform = new FakePlatform();
		const service = createBenchmarkService({ client: platform, config: baseConfig, db });
		await service.bind({ projectId: "p1", uniqueCode: "web_01" });

		const hint = await service.hint("p1");
		expect(hint.ok).toBe(true);
		if (hint.ok) expect(hint.data).toBe("look at the username field");
		expect(getBenchmarkBinding(db, "p1")?.hint_used).toBe(true);

		platform.nextSubmit = accept(2, 2);
		await service.submit("p1", "flag{a}");
		await service.submit("p1", "flag{b}");
		const blocked = await service.hint("p1");
		expect(blocked.ok).toBe(false);
		if (!blocked.ok) expect(blocked.error.code).toBe("already_completed");
		db.close();
	});

	it("refreshes container state and closes the challenge", async () => {
		const db = makeDb();
		insertProject(db, "p1");
		const platform = new FakePlatform();
		const service = createBenchmarkService({ client: platform, config: baseConfig, db });
		await service.bind({ projectId: "p1", uniqueCode: "web_01" });

		platform.challenges[0]!.container_status = "stopped";
		platform.challenges[0]!.container_addr = [];
		const status = await service.status("p1");
		expect(status.ok).toBe(true);
		if (status.ok) expect(status.data.container_status).toBe("stopped");

		const closed = await service.close("p1");
		expect(closed.ok).toBe(true);
		if (closed.ok) {
			expect(closed.data.closed_at).not.toBeNull();
			expect(closed.data.container_status).toBe("stopped");
		}
		db.close();
	});

	it("reset drops the binding so the same challenge can be rebound", async () => {
		const db = makeDb();
		insertProject(db, "p1");
		insertProject(db, "p2");
		const platform = new FakePlatform();
		const service = createBenchmarkService({ client: platform, config: baseConfig, db });
		await service.bind({ projectId: "p1", uniqueCode: "web_01" });

		const reset = service.reset("p1");
		expect(reset.ok).toBe(true);
		if (reset.ok) expect(reset.data.deleted).toBe(true);
		expect(getBenchmarkBinding(db, "p1")).toBeUndefined();

		const rebound = await service.bind({ projectId: "p2", uniqueCode: "web_01" });
		expect(rebound.ok).toBe(true);
		if (rebound.ok) expect(rebound.data.project_id).toBe("p2");
		db.close();
	});
});
