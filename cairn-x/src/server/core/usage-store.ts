import type { RecordUsageBody } from "../../contracts/models.js";
import type { Db, UsageEventRow } from "../db.js";

/**
 * 落一笔用量，`source_file` 非空时按 (项目, 会话文件) 幂等。
 *
 * 同一个 Decide 会话文件会被两方观测：Worker 运行结束时的一次性上报，以及
 * 控制端从轨迹回填（运行被掐、控制面瞬时不可达时上报会丢失）。两者读的是
 * 同一批 assistant.usage，正常情况完全相等；但回填可能看到「运行还没写完文件」
 * 的部分观测。按列取最大值 —— token 在一次运行里只增不减 —— 就能让后来的完整
 * 观测修正先落地的部分值，而完整的先落地也绝不会被后来的部分值缩水。
 */
export function writeUsageEvent(
	db: Db,
	projectId: string,
	body: RecordUsageBody,
	createdAt: string,
): UsageEventRow {
	return db
		.prepare(
			`INSERT INTO usage_events (project_id, activity, step_id, execution_id, source_file, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT (project_id, source_file) DO UPDATE SET
				input_tokens = MAX(input_tokens, excluded.input_tokens),
				output_tokens = MAX(output_tokens, excluded.output_tokens),
				cache_read_tokens = MAX(cache_read_tokens, excluded.cache_read_tokens),
				cache_write_tokens = MAX(cache_write_tokens, excluded.cache_write_tokens)
			 RETURNING *`,
		)
		.get(
			projectId,
			body.activity,
			body.step_id ?? null,
			body.execution_id ?? null,
			body.source_file ?? null,
			body.model,
			body.input_tokens,
			body.output_tokens,
			body.cache_read_tokens ?? 0,
			body.cache_write_tokens ?? 0,
			createdAt,
		) as UsageEventRow;
}
