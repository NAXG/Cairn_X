/**
 * 活动运行遥测：UsageRecord 是单次 Decide/Execute 运行的实时 token
 * 用量（由会话实现累计），运行结束时由调用方尽力写回服务器。
 */

import type { ActivityType } from "../../contracts/activity.js";

/** 单次活动运行的实时 token 用量。 */
export interface UsageRecord {
	activity: ActivityType;
	/** 仅 execute 运行设置（产生该用量的 step）。 */
	step_id?: string;
	model: string;
	input_tokens: number;
	output_tokens: number;
	/** 命中上下文缓存的输入 token（DeepSeek 自动缓存 / Anthropic cache read）。 */
	cache_read_tokens: number;
	/** 显式写入缓存的 token（Anthropic 系；自动缓存的供应商恒为 0）。 */
	cache_write_tokens: number;
}
