/**
 * Decide 持久化规划版本与触发控制（阶段四）。
 *
 * - 规划 checkpoint 存于 decide_checkpoints 表（每项目一行），
 *   dispatcher 重启后从最后完成的 checkpoint 恢复，不丢待触发变更。
 * - 触发由服务端在认领时从持久化 checkpoint 与变更日志计算；
 *   dispatcher 只提交 min_interval 节奏参数，不再本地 diff。
 * - 触发是提示，不自动成为下一阶段输入的一部分；权威状态永远以
 *   get_graph 为准。
 * - 触发枚举：initial_run / fact_added / finding_added / hint_added /
 *   goal_changed / waiting_timeout / external_signal。Execute 在途时 Fact/Finding
 *   只积累，批次边界信号（Step 完成 step_completed / 未耗尽失败
 *   step_attempt_failed）后开放证据触发；complete 只确认最后读图水位；
 *   未读外部变化留给下一轮，自身修改按 actor 排除，不支持自主心跳触发。
 * - planning_version 每次 complete 递增，complete 携带 CAS 校验；
 *   崩溃恢复通过“checkpoint 只在 complete 时前进”自然获得。
 */

import type { Db } from "../db.js";
import { ApiError, utcnow } from "./base.js";
import { compareScopedIds } from "../../contracts/graph.js";
import {
	decideSignalPreview,
	getDecideRead,
	latestDecideChange,
	pendingDecideChanges,
	pendingDecideSignals,
	saveDecideRead,
} from "./decide-changes.js";

interface DecideCounts {
	fact_count: number;
	hint_count: number;
	open_step_count: number;
	/** 项目的全部步骤（任意状态）；空图判定用，见 computeDecideTrigger 的空图保护。 */
	total_step_count: number;
	/** 当前正在执行的步骤；用于把自动证据触发推迟到至少一个 Step 完成。 */
	claimed_step_count: number;
	goal_count: number;
	finding_count: number;
}

interface CheckpointRow {
	project_id: string;
	planning_version: number;
	fact_count: number;
	hint_count: number;
	open_step_count: number;
	goal_count: number;
	finding_count: number;
	last_trigger: string | null;
	last_completed_by: string | null;
	external_signal: string | null;
	/** 上一次 Decide 是否空转（0/1）；见 computeDecideTrigger 的空转抑制。 */
	last_noop: number;
	/** 上次完成规划实际读取的 fact 水位。 */
	last_fact_id: string | null;
	observed_seq: number;
	/** complete 时仍有未读外部输入：下一轮不受 fact 批量阈值抑制。 */
	unread_changes: number;
	updated_at: string;
}

/** 空转之后，事实至少再攒这么多条才重新触发 Decide（避免逐条事实空转）。 */
const NOOP_FACT_THRESHOLD = 3;
/**
 * 有产出的 Decide 之后，事实要再攒这么多条才在下一个 Step 完成边界参与规划。
 *
 * Decide 每次都要重读全图并重新规划（其输出 token 甚至超过 Execute 总和）。
 * 单条事实通常只是当前计划内的新观测，不足以推翻计划；先积累、再在 Step 完成
 * 边界统一吸收，能把 Decide 次数显著压下来。
 * finding_added 与 Fact 一样在 Execute 运行中先积累；步骤耗尽、完成边界和
 * 外部信号仍可直接触发 —— 那些才真正改变计划。
 */
const FACT_THRESHOLD = 2;

/** 一次原始规划和一次自动重试均中断后，等待新的输入或人工重规划。 */
export const MAX_CONSECUTIVE_DECIDE_INTERRUPTS = 2;

/** 只看最后连续的中断；新步骤结果、人工信号或提示会开启新的尝试窗口。 */
export function pendingDecideInterruptions(db: Db, projectId: string): number {
	const observedSeq = getCheckpoint(db, projectId)?.observed_seq ?? 0;
	const rows = db
		.prepare(
			`SELECT kind, detail FROM decide_changes WHERE project_id = ? AND seq > ?
			 AND kind IN ('signal', 'hint')
			 ORDER BY seq DESC LIMIT ?`,
		)
		.all(projectId, observedSeq, MAX_CONSECUTIVE_DECIDE_INTERRUPTS) as Array<{
		kind: string;
		detail: string | null;
	}>;
	let count = 0;
	for (const row of rows) {
		if (row.kind !== "signal" || row.detail !== "decide_interrupted") break;
		count++;
	}
	return count;
}

function decideCounts(db: Db, projectId: string): DecideCounts {
	// 一次聚合取七个计数：dispatcher 每个 tick 都会对每个无租约项目尝试认领，
	// 七个独立 COUNT 会把这份开销乘以 7。
	return db
		.prepare(
			`SELECT
			   (SELECT COUNT(*) FROM facts WHERE project_id = ?) AS fact_count,
			   (SELECT COUNT(*) FROM hints WHERE project_id = ?) AS hint_count,
			   (SELECT COUNT(*) FROM goals WHERE project_id = ?) AS goal_count,
			   (SELECT COUNT(*) FROM findings WHERE project_id = ?) AS finding_count,
			   (SELECT COUNT(*) FROM steps WHERE project_id = ? AND status IN ('open','claimed')) AS open_step_count,
			   (SELECT COUNT(*) FROM steps WHERE project_id = ? AND status = 'claimed') AS claimed_step_count,
			   (SELECT COUNT(*) FROM steps WHERE project_id = ?) AS total_step_count`,
		)
		.get(
			projectId,
			projectId,
			projectId,
			projectId,
			projectId,
			projectId,
			projectId,
		) as DecideCounts;
}

export function getCheckpoint(db: Db, projectId: string): CheckpointRow | null {
	return (
		(db.prepare("SELECT * FROM decide_checkpoints WHERE project_id = ?").get(projectId) as
			CheckpointRow | undefined) ?? null
	);
}

/**
 * 新 Execute 的服务端调度屏障：Step 完成、耗尽失败或规划中断已经交回规划器，但尚未被
 * 一次完成的 Decide checkpoint 覆盖时，不允许领取下一条 open Step。
 * 已经 claimed/running 的旧批次执行不受影响。
 */
export function hasPendingStepResultBarrier(db: Db, projectId: string): boolean {
	const observedSeq = getCheckpoint(db, projectId)?.observed_seq ?? 0;
	return (
		db
			.prepare(
				`SELECT 1 AS pending FROM decide_changes
				 WHERE project_id = ? AND seq > ? AND kind = 'signal'
				 AND (detail LIKE 'step_completed:%' OR detail IN ('step_failed', 'decide_interrupted'))
				 LIMIT 1`,
			)
			.get(projectId, observedSeq) !== undefined
	);
}

/** 当前最大 fact id（compareScopedIds 序）；无事实时返回 null。
 * 排除 origin：按 compareScopedIds「先长度后字典」，"origin"(6) 永远大于
 * 任何 f-id(4+)，混进去会让水位线退化成「所有事实都是旧的」。 */
function maxFactId(db: Db, projectId: string): string | null {
	const rows = db
		.prepare("SELECT id FROM facts WHERE project_id = ? AND id <> 'origin'")
		.all(projectId) as Array<{ id: string }>;
	let max: string | null = null;
	for (const { id } of rows) {
		if (max === null || compareScopedIds(id, max) > 0) max = id;
	}
	return max;
}

/** 认领时从已完成 checkpoint 起步；未真正读取 planning view 时不得确认新输入。 */
export function beginDecideRead(db: Db, projectId: string, worker: string): void {
	const checkpoint = getCheckpoint(db, projectId);
	saveDecideRead(db, projectId, worker, {
		observed_seq: checkpoint?.observed_seq ?? 0,
		last_fact_id: checkpoint?.last_fact_id ?? null,
		coverage_complete: 0,
		next_cursor: null,
		cursor_state: null,
	});
}

function insertBaseline(db: Db, projectId: string, counts: DecideCounts): void {
	db.prepare(
		`INSERT OR IGNORE INTO decide_checkpoints
		 (project_id, planning_version, fact_count, hint_count, open_step_count, goal_count,
		  finding_count, last_trigger, last_completed_by, external_signal, last_noop, last_fact_id, observed_seq, updated_at)
		 VALUES (?, 0, ?, ?, ?, ?, ?, NULL, NULL, NULL, 0, ?, ?, ?)`,
	).run(
		projectId,
		counts.fact_count,
		counts.hint_count,
		counts.open_step_count,
		counts.goal_count,
		counts.finding_count,
		maxFactId(db, projectId),
		latestDecideChange(db, projectId),
		utcnow(),
	);
}

/**
 * 计算认领触发；无触发返回 null。副作用：首次见到有在办步骤的
 * 项目时写入静默基线（不触发，与 dispatcher 旧行为一致）。
 */
export function computeDecideTrigger(
	db: Db,
	projectId: string,
	minIntervalSeconds: number,
): { trigger: string; planningVersion: number } | null {
	const counts = decideCounts(db, projectId);
	const open = counts.open_step_count;
	const cp = getCheckpoint(db, projectId);
	if (cp === null) {
		if (open === 0) {
			return { trigger: "initial_run", planningVersion: 0 };
		}
		insertBaseline(db, projectId, counts);
		return null;
	}
	if (pendingDecideInterruptions(db, projectId) >= MAX_CONSECUTIVE_DECIDE_INTERRUPTS) return null;
	const parts: string[] = [];
	const pending = new Map(
		pendingDecideChanges(db, projectId, cp.observed_seq, cp.last_completed_by).map(
			({ kind, count }) => [kind, count],
		),
	);
	const pendingSignals = pendingDecideSignals(db, projectId, cp.observed_seq, cp.last_completed_by);
	// 批次边界信号：Step 完成（step_completed:*）与未耗尽的尝试失败
	// （step_attempt_failed）。二者的结果都已交回规划器，重规划优先于
	// min_interval 节流，且允许本轮吸收 Execute 在途积累的证据。
	const stepResultSignal = pendingSignals.some(
		({ detail }) => detail?.startsWith("step_completed:") || detail === "step_attempt_failed",
	);
	// Execute 会实时写 Fact/Finding，但这些中间产物不应在步骤尚未结束时反复
	// 唤醒 Decide。只有出现批次边界信号（完成/失败已交回），或项目当前没有
	// 在途 Execute 时，才允许证据变化参与触发。边界信号保证每个交回的结果
	// —— 成功 summary 或失败尝试的事实 —— 都有一次规划机会。
	const acceptEvidenceChanges = stepResultSignal || counts.claimed_step_count === 0;
	// 触发只认变更日志（DB 触发器覆盖所有写入入口），计数只用于展示文案。
	const factDelta = pending.get("fact") ?? 0;
	// 空转抑制：上一次 Decide 既没新建也没废弃任何步骤（last_noop=1）说明当前
	// 计划已经够用，此时只有事实又攒够一批才值得再跑一轮。没有这层抑制时，
	// 每来 1 条事实就空转一次 Decide。
	const factThreshold =
		cp.unread_changes === 1 ? 1 : cp.last_noop === 1 ? NOOP_FACT_THRESHOLD : FACT_THRESHOLD;
	if (acceptEvidenceChanges && factDelta >= factThreshold)
		parts.push(`fact_added:${cp.fact_count}->${counts.fact_count}`);
	if (acceptEvidenceChanges && pending.has("finding"))
		parts.push(`finding_added:${cp.finding_count}->${counts.finding_count}`);
	if (pending.has("hint")) parts.push(`hint_added:${cp.hint_count}->${counts.hint_count}`);
	if (pending.has("goal")) parts.push(`goal_changed:${cp.goal_count}->${counts.goal_count}`);
	if (cp.external_signal !== null) parts.push(`external_signal:${cp.external_signal}`);
	// 无事可做兜底：既没有 open 也没有 claimed 的步骤（全部结束/被放弃
	// 且上一轮 decide 未产出新步骤）时总会附带 waiting_timeout，
	// 与其他变更触发叠加。受 min_interval 节奏约束。
	if (open === 0) {
		// 从「有步骤」跌到「没步骤」总是唤醒一次；但如果上一轮 Decide 已经空转过
		// （既没建也没废步骤），重放同一份图不会得到不同结果 —— 不再无脑补
		// waiting_timeout，否则 open==0 的项目会被每 min_interval 唤醒一次。
		// 新事实/finding/外部信号仍会立即重新触发（即上面的 parts 非空）。
		const transitioned = cp.open_step_count > 0;
		// 空图保护：项目从未产出过任何步骤（total==0）时不能套用空转抑制。
		// 这不是「计划已够用」，而是首轮 Decide 没能给出计划（例如模型只输出
		// 思考、没调用 add_step）。若一并抑制，open==0 + last_noop==1 会让项目
		// 永久冻结，只能靠人工 external_signal 救活（a-09 曾因此空转 74 分钟）。
		// 仍受 min_interval 节流，因此它按节奏重试而不是每 tick 热循环。
		const neverPlanned = counts.total_step_count === 0;
		if (transitioned || cp.last_noop !== 1 || parts.length > 0 || neverPlanned) {
			parts.push(transitioned ? `waiting_timeout:${cp.open_step_count}->0` : "waiting_timeout");
		}
	}
	if (parts.length === 0) return null;
	// 批次边界信号（Step 完成 / 尝试失败）优先于节流：否则空出的并发槽可能
	// 先被旧 open Step 补位，违背“完成一个 Step → 先 Decide → 再派发”的调度语义。
	if (minIntervalSeconds > 0 && !stepResultSignal) {
		// 节流基准取「checkpoint 更新时间」与「上次认领时间」的较大者：
		// 认领后没能 complete（崩溃、租约过期，或规划未读满必需内容被服务端拒绝）
		// 时 checkpoint 不前进，只看 updated_at 会让重试每 tick 热跑。
		// 正常收尾两轮时 updated_at 更新，基准不变。
		const claimStartedAt = (
			db.prepare("SELECT decide_started_at FROM projects WHERE id = ?").get(projectId) as
				{ decide_started_at: string | null } | undefined
		)?.decide_started_at;
		const baseline = Math.max(
			Date.parse(cp.updated_at),
			claimStartedAt ? Date.parse(claimStartedAt) : 0,
		);
		const elapsed = Date.now() - baseline;
		if (cp.last_trigger !== null && elapsed < minIntervalSeconds * 1000) return null;
	}
	return { trigger: parts.join(","), planningVersion: cp.planning_version };
}

/**
 * 判断这次 Decide 是否真的改动了图谱：只统计「新建步骤」与「废弃步骤」这两类
 * Decide 独占写的动作。两个信号都取不到写入证据才认定为空转 —— 保守取向，
 * 宁可多跑一轮 Decide，也不要把真有产出的 decide 记成空转后按空转抑制。
 */
function decideWroteGraph(db: Db, projectId: string, worker: string): boolean {
	const byCreator = (
		db
			.prepare("SELECT COUNT(*) AS n FROM steps WHERE project_id = ? AND creator = ?")
			.get(projectId, worker) as { n: number }
	).n;
	if (byCreator > 0) return true;
	const startedAt = (
		db.prepare("SELECT decide_started_at FROM projects WHERE id = ?").get(projectId) as
			{ decide_started_at: string | null } | undefined
	)?.decide_started_at;
	if (startedAt === null || startedAt === undefined) return false;
	// 严格大于：created_at 只精确到秒，用 >= 会把「认领前同一秒里创建的步骤」
	// 误算成本轮的产出，把真正的空转记成有产出，空转抑制随即失效。
	const created = (
		db
			.prepare("SELECT COUNT(*) AS n FROM steps WHERE project_id = ? AND created_at > ?")
			.get(projectId, startedAt) as { n: number }
	).n;
	if (created > 0) return true;
	const abandoned = (
		db
			.prepare(
				"SELECT COUNT(*) AS n FROM steps WHERE project_id = ? AND status = 'abandoned' AND concluded_at IS NOT NULL AND concluded_at >= ?",
			)
			.get(projectId, startedAt) as { n: number }
	).n;
	return abandoned > 0;
}

/** complete 的 CAS 提交：返回最新 planning_version。 */
export function completeDecide(
	db: Db,
	projectId: string,
	worker: string,
	planningVersion: number,
	decideTrigger: string | null,
): { planning_version: number } {
	const cp = getCheckpoint(db, projectId);
	// 幂等确认：同一 worker 已把版本推进到下一版（网络重试）。
	if (
		cp !== null &&
		cp.planning_version === planningVersion + 1 &&
		cp.last_completed_by === worker
	) {
		return { planning_version: cp.planning_version };
	}
	const currentVersion = cp?.planning_version ?? 0;
	if (currentVersion !== planningVersion) {
		throw new ApiError(
			409,
			`Planning version is stale (expected ${currentVersion}, got ${planningVersion}); another decide completed first`,
		);
	}
	const currentCounts = decideCounts(db, projectId);
	// 认领时（beginDecideRead）已预置读取水位；运行期间带身份的全图读取会推进它。
	const recordedRead = getDecideRead(db, projectId, worker);
	if (recordedRead === undefined) {
		throw new ApiError(409, "Decide read watermark missing; the claim did not seed it");
	}
	if (recordedRead.coverage_complete !== 1) {
		throw new ApiError(
			409,
			recordedRead.next_cursor
				? `Planning graph coverage incomplete; continue get_graph with cursor ${recordedRead.next_cursor}`
				: "Planning graph has not been read; call get_graph with view=planning",
		);
	}
	const signals = pendingDecideSignals(db, projectId, recordedRead.observed_seq, worker);
	const remainingSignal = signals.at(-1)?.detail ?? null;
	const unread = pendingDecideChanges(db, projectId, recordedRead.observed_seq, worker).length > 0;
	const noop = decideWroteGraph(db, projectId, worker) ? 0 : 1;
	db.prepare(
		`INSERT INTO decide_checkpoints
		 (project_id, planning_version, fact_count, hint_count, open_step_count, goal_count,
		  finding_count, last_trigger, last_completed_by, external_signal, last_noop, last_fact_id, observed_seq, unread_changes, updated_at)
		 VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(project_id) DO UPDATE SET
		   planning_version = planning_version + 1,
		   fact_count = excluded.fact_count,
		   hint_count = excluded.hint_count,
		   open_step_count = excluded.open_step_count,
		   goal_count = excluded.goal_count,
		   finding_count = excluded.finding_count,
		   last_trigger = excluded.last_trigger,
		   last_completed_by = excluded.last_completed_by,
		   external_signal = excluded.external_signal,
		   last_noop = excluded.last_noop,
		   last_fact_id = excluded.last_fact_id,
		   observed_seq = excluded.observed_seq,
		   unread_changes = excluded.unread_changes,
		   updated_at = excluded.updated_at`,
	).run(
		projectId,
		currentCounts.fact_count,
		currentCounts.hint_count,
		currentCounts.open_step_count,
		currentCounts.goal_count,
		currentCounts.finding_count,
		decideTrigger,
		worker,
		remainingSignal,
		noop,
		recordedRead.last_fact_id,
		recordedRead.observed_seq,
		unread ? 1 : 0,
		utcnow(),
	);
	return { planning_version: planningVersion + 1 };
}

/**
 * 置 Decide 外部信号（下一次认领以 external_signal 触发，消费一次即清除）。
 *
 * 调用方直接传入 actor，用于区分级联取消、执行丢失等内部来源（无来源时省略）。
 * 首轮规划中断等场景可能还没有 checkpoint；此时补建基线，但不消费本次信号。
 *
 * operation 让调用方标注信号来源（如执行者的升级上报），只影响变更记录的
 * operation 字段与按来源去重；触发语义与对外信号完全一致。
 */
export function signalDecideExternal(
	db: Db,
	projectId: string,
	signal: string,
	actor?: string | null,
	subjectId?: string | null,
	operation = "signal",
): void {
	db.transaction(() => {
		db.prepare(
			`INSERT INTO decide_changes (project_id, kind, actor, detail, subject_id, operation)
			 VALUES (?, 'signal', ?, ?, ?, ?)`,
		).run(projectId, actor ?? null, signal, subjectId ?? null, operation);
		// 没有 checkpoint 行时按当前图计数补一条基线再挂信号（等价于
		// 「补基线 + 置信号」两步）。
		// 基线水位从 0 起：还没有任何一轮 Decide 完成过，此前的 hint/事实都没被读过；
		// 若取当前最新 seq，首轮规划中断后这些变更会被当成已读，从此不再进入规划页。
		// 注意 SELECT ... ON CONFLICT 必须带 WHERE 子句，否则 SQLite 无法区分
		// UPSERT 的 ON 与 JOIN 的 ON。
		db.prepare(
			`INSERT INTO decide_checkpoints
		 (project_id, planning_version, fact_count, hint_count, open_step_count, goal_count,
		  finding_count, last_trigger, last_completed_by, external_signal, last_noop, observed_seq, updated_at)
		 SELECT ?, 0,
		   (SELECT COUNT(*) FROM facts WHERE project_id = ?),
		   (SELECT COUNT(*) FROM hints WHERE project_id = ?),
		   (SELECT COUNT(*) FROM steps WHERE project_id = ? AND status IN ('open','claimed')),
		   (SELECT COUNT(*) FROM goals WHERE project_id = ?),
		   (SELECT COUNT(*) FROM findings WHERE project_id = ?),
		   NULL, NULL, ?, 0, ?, ?
		 WHERE true
		 ON CONFLICT(project_id) DO UPDATE SET external_signal = excluded.external_signal`,
		).run(
			projectId,
			projectId,
			projectId,
			projectId,
			projectId,
			projectId,
			decideSignalPreview(signal, operation),
			0,
			utcnow(),
		);
	})();
}
