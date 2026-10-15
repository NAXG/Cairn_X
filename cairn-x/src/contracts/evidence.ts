/**
 * 显式证据引用（阶段二）：Fact/Finding 指向具体 ExecutionEvent，
 * Goal 完成引用类型化的 Fact/Finding。
 *
 * 证据引用只建立可审计的来源关系，不代表结论自动成立；原始输出仍属
 * 不可信资料，结论由提交者负责。
 */

/** Goal 完成证据：类型化的 Fact/Finding 引用。 */
export interface TypedEvidenceRef {
	type: "fact" | "finding";
	id: string;
}

/** Fact/Finding 的原始资料引用：已落盘的具体执行事件。 */
export interface EvidenceRef {
	kind: "event";
	execution_id: string;
	seq: number;
}

export const evidenceRefKey = (ref: EvidenceRef): string => `event:${ref.execution_id}:${ref.seq}`;

export const typedRefKey = (ref: TypedEvidenceRef): string => `${ref.type}:${ref.id}`;
