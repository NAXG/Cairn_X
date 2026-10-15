import { describe, expect, it } from "vitest";

import type { FgsClient } from "../../src/orchestrator/client.js";
import type { ProjectSummary } from "../../src/contracts/models.js";
import type { BenchmarkConfig } from "../../src/scheduler/config.js";
import {
	buildChallengeGoal,
	buildChallengeOrigin,
	BenchmarkDriver,
	challengeProjectTitle,
} from "../../src/tsecbench/driver.js";
import type { BenchmarkBinding } from "../../src/tsecbench/store.js";
import type { Challenge } from "../../src/tsecbench/types.js";
import { silentLogger } from "../orchestrator/helpers.js";

const config: BenchmarkConfig = {
	base_url: "https://tsecbench.example.com",
	token: "t",
	max_active: 3,
	auto_start: true,
	auto_close: true,
	challenge_timeout: 3600,
};

function challenge(overrides: Partial<Challenge> = {}): Challenge {
	return {
		unique_code: "web_01",
		description: "SQLi",
		difficulty: "easy",
		level: 1,
		total_score: 100,
		flag_count: 1,
		correct_flag_count: 0,
		is_completed: false,
		container_status: "stopped",
		container_addr: [],
		...overrides,
	};
}

function binding(overrides: Partial<BenchmarkBinding> = {}): BenchmarkBinding {
	return {
		project_id: "p1",
		unique_code: "web_01",
		title: "web_01",
		description: "SQLi",
		difficulty: "easy",
		level: 1,
		total_score: 100,
		flag_count: 1,
		correct_flag_count: 0,
		is_completed: false,
		container_status: "available",
		container_addr: ["10.0.0.9:80"],
		hint_used: false,
		created_at: new Date().toISOString(),
		updated_at: new Date().toISOString(),
		closed_at: null,
		container_started_at: null,
		...overrides,
	};
}

function project(id: string, status: ProjectSummary["status"] = "active"): ProjectSummary {
	return {
		id,
		title: id,
		status,
		created_at: new Date().toISOString(),
		finding_schema: null,
		experiment_id: null,
		harness_variant: null,
		decide: null,
		fact_count: 0,
		goal_count: 1,
		step_count: 0,
		working_step_count: 0,
		unclaimed_step_count: 0,
		finding_count: 0,
		hint_count: 0,
	};
}

/** 驱动用到的控制面方法子集。 */
class FakeControl {
	challenges: Challenge[];
	bindings: BenchmarkBinding[];
	projects: ProjectSummary[];
	created: Array<{ title: string; origin: string; goal: string }> = [];
	closed: string[] = [];
	restarted: string[] = [];
	completed: string[] = [];
	stopped: string[] = [];
	status: "active" | "stopped" = "active";

	constructor(
		challenges: Challenge[],
		bindings: BenchmarkBinding[] = [],
		projects: ProjectSummary[] = [],
	) {
		this.challenges = challenges;
		this.bindings = bindings;
		this.projects = projects;
	}

	async listBenchmarkChallenges() {
		return { statusCode: 200, ok: true, data: this.challenges.map((c) => ({ ...c })), text: "" };
	}
	async listBenchmarkTasks() {
		return this.bindings;
	}
	async listSchedulingProjects() {
		return this.projects;
	}
	async createProject(body: { title: string; origin: string; goal: string }) {
		this.created.push({ title: body.title, origin: body.origin, goal: body.goal });
		const id = `p${this.created.length}`;
		this.projects.push(project(id));
		return { statusCode: 201, ok: true, data: { project: { id } }, text: "" };
	}
	async bindBenchmark(body: { project_id: string; unique_code: string; title?: string }) {
		const target = this.challenges.find((c) => c.unique_code === body.unique_code)!;
		const created = binding({
			project_id: body.project_id,
			unique_code: target.unique_code,
			title: body.title ?? `[${target.unique_code}]`,
			description: target.description,
			flag_count: target.flag_count,
			container_status: this.status === "active" ? "available" : "stopped",
			closed_at: null,
		});
		this.bindings.push(created);
		return { statusCode: 200, ok: true, data: created, text: "" };
	}
	async refreshBenchmark(projectId: string) {
		const found = this.bindings.find((b) => b.project_id === projectId)!;
		return { statusCode: 200, ok: true, data: found, text: "" };
	}
	async startBenchmark(projectId: string) {
		const found = this.bindings.find((b) => b.project_id === projectId)!;
		found.container_status = "available";
		found.container_addr = ["10.0.0.9:80"];
		found.closed_at = null;
		found.container_started_at = new Date().toISOString();
		this.restarted.push(found.unique_code);
		return { statusCode: 200, ok: true, data: found, text: "" };
	}
	async closeBenchmark(projectId: string) {
		const found = this.bindings.find((b) => b.project_id === projectId)!;
		found.closed_at = new Date().toISOString();
		this.closed.push(found.unique_code);
		return { statusCode: 200, ok: true, data: found, text: "" };
	}
	/** 按 client_event_id 去重的完成事实表（模拟服务端幂等重传）。 */
	factKeys = new Map<string, string>();
	/** >0 时 createFact 返回 500（模拟瞬时控制面故障）。 */
	factTransientFailures = 0;
	async createFact(_projectId: string, body?: { client_event_id?: string }) {
		if (this.factTransientFailures > 0) {
			this.factTransientFailures -= 1;
			return { statusCode: 500, ok: false, data: undefined, text: "transient" };
		}
		const key = body?.client_event_id;
		if (key !== undefined && this.factKeys.has(key)) {
			return { statusCode: 200, ok: true, data: { id: this.factKeys.get(key) }, text: "" };
		}
		const id = `f${this.factKeys.size + 1}`;
		if (key !== undefined) this.factKeys.set(key, id);
		return { statusCode: 201, ok: true, data: { id }, text: "" };
	}
	/** >0 时 completeProject 先返回 409（模拟 pending 子目标挡路）。 */
	completeFailures = 0;
	/** >0 时 completeProject 返回 500（模拟瞬时控制面故障）。 */
	completeTransientFailures = 0;
	goals: Array<{ id: string; parent_goal_id: string | null; status: string }> = [];
	goalPageSize = 100;
	goalPageReads = 0;
	async getGoalsPage(_projectId: string, cursor?: string) {
		this.goalPageReads++;
		const start = cursor ? Number(cursor) : 0;
		return {
			items: this.goals.slice(start, start + this.goalPageSize),
			next_cursor:
				start + this.goalPageSize < this.goals.length ? String(start + this.goalPageSize) : null,
		};
	}
	async deleteGoal(_projectId: string, goalId: string) {
		this.goals = this.goals.filter((goal) => goal.id !== goalId);
		return { statusCode: 204, ok: true, data: null, text: "" };
	}
	async completeProject(_projectId: string) {
		if (this.completeTransientFailures > 0) {
			this.completeTransientFailures -= 1;
			return { statusCode: 500, ok: false, data: undefined, text: "transient" };
		}
		if (this.completeFailures > 0) {
			this.completeFailures -= 1;
			return { statusCode: 409, ok: false, data: undefined, text: "Resolve pending sub goals" };
		}
		this.completed.push(_projectId);
		return { statusCode: 200, ok: true, data: null, text: "" };
	}
	async setProjectStatus(projectId: string, status: "active" | "stopped") {
		this.stopped.push(`${projectId}:${status}`);
		const found = this.projects.find((p) => p.id === projectId);
		if (found !== undefined) found.status = status;
		return { statusCode: 200, ok: true, data: null, text: "" };
	}
}

function driver(control: FakeControl, only?: string[]): BenchmarkDriver {
	return new BenchmarkDriver({
		client: control as unknown as FgsClient,
		config,
		logger: silentLogger,
		only,
	});
}

describe("benchmark driver", () => {
	it("creates a project and binds unsolved challenges", async () => {
		const control = new FakeControl([challenge(), challenge({ unique_code: "crypto_02" })]);
		const summary = await driver(control).reconcileOnce();
		expect(summary.bound).toBe(2);
		expect(control.created).toHaveLength(2);
		expect(control.bindings.map((b) => b.unique_code).sort()).toEqual(["crypto_02", "web_01"]);
		expect(control.created[0]?.origin).toContain("web_01");
		expect(control.created[0]?.goal).toContain("web_01");
	});

	it("keeps a long challenge description out of the title without losing it", async () => {
		const description = "题目描述".repeat(100);
		const control = new FakeControl([challenge({ description })]);
		const summary = await driver(control).reconcileOnce();
		expect(summary.bound).toBe(1);
		expect(control.created[0]?.title).toBe("[web_01]");
		expect(control.created[0]?.origin).toContain(description);
		expect(control.bindings[0]?.title).toBe("[web_01]");
		expect(control.bindings[0]?.description).toBe(description);
	});

	it("respects the platform concurrency cap", async () => {
		const control = new FakeControl([
			challenge({ unique_code: "a" }),
			challenge({ unique_code: "b" }),
			challenge({ unique_code: "c" }),
			challenge({ unique_code: "d" }),
		]);
		// 已经有两道题在跑 → 只剩一个槽位。
		control.bindings.push(
			binding({ project_id: "p1", unique_code: "running_1", container_status: "available" }),
			binding({ project_id: "p2", unique_code: "running_2", container_status: "pending" }),
		);
		control.projects.push(project("p1"), project("p2"));
		const summary = await driver(control).reconcileOnce();
		expect(summary.bound).toBe(1);
		expect(summary.skipped).toBe(3);
	});

	it("completes the project and releases the container for solved challenges", async () => {
		const control = new FakeControl(
			[challenge({ correct_flag_count: 1, is_completed: true, container_status: "available" })],
			[binding({ project_id: "p1" })],
			[project("p1")],
		);
		const summary = await driver(control).reconcileOnce();
		expect(summary.completed).toBe(1);
		expect(summary.closed).toBe(1);
		expect(control.completed).toEqual(["p1"]);
		expect(control.closed).toEqual(["web_01"]);
	});

	it("releases containers for projects that already ended", async () => {
		const control = new FakeControl(
			[challenge()],
			[binding({ project_id: "p1" })],
			[project("p1", "completed")],
		);
		const summary = await driver(control).reconcileOnce();
		expect(summary.closed).toBe(1);
		expect(control.completed).toEqual([]);
	});

	it("does not rebuild a challenge whose old project already ended", async () => {
		const control = new FakeControl(
			[challenge()],
			[
				binding({
					project_id: "p1",
					closed_at: new Date().toISOString(),
					container_status: "stopped",
				}),
			],
			[project("p1", "stopped")],
		);
		const summary = await driver(control).reconcileOnce();
		expect(control.created).toHaveLength(0);
		expect(control.bindings).toHaveLength(1);
		// 绑定已释放且平台确认容器停止，release 是幂等 no-op。
		expect(summary.closed).toBe(0);
	});

	it("re-closes a container whose closed_at is stale but became available again", async () => {
		// worker 在解题中 benchmark_reset（close→start）重建容器后，本地
		// closed_at 仍在但平台容器已 available；修复前 release 永久短路 → 泄漏槽位。
		const control = new FakeControl(
			[challenge()],
			[
				binding({
					project_id: "p1",
					closed_at: new Date().toISOString(),
					container_status: "available",
				}),
			],
			[project("p1", "stopped")],
		);
		const summary = await driver(control).reconcileOnce();
		expect(summary.closed).toBe(1);
		expect(control.closed).toEqual(["web_01"]);
	});

	it("clears stale pending sub goals when the platform reports the challenge solved", async () => {
		const control = new FakeControl(
			[challenge({ correct_flag_count: 1, is_completed: true, container_status: "available" })],
			[binding({ project_id: "p1" })],
			[project("p1")],
		);
		control.completeFailures = 1;
		control.goals = [{ id: "g002", parent_goal_id: "goal", status: "pending" }];
		const summary = await driver(control).reconcileOnce();
		expect(summary.completed).toBe(1);
		expect(control.goals).toHaveLength(0);
		expect(control.stopped).toEqual([]);
	});

	it("reads every goal page and deletes pending leaves before their parents", async () => {
		const control = new FakeControl(
			[challenge({ correct_flag_count: 1, is_completed: true, container_status: "available" })],
			[binding({ project_id: "p1" })],
			[project("p1")],
		);
		control.completeFailures = 1;
		control.goalPageSize = 2;
		control.goals = [
			{ id: "goal", parent_goal_id: null, status: "pending" },
			{ id: "g1", parent_goal_id: "goal", status: "pending" },
			{ id: "achieved", parent_goal_id: "goal", status: "achieved" },
			{ id: "g2", parent_goal_id: "g1", status: "pending" },
			{ id: "g3", parent_goal_id: "goal", status: "pending" },
		];
		const summary = await driver(control).reconcileOnce();
		expect(summary.completed).toBe(1);
		expect(control.stopped).toEqual([]);
		expect(control.goals.map((goal) => goal.id)).toEqual(["goal", "achieved"]);
		expect(control.goalPageReads).toBeGreaterThan(3);
	});

	it("stops and releases challenges past the timeout", async () => {
		const control = new FakeControl(
			[challenge()],
			[binding({ project_id: "p1", created_at: new Date(Date.now() - 7200_000).toISOString() })],
			[project("p1")],
		);
		const summary = await driver(control).reconcileOnce();
		expect(summary.closed).toBe(1);
		expect(control.stopped).toContain("p1:stopped");
	});

	it("restarts the container when an active project's target was reclaimed", async () => {
		const control = new FakeControl(
			[challenge()],
			[binding({ project_id: "p1", container_status: "stopped", container_addr: [] })],
			[project("p1")],
		);
		const summary = await driver(control).reconcileOnce();
		expect(control.restarted).toEqual(["web_01"]);
		expect(summary.restarted).toBe(1);
		expect(control.bindings[0]?.container_status).toBe("available");
		expect(summary.errors).toEqual([]);
	});

	it("stops the project instead of restarting once the platform runtime cap is reached", async () => {
		const control = new FakeControl(
			[challenge()],
			[
				binding({
					project_id: "p1",
					container_status: "stopped",
					container_addr: [],
					container_started_at: new Date(Date.now() - 7201_000).toISOString(),
				}),
			],
			[project("p1")],
		);
		const summary = await driver(control).reconcileOnce();
		expect(control.restarted).toEqual([]);
		expect(summary.restarted).toBe(0);
		expect(control.stopped).toContain("p1:stopped");
		expect(summary.closed).toBe(1);
	});

	it("does not restart when auto_start is disabled", async () => {
		const control = new FakeControl(
			[challenge()],
			[binding({ project_id: "p1", container_status: "stopped", container_addr: [] })],
			[project("p1")],
		);
		const manual = new BenchmarkDriver({
			client: control as unknown as FgsClient,
			config: { ...config, auto_start: false },
			logger: silentLogger,
		});
		const summary = await manual.reconcileOnce();
		expect(control.restarted).toEqual([]);
		expect(summary.restarted).toBe(0);
	});

	it("honours the only filter", async () => {
		const control = new FakeControl([challenge(), challenge({ unique_code: "crypto_02" })]);
		const summary = await driver(control, ["crypto_02"]).reconcileOnce();
		expect(summary.challenges).toBe(1);
		expect(control.bindings.map((b) => b.unique_code)).toEqual(["crypto_02"]);
	});
	it("leaves unselected bindings untouched even when stopped or timed out", async () => {
		const control = new FakeControl(
			[challenge({ is_completed: true })],
			[
				binding({ project_id: "p2", unique_code: "other", created_at: "2000-01-01T00:00:00Z" }),
				binding({ project_id: "p3", unique_code: "stopped" }),
			],
			[project("p2"), project("p3", "stopped")],
		);
		await driver(control, ["web_01"]).reconcileOnce();
		expect(control.closed).toEqual([]);
		expect(control.stopped).toEqual([]);
	});

	it("does not lose a solved challenge on a transient completion failure", async () => {
		const control = new FakeControl(
			[challenge({ correct_flag_count: 1, is_completed: true, container_status: "available" })],
			[binding({ project_id: "p1" })],
			[project("p1")],
		);
		control.completeTransientFailures = 1;
		const runner = driver(control);
		const first = await runner.reconcileOnce();
		expect(first.completed).toBe(0);
		expect(first.errors.length).toBeGreaterThan(0);
		// 瞬时失败绝不能把项目标成 stopped：否则后续 pass 会在"非 active"分支跳过 finalize。
		expect(control.stopped).toEqual([]);
		// 下一轮 pass 用同一幂等键重试并真正完成，且只产生一条完成事实。
		const second = await runner.reconcileOnce();
		expect(second.completed).toBe(1);
		expect(control.stopped).toEqual([]);
		expect([...control.factKeys.keys()]).toEqual(["benchmark-complete:p1"]);
	});

	it("retries when writing the completion fact fails transiently", async () => {
		const control = new FakeControl(
			[challenge({ correct_flag_count: 1, is_completed: true, container_status: "available" })],
			[binding({ project_id: "p1" })],
			[project("p1")],
		);
		control.factTransientFailures = 1;
		const runner = driver(control);
		const first = await runner.reconcileOnce();
		expect(first.completed).toBe(0);
		expect(control.stopped).toEqual([]);
		const second = await runner.reconcileOnce();
		expect(second.completed).toBe(1);
		expect(control.factKeys.size).toBe(1);
	});
});

describe("challenge project text", () => {
	it("embeds a reachable target address and the flag count", () => {
		const c = challenge({ container_addr: ["10.1.2.3:8080"], flag_count: 3 });
		expect(buildChallengeOrigin(c)).toContain("10.1.2.3:8080");
		expect(buildChallengeOrigin(c)).toContain("3");
		expect(buildChallengeGoal(c)).toContain("web_01");
		expect(buildChallengeGoal(c)).toContain("3");
	});

	it("builds a project title within the server's 120-character limit", () => {
		expect(challengeProjectTitle(challenge({ description: null }))).toBe("[web_01]");
		expect(challengeProjectTitle(challenge({ description: "x".repeat(500) }))).toBe("[web_01]");
		const title = challengeProjectTitle(challenge({ unique_code: "x".repeat(200) }));
		expect(title).toHaveLength(120);
		expect(title.endsWith("]")).toBe(true);
	});
});
