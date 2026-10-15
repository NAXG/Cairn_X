import type { Agent, AgentTool } from "@earendil-works/pi-agent-core";
import { hasToolError, isCairnTool } from "./toolkit.js";

/** Preserve PI/plugin hooks while making Cairn's returned failures real tool errors. */
export function createCairnToolResultHook(
	tools: readonly AgentTool[],
	previous?: Agent["afterToolCall"],
): NonNullable<Agent["afterToolCall"]> {
	const names = new Set(tools.filter(isCairnTool).map((tool) => tool.name));
	return async (context, signal) => {
		if (!names.has(context.toolCall.name)) return previous?.(context, signal);
		const isError = context.isError || hasToolError(context.result.details);
		// Extension handlers must see the correct status too (e.g. for redaction or audit).
		const override = await previous?.({ ...context, isError }, signal);
		return {
			...override,
			isError:
				isError ||
				override?.isError === true ||
				hasToolError(override?.details ?? context.result.details),
		};
	};
}
