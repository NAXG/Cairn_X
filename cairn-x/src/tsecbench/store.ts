/**
 * TSecBench 题目绑定存储：Cairn 项目 ↔ 平台 unique_code 的唯一映射。
 *
 * 平台 token 不下发到 Worker；Worker 只按 execution 解析出的 project_id
 * 读取这里的绑定，再经控制端代理调用平台。绑定是运行期路由信息，因此
 * 落在主库（与 executions 同级），项目删除时级联清理。
 */

import type { BenchmarkTaskRow, Db } from "../server/db.js";
import type { Challenge, ContainerStatus, SubmitFlagResult } from "./types.js";
import { utcnow } from "../shared/time.js";

export interface BenchmarkBinding {
	project_id: string;
	unique_code: string;
	title: string;
	description: string | null;
	difficulty: string;
	level: number;
	total_score: number;
	flag_count: number;
	correct_flag_count: number;
	is_completed: boolean;
	container_status: ContainerStatus;
	container_addr: string[];
	hint_used: boolean;
	created_at: string;
	updated_at: string;
	closed_at: string | null;
	/** 最近一次成功启动/重建容器的时刻；平台 2 小时上限以此为基准。 */
	container_started_at: string | null;
}

export interface CreateBenchmarkBindingInput {
	projectId: string;
	uniqueCode: string;
	title: string;
	description?: string | null;
	difficulty?: string;
	level?: number;
	totalScore?: number;
	flagCount?: number;
	containerAddr?: string[];
	containerStatus?: ContainerStatus;
}

function parseAddrs(raw: string): string[] {
	try {
		const parsed = JSON.parse(raw) as unknown;
		return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
	} catch {
		return [];
	}
}

function toBinding(row: BenchmarkTaskRow): BenchmarkBinding {
	return {
		project_id: row.project_id,
		unique_code: row.unique_code,
		title: row.title,
		description: row.description,
		difficulty: row.difficulty,
		level: row.level,
		total_score: row.total_score,
		flag_count: row.flag_count,
		correct_flag_count: row.correct_flag_count,
		is_completed: row.is_completed === 1,
		container_status: row.container_status as ContainerStatus,
		container_addr: parseAddrs(row.container_addr),
		hint_used: row.hint_used === 1,
		created_at: row.created_at,
		updated_at: row.updated_at,
		closed_at: row.closed_at,
		container_started_at: row.container_started_at ?? null,
	};
}

export function createBenchmarkBinding(
	db: Db,
	input: CreateBenchmarkBindingInput,
): BenchmarkBinding {
	const now = utcnow();
	db.prepare(
		`INSERT INTO benchmark_tasks
			(project_id, unique_code, title, description, difficulty, level, total_score,
			 flag_count, correct_flag_count, is_completed, container_status, container_addr,
			 hint_used, created_at, updated_at, closed_at, container_started_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, 0, ?, ?, NULL, NULL)`,
	).run(
		input.projectId,
		input.uniqueCode,
		input.title,
		input.description ?? null,
		input.difficulty ?? "",
		input.level ?? 0,
		input.totalScore ?? 0,
		input.flagCount ?? 0,
		input.containerStatus ?? "stopped",
		JSON.stringify(input.containerAddr ?? []),
		now,
		now,
	);
	return getBenchmarkBinding(db, input.projectId)!;
}

export function getBenchmarkBinding(db: Db, projectId: string): BenchmarkBinding | undefined {
	const row = db.prepare("SELECT * FROM benchmark_tasks WHERE project_id = ?").get(projectId) as
		BenchmarkTaskRow | undefined;
	return row === undefined ? undefined : toBinding(row);
}

export function getBenchmarkBindingByCode(
	db: Db,
	uniqueCode: string,
): BenchmarkBinding | undefined {
	const row = db.prepare("SELECT * FROM benchmark_tasks WHERE unique_code = ?").get(uniqueCode) as
		BenchmarkTaskRow | undefined;
	return row === undefined ? undefined : toBinding(row);
}

export function listBenchmarkBindings(db: Db): BenchmarkBinding[] {
	const rows = db
		.prepare("SELECT * FROM benchmark_tasks ORDER BY created_at ASC")
		.all() as BenchmarkTaskRow[];
	return rows.map(toBinding);
}

/** 用平台返回的题目快照刷新绑定（listChallenges / startChallenge 之后调用）。 */
export function applyChallengeState(
	db: Db,
	projectId: string,
	challenge: Challenge,
): BenchmarkBinding | undefined {
	db.prepare(
		`UPDATE benchmark_tasks SET
			difficulty = ?, level = ?, total_score = MAX(total_score, ?),
			flag_count = MAX(flag_count, ?),
			correct_flag_count = MAX(correct_flag_count, ?),
			is_completed = CASE WHEN ? = 1 THEN 1 ELSE is_completed END,
			container_status = ?, container_addr = ?, updated_at = ?,
			-- 首次看到容器活跃时记录启动时刻（外部启动的容器也据此获得基准）；
			-- 平台 2 小时运行时上限以此为基准，driver 不再复活超时容器。
			container_started_at = CASE
				WHEN ? <> 'stopped' AND (container_started_at IS NULL OR closed_at IS NOT NULL) THEN ?
				ELSE container_started_at END,
			-- 容器重新变为活跃（worker 调过 benchmark_reset 重建，或控制面重启）
			-- 时清掉 closed_at，否则 driver.release() 会永久短路、靶场容器泄漏。
			closed_at = CASE WHEN ? = 'stopped' THEN closed_at ELSE NULL END
		 WHERE project_id = ?`,
	).run(
		challenge.difficulty,
		challenge.level,
		challenge.total_score,
		challenge.flag_count,
		challenge.correct_flag_count,
		challenge.is_completed ? 1 : 0,
		challenge.container_status,
		JSON.stringify(challenge.container_addr ?? []),
		utcnow(),
		challenge.container_status,
		utcnow(),
		challenge.container_status,
		projectId,
	);
	return getBenchmarkBinding(db, projectId);
}

/** 记录一次提交结果；只前进不回退（幂等重传不会把进度改小）。 */
export function applySubmitResult(
	db: Db,
	projectId: string,
	result: SubmitFlagResult,
): BenchmarkBinding | undefined {
	db.prepare(
		`UPDATE benchmark_tasks SET
			correct_flag_count = MAX(correct_flag_count, ?),
			flag_count = MAX(flag_count, ?),
			total_score = MAX(total_score, ?),
			-- flag_count=0 时 0>=0 恒真会误标完成：必须有已知 flag 才算通关。
			is_completed = CASE
				WHEN MAX(flag_count, ?) > 0 AND MAX(correct_flag_count, ?) >= MAX(flag_count, ?)
				THEN 1 ELSE is_completed END,
			updated_at = ?
		 WHERE project_id = ?`,
	).run(
		result.correct_flag_count,
		result.total_flag_count,
		result.cumulative_score,
		result.total_flag_count,
		result.correct_flag_count,
		result.total_flag_count,
		utcnow(),
		projectId,
	);
	return getBenchmarkBinding(db, projectId);
}

export function markHintUsed(db: Db, projectId: string): void {
	db.prepare("UPDATE benchmark_tasks SET hint_used = 1, updated_at = ? WHERE project_id = ?").run(
		utcnow(),
		projectId,
	);
}

export function markContainerStarted(
	db: Db,
	projectId: string,
	containerAddr: string[],
): BenchmarkBinding | undefined {
	const now = utcnow();
	db.prepare(
		`UPDATE benchmark_tasks SET container_status = 'pending', container_addr = ?,
		 container_started_at = ?, updated_at = ? WHERE project_id = ?`,
	).run(JSON.stringify(containerAddr ?? []), now, now, projectId);
	return getBenchmarkBinding(db, projectId);
}

/** 删除绑定（用于 --rebind：让同一 unique_code 可以重新建项目）。 */
export function deleteBenchmarkBinding(
	db: Db,
	projectId: string,
	expected?: { uniqueCode: string; createdAt: string },
): boolean {
	const info = expected
		? db
				.prepare(
					"DELETE FROM benchmark_tasks WHERE project_id = ? AND unique_code = ? AND created_at = ?",
				)
				.run(projectId, expected.uniqueCode, expected.createdAt)
		: db.prepare("DELETE FROM benchmark_tasks WHERE project_id = ?").run(projectId);
	return info.changes > 0;
}

export function markClosed(db: Db, projectId: string): void {
	db.prepare(
		"UPDATE benchmark_tasks SET container_status = 'stopped', container_addr = '[]', closed_at = ?, updated_at = ? WHERE project_id = ?",
	).run(utcnow(), utcnow(), projectId);
}
