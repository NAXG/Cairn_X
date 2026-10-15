import type { ConfigurationControl } from "../../control/index.js";
import type { RuntimeSettings } from "../../contracts/configuration.js";
/**
 * Executor Worker 协议路由（/internal/executions/*）与 TSecBench 评测代理
 * （/internal/benchmark/*）。
 *
 * TSecBench 平台 token 只在控制端（benchmark service）；Worker 通过
 * /internal/executions/:id/benchmark/* 代理 status/submit/hint/reset，driver 通过
 * /internal/benchmark/* 绑定题目、启动/重启与释放容器。
 *
 * 身份模型：
 * - 控制端调用（dispatcher）：Bearer 全局 API token。
 * - Worker 调用：Bearer 短期执行令牌（领取 queued execution 时发放，绑定单个
 *   execution；执行进入终态后立即失效）。
 *
 * 全局 authMiddleware 不校验 /internal/ 前缀路径 —— 本模块自行鉴权：
 * 每个端点要么验证 API token，要么通过令牌哈希解析 execution 并校验
 * 执行身份、项目归属、租约状态与权限范围。
 */

import { Hono } from "hono";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { createFact } from "../core/facts.js";
import { factContentSchema } from "../../contracts/facts.js";
import { createFinding } from "../core/findings.js";
import { backfillExecutionUsage } from "../core/usage-backfill.js";
import { consoleLogger } from "../../shared/logger.js";
import { z } from "zod";

import type { Db, ProjectWorkerRow } from "../db.js";
import { parseBody } from "../http.js";
import { evidenceRefSchema, usageTokensShape } from "../models.js";
import { validApiToken, type AuthConfig } from "../auth.js";
import {
	appendExecutionEvents,
	applyExecutionResult,
	claimQueuedExecution,
	createExecution,
	escalateFromExecution,
	executionToView,
	flushExecutionEvents,
	getExecutionRow,
	heartbeatExecution,
	listActiveExecutions,
	listQueuedExecutions,
	requestCancel,
	requireExecutionAlive,
	requireExecutionByToken,
	reapExpiredExecutions,
	transitionExecution,
	type ExecutionRowLike,
} from "../core/executions.js";
import {
	getProjectWorker,
	issueProjectWorkerToken,
	listProjectWorkers,
	projectWorkerView,
	requireProjectWorkerByToken,
	stopProjectWorker,
	touchProjectWorker,
} from "../core/project-workers.js";
import { ApiError, utcnow } from "../core/base.js";
import { getProjectOr404, getStepOr404 } from "../core/project-guards.js";
import { getLeaseTimeout, heartbeatIntervalFor } from "../core/lease-expiry.js";
import { stopProjectWorkExcept } from "../core/execution-cascade.js";
import {
	annotateInterruptedTool,
	eventSearchOptionsFromQuery,
	readTraceRequest,
	searchExecutionEvents,
	WORKER_INLINE_BYTES,
	WORKER_PAGE_BYTES,
} from "../core/event-search.js";
import { signalDecideExternal } from "../core/decide.js";
import {
	DEFAULT_GRACE_MS,
	executionDeadlineSeconds,
	executionResultSubmissionSchema,
} from "../../contracts/execution.js";
import type { BenchmarkService, BenchmarkServiceResult } from "../../tsecbench/service.js";
import type { BenchmarkBinding } from "../../tsecbench/store.js";
import type {
	ExecutionBenchmarkContext,
	ExecutionSourceFact,
	ExecutionTask,
	ProjectWorkerTask,
} from "../../contracts/execution.js";

export interface ExecutionRoutesDeps {
	/** 配置中心（活动快照、Agent Profile）；生产与测试均为必选。 */
	configuration: ConfigurationControl;
	db: Db;
	/** 机器端鉴权（与 serve 启动参数一致）；未配置时仅允许本地无鉴权模式。 */
	auth?: AuthConfig;
	/**
	 * Worker 访问控制端使用的基地址（compose 内为服务别名；host 部署为
	 * 宿主地址）。活动模型通道 URL 由此派生。
	 */
	workerControlUrl: string;
	/** 单条 bash 命令的默认超时（秒），随执行任务下发给 Worker。 */
	bash_timeout_seconds: number;
	dataRoot: string;
	/** TSecBench 评测代理；未配置评测时缺省，相关接口返回 503。 */
	benchmark?: BenchmarkService;
}

/**
 * steer → 强制 abort 之间的宽限（毫秒）。默认 60s；可用 CAIRN_GRACE_SECONDS
 * 覆盖（上限 600s），便于按环境调短/调长。
 */
function getGraceMs(): number {
	const seconds = Number.parseInt(process.env.CAIRN_GRACE_SECONDS ?? "", 10);
	return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 600) * 1000 : DEFAULT_GRACE_MS;
}

function requireMachineToken(
	deps: ExecutionRoutesDeps,
	c: { req: { header: (n: string) => string | undefined } },
): void {
	if (deps.auth === undefined) {
		return;
	}
	if (!validApiToken(deps.auth, c.req.header("authorization"))) {
		throw new ApiError(401, "Control API token required");
	}
}

export function executionRoutes(deps: ExecutionRoutesDeps): Hono {
	const app = new Hono();
	registerExecutionRoutes(app, deps);
	registerProjectWorkerRoutes(app, deps);
	registerExecutionProtocolRoutes(app, deps);
	registerBenchmarkRoutes(app, deps);
	return app;
}

function registerExecutionRoutes(app: Hono, deps: ExecutionRoutesDeps): void {
	const { db } = deps;
	app.post("/internal/executions", async (c) => {
		requireMachineToken(deps, c);
		const body = await parseBody(c, executionCreateSchema);
		const profile = deps.configuration.store.profile("execute");
		const created = db.transaction(() => {
			const result = createExecution(
				db,
				body,
				// Worker 的两段 grace 必须计入 deadline，否则"用满宽限"= 必然被硬杀。
				executionDeadlineSeconds({
					runSeconds: profile.run_seconds,
					harvestSeconds: profile.harvest_seconds,
					graceMs: getGraceMs(),
				}),
			);
			deps.configuration.store.snapshot(result.id, "execute", body.project_id);
			return result;
		})();
		const configuration = deps.configuration.store.readSnapshot(created.id);
		return c.json(
			{
				execution_id: created.id,
				configuration,
				attempt: created.attempt,
				lease_version: created.lease_version,
				heartbeat_interval_s: getHeartbeatIntervalS(db),
				// Worker 用它作为自保预算（服务端 deadline 的权威来源）。
				deadline_seconds: created.deadline_seconds,
				deadline_at: created.deadline_at,
			},
			// 201 = 本次创建；200 = 幂等重放（同一 execution_id 的响应丢失后重发）。
			created.replayed ? 200 : 201,
		);
	});

	app.get("/internal/executions/:id", (c) => {
		// 控制端或 Worker 本人可读。
		const token = bearerToken(c.req.header("authorization"));
		let row: ExecutionRowLike;
		if (
			token !== undefined &&
			deps.auth !== undefined &&
			validApiToken(deps.auth, c.req.header("authorization"))
		) {
			// 机器端 Bearer（dispatcher）。
			row = getExecutionRow(db, c.req.param("id"));
		} else if (token !== undefined) {
			row = requireExecutionByToken(db, token);
			if (row.id !== c.req.param("id")) {
				throw new ApiError(403, "Execution token does not match");
			}
			// Historical execution views require the machine token; worker credentials
			// only grant access while their execution and step lease are still alive.
			requireExecutionAlive(db, row);
		} else {
			requireMachineToken(deps, c);
			row = getExecutionRow(db, c.req.param("id"));
		}
		return c.json(executionToView(db, row));
	});

	app.post("/internal/executions/:id/status", async (c) => {
		requireMachineToken(deps, c);
		const body = await parseBody(c, executionStatusSchema);
		const row = getExecutionRow(db, c.req.param("id"));
		// 判 lost 时 Worker 已经死了、来不及上报任何东西，error 里只有一句
		// "deadline exceeded"。轨迹是实时持久化的，从这里反推出「卡在哪个工具上」，
		// 否则这条记录除了"超时了"什么也说明不了。
		const error =
			body.error === undefined || body.error === null
				? null
				: body.status === "lost"
					? annotateInterruptedTool(db, row.id, body.error)
					: body.error;
		transitionExecution(db, row, body.status as "failed" | "cancelled" | "lost", {
			error,
			exit_code: body.exit_code ?? null,
		});
		if (body.status === "lost") {
			const project = getProjectOr404(db, row.project_id);
			if (project.status === "active") signalDecideExternal(db, row.project_id, "execution_lost");
		}
		flushExecutionEvents(db, getExecutionRow(db, row.id), deps.dataRoot);
		return c.json(executionToView(db, getExecutionRow(db, row.id)));
	});

	app.post("/internal/executions/:id/cancel", async (c) => {
		requireMachineToken(deps, c);
		const row = getExecutionRow(db, c.req.param("id"));
		return c.json(requestCancel(db, row));
	});

	app.post("/internal/executions/reap", async (c) => {
		// 控制端兜底回收：截止时间已过的非终态执行 → lost。
		requireMachineToken(deps, c);
		const active = listActiveExecutions(db);
		const now = utcnow();
		const reaped = reapExpiredExecutions(db, now);
		const affectedProjects = [...new Set(reaped.map((row) => row.project_id))];
		for (const row of active) {
			// 刚被 reaper 置为终态的执行：刷写会话轨迹（幂等）。
			flushExecutionEvents(db, getExecutionRow(db, row.id), deps.dataRoot);
		}
		for (const row of active) {
			// 轨迹落盘后再从轨迹回填 token：deadline 判 lost 的执行等不到 Worker 上报。
			// 非终态（仍在跑）的执行会被 backfillExecutionUsage 直接跳过。
			backfillExecutionUsage(db, row.id, now);
		}
		for (const projectId of affectedProjects) {
			const project = getProjectOr404(db, projectId);
			if (project.status === "active") signalDecideExternal(db, projectId, "execution_lost");
		}
		return c.json({ reaped: reaped.length });
	});
}

function registerProjectWorkerRoutes(app: Hono, deps: ExecutionRoutesDeps): void {
	const { db } = deps;
	//
	// 控制端签发的项目令牌只绑定一个项目；容器内的并发 step 循环用它在
	// next 接口原子领取 queued execution，服务端当场为那一个 execution
	// 现签短期执行令牌。既有 /internal/executions/:id/* 协议因此完全不变。

	// 控制端：签发/轮换项目令牌（容器启动时注入）。
	app.post("/internal/project-workers/:projectId/token", async (c) => {
		requireMachineToken(deps, c);
		const body = await parseBody(c, projectWorkerTokenSchema);
		const issued = issueProjectWorkerToken(
			db,
			c.req.param("projectId"),
			body.container_name ?? null,
		);
		return c.json(
			{
				project_id: issued.view.project_id,
				token: issued.token,
				container_name: issued.view.container_name,
			},
			201,
		);
	});

	// 机器端运维观测：无仓内调用方（控制端只用 token/stop），保留用于排查
	// 项目常驻 Worker 状态；响应不含 token 哈希。
	app.get("/internal/project-workers", (c) => {
		requireMachineToken(deps, c);
		return c.json(listProjectWorkers(db).map(projectWorkerView));
	});

	// 同上，单个项目的 Worker 视图。
	app.get("/internal/project-workers/:projectId", (c) => {
		requireMachineToken(deps, c);
		return c.json(projectWorkerView(getProjectWorkerOr404(db, c.req.param("projectId"))));
	});

	app.post("/internal/project-workers/:projectId/stop", (c) => {
		requireMachineToken(deps, c);
		stopProjectWorker(db, c.req.param("projectId"));
		return c.json(projectWorkerView(getProjectWorkerOr404(db, c.req.param("projectId"))));
	});

	// 项目容器：领取下一个 queued execution（无任务时 204，循环自行退避）。
	app.post("/internal/project-workers/:projectId/next", async (c) => {
		const worker = requireProjectSelf(db, c);
		// 任务载荷先于 claim 组装：组装失败（配置快照缺失等）时 execution 保持
		// queued 供下次 next 重试，而不是卡在 running 且令牌无人持有。候选被
		// 并发循环领走时顺延到下一个：claim 是带状态条件的原子操作。某个候选
		// 载荷组装失败时也顺延，避免它阻塞同项目的其它排队执行（它保持 queued，
		// 到期由 reaper 判 lost）；全部失败才把最后一个错误抛给调用方。
		let lastError: unknown;
		for (const candidate of listQueuedExecutions(db, worker.project_id)) {
			let task: ExecutionTask;
			try {
				task = await buildExecutionTask(deps, db, candidate);
			} catch (err) {
				lastError = err;
				continue;
			}
			const claimed = claimQueuedExecution(db, worker.project_id, candidate.id);
			if (claimed === undefined) continue;
			const payload: ProjectWorkerTask = { ...task, token: claimed.token };
			return c.json(payload);
		}
		if (lastError !== undefined) throw lastError;
		return c.body(null, 204);
	});

	// 项目容器存活心跳：刷新 last_seen_at，并下发项目状态供循环决定何时退出。
	// 单项目并发随心跳下发：容器常驻，启动时注入的并发数会在运行中修改设置后
	// 过期；调度器按新上限派发而容器仍按旧上限领取，多出的执行只能排队到超时。
	app.post("/internal/project-workers/:projectId/heartbeat", (c) => {
		const worker = requireProjectSelf(db, c);
		const project = getProjectOr404(db, worker.project_id);
		const runtime = deps.configuration.store.get<RuntimeSettings>("runtime", "global");
		return c.json({
			project_id: worker.project_id,
			project_status: project.status,
			heartbeat_interval_s: getHeartbeatIntervalS(db),
			...(runtime ? { max_concurrency: runtime.max_project_workers } : {}),
		});
	});
}

function registerExecutionProtocolRoutes(app: Hono, deps: ExecutionRoutesDeps): void {
	const { db } = deps;
	app.post("/internal/executions/:id/heartbeat", async (c) => {
		const row = requireSelf(db, c);
		heartbeatExecution(db, row);
		const fresh = getExecutionRow(db, row.id);
		return c.json({
			lease_timeout_s: getLeaseTimeout(db),
			// 心跳间隔与 TTL 解耦，Worker 优先采用这里的值而非 TTL/3。
			heartbeat_interval_s: getHeartbeatIntervalS(db),
			cancel: fresh.cancel_requested === 1,
			deadline_at: fresh.deadline_at,
		});
	});

	app.post("/internal/executions/:id/events", async (c) => {
		const row = requireSelf(db, c);
		const body = await parseBody(c, executionEventsSchema);
		const result = appendExecutionEvents(db, row, body.events);
		return c.json(result);
	});

	app.post("/internal/executions/:id/result", async (c) => {
		const row = requireSelf(db, c, true);
		const body = await parseBody(c, executionResultSchema);
		// Step、用量、Execution 终态在同一 SQLite 事务内提交后才确认。
		const ack = applyExecutionResult(db, row, body);
		flushExecutionEvents(db, getExecutionRow(db, row.id), deps.dataRoot);
		return c.json(ack);
	});

	// ---- Worker 的证据操作（业务语义与公开路由一致）----
	// 受限过程检索：同项目历史执行的关键词检索（预算与字段过滤由核心层强制）。
	app.get("/internal/executions/:id/search-events", (c) => {
		const row = requireSelf(db, c);
		return c.json(
			searchExecutionEvents(
				db,
				row.project_id,
				c.req.query("q"),
				eventSearchOptionsFromQuery((name) => c.req.query(name)),
			),
		);
	});

	// 读取同项目某次执行的轨迹片段（分页、字节预算；目标必须属于本项目）。
	// Worker 走比控制台更窄的单条内联预算：模型要的是定位事件，不是搬运工具输出。
	app.get("/internal/executions/:id/trace/:targetId", (c) => {
		const row = requireSelf(db, c);
		const view = c.req.query("view");
		if (view !== undefined && view !== "index") throw new ApiError(400, "Invalid view (index)");
		return c.json(
			readTraceRequest(db, row.project_id, c.req.param("targetId"), (name) => c.req.query(name), {
				inlineBytes: WORKER_INLINE_BYTES,
				pageBytes: WORKER_PAGE_BYTES,
				index: view === "index",
			}),
		);
	});

	app.post("/internal/executions/:id/facts", async (c) => {
		const row = requireSelf(db, c);
		const body = await parseBody(c, executionFactSchema);
		requireExecutionAlive(db, row);
		const result = createFact(db, row.project_id, {
			...body,
			step_id: row.step_id,
			execution_id: row.id,
		});
		if (result.duplicate) return c.json({ id: result.model.id, duplicate: true }, 200);
		return c.json({ ...result.model, duplicate: false }, 201);
	});

	app.post("/internal/executions/:id/findings", async (c) => {
		const row = requireSelf(db, c);
		const body = await parseBody(c, executionFindingSchema);
		const result = createFinding(
			db,
			row.project_id,
			{ ...body, step_id: row.step_id, execution_id: row.id },
			{
				authorize: () => requireExecutionAlive(db, row),
			},
		);
		return c.json(
			{ id: result.model.id, duplicate: result.duplicate },
			result.duplicate ? 200 : 201,
		);
	});

	// 执行者升级上报：把「当前计划的前提已经不成立」立刻交回规划层。
	// 不中断本次执行——规划器在下一个节拍带着新证据重规划，执行者继续本步骤。
	app.post("/internal/executions/:id/signal", async (c) => {
		const row = requireSelf(db, c);
		const body = await parseBody(c, executionSignalSchema);
		const ack = escalateFromExecution(db, row, body.reason);
		return c.json(ack, ack.accepted ? 201 : 200);
	});
}

function registerBenchmarkRoutes(app: Hono, deps: ExecutionRoutesDeps): void {
	const { db } = deps;
	// ---- TSecBench 评测代理（Worker，短期执行令牌）----

	app.get("/internal/executions/:id/benchmark", async (c) => {
		const row = requireSelf(db, c);
		return benchmarkJson(c, await requireBenchmark(deps).status(row.project_id));
	});

	app.post("/internal/executions/:id/benchmark/reset", async (c) => {
		const row = requireSelf(db, c);
		// 所有步骤共享同一个常驻容器：重建会换地址并清空现场。必须拒绝在兄弟
		// 执行仍处于 queued/running 时执行，否则会毁掉它们正在用的会话与状态。
		const siblings = (
			db
				.prepare(
					`SELECT COUNT(*) AS n FROM executions
					 WHERE project_id = ? AND status IN ('queued', 'running') AND id <> ?`,
				)
				.get(row.project_id, row.id) as { n: number }
		).n;
		if (siblings > 0) {
			return benchmarkError(c, {
				code: "invalid_state",
				message:
					`${siblings} sibling execution(s) still running in the shared target container; ` +
					"rebuilding now would destroy their state. Retry after they finish.",
			});
		}
		return benchmarkJson(c, await requireBenchmark(deps).rebuild(row.project_id));
	});

	app.post("/internal/executions/:id/benchmark/submit", async (c) => {
		const row = requireSelf(db, c);
		const body = await parseBody(c, benchmarkSubmitSchema);
		const result = await requireBenchmark(deps).submit(row.project_id, body.flag);
		// 题目已通关：立刻掐掉其它在途执行，并给 Decide 一个外部信号让它尽快
		// 给根目标盖章。调用方自身那次执行必须留活 —— 它还要 submit_fact/conclude。
		if (
			result.ok &&
			result.data.total_flag_count > 0 &&
			result.data.correct_flag_count >= result.data.total_flag_count
		) {
			const stopped = stopProjectWorkExcept(db, row.project_id, row.id, utcnow());
			signalDecideExternal(db, row.project_id, "flags_complete");
			if (stopped > 0) {
				consoleLogger.info(
					`challenge solved project=${row.project_id} execution=${row.id}; stopped ${stopped} in-flight execution(s)`,
				);
			}
		}
		return benchmarkJson(c, result);
	});

	app.post("/internal/executions/:id/benchmark/hint", async (c) => {
		const row = requireSelf(db, c);
		// hint 是一次性、不可逆的扣分资源：要求并记录显式理由，作为授权与审计。
		const body = await parseBody(c, benchmarkHintSchema);
		const result = await requireBenchmark(deps).hint(row.project_id);
		if (!result.ok) return benchmarkError(c, result.error);
		consoleLogger.info(
			`benchmark hint used project=${row.project_id} execution=${row.id} reason=${body.reason}`,
		);
		return c.json({ hint: result.data });
	});

	// ---- TSecBench 评测控制面（driver / 运维，机器 token）----

	app.get("/internal/benchmark/challenges", async (c) => {
		requireMachineToken(deps, c);
		return benchmarkJson(c, await requireBenchmark(deps).listPlatformChallenges());
	});

	app.get("/internal/benchmark/tasks", (c) => {
		requireMachineToken(deps, c);
		return c.json(requireBenchmark(deps).listTasks());
	});

	app.post("/internal/benchmark/bind", async (c) => {
		requireMachineToken(deps, c);
		const body = await parseBody(c, benchmarkBindSchema);
		return benchmarkJson(
			c,
			await requireBenchmark(deps).bind({
				projectId: body.project_id,
				uniqueCode: body.unique_code,
				title: body.title,
				description: body.description,
				start: body.start,
			}),
		);
	});

	app.post("/internal/benchmark/:projectId/refresh", async (c) => {
		requireMachineToken(deps, c);
		return benchmarkJson(c, await requireBenchmark(deps).status(c.req.param("projectId")));
	});

	// 控制面兜底：容器被平台回收后重新拉起。driver 对进行中的项目自动调用，
	// 运维也可在 auto_start=false 时手动调用。
	app.post("/internal/benchmark/:projectId/start", async (c) => {
		requireMachineToken(deps, c);
		return benchmarkJson(c, await requireBenchmark(deps).start(c.req.param("projectId")));
	});

	app.post("/internal/benchmark/:projectId/close", async (c) => {
		requireMachineToken(deps, c);
		return benchmarkJson(c, await requireBenchmark(deps).close(c.req.param("projectId")));
	});

	app.post("/internal/benchmark/:projectId/reset", (c) => {
		requireMachineToken(deps, c);
		return benchmarkJson(c, requireBenchmark(deps).reset(c.req.param("projectId")));
	});
}

// ---- 内部 ----

/**
 * 心跳间隔（秒）。与租约 TTL 解耦：旧实现用 TTL/3，导致"加大 TTL 必然
 * 连带拉长心跳与取消延迟"；现在固定为 DEFAULT_HEARTBEAT_INTERVAL_S，仅
 * 保证显著小于 TTL（避免心跳间隔逼近租约到期时间）。
 */
function getHeartbeatIntervalS(db: Db): number {
	return heartbeatIntervalFor(getLeaseTimeout(db));
}

/** 只下发 Step.from 显式引用的事实，不扩展任何其它项目上下文。 */
function buildExecutionSourceFacts(
	db: Db,
	projectId: string,
	stepId: string,
): ExecutionSourceFact[] {
	return db
		.prepare(
			`SELECT f.id, f.description, f.confidence FROM step_sources s
			 JOIN facts f ON f.project_id = s.project_id AND f.id = s.fact_id
			 WHERE s.project_id = ? AND s.step_id = ? ORDER BY s.rowid`,
		)
		.all(projectId, stepId) as ExecutionSourceFact[];
}

/**
 * 组装 Worker 领取到的任务载荷。既有 claim 与项目 worker 的 next
 * 共用同一实现，避免两处漂移。
 */
async function buildExecutionTask(
	deps: ExecutionRoutesDeps,
	db: Db,
	row: ExecutionRowLike,
): Promise<ExecutionTask> {
	const project = getProjectOr404(db, row.project_id);
	const step = getStepOr404(db, row.project_id, row.step_id);
	const configuration = deps.configuration.store.readSnapshot(row.id);
	if (configuration === undefined) {
		throw new ApiError(409, "Activity configuration snapshot missing for this execution");
	}
	// 项目若绑定了 TSecBench 题目，随任务下发题目上下文（含靶场地址）。
	// 已进入终态的执行不再允许调用平台接口，因此 refresh=false 只读本地绑定。
	const benchmarkBinding =
		deps.benchmark === undefined
			? undefined
			: await deps.benchmark.status(row.project_id, { refresh: false });
	return {
		configuration,
		execution_id: row.id,
		project_id: row.project_id,
		step_id: row.step_id,
		attempt: row.attempt,
		lease_version: row.lease_version,
		worker: row.id,
		step_description: step.description,
		source_facts: buildExecutionSourceFacts(db, row.project_id, row.step_id),
		finding_schema: project.finding_schema === null ? null : JSON.parse(project.finding_schema),
		...(benchmarkBinding?.ok ? { benchmark: toBenchmarkContext(benchmarkBinding.data) } : {}),
		prompt: {},
		control_url: deps.workerControlUrl,
		timeouts: {
			step_ms: configuration.profile.run_seconds * 1000,
			harvest_ms: configuration.profile.harvest_seconds * 1000,
			grace_ms: getGraceMs(),
		},
		heartbeat_interval_s: getHeartbeatIntervalS(db),
		lease_timeout_s: getLeaseTimeout(db),
		bash_timeout_seconds: deps.bash_timeout_seconds,
		// 契约里 deadline_at 是非空字符串；创建 execution 时一定写入，这里仅为可空列类型兜底。
		deadline_at: row.deadline_at ?? "",
		// Worker 用它做启动自检：deadline 必须覆盖它自己的最坏耗时。
		// 由 created_at/deadline_at 反推，不额外存列。
		deadline_seconds: Math.max(
			0,
			Math.round((Date.parse(row.deadline_at ?? "") - Date.parse(row.created_at)) / 1000) || 0,
		),
	};
}

function requireSelf(
	db: Db,
	c: { req: { param: (k: string) => string; header: (n: string) => string | undefined } },
	allowTerminal = false,
): ExecutionRowLike {
	const token = bearerToken(c.req.header("authorization"));
	const row = requireExecutionByToken(db, token);
	if (row.id !== c.req.param("id")) {
		throw new ApiError(403, "Execution token does not match");
	}
	if (!allowTerminal) requireExecutionAlive(db, row);
	return row;
}

/** 项目令牌鉴权：令牌须属于路径中的项目；通过即刷新存活时间。 */
function requireProjectSelf(
	db: Db,
	c: { req: { param: (k: string) => string; header: (n: string) => string | undefined } },
): ProjectWorkerRow {
	const worker = requireProjectWorkerByToken(db, bearerToken(c.req.header("authorization")));
	if (worker.project_id !== c.req.param("projectId")) {
		throw new ApiError(403, "Project worker token does not match");
	}
	touchProjectWorker(db, worker.project_id);
	return worker;
}

function getProjectWorkerOr404(db: Db, projectId: string): ProjectWorkerRow {
	const row = getProjectWorker(db, projectId);
	if (row === undefined) throw new ApiError(404, "Project worker not found");
	return row;
}

const executionCreateSchema = z.object({
	project_id: z.string().min(1),
	step_id: z.string().min(1),
	execution_id: z.string().min(1),
});

const projectWorkerTokenSchema = z.object({
	container_name: z.string().min(1).max(200).nullish(),
});

const executionStatusSchema = z.object({
	status: z.enum(["failed", "cancelled", "lost"]),
	error: z.string().max(2000).nullish(),
	exit_code: z.number().int().nullish(),
});

const executionEventsSchema = z.object({
	events: z
		.array(
			z.object({
				seq: z.number().int(),
				line: z.string().min(1).max(8_000_000),
			}),
		)
		.max(500),
});

/** 执行协议里所有「图记录」共用的字段：幂等键与证据引用。 */
const executionRecordShape = {
	client_event_id: z.string().min(1).max(128).optional(),
	evidence: z.array(evidenceRefSchema).max(32).optional(),
};

const executionFactSchema = z.object({
	...factContentSchema.shape,
	...executionRecordShape,
});

const executionSignalSchema = z.object({
	reason: z.string().min(1).max(2000),
});

const executionFindingSchema = z.object({
	title: z.string().min(1).max(2000),
	description: z.string().min(1).max(100_000),
	data: z.unknown().optional(),
	fact_ids: z.array(z.string().min(1)).nullish(),
	...executionRecordShape,
});

const executionUsageSchema = z.object({
	model: z.string().min(1),
	...usageTokensShape,
});

const executionResultSchema = z
	.object({
		outcome: z.enum(["succeeded", "failed", "cancelled"]),
		// 与 Worker 工具侧共用同一份契约（见 contracts/execution.ts）。
		result: executionResultSubmissionSchema.optional(),
		error: z.string().max(4000).nullish(),
		dropped_events: z.number().int().nonnegative().optional(),
		usage: executionUsageSchema.optional(),
	})
	.strict()
	.refine((body) => body.outcome !== "succeeded" || body.result !== undefined, {
		message: "successful execution requires a structured result",
	});
const benchmarkSubmitSchema = z.object({
	flag: z.string().min(1).max(4096),
});

const benchmarkHintSchema = z.object({
	reason: z.string().min(1).max(500),
});

const benchmarkBindSchema = z.object({
	project_id: z.string().min(1),
	unique_code: z.string().min(1),
	title: z.string().min(1).max(2000).optional(),
	description: z.string().max(100_000).nullish(),
	start: z.boolean().optional(),
});

/** benchmark service 错误码 → HTTP 状态码（供 Worker / driver 分支处理）。 */
const BENCHMARK_HTTP_STATUS: Record<string, number> = {
	not_bound: 404,
	challenge_not_found: 404,
	task_not_found: 404,
	invalid_state: 409,
	duplicate: 409,
	already_completed: 409,
	already_bound: 409,
	resource_unavailable: 503,
	network_error: 502,
	validation_error: 422,
	internal_error: 500,
	unexpected_error: 502,
};

function requireBenchmark(deps: ExecutionRoutesDeps): BenchmarkService {
	if (deps.benchmark === undefined) {
		throw new ApiError(503, "TSecBench integration is not configured");
	}
	return deps.benchmark;
}

function benchmarkError(c: Context, error: { code: string; message: string }): Response {
	const status = BENCHMARK_HTTP_STATUS[error.code] ?? 500;
	return c.json({ code: error.code, message: error.message }, status as ContentfulStatusCode);
}

function benchmarkJson<T>(c: Context, result: BenchmarkServiceResult<T>): Response {
	if (result.ok) {
		return c.json(result.data as never);
	}
	return benchmarkError(c, result.error);
}

function toBenchmarkContext(binding: BenchmarkBinding): ExecutionBenchmarkContext {
	return {
		unique_code: binding.unique_code,
		title: binding.title,
		description: binding.description,
		difficulty: binding.difficulty,
		level: binding.level,
		total_score: binding.total_score,
		flag_count: binding.flag_count,
		correct_flag_count: binding.correct_flag_count,
		hint_used: binding.hint_used,
		container_status: binding.container_status,
		container_addr: binding.container_addr,
	};
}

function bearerToken(header: string | undefined): string | undefined {
	if (!header?.startsWith("Bearer ")) {
		return undefined;
	}
	const token = header.slice("Bearer ".length).trim();
	return token === "" ? undefined : token;
}
