/**
 * 上下文压缩参数解析。
 *
 * 优先使用 dispatch.yaml 的 compaction 配置；未配置时回落到与 PI 默认语义等价的公式。
 * 配置值会被夹到合法区间，避免 window 很小时压缩后仍高于阈值导致每轮都压缩。
 */

import { MODEL_DEFAULTS, type ActivitySnapshot } from "../contracts/configuration.js";

interface CompactionSettings {
	/** 摘要提示词与输出预留的 token 数。 */
	reserveTokens: number;
	/** compact 后保留的最近上下文 token 估算值。 */
	keepRecentTokens: number;
}

export type CompactionOptions = NonNullable<ActivitySnapshot["compaction"]>;

function positiveInteger(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

/** configured 已由 compactionConfigSchema 校验，这里不再重复防御。 */
export function resolveCompactionSettings(
	contextWindow: number,
	configured?: CompactionOptions | null,
): CompactionSettings {
	// window 仍保留兜底：本函数签名接受任意 number，window=0 时下面的夹取会把
	// 阈值算成 0、导致每轮都触发压缩。
	const window = positiveInteger(contextWindow, MODEL_DEFAULTS.context_window);
	const defaultReserve = Math.min(16_384, Math.floor(window / 4));
	const defaultKeep = Math.min(20_000, Math.floor(window / 3));
	const reserve = Math.max(1, Math.min(configured?.reserve_tokens ?? defaultReserve, window - 1));
	const keep = Math.max(
		1,
		Math.min(configured?.keep_recent_tokens ?? defaultKeep, window - reserve - 1),
	);
	return { reserveTokens: reserve, keepRecentTokens: keep };
}
