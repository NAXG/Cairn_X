import { z } from "zod";

const MAX_STEP_DEPENDENCIES = 8;
const MAX_GOAL_EVIDENCE = 64;
const text = z.string().trim().min(1).regex(/\S/);
const id = text.max(200);

export const addStepInput = z
	.object({
		from: z
			.array(id)
			.min(1)
			.describe("Existing Fact IDs whose full text Execute needs; not Step or Finding IDs"),
		description: text.describe(
			"Self-contained action, scope and verifiable acceptance criteria for Execute",
		),
		priority: z.number().int().optional().describe("Higher values run first; defaults to 0"),
		goal_id: id.optional().describe('Goal served; defaults to the root goal "goal"'),
		route_id: id
			.optional()
			.describe("Existing route grouping this strategy's steps; omit for no route"),
		waiting_on: z
			.array(id)
			.max(MAX_STEP_DEPENDENCIES)
			.optional()
			.describe(
				"Only orders completion, not successful acceptance or output transfer. Create a dependent task after its required facts exist; omit for runnable steps.",
			),
	})
	.strict();

export const addRouteInput = z
	.object({
		description: text.describe("Distinct strategy or hypothesis for reaching the goal"),
		goal_id: id.optional().describe('Goal served; defaults to the root goal "goal"'),
	})
	.strict();
export const abandonStepInput = z
	.object({
		step_id: id.describe("Existing Step ID to abandon"),
		reason: text.optional().describe("Why this step is no longer worth executing"),
	})
	.strict();
export const setPriorityInput = z
	.object({
		step_id: id.describe("Existing open Step ID to reprioritize"),
		priority: z.number().int().describe("New priority; higher values run first"),
	})
	.strict();
export const goalEvidenceInput = z
	.array(
		z
			.object({
				type: z.enum(["fact", "finding"]),
				id: id.describe("Existing ID of the stated evidence type"),
			})
			.strict(),
	)
	.min(1)
	.max(MAX_GOAL_EVIDENCE)
	.describe("For achieve only: typed Fact/Finding references proving acceptance, not bare IDs");
const goalDescription = text.describe(
	"For add: subgoal and acceptance criteria. For achieve: how the cited evidence proves acceptance.",
);
export const goalInput = z.discriminatedUnion("action", [
	z
		.object({
			action: z.literal("add"),
			description: goalDescription,
			parent_goal_id: id.optional().describe('For add only: parent goal; defaults to "goal"'),
		})
		.strict(),
	z
		.object({
			action: z.literal("remove"),
			goal_id: id.describe('For remove/achieve: existing Goal ID; "goal" is the root'),
		})
		.strict(),
	z
		.object({
			action: z.literal("achieve"),
			goal_id: id.describe('For remove/achieve: existing Goal ID; "goal" is the root'),
			description: goalDescription,
			from: goalEvidenceInput,
		})
		.strict(),
]);

export const readEvidenceInput = z
	.object({
		type: z.enum(["fact", "finding"]),
		id: id.describe("Existing Fact/Finding ID whose attached event evidence should be read"),
		ref_index: z
			.number()
			.int()
			.nonnegative()
			.optional()
			.describe(
				"Zero-based evidence reference; defaults to 0. Follow next_ref_index after finishing this event.",
			),
		offset: z
			.number()
			.int()
			.nonnegative()
			.optional()
			.describe(
				"Defaults to 0; use event.next_offset to continue this reference with its revision",
			),
		revision: z
			.string()
			.regex(/^[0-9a-f]{64}$/)
			.optional()
			.describe(
				"Required when offset > 0: return this reference's revision; omit when starting another reference",
			),
	})
	.strict();
export type ReadEvidenceInput = z.infer<typeof readEvidenceInput>;

/** Side effects are bounded acknowledgements, not a second graph store. */
interface MutationEffects {
	abandoned_step_ids?: string[];
	abandoned_step_count?: number;
	cancelled_execution_ids?: string[];
	cancelled_execution_count?: number;
	reparented_goal_count?: number;
	detached_step_count?: number;
	reparented_route_count?: number;
	project_completed?: boolean;
	truncated?: boolean;
}
export type WithEffects<T> = T & { effects?: MutationEffects };
