import { registerTestDatabase } from "../support/project-state.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { serve } from "@hono/node-server";
import { onTestFinished } from "vitest";

import { FgsClient } from "../../src/orchestrator/client.js";
import { WorkerClient } from "../../src/worker/client.js";
import type { ProjectWorkerTask } from "../../src/contracts/execution.js";
import type { DispatchConfig } from "../../src/scheduler/config.js";
import type {
	ProjectWorkerLaunchSpec,
	ProjectWorkerLauncher,
} from "../../src/scheduler/launcher.js";
import { containerNameForProject } from "../../src/scheduler/launcher.js";
import type { ActivityRunners, DecideContext, ExecuteContext } from "../../src/scheduler/types.js";
import type { ActivityType, Outcome } from "../../src/contracts/activity.js";
import type { Db } from "../../src/server/db.js";
import { openDatabase } from "../../src/server/db.js";
import { createApp } from "../../src/server/app.js";
import { createConfigurationControl, type ConfigurationControl } from "../../src/control/index.js";
import type { BenchmarkService } from "../../src/tsecbench/service.js";

export interface TestServer {
	url: string;
	client: FgsClient;
	db: Db;
	close: () => Promise<void>;
}

/** 覆盖服务器侧运行时设置（调度循环每轮从服务器读取，测试需要把上限类配置写到服务器）。 */
export function seedServerRuntime(
	db: Db,
	overrides: Partial<import("../../src/contracts/configuration.js").RuntimeSettings>,
): void {
	const row = db
		.prepare("SELECT body FROM configuration_objects WHERE kind='runtime' AND id='global'")
		.get() as { body: string } | undefined;
	if (!row) throw new Error("runtime settings row missing");
	db.prepare("UPDATE configuration_objects SET body=? WHERE kind='runtime' AND id='global'").run(
		JSON.stringify({ ...JSON.parse(row.body), ...overrides }),
	);
}

/**
 * 关闭测试服务器并主动断开残留连接。
 *
 * `server.close()` 只等已有连接结束；测试里的 fetch 走 keep-alive 连接池，
 * 空闲 socket 要等 keepAliveTimeout 才释放，于是清理钩子偶发超过 10s 预算
 * 报 “Hook timed out”，把一次正常的运行伪装成失败。closeAllConnections 让
 * 回调立即落地，测试结果不再取决于机器负载。
 */
async function closeServer(server: {
	close: (cb: () => void) => unknown;
	closeAllConnections?: () => void;
}) {
	const done = new Promise<void>((resolve) => server.close(() => resolve()));
	server.closeAllConnections?.();
	await done;
}

/** 在随机端口上启动真实的 FGS 服务器 + 执行控制面，底层使用临时 SQLite 数据库。 */
export async function startTestServer(): Promise<TestServer> {
	const dir = mkdtempSync(path.join(tmpdir(), "cairn-x-orch-"));
	const db = openDatabase(path.join(dir, "cairn.db"));
	const app = createApp(db);
	seedServerRuntime(db, { decide_min_interval: 0 });
	let closed = false;
	let server: ReturnType<typeof serve>;
	const close = async () => {
		if (closed) {
			return;
		}
		closed = true;
		await closeServer(server);
		db.close();
		rmSync(dir, { recursive: true, force: true });
	};
	const port = await new Promise<number>((resolve, reject) => {
		server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 }, (info) =>
			resolve(info.port),
		);
		server.on("error", reject);
	});
	onTestFinished(close);
	const url = `http://127.0.0.1:${port}`;
	return { url, client: registerTestDatabase(new FgsClient(url), db), db, close };
}

/** 带完整执行控制面的服务器（execution 协议 + 配置中心活动通道）。 */
export async function startExecutorTestServer(
	model: {
		api: "openai-completions" | "anthropic-messages" | "openai-responses";
		base_url: string;
		api_key: string;
	},
	options: {
		timeouts?: { step_ms: number; harvest_ms: number; grace_ms: number };
		/** Caller-owned storage, preserved by close() so tests can reopen it. */
		dataRoot?: string;
		/** Docker acceptance: bind and advertise only on the isolated test network. */
		listenHost?: string;
		controlHost?: string;
		/** TSecBench 评测代理工厂；缺省时相关接口返回 503。 */
		benchmarkFactory?: (db: Db, control: ConfigurationControl) => BenchmarkService;
	} = {},
): Promise<TestServer & { dataRoot: string; control: ConfigurationControl }> {
	const dir = options.dataRoot ?? mkdtempSync(path.join(tmpdir(), "cairn-x-executor-"));
	const db = openDatabase(path.join(dir, "cairn.db"));
	const auth = { user: "admin", password: "test", apiToken: "test-token" };
	const stepTimeout = (options.timeouts?.step_ms ?? 30_000) / 1000;
	const harvestTimeout = (options.timeouts?.harvest_ms ?? 30_000) / 1000;
	const control = createConfigurationControl(
		db,
		dir,
		testConfig("http://unused", {
			models: {
				decide: {
					model_id: "faux-decide",
					base_url: "http://unused",
					api: "openai-completions",
					api_key: "test",
				},
				execute: {
					model_id: "faux-execute",
					base_url: model.base_url,
					api: model.api,
					api_key: model.api_key,
				},
			},
			tasks: {
				execute: {
					step_timeout: stepTimeout,
					harvest_timeout: harvestTimeout,
					bash_timeout: 120,
				},
			},
		}),
	);
	// workerControlUrl 必须指向本服务器（Worker 的活动通道同源），但端口在
	// serve 之后才知道：先占位，监听后回写（路由闭包按引用读取）。
	const executions = {
		configuration: control,
		benchmark: options.benchmarkFactory?.(db, control),
		db,
		auth,
		workerControlUrl: "http://127.0.0.1:1",
		bash_timeout_seconds: 120,
		dataRoot: dir,
	};
	const app = createApp(db, auth, undefined, dir, { executions, configuration: control });
	let closed = false;
	let server: ReturnType<typeof serve>;
	const close = async () => {
		if (closed) {
			return;
		}
		closed = true;
		await closeServer(server);
		db.close();
		if (options.dataRoot === undefined) rmSync(dir, { recursive: true, force: true });
	};
	const port = await new Promise<number>((resolve, reject) => {
		server = serve(
			{ fetch: app.fetch, hostname: options.listenHost ?? "127.0.0.1", port: 0 },
			(info) => resolve(info.port),
		);
		server.on("error", reject);
	});
	onTestFinished(close);
	const url = `http://${options.controlHost ?? "127.0.0.1"}:${port}`;
	executions.workerControlUrl = url;
	return {
		url,
		client: registerTestDatabase(new FgsClient(url, 10_000, "test-token"), db),
		db,
		close,
		dataRoot: dir,
		control,
	};
}

/**
 * 把控制面里某个导入连接（imported-decide / imported-execute）脚本化为
 * faux provider：模型流量走 /internal/activities/model 的完整 HTTP 链路，
 * 响应由测试脚本驱动。
 */
export async function scriptConnectionWithFaux(
	control: ConfigurationControl,
	connectionId: string,
	faux: { provider: { streamSimple: (model: any, context: any, options?: any) => unknown } },
): Promise<void> {
	const connection = control.models.connection(connectionId);
	const runtime = await control.models.runtime(connection);
	runtime.registerProvider(connection.sdk_id, {
		baseUrl: "http://faux.invalid",
		api: connection.api as never,
		models: connection.models.map((m) => ({
			...m,
			input: ["text" as const],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		})),
		streamSimple: (model, context, options) =>
			faux.provider.streamSimple(model, context, options) as never,
	});
}

export function testConfig(
	server: string,
	overrides: {
		runtime?: Partial<DispatchConfig["runtime"]>;
		models?: Partial<DispatchConfig["models"]>;
		container?: DispatchConfig["container"];
		tasks?: DispatchConfig["tasks"];
		healthcheck?: DispatchConfig["healthcheck"];
		compaction?: DispatchConfig["compaction"];
	} = {},
): DispatchConfig {
	return {
		server,
		runtime: {
			interval: 1,
			max_workers: 8,
			max_running_projects: 3,
			max_project_workers: 4,
			decide_min_interval: 0,
			endpoint_cooldown: 5,
			endpoint_unhealthy_threshold: 3,
			...overrides.runtime,
		},
		models: {
			decide: {
				model_id: "mock-decide",
				base_url: "http://127.0.0.1:1",
				api: "openai-completions",
				api_key: "test",
				...overrides.models?.decide,
			},
			execute: {
				model_id: "mock-execute",
				base_url: "http://127.0.0.1:1",
				api: "openai-completions",
				api_key: "test",
				...overrides.models?.execute,
			},
		},
		container: overrides.container ?? {
			image: "cairn-x-worker:test",
			network: "cairn-workers",
			cpus: 1,
			memory_mb: 512,
			pids_limit: 256,
			stop_grace_seconds: 2,
			auto_remove: false,
			project_idle_seconds: 600,
		},
		tasks: overrides.tasks ?? {
			execute: {
				step_timeout: 1200,
				harvest_timeout: 180,
				bash_timeout: 120,
			},
		},
		healthcheck: overrides.healthcheck ?? { timeout: 20 },
		compaction: overrides.compaction,
	};
}

/** 进程级 ProjectWorkerLauncher 伪实现：容器状态用内存记录，无 Docker。 */
export class FakeLauncher implements ProjectWorkerLauncher {
	readonly ensured: ProjectWorkerLaunchSpec[] = [];
	/** 每次真正新建容器时签发的项目令牌（复用运行中容器时绝不签发）。 */
	readonly issuedTokens: string[] = [];
	readonly removed: string[] = [];
	readonly stopped: string[] = [];
	readonly states = new Map<string, string>();
	private readonly waiters = new Map<string, Array<() => void>>();
	failStart = false;

	async ping(): Promise<void> {
		if (this.failStart) {
			throw new Error("docker daemon down");
		}
	}

	containerName(projectId: string): string {
		return containerNameForProject(projectId);
	}

	projectIdForContainer(handle: string): string | null {
		return handle.startsWith("cairn-pw-") ? handle.slice("cairn-pw-".length) || null : null;
	}

	async ensure(spec: ProjectWorkerLaunchSpec): Promise<string> {
		if (this.failStart) {
			throw new Error("failed to create worker container");
		}
		const name = this.containerName(spec.projectId);
		if (this.states.get(name) === "running") {
			return name;
		}
		this.ensured.push(spec);
		this.issuedTokens.push(await spec.issueToken());
		this.states.set(name, "running");
		return name;
	}

	/** 模拟容器自然退出（Worker 报告终态后调用）。 */
	exit(handle: string): void {
		this.states.set(handle, "exited");
		for (const waiter of this.waiters.get(handle) ?? []) {
			waiter();
		}
		this.waiters.delete(handle);
	}

	async stop(handle: string): Promise<boolean> {
		this.stopped.push(handle);
		this.exit(handle);
		return true;
	}

	async remove(handle: string): Promise<boolean> {
		if (!this.states.has(handle)) {
			return false;
		}
		this.removed.push(handle);
		this.states.delete(handle);
		for (const waiter of this.waiters.get(handle) ?? []) {
			waiter();
		}
		this.waiters.delete(handle);
		return true;
	}

	async listManaged(): Promise<Array<{ name: string; state: string }>> {
		return [...this.states.entries()].map(([name, state]) => ({ name, state }));
	}

	/** 等待容器被模拟退出（配合 FakeLauncher.exit 使用）。 */
	waitForExit(handle: string, timeoutMs = 10_000): Promise<void> {
		if (this.states.get(handle) !== "running") {
			return Promise.resolve();
		}
		return new Promise((resolve, reject) => {
			const timer = setTimeout(
				() => reject(new Error(`container ${handle} did not exit within ${timeoutMs}ms`)),
				timeoutMs,
			);
			const list = this.waiters.get(handle) ?? [];
			list.push(() => {
				clearTimeout(timer);
				resolve();
			});
			this.waiters.set(handle, list);
		});
	}
}

export interface RunnerCall {
	activity: ActivityType;
	projectId: string;
	stepId?: string;
	trigger?: string;
	/** execute：本次执行尝试的 execution_id（uuid）。 */
	worker: string;
}

export interface RunnerBehaviors {
	decide?: (ctx: DecideContext, signal: AbortSignal) => Promise<Outcome>;
	execute?: (ctx: ExecuteContext, signal: AbortSignal) => Promise<Outcome>;
}

/**
 * 记录每一次调用。默认行为：decide 立即成功；execute
 * 结束自己的 step（创建一条 fact）并成功返回。
 */
export function recordingRunners(behaviors: RunnerBehaviors = {}): {
	runners: ActivityRunners;
	calls: RunnerCall[];
} {
	const calls: RunnerCall[] = [];
	const runners: ActivityRunners = {
		decide: async (ctx, signal) => {
			calls.push({
				activity: "decide",
				projectId: ctx.projectId,
				trigger: ctx.trigger,
				worker: ctx.worker,
			});
			await readAllPlanningGraph(ctx.client, ctx.projectId, ctx.worker);
			return behaviors.decide ? behaviors.decide(ctx, signal) : "success";
		},
		execute: async (ctx, signal) => {
			calls.push({
				activity: "execute",
				projectId: ctx.projectId,
				stepId: ctx.stepId,
				worker: ctx.worker,
			});
			if (behaviors.execute) {
				return behaviors.execute(ctx, signal);
			}
			await ctx.client.createFact(ctx.projectId, {
				confidence: "observed",
				description: `observed ${ctx.stepId}`,
				step_id: ctx.stepId,
				worker: ctx.worker,
			});
			const result = await ctx.client.concludeStep(
				ctx.projectId,
				ctx.stepId,
				ctx.worker,
				`concluded ${ctx.stepId}`,
			);
			return result.ok ? "success" : "failed";
		},
	};
	return { runners, calls };
}

export async function readAllPlanningGraph(client: FgsClient, projectId: string, worker: string) {
	const pages: import("../../src/contracts/planning-graph.js").PlanningGraphPage[] = [];
	let cursor: string | undefined;
	for (let i = 0; i < 1000; i++) {
		const response = await client.readDecideGraph(projectId, {
			worker,
			view: "planning",
			...(cursor === undefined ? {} : { cursor }),
		});
		if (response.view !== "planning") throw new Error("expected planning graph page");
		pages.push(response);
		if (response.coverage.required_complete) return pages;
		cursor = response.coverage.next_cursor ?? undefined;
	}
	throw new Error("planning graph pagination did not converge");
}

export const silentLogger = {
	debug: () => {},
	info: () => {},
	warn: () => {},
	error: () => {},
};

export async function createProject(
	client: FgsClient,
	extra: Record<string, unknown> = {},
): Promise<string> {
	const result = await client.createProject({
		title: "test",
		origin: "starting point",
		goal: "finish the thing",
		...extra,
	});
	if (!result.ok || result.data === undefined) {
		throw new Error(`createProject failed: ${result.statusCode} ${result.text}`);
	}
	return result.data.project.id;
}

export async function addStep(
	client: FgsClient,
	projectId: string,
	options: { priority?: number; description?: string } = {},
): Promise<string> {
	const result = await client.createStep(projectId, {
		actor: "human",
		from: ["origin"],
		description: options.description ?? "do work",
		priority: options.priority,
		creator: "test",
	});
	if (!result.ok || result.data === undefined) {
		throw new Error(`addStep failed: ${result.statusCode} ${result.text}`);
	}
	return result.data.id;
}

/** Test-side equivalent of the production project Worker next() path. */
async function issueProjectWorkerToken(
	server: TestServer,
	projectId: string,
	containerName = "cairn-pw-test",
): Promise<string> {
	const response = await fetch(`${server.url}/internal/project-workers/${projectId}/token`, {
		method: "POST",
		headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
		body: JSON.stringify({ container_name: containerName }),
	});
	if (response.status !== 201) {
		throw new Error(`issueProjectWorkerToken failed: ${response.status} ${await response.text()}`);
	}
	return ((await response.json()) as { token: string }).token;
}

export async function claimExecutionWithProjectWorker(
	server: TestServer,
	projectId: string,
	executionId: string,
	projectToken?: string,
): Promise<{ task: ProjectWorkerTask; worker: WorkerClient; projectToken: string }> {
	const token = projectToken ?? (await issueProjectWorkerToken(server, projectId));
	const response = await fetch(`${server.url}/internal/project-workers/${projectId}/next`, {
		method: "POST",
		headers: { Authorization: `Bearer ${token}` },
	});
	if (response.status !== 200) {
		throw new Error(`next failed: ${response.status} ${await response.text()}`);
	}
	const task = (await response.json()) as ProjectWorkerTask;
	if (task.execution_id !== executionId) {
		throw new Error(`next returned ${task.execution_id}, expected ${executionId}`);
	}
	return {
		task,
		worker: new WorkerClient(server.url, executionId, task.token),
		projectToken: token,
	};
}
