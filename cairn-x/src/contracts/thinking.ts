export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];
export type ThinkingLevelMap = Partial<Record<ThinkingLevel, string | null>>;

/** Mirrors pi-ai's capability rules without importing the SDK into the web bundle. */
export function supportedThinkingLevels(model: {
	reasoning: boolean;
	thinkingLevelMap?: ThinkingLevelMap;
}): ThinkingLevel[] {
	if (!model.reasoning) return ["off"];
	return THINKING_LEVELS.filter((level) => {
		const mapped = model.thinkingLevelMap?.[level];
		if (mapped === null) return false;
		return (level !== "xhigh" && level !== "max") || mapped !== undefined;
	});
}

/**
 * Mirrors pi-ai's clampThinkingLevel：把请求的等级规约到最近的可达等级。
 * 用于「默认等级」这类不能事先知道模型能力上限的场景（如 max 需要显式映射）。
 */
export function clampThinkingLevel(
	model: { reasoning: boolean; thinkingLevelMap?: ThinkingLevelMap },
	level: ThinkingLevel,
): ThinkingLevel {
	const levels = supportedThinkingLevels(model);
	if (levels.includes(level)) return level;
	const requested = THINKING_LEVELS.indexOf(level);
	for (let i = requested; i < THINKING_LEVELS.length; i++) {
		const candidate = THINKING_LEVELS[i];
		if (levels.includes(candidate)) return candidate;
	}
	for (let i = requested - 1; i >= 0; i--) {
		const candidate = THINKING_LEVELS[i];
		if (levels.includes(candidate)) return candidate;
	}
	return levels[0] ?? "off";
}
