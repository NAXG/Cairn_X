/**
 * usage_events 的聚合查询。
 *
 * 单独成模块是为了避免循环依赖：core/model-mappers 与 core/stats 都要用，
 * 而 core/usage 自身依赖 core/model-mappers。
 */

import type { Db } from "../db.js";

interface UsageTotals {
	events: number;
	input_tokens: number;
	output_tokens: number;
	cache_read_tokens: number;
	cache_write_tokens: number;
}

/** 按 activity 分组的 token 总计；无记录的 activity 不出现在结果里。 */
export function usageByActivity(
	db: Db,
	projectId: string,
): Array<UsageTotals & { activity: string }> {
	return db
		.prepare(
			`SELECT activity, COUNT(*) AS events,
			        COALESCE(SUM(input_tokens), 0) AS input_tokens,
			        COALESCE(SUM(output_tokens), 0) AS output_tokens,
			        COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
			        COALESCE(SUM(cache_write_tokens), 0) AS cache_write_tokens
			 FROM usage_events
			 WHERE project_id = ?
			 GROUP BY activity`,
		)
		.all(projectId) as Array<UsageTotals & { activity: string }>;
}
