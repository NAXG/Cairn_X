import type { ProviderDraft } from "./ProviderEditor";

/** 两个值是否不同；深比较用 JSON，足以覆盖设置页里的纯数据草稿。 */
export function changed(a: unknown, b: unknown): boolean {
	return JSON.stringify(a) !== JSON.stringify(b);
}

/** 合并服务端保存结果时，保留请求发出后用户继续做的修改。 */
export function preserveEdits<T extends object>(saved: T, submitted: T, current: T): T {
	const patch: Record<string, unknown> = {};
	for (const key of new Set([...Object.keys(submitted), ...Object.keys(current)])) {
		const field = key as keyof T;
		if (JSON.stringify(current[field]) !== JSON.stringify(submitted[field]))
			patch[key] = current[field];
	}
	return { ...saved, ...patch } as T;
}

export function preserveProviderEdits(
	saved: ProviderDraft,
	baseline: ProviderDraft,
	current: ProviderDraft,
): ProviderDraft {
	const merged = preserveEdits(saved, baseline, current);
	if (JSON.stringify(current.models) === JSON.stringify(baseline.models)) return merged;
	const previousIds = new Set(baseline.models.map((model) => model.id));
	const draftIds = new Set(current.models.map((model) => model.id));
	return {
		...merged,
		models: [
			...current.models,
			...saved.models.filter((model) => !previousIds.has(model.id) && !draftIds.has(model.id)),
		],
	};
}

// crypto.randomUUID 仅在安全上下文（HTTPS/localhost）可用；生产是 HTTP+IP，需要回退实现。
export function newId(): string {
	if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
	const b = crypto.getRandomValues(new Uint8Array(16));
	b[6] = (b[6] & 0x0f) | 0x40;
	b[8] = (b[8] & 0x3f) | 0x80;
	const h = [...b].map((v) => v.toString(16).padStart(2, "0")).join("");
	return (
		h.slice(0, 8) +
		"-" +
		h.slice(8, 12) +
		"-" +
		h.slice(12, 16) +
		"-" +
		h.slice(16, 20) +
		"-" +
		h.slice(20)
	);
}
