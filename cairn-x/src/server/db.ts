import { installSessionIndex } from "./core/session-index.js";
import { installReadVersions } from "./core/read-versions.js";
import type { ProjectStatus, StepStatus, GoalStatus } from "../contracts/models.js";
import Database from "better-sqlite3";

export type Db = Database.Database;

/**
 * 预编译语句缓存。better-sqlite3 的 prepare() 每次都会重新编译 SQL，而守卫查找
 * （最热路径：几乎每个请求都会 getProjectOr404）与租约超时读在每个调用里都要执行。
 * 按连接缓存**字面量**语句；动态拼接 SQL 的查询不要走这里（缓存会无限增长）。
 */
const preparedStatements = new WeakMap<Db, Map<string, Database.Statement>>();
export function cachedPrepare(db: Db, sql: string): Database.Statement {
	let cache = preparedStatements.get(db);
	if (cache === undefined) {
		cache = new Map();
		preparedStatements.set(db, cache);
	}
	let statement = cache.get(sql);
	if (statement === undefined) {
		statement = db.prepare(sql);
		cache.set(sql, statement);
	}
	return statement;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
    -- 步骤租约 TTL（秒），不是执行预算：执行预算由 Agent profile 的
    -- run_seconds / harvest_seconds 决定（见 services.ts 的 getLeaseTimeout）。
    lease_timeout INTEGER NOT NULL DEFAULT 120,
    decide_timeout INTEGER NOT NULL DEFAULT 30
);

INSERT OR IGNORE INTO settings (rowid, lease_timeout, decide_timeout) VALUES (1, 120, 30);

CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL,
    finding_schema TEXT,
    experiment_id TEXT,
    harness_variant TEXT,
    decide_worker TEXT,
    decide_trigger TEXT,
    decide_started_at TEXT,
    decide_last_heartbeat_at TEXT,
    decide_expires_at TEXT
);

CREATE TABLE IF NOT EXISTS facts (
    id TEXT NOT NULL,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    description TEXT NOT NULL,
    confidence TEXT NOT NULL DEFAULT 'observed',
    step_id TEXT,
    execution_id TEXT,
    client_event_id TEXT,
    created_at TEXT NOT NULL,
    PRIMARY KEY (id, project_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_facts_client_event
    ON facts (project_id, client_event_id) WHERE client_event_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS goals (
    id TEXT NOT NULL,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    parent_goal_id TEXT,
    description TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    achieved_description TEXT,
    created_at TEXT NOT NULL,
    achieved_at TEXT,
    PRIMARY KEY (id, project_id)
);

CREATE TABLE IF NOT EXISTS steps (
    id TEXT NOT NULL,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    description TEXT NOT NULL,
    priority INTEGER NOT NULL DEFAULT 0,
    goal_id TEXT,
    status TEXT NOT NULL DEFAULT 'open',
    creator TEXT NOT NULL,
    worker TEXT,
    summary TEXT,
    last_heartbeat_at TEXT,
    lease_expires_at TEXT,
    lease_version INTEGER NOT NULL DEFAULT 0,
    waiting_on TEXT,
    route_id TEXT,
    created_at TEXT NOT NULL,
    concluded_at TEXT,
    PRIMARY KEY (id, project_id)
);

-- 攻击路线/假设：steps.route_id 指向一条路线，路线可整体放弃并级联取消其步骤。
CREATE TABLE IF NOT EXISTS routes (
    id TEXT NOT NULL,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    description TEXT NOT NULL,
    goal_id TEXT,
    creator TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (id, project_id)
);
CREATE INDEX IF NOT EXISTS idx_routes_project ON routes (project_id);

-- 每次执行尝试一行：dispatcher 分配 execution_id 并持有 step 租约；
-- queued 阶段不持有 Worker 凭据，项目 Worker 领取时才由控制端签发短期令牌。
CREATE TABLE IF NOT EXISTS executions (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    step_id TEXT NOT NULL,
    attempt INTEGER NOT NULL,
    lease_version INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued'
        CHECK (status IN ('queued','running','succeeded','failed','cancelled','lost')),
    cancel_requested INTEGER NOT NULL DEFAULT 0,
    token_hash TEXT,
    created_at TEXT NOT NULL,
    started_at TEXT,
    last_heartbeat_at TEXT,
    lease_expires_at TEXT,
    deadline_at TEXT,
    finished_at TEXT,
    result_outcome TEXT,
    summary TEXT,
    error TEXT,
    exit_code INTEGER,
    -- Worker 上报的轨迹丢行数（EventPump 缓冲溢出）；0 = 轨迹完整。
    dropped_events INTEGER NOT NULL DEFAULT 0,
    -- 终态后物化的确定性失败归类（见 core/execution-failure.ts）；NULL = 尚未归类。
    -- 规划投影直接读这两列，不必每轮为前沿里的每个失败尝试重扫一遍事件流。
    failure_class TEXT,
    failure_component TEXT
);
CREATE INDEX IF NOT EXISTS idx_executions_step ON executions (project_id, step_id, attempt);
CREATE INDEX IF NOT EXISTS idx_executions_status ON executions (status);
-- 短期执行令牌的身份入口（requireExecutionByToken）：Worker 的每个协议请求
-- （心跳、事件、结果、写图）都要按 token_hash 反查，没有索引就是全表扫描。
CREATE INDEX IF NOT EXISTS idx_executions_token ON executions (token_hash);

-- Execute 的结构化最终交付。它与 execution 一对一，不是新的图谱节点；
-- 使用独立表可让既有数据库通过 CREATE TABLE IF NOT EXISTS 平滑升级。
CREATE TABLE IF NOT EXISTS execution_results (
    execution_id TEXT PRIMARY KEY REFERENCES executions(id) ON DELETE CASCADE,
    schema_version INTEGER NOT NULL,
    payload TEXT NOT NULL,
    created_at TEXT NOT NULL
);

-- Worker 会话事件：按 execution 分组、seq 单调追加（幂等去重靠 session_seq 推进）。
CREATE TABLE IF NOT EXISTS execution_events (
    execution_id TEXT NOT NULL REFERENCES executions(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    line TEXT NOT NULL,
    PRIMARY KEY (execution_id, seq)
);

CREATE TABLE IF NOT EXISTS step_sources (
    step_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    fact_id TEXT NOT NULL,
    PRIMARY KEY (step_id, project_id, fact_id),
    FOREIGN KEY (step_id, project_id) REFERENCES steps(id, project_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS findings (
    id TEXT NOT NULL,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    data TEXT,
    fact_ids TEXT NOT NULL DEFAULT '[]',
    step_id TEXT,
    execution_id TEXT,
    client_event_id TEXT,
    created_at TEXT NOT NULL,
    PRIMARY KEY (id, project_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_findings_client_event
    ON findings (project_id, client_event_id) WHERE client_event_id IS NOT NULL;

-- TSecBench 评测任务绑定：一个 Cairn 项目对应一道平台题目。
-- 绑定由控制端（benchmark driver）创建；Worker 通过执行协议读取并代理
-- submit/hint，平台 token 只留在控制端。
CREATE TABLE IF NOT EXISTS benchmark_tasks (
    project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
    unique_code TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    difficulty TEXT NOT NULL DEFAULT '',
    level INTEGER NOT NULL DEFAULT 0,
    total_score INTEGER NOT NULL DEFAULT 0,
    flag_count INTEGER NOT NULL DEFAULT 0,
    correct_flag_count INTEGER NOT NULL DEFAULT 0,
    is_completed INTEGER NOT NULL DEFAULT 0,
    container_status TEXT NOT NULL DEFAULT 'stopped',
    container_addr TEXT NOT NULL DEFAULT '[]',
    hint_used INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    closed_at TEXT,
    -- 最近一次成功启动/重建容器的时刻；平台 2 小时运行时上限以此为基准。
    container_started_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_benchmark_tasks_code ON benchmark_tasks (unique_code);

-- Goal 完成证据：类型化的 Fact/Finding 引用（替换 goals.from_fact_ids）。
CREATE TABLE IF NOT EXISTS goal_evidence (
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    goal_id TEXT NOT NULL,
    evidence_type TEXT NOT NULL CHECK (evidence_type IN ('fact','finding')),
    evidence_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (project_id, goal_id, evidence_type, evidence_id)
);

-- Fact/Finding 的原始资料引用：已落盘的具体 ExecutionEvent。
-- ref_key 规范化去重。
CREATE TABLE IF NOT EXISTS evidence_refs (
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    subject_type TEXT NOT NULL CHECK (subject_type IN ('fact','finding')),
    subject_id TEXT NOT NULL,
    ref_key TEXT NOT NULL,
    execution_id TEXT NOT NULL,
    event_seq INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (project_id, subject_type, subject_id, ref_key)
);

CREATE TABLE IF NOT EXISTS hints (
    id TEXT NOT NULL,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    creator TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (id, project_id)
);

-- Explicit human choice; ordinary hints remain consumed by the planning watermark.
CREATE TABLE IF NOT EXISTS persistent_hints (
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    hint_id TEXT NOT NULL,
    PRIMARY KEY(project_id, hint_id),
    FOREIGN KEY(hint_id, project_id) REFERENCES hints(id, project_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS usage_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    activity TEXT NOT NULL CHECK (activity IN ('decide', 'execute')),
    step_id TEXT,
    -- 产生该笔用量的执行；由执行协议端点自动填充（Decide 用量为 NULL）。
    -- 取消/失联的执行由控制端从轨迹回填，靠它做幂等与按 attempt 归属。
    execution_id TEXT,
    -- 产生该笔用量的会话轨迹文件名；只有 Decide 会填（Execute 走 execution_id）。
    -- 运行结束时的一次性上报可能丢失，控制端按这个文件名从轨迹回填同一笔。
    source_file TEXT,
    model TEXT NOT NULL,
    input_tokens INTEGER NOT NULL,
    output_tokens INTEGER NOT NULL,
    cache_read_tokens INTEGER NOT NULL DEFAULT 0,
    cache_write_tokens INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_usage_events_project ON usage_events (project_id, activity);
-- 按执行查用量（recordUsage 的幂等检查、backfillExecutionUsage 的存在性检查）：
-- 两个都是热路径，且回填会在 expireWorkers 的事务里对每个失联执行逐个调用。
CREATE INDEX IF NOT EXISTS idx_usage_events_execution ON usage_events (execution_id);
-- 同一个 (项目, 会话文件) 只记一笔，上报与轨迹回填谁先到都幂等；
-- Execute 行的 source_file 为 NULL，而 SQLite 的唯一索引不约束 NULL。
CREATE UNIQUE INDEX IF NOT EXISTS idx_usage_events_source ON usage_events (project_id, source_file);

CREATE INDEX IF NOT EXISTS idx_facts_project ON facts (project_id);
CREATE INDEX IF NOT EXISTS idx_goals_project ON goals (project_id);
CREATE INDEX IF NOT EXISTS idx_findings_project ON findings (project_id);
CREATE INDEX IF NOT EXISTS idx_hints_project ON hints (project_id);
CREATE INDEX IF NOT EXISTS idx_steps_project_status ON steps (project_id, status);
CREATE INDEX IF NOT EXISTS idx_steps_dispatchable ON steps(project_id,priority DESC,created_at DESC,id DESC) WHERE status='open' AND worker IS NULL;
CREATE INDEX IF NOT EXISTS idx_step_sources_project ON step_sources (project_id, step_id);

CREATE TABLE IF NOT EXISTS counters (
    name TEXT PRIMARY KEY,
    value INTEGER NOT NULL DEFAULT 0
);

INSERT OR IGNORE INTO counters (name, value) VALUES ('project', 0);

CREATE TABLE IF NOT EXISTS scoped_counters (
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    value INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (project_id, kind)
);

CREATE TABLE IF NOT EXISTS decide_checkpoints (
    project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
    planning_version INTEGER NOT NULL DEFAULT 0,
    fact_count INTEGER NOT NULL,
    hint_count INTEGER NOT NULL,
    open_step_count INTEGER NOT NULL,
    goal_count INTEGER NOT NULL,
    finding_count INTEGER NOT NULL,
    last_trigger TEXT,
    last_completed_by TEXT,
    external_signal TEXT,
    -- 上一次 Decide 是否空转（既未新建也未废弃任何步骤）；用于抑制空转 Decide。
    last_noop INTEGER NOT NULL DEFAULT 0,
    -- 上次完成规划实际读取的 fact 水位线（不是 complete 时的最新事实）。
    last_fact_id TEXT,
    observed_seq INTEGER NOT NULL DEFAULT 0,
    unread_changes INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
);

-- 规划输入的轻量变更日志；序号不因删除/重启而复用。
CREATE TABLE IF NOT EXISTS decide_changes (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('fact','finding','hint','goal','signal')),
    actor TEXT,
    detail TEXT,
    subject_id TEXT,
    operation TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_decide_changes_project ON decide_changes (project_id, seq);

-- 每项目只保留当前认领者最后一次全图读取的服务端水位。
CREATE TABLE IF NOT EXISTS decide_reads (
    project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
    worker TEXT NOT NULL,
    observed_seq INTEGER NOT NULL,
    last_fact_id TEXT,
    coverage_complete INTEGER NOT NULL DEFAULT 0,
    next_cursor TEXT,
    cursor_state TEXT
);

-- Acknowledgements for graph creation retries; removed with the project.
CREATE TABLE IF NOT EXISTS decide_mutations (
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    worker TEXT NOT NULL,
    operation TEXT NOT NULL,
    request_id TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    response_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (project_id, worker, operation, request_id)
);

-- 项目级常驻 Worker：一个 active 项目最多一个
-- 常驻容器。项目令牌只存哈希，容器内的并发 step 循环用它换取每次执行的短期
-- 令牌；容器停止后令牌立即失效。
CREATE TABLE IF NOT EXISTS project_workers (
    project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending','running','stopped')),
    container_name TEXT,
    created_at TEXT NOT NULL,
    last_seen_at TEXT,
    stopped_at TEXT
);

`;

export interface ProjectRow {
	id: string;
	title: string;
	status: ProjectStatus;
	created_at: string;
	finding_schema: string | null;
	experiment_id: string | null;
	harness_variant: string | null;
	decide_worker: string | null;
	decide_trigger: string | null;
	decide_started_at: string | null;
	decide_last_heartbeat_at: string | null;
}

/** 项目级常驻 Worker 注册行（token 只存哈希）。 */
export interface ProjectWorkerRow {
	project_id: string;
	token_hash: string;
	status: "pending" | "running" | "stopped";
	container_name: string | null;
	created_at: string;
	last_seen_at: string | null;
	stopped_at: string | null;
}

export interface FactRow {
	id: string;
	project_id: string;
	description: string;
	confidence: "observed" | "inferred";
	step_id: string | null;
	execution_id: string | null;
	created_at: string;
}

export interface GoalRow {
	id: string;
	project_id: string;
	parent_goal_id: string | null;
	description: string;
	status: GoalStatus;
	achieved_description: string | null;
	created_at: string;
	achieved_at: string | null;
}

export interface StepRow {
	summary: string | null;
	id: string;
	project_id: string;
	description: string;
	priority: number;
	goal_id: string | null;
	status: StepStatus;
	creator: string;
	worker: string | null;
	last_heartbeat_at: string | null;
	lease_version: number;
	lease_expires_at: string | null;
	/** JSON 数组：本步骤派发前必须先 concluded 的步骤 id。 */
	waiting_on: string | null;
	/** 所属攻击路线 id（routes.id）；未归入路线为 null。 */
	route_id: string | null;
	created_at: string;
	concluded_at: string | null;
}

export interface RouteRow {
	id: string;
	project_id: string;
	description: string;
	goal_id: string | null;
	creator: string;
	created_at: string;
}

export interface FindingRow {
	id: string;
	project_id: string;
	title: string;
	description: string;
	data: string | null;
	fact_ids: string;
	step_id: string | null;
	execution_id: string | null;
	created_at: string;
}

export interface HintRow {
	id: string;
	project_id: string;
	content: string;
	creator: string;
	created_at: string;
}

export interface BenchmarkTaskRow {
	project_id: string;
	unique_code: string;
	title: string;
	description: string | null;
	difficulty: string;
	level: number;
	total_score: number;
	flag_count: number;
	correct_flag_count: number;
	is_completed: number;
	container_status: string;
	container_addr: string;
	hint_used: number;
	created_at: string;
	updated_at: string;
	closed_at: string | null;
	container_started_at: string | null;
}

export interface UsageEventRow {
	id: number;
	project_id: string;
	activity: "decide" | "execute";
	step_id: string | null;
	execution_id: string | null;
	source_file: string | null;
	model: string;
	input_tokens: number;
	output_tokens: number;
	cache_read_tokens: number;
	cache_write_tokens: number;
	created_at: string;
}

/** DB 触发器覆盖所有写入入口（包括离线写库）；自身规划修改由服务层标注 actor。 */
function ensureDecideChangeTriggers(db: Db): void {
	db.transaction(() => {
		for (const [table, kind] of [
			["facts", "fact"],
			["findings", "finding"],
			["hints", "hint"],
			["goals", "goal"],
		]) {
			for (const operation of ["INSERT", "UPDATE", "DELETE"]) {
				const ref = operation === "DELETE" ? "OLD" : "NEW";
				const name = `decide_change_${table}_${operation.toLowerCase()}`;
				db.exec(`DROP TRIGGER IF EXISTS ${name}`);
				db.exec(`CREATE TRIGGER ${name}
				AFTER ${operation} ON ${table} BEGIN
					INSERT INTO decide_changes (project_id, kind, subject_id, operation)
					SELECT ${ref}.project_id, '${kind}', ${ref}.id, '${operation.toLowerCase()}'
					WHERE EXISTS (SELECT 1 FROM projects WHERE id = ${ref}.project_id);
				END`);
			}
		}
	}).immediate();
}

export function openDatabase(path: string): Db {
	const db = new Database(path);
	db.pragma("journal_mode = WAL");
	db.pragma("foreign_keys = ON");
	db.exec(SCHEMA);
	for (const table of ["facts", "goals", "steps", "findings", "hints", "routes"])
		db.exec(
			`CREATE INDEX IF NOT EXISTS idx_${table}_history ON ${table}(project_id,LENGTH(id),id)`,
		);
	for (const table of ["projects", "facts", "goals", "steps", "findings", "hints"])
		db.exec(
			`CREATE INDEX IF NOT EXISTS idx_${table}_created ON ${table}(${table === "projects" ? "" : "project_id,"}created_at DESC,id DESC)`,
		);
	db.exec(
		"CREATE INDEX IF NOT EXISTS idx_steps_concluded ON steps(project_id,concluded_at DESC,id DESC); CREATE INDEX IF NOT EXISTS idx_goals_achieved ON goals(project_id,achieved_at DESC,id DESC)",
	);
	ensureDecideChangeTriggers(db);
	installReadVersions(db);
	installSessionIndex(db);
	return db;
}
