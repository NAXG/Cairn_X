import { z } from "zod";
import { THINKING_LEVELS, supportedThinkingLevels } from "../contracts/thinking.js";
const positive = z.number().int().min(1);
export const roleSchema = z.enum(["decide", "execute"]);
export const agentBudgetSchema = z.object({
	revision: positive,
	run_seconds: positive.max(86400),
	harvest_seconds: positive.max(3600),
});
/**
 * Agent 的供应商/模型绑定允许为空（空串 = 未配置）。未配置的 Agent 无法开始活动
 * （见 store.createSnapshot 的「请先配置 Agent 模型」），但必须能被保存：否则控制台
 * 改完提示词/工具后保存会报 provider_id/model_id "Too small"，也无法把 Agent 从某个
 * 供应商上解绑，被绑定的供应商就永远删不掉。
 */
const unboundOrId = z.union([z.literal(""), z.string().trim().min(1).max(200)]);
export const agentSchema = z
	.object({
		role: roleSchema,
		revision: positive,
		provider_id: unboundOrId,
		model_id: unboundOrId,
		prompt: z.string().min(1).max(200000),
		thinking: z.enum(THINKING_LEVELS),
		context_window: positive.max(10000000),
		max_output_tokens: positive.max(1000000),
		run_seconds: agentBudgetSchema.shape.run_seconds,
		harvest_seconds: agentBudgetSchema.shape.harvest_seconds,
		tools: z
			.array(z.enum(["read", "bash", "edit", "write"]))
			.max(4)
			.refine((tools) => new Set(tools).size === tools.length, "工具不能重复"),
		bash_mode: z.enum(["one-shot", "persistent"]).optional(),
	})
	.refine((p) => (p.provider_id === "") === (p.model_id === ""), {
		message: "供应商与模型必须同时选择或同时留空",
		path: ["provider_id"],
	})
	.refine((p) => p.role === "decide" || (p.tools.length > 0 && p.tools.includes("bash")), {
		message: "Execute 至少保留 bash（世界操作后备）",
		path: ["tools"],
	});
export const providerSchema = z
	.object({
		revision: z.number().int().nonnegative(),
		name: z.string().min(1).max(100),
		kind: z.enum(["custom", "builtin"]),
		sdk_id: z.string().min(1).max(100),
		base_url: z.string().max(2000),
		api: z.string().max(100),
		headers: z.record(z.string(), z.string()).default({}),
		models: z
			.array(
				z
					.object({
						id: z.string().min(1).max(200),
						name: z.string().min(1).max(200),
						contextWindow: positive.max(10000000),
						maxTokens: positive.max(1000000),
						reasoning: z.boolean(),
						thinkingLevelMap: z
							.partialRecord(z.enum(THINKING_LEVELS), z.string().trim().min(1).max(100).nullable())
							.optional(),
					})
					.refine((model) => supportedThinkingLevels(model).length > 0, {
						message: "至少保留一个可用思考等级",
						path: ["thinkingLevelMap"],
					}),
			)
			.max(500),
		api_key: z.string().max(10000).optional(),
		clear_key: z.boolean().optional(),
	})
	.refine((provider) => !(provider.api_key && provider.clear_key), {
		message: "不能同时设置和清除凭据",
		path: ["clear_key"],
	});
export const runtimeSchema = z.object({
	revision: positive,
	max_workers: positive.max(128),
	max_running_projects: positive.max(128),
	max_project_workers: positive.max(128),
	decide_min_interval: z.number().min(0).max(3600),
});
