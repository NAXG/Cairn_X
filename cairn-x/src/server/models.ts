import { z } from "zod";
import { factContentSchema } from "../contracts/facts.js";
import { addStepInput, addRouteInput, goalEvidenceInput } from "../contracts/decide-tools.js";

import { SESSION_FILE_PATTERN } from "../contracts/transcripts.js";

const nonEmptyText = z.string().trim().min(1);
const projectTitle = nonEmptyText.max(120);
const projectText = nonEmptyText.max(12000);

const factIdList = addStepInput.shape.from;

/** Fact/Finding 的原始资料证据引用：已落盘的具体执行事件。 */
export const evidenceRefSchema = z.object({
	kind: z.literal("event"),
	execution_id: nonEmptyText,
	seq: z.number().int().positive(),
});
const evidenceRefList = z.array(evidenceRefSchema).max(32).optional();

/** Goal 完成证据：类型化的 Fact/Finding 引用。 */
const typedEvidenceList = goalEvidenceInput;

export const updateSettingsSchema = z
	.object({
		lease_timeout: z.number().int().min(5).optional(),
		decide_timeout: z.number().int().min(5).optional(),
	})
	.refine((v) => v.lease_timeout !== undefined || v.decide_timeout !== undefined, {
		message: "at least one of lease_timeout or decide_timeout is required",
	});

export const createProjectSchema = z.object({
	title: projectTitle,
	origin: projectText,
	goal: projectText,
	finding_schema: z.unknown().optional(),
	experiment_id: z.string().min(1).max(200).optional(),
	harness_variant: z.string().min(1).max(200).optional(),
	hints: z
		.array(
			z.object({
				content: nonEmptyText,
				creator: nonEmptyText,
				persistent: z.boolean().optional(),
			}),
		)
		.nullish(),
});

export const updateProjectStatusSchema = z.object({
	status: z.enum(["active", "stopped"]),
});

export const createHintSchema = z.object({
	content: nonEmptyText,
	creator: nonEmptyText,
	persistent: z.boolean().optional(),
});

export const createFactSchema = z.object({
	actor: z.literal("human").optional(),
	...factContentSchema.shape,
	step_id: nonEmptyText.nullish(),
	worker: nonEmptyText.nullish(),
	/** 幂等重传键：同一 (worker, execution_id, client_event_id) 重复提交返回首次结果。 */
	client_event_id: nonEmptyText.optional(),
	execution_id: nonEmptyText.optional(),
	evidence: evidenceRefList,
});

export const createStepSchema = z.object({
	request_id: nonEmptyText.max(200).optional(),
	actor: z.literal("human").optional(),
	decide_worker: nonEmptyText.optional(),
	from: factIdList,
	goal_id: nonEmptyText.nullish(),
	route_id: nonEmptyText.nullish(),
	description: addStepInput.shape.description,
	priority: addStepInput.shape.priority,
	waiting_on: addStepInput.shape.waiting_on,
	creator: nonEmptyText,
	worker: nonEmptyText.nullish(),
});

export const createRouteSchema = z.object({
	request_id: nonEmptyText.max(200).optional(),
	actor: z.literal("human").optional(),
	worker: nonEmptyText.optional(),
	description: addRouteInput.shape.description,
	goal_id: nonEmptyText.nullish(),
});

export const heartbeatSchema = z.object({
	worker: nonEmptyText,
});

export const concludeStepSchema = z.object({
	worker: nonEmptyText,
	description: nonEmptyText,
});

export const abandonStepSchema = z.object({
	worker: nonEmptyText,
	reason: nonEmptyText.nullish(),
});

export const updateStepPrioritySchema = z.object({
	actor: z.literal("human").optional(),
	worker: nonEmptyText.optional(),
	priority: z.number().int(),
});

export const createGoalSchema = z.object({
	request_id: nonEmptyText.max(200).optional(),
	actor: z.literal("human").optional(),
	worker: nonEmptyText.optional(),
	description: nonEmptyText,
	parent_goal_id: nonEmptyText.nullish(),
});

export const achieveGoalSchema = z.object({
	actor: z.literal("human").optional(),
	from: typedEvidenceList,
	description: nonEmptyText,
	worker: nonEmptyText.optional(),
});

export const createFindingSchema = z.object({
	step_id: nonEmptyText.optional(),
	actor: z.literal("human").optional(),
	worker: nonEmptyText.optional(),
	title: nonEmptyText,
	description: nonEmptyText,
	data: z.unknown().optional(),
	fact_ids: z.array(nonEmptyText).nullish(),
	/** 幂等重传键（同 facts.client_event_id）。 */
	client_event_id: nonEmptyText.optional(),
	execution_id: nonEmptyText.optional(),
	evidence: evidenceRefList,
});

export const decideClaimSchema = z.object({
	worker: nonEmptyText,
	min_interval_seconds: z.number().int().min(0).max(3600).default(0),
});

export const decideCompleteSchema = z.object({
	worker: nonEmptyText,
	planning_version: z.number().int().min(0),
});

export const decideSignalSchema = z.object({
	signal: nonEmptyText.pipe(z.string().max(200)),
});

const graphSectionSchema = z.enum(["facts", "goals", "steps", "hints", "findings", "routes"]);
const graphRecordSectionSchema = z.enum([
	"facts",
	"goals",
	"steps",
	"hints",
	"findings",
	"routes",
	"project",
	"usage",
]);

export const decideGraphSchema = z.discriminatedUnion("view", [
	z
		.object({ worker: nonEmptyText, view: z.literal("planning"), cursor: nonEmptyText.optional() })
		.strict(),
	z
		.object({
			worker: nonEmptyText,
			view: z.literal("section"),
			section: graphSectionSchema,
			query: nonEmptyText.max(200).optional(),
			status: nonEmptyText.optional(),
			goal_id: nonEmptyText.optional(),
			route_id: nonEmptyText.optional(),
			cursor: nonEmptyText.optional(),
		})
		.strict(),
	z
		.object({
			worker: nonEmptyText,
			view: z.literal("record"),
			section: graphRecordSectionSchema,
			id: nonEmptyText.pipe(z.string().max(200)),
			offset: z.number().int().nonnegative().optional(),
			revision: z
				.string()
				.regex(/^[0-9a-f]{64}$/)
				.optional(),
		})
		.strict()
		.refine(
			(body) => body.offset === undefined || body.offset === 0 || body.revision !== undefined,
			{
				message: "revision is required when offset is greater than zero",
				path: ["revision"],
			},
		),
]);

/** 与 achieveGoalSchema 同形：完成项目 = 以证据达成根目标。 */
export const completeProjectSchema = achieveGoalSchema;

/** 单笔模型调用的 token 计数；控制端直报与 Worker 执行结果共用。 */
export const usageTokensShape = {
	input_tokens: z.number().int().nonnegative(),
	output_tokens: z.number().int().nonnegative(),
	cache_read_tokens: z.number().int().nonnegative().optional(),
	cache_write_tokens: z.number().int().nonnegative().optional(),
};

export const createUsageEventSchema = z.object({
	activity: z.enum(["decide", "execute"]),
	step_id: nonEmptyText.nullish(),
	/** 可选：同一执行重复上报时用于幂等去重（与 RecordUsageBody 一致）。 */
	execution_id: nonEmptyText.nullish(),
	/** 可选：产生该笔用量的会话轨迹文件名，Decide 用量按它幂等并支持轨迹回填。 */
	source_file: nonEmptyText.regex(SESSION_FILE_PATTERN).nullish(),
	model: nonEmptyText,
	...usageTokensShape,
});
