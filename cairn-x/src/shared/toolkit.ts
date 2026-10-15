/**
 * 自定义 Agent 工具的公共构造件。
 *
 * Decision / Worker 两侧的工具（orchestrator/tools/graph、worker/graphtools、
 * worker/benchmarktools）都需要同一套「TypeBox schema + 类型化 execute」的
 * 封装与统一的结果格式；收敛到这里，避免多份实现漂移。放在中立目录是为了
 * 同时被 orchestrator 与 worker 引用而不引入跨层循环依赖。
 */

import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type, type Static, type TSchema } from "@earendil-works/pi-ai";
import { z } from "zod";

/** 从权威契约生成模型可见的工具参数，避免手写第二份校验规则。 */
export function toolSchema<S extends z.ZodType>(input: S) {
	const json = z.toJSONSchema(input, { target: "draft-7" });
	delete json.$schema;
	return Type.Unsafe<z.infer<S>>({ ...json, type: "object" });
}

// Ownership stays outside model-visible tool definitions. PI tools and plugins
// keep their own result semantics, even if they use a details.error field.
const cairnTools = new WeakSet<object>();

export function markCairnTool<T extends object>(tool: T): T {
	cairnTools.add(tool);
	return tool;
}

export function isCairnTool(tool: AgentTool): boolean {
	return cairnTools.has(tool);
}

/** Explicit failure metadata; never infer an error from untrusted output text. */
export function hasToolError(details: unknown): boolean {
	return (
		typeof details === "object" && details !== null && "error" in details && details.error === true
	);
}

/** 把失败结果格式化为模型可见文本。 */
export function errorText(statusCode: number, text: string): string {
	const trimmed = text.length > 500 ? `${text.slice(0, 500)}…` : text;
	return `ERROR ${statusCode}: ${trimmed || "unknown error"}`;
}

export function toolResult(text: string, details: unknown): AgentToolResult<unknown> {
	return { content: [{ type: "text", text }], details };
}

/**
 * 读取类工具的结果：文本即载荷，details 不再复制一份。
 *
 * details 在生产侧只有 afterToolCall 的 hasToolError 读，而它只认 `error: true`。
 * 把整个载荷再存一份，会让会话行、execution_events 与轨迹读回体积翻倍：
 * 一次 48 KiB 的轨迹页会变成 93 KiB，而且模型下次读回这条事件时也要吞双份。
 * 需要结构化数据的调用方直接解析 content 文本。
 */
export function payloadResult(text: string): AgentToolResult<unknown> {
	return { content: [{ type: "text", text }], details: undefined };
}

/** 把失败的控制端响应统一格式化为工具错误结果。 */
export function errorResult(result: {
	statusCode: number;
	text: string;
}): AgentToolResult<unknown> {
	return toolResult(errorText(result.statusCode, result.text), { error: true });
}

export function makeTool<TParameters extends TSchema>(
	name: string,
	label: string,
	descriptionText: string,
	parameters: TParameters,
	execute: (params: Static<TParameters>, toolCallId: string) => Promise<AgentToolResult<unknown>>,
): AgentTool<TParameters> {
	return markCairnTool<AgentTool<TParameters>>({
		name,
		label,
		description: descriptionText,
		parameters,
		execute: async (toolCallId, params) => execute(params, toolCallId),
	});
}
