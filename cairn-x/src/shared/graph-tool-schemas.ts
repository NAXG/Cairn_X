import { Type, type Static } from "@earendil-works/pi-ai";
const graphSection = Type.Union(
	["facts", "goals", "steps", "hints", "findings", "routes"].map((value) => Type.Literal(value)),
);
const graphRecordSection = Type.Union([
	graphSection,
	Type.Literal("project"),
	Type.Literal("usage"),
]);
const graphReadUnion = Type.Union([
	Type.Object(
		{
			view: Type.Literal("planning"),
			cursor: Type.Optional(
				Type.String({ minLength: 1, description: "Server-issued next_cursor from the prior page" }),
			),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			view: Type.Literal("section"),
			section: Type.Union(graphSection.anyOf, {
				description: "History index to page or search; use view=record for full contents",
			}),
			query: Type.Optional(
				Type.String({
					minLength: 1,
					maxLength: 200,
					pattern: "\\S",
					description:
						"1-5 literal keyword terms (AND); matches have previews. Keep filters unchanged while paging.",
				}),
			),
			status: Type.Optional(
				Type.String({
					minLength: 1,
					description:
						"steps: open/claimed/concluded/abandoned; goals: pending/achieved/abandoned. Omit for other sections.",
				}),
			),
			goal_id: Type.Optional(
				Type.String({
					minLength: 1,
					description: "Filter steps or routes serving this Goal ID; invalid for other sections",
				}),
			),
			route_id: Type.Optional(
				Type.String({
					minLength: 1,
					description: "Filter steps assigned to this Route ID; valid only for section=steps",
				}),
			),
			cursor: Type.Optional(
				Type.String({
					minLength: 1,
					description: "Return next_cursor from this section; keep section and filters unchanged",
				}),
			),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			view: Type.Literal("record"),
			section: Type.Union(graphRecordSection.anyOf, {
				description: "Record collection; project and usage are singleton sections",
			}),
			id: Type.String({
				minLength: 1,
				maxLength: 200,
				description:
					'ID within the selected section; use "project" or "usage" for singleton records',
			}),
			offset: Type.Optional(
				Type.Integer({
					minimum: 0,
					description: "Defaults to 0; continue raw JSON text at next_offset until it is null",
				}),
			),
			revision: Type.Optional(
				Type.String({
					pattern: "^[0-9a-f]{64}$",
					description:
						"Required when offset > 0: return the previous record revision; on 409 restart at offset 0",
				}),
			),
		},
		{ additionalProperties: false },
	),
]);
/** OpenAI 兼容端点要求顶层 type:"object"；保留联合分支校验三种 view。 */
export const graphReadSchema = Type.Unsafe<Static<typeof graphReadUnion>>({
	type: "object",
	...graphReadUnion,
});
export const executionTraceSchema = Type.Object(
	{
		execution_id: Type.String({
			minLength: 1,
			description:
				"Existing execution in this project; use the task's execution_id or a search hit",
		}),
		view: Type.Optional(
			Type.Literal("index", {
				description:
					"Compact event index (seq, role, tool, preview); omit for transcript content. event_seq takes precedence.",
			}),
		),
		after_seq: Type.Optional(
			Type.Integer({
				minimum: 0,
				description:
					"Page events strictly after this sequence; defaults to 0. Continue with next_cursor; ignored with event_seq.",
			}),
		),
		limit: Type.Optional(
			Type.Integer({
				minimum: 1,
				maximum: 200,
				description:
					"Maximum events per page; defaults to 100. Prefer small pages; ignored with event_seq.",
			}),
		),
		event_seq: Type.Optional(
			Type.Integer({
				minimum: 1,
				description: "Read one oversized event as raw JSON text fragments instead of a page.",
			}),
		),
		offset: Type.Optional(
			Type.Integer({
				minimum: 0,
				description:
					"Only with event_seq; defaults to 0. Continue at next_offset and concatenate JSON text until has_more=false.",
			}),
		),
	},
	{ additionalProperties: false },
);
export const searchEventsSchema = Type.Object(
	{
		query: Type.String({
			minLength: 1,
			maxLength: 200,
			description:
				"1-5 whitespace-separated literal keywords (AND, case-insensitive), at most 80 characters each; no regex",
		}),
		execution_id: Type.Optional(
			Type.String({
				minLength: 1,
				description: "Restrict to one execution in this project; omit to search across executions",
			}),
		),
		step_id: Type.Optional(
			Type.String({
				minLength: 1,
				description: "Restrict to attempts of this Step ID; may be combined with execution_id",
			}),
		),
		cursor: Type.Optional(
			Type.String({
				minLength: 1,
				description: "Return next_cursor unchanged to continue; keep query and filters unchanged",
			}),
		),
		limit: Type.Optional(
			Type.Integer({
				minimum: 1,
				maximum: 50,
				description: "Maximum hits per page; defaults to 20",
			}),
		),
	},
	{ additionalProperties: false },
);
