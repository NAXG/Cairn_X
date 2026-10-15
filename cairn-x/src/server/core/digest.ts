import {
	EXECUTION_TERMINAL_STATUSES,
	UNHEALTHY_ERROR_MARKER,
	type ExecutionStatus,
} from "../../contracts/execution.js";
import type {
	DigestToolCall,
	ExecutionDigest,
	FailureClass,
	FailureComponent,
	ProjectDigest,
	StepDigest,
} from "../../contracts/digest.js";
import type { Db } from "../db.js";
import { ApiError, utcnow } from "./base.js";
import { getProjectOr404 } from "./project-guards.js";
import { executionSeconds } from "./execution-duration.js";
import { projectExperimentMetadata } from "./experiment-metadata.js";
import { hasToolError } from "../../shared/toolkit.js";

const DEFAULT_EXECUTION_LIMIT = 200;
const MAX_EXECUTION_LIMIT = 2_000;
const DEFAULT_EVENT_LIMIT = 20_000;
const MAX_EVENT_LIMIT = 200_000;
const EVIDENCE_LIMIT = 6;
const EVIDENCE_CHARS = 400;
const TOOL_EXCERPT_CHARS = 500;

// Only interpret historical Cairn failure metadata. PI tools and arbitrary
// plugins may have unrelated details.error fields and retain their SDK status.
const LEGACY_CAIRN_TOOLS = new Set([
	"get_graph",
	"read_evidence",
	"add_step",
	"abandon_step",
	"add_route",
	"set_step_priority",
	"goal",
	"submit_fact",
	"submit_finding",
	"signal_planner",
	"search_execution_events",
	"get_execution_trace",
	"submit_result",
	"benchmark_status",
	"benchmark_submit_flag",
	"benchmark_hint",
	"benchmark_reset",
]);

interface CountRow {
	n: number;
}

interface StepUsageRow {
	events: number;
	input_tokens: number;
	output_tokens: number;
}

interface BenchmarkDigestRow {
	unique_code: string;
	is_completed: number;
	correct_flag_count: number;
	flag_count: number;
	hint_used: number;
}

interface DigestExecutionRow {
	id: string;
	project_id: string;
	step_id: string;
	attempt: number;
	status: ExecutionStatus;
	created_at: string;
	started_at: string | null;
	finished_at: string | null;
	result_outcome: string | null;
	summary: string | null;
	error: string | null;
	dropped_events: number;
}

interface InternalToolCall {
	id: string;
	name: string;
	sequence: number;
	arguments_excerpt: string;
	result: "ok" | "error" | "missing";
	error_excerpt: string | null;
	timeout: boolean;
	started_ms: number | null;
	duration_ms: number | null;
}

interface NormalizedTranscript {
	events: number;
	messages: number;
	malformed: number;
	assistant_stop_reasons: string[];
	assistant_text_chars: number;
	harvested: boolean;
	harvest_blocked_count: number;
	tokens: {
		input: number;
		output: number;
		cache_read: number;
		cache_write: number;
	};
	tool_calls: InternalToolCall[];
}

interface ProjectDigestOptions {
	/** 只归因某个 step。 */
	step_id?: string;
	/** 最多拉取多少个 execution（默认 200，最大 2000）。 */
	limit?: number;
	/** 每个 execution 最多解析多少条轨迹事件（默认 20000，最大 200000）。 */
	event_limit?: number;
}

interface ExecutionDigestOptions {
	event_limit?: number;
}

function finiteNumber(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function objectValue(value: unknown): Record<string, unknown> | null {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
	return value as Record<string, unknown>;
}

function textValue(value: unknown): string | null {
	return typeof value === "string" ? value : null;
}

function excerpt(text: string, max = EVIDENCE_CHARS): string {
	const compact = text.replace(/\s+/g, " ").trim();
	return compact.length <= max ? compact : compact.slice(0, max - 1) + "…";
}

function timestampMs(value: unknown): number | null {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string") {
		const parsed = Date.parse(value);
		return Number.isFinite(parsed) ? parsed : null;
	}
	return null;
}

function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content) === false) return "";
	const parts: string[] = [];
	for (const block of content) {
		const item = objectValue(block);
		if (item === null) continue;
		const text = textValue(item.text);
		if (text !== null) parts.push(text);
	}
	return parts.join("\n");
}

function isTimeoutText(text: string): boolean {
	return /timeout|timed out|time out|超时|ETIMEDOUT|deadline exceeded/i.test(text);
}

function isUnknownToolText(text: string): boolean {
	return /unknown tool|tool not found|no such tool|not available|未知工具/i.test(text);
}

/**
 * 把 execution_events 的原始 JSONL 消息归一化成稳定结构。
 *
 * 只依赖消息协议里的公开字段：assistant.content 的 toolCall block、
 * toolResult 的 toolCallId/isError、assistant.usage。即使 Worker 没有成功
 * 上传 usage_events，也能从轨迹里还原本次执行的真实 token。
 */
function normalizeTranscript(rows: Array<{ seq: number; line: string }>): NormalizedTranscript {
	const calls = new Map<string, InternalToolCall>();
	const ordered: InternalToolCall[] = [];
	const firstSeen = crypto.randomUUID();
	const tokens = { input: 0, output: 0, cache_read: 0, cache_write: 0 };
	const assistant_stop_reasons: string[] = [];
	let messages = 0;
	let malformed = 0;
	let assistant_text_chars = 0;
	let harvested = false;
	let harvest_blocked_count = 0;
	let missingCounter = 0;

	for (const row of rows) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(row.line);
		} catch {
			malformed += 1;
			continue;
		}
		const record = objectValue(parsed);
		const message = record === null ? null : objectValue(record.message);
		if (record === null || message === null) {
			malformed += 1;
			continue;
		}
		messages += 1;
		const role = textValue(message.role);

		if (role === "assistant") {
			const usage = objectValue(message.usage);
			if (usage !== null) {
				tokens.input += finiteNumber(usage.input);
				tokens.output += finiteNumber(usage.output);
				tokens.cache_read += finiteNumber(usage.cacheRead);
				tokens.cache_write += finiteNumber(usage.cacheWrite);
			}
			const stopReason = textValue(message.stopReason);
			if (stopReason !== null) assistant_stop_reasons.push(stopReason);
			if (Array.isArray(message.content)) {
				for (const block of message.content) {
					const item = objectValue(block);
					if (item === null) continue;
					if (item.type === "text") {
						const text = textValue(item.text);
						if (text !== null) assistant_text_chars += text.length;
					}
					if (item.type !== "toolCall") continue;
					const name = textValue(item.name);
					if (name === null) continue;
					missingCounter += 1;
					const id = textValue(item.id) ?? "missing-call-" + missingCounter + "-" + firstSeen;
					const args = item.arguments === undefined ? "{}" : JSON.stringify(item.arguments);
					const call: InternalToolCall = {
						id,
						name,
						sequence: row.seq,
						arguments_excerpt: excerpt(args, 200),
						result: "missing",
						error_excerpt: null,
						timeout: false,
						started_ms: timestampMs(record.timestamp) ?? timestampMs(message.timestamp),
						duration_ms: null,
					};
					calls.set(id, call);
					ordered.push(call);
				}
			}
			continue;
		}

		if (role === "toolResult") {
			const id = textValue(message.toolCallId) ?? "orphan-result-" + row.seq;
			const name = textValue(message.toolName) ?? "unknown";
			const resultText = contentText(message.content);
			// Older Cairn traces returned failures normally, so PI wrote isError=false.
			const isError =
				message.isError === true || (LEGACY_CAIRN_TOOLS.has(name) && hasToolError(message.details));
			const timeout = isTimeoutText(resultText);
			if (resultText.includes("收尾阶段：世界工具已关闭")) harvest_blocked_count += 1;
			let call = calls.get(id);
			if (call === undefined) {
				call = {
					id,
					name,
					sequence: row.seq,
					arguments_excerpt: "",
					result: isError ? "error" : "ok",
					error_excerpt: isError ? excerpt(resultText, TOOL_EXCERPT_CHARS) : null,
					timeout,
					started_ms: null,
					duration_ms: null,
				};
				calls.set(id, call);
				ordered.push(call);
			} else {
				call.result = isError ? "error" : "ok";
				call.error_excerpt = isError ? excerpt(resultText, TOOL_EXCERPT_CHARS) : null;
				call.timeout = timeout;
				const finished = timestampMs(record.timestamp) ?? timestampMs(message.timestamp);
				if (call.started_ms !== null && finished !== null && finished >= call.started_ms) {
					call.duration_ms = finished - call.started_ms;
				}
			}
			continue;
		}

		if (role === "user") {
			const text = contentText(message.content);
			if (text.includes("现在是收尾阶段")) harvested = true;
		}
	}

	return {
		events: rows.length,
		messages,
		malformed,
		assistant_stop_reasons,
		assistant_text_chars,
		harvested,
		harvest_blocked_count,
		tokens,
		tool_calls: ordered,
	};
}

function pushEvidence(evidence: string[], text: string | null | undefined): void {
	if (text === null || text === undefined) return;
	const item = excerpt(text);
	if (item === "" || evidence.includes(item) || evidence.length >= EVIDENCE_LIMIT) return;
	evidence.push(item);
}

function componentForToolCall(call: InternalToolCall): FailureComponent {
	return ("tool:" + call.name) as FailureComponent;
}

function classify(
	row: DigestExecutionRow,
	transcript: NormalizedTranscript,
	pending: InternalToolCall | null,
): { failure_class: FailureClass; component: FailureComponent; evidence: string[] } {
	const error = row.error ?? "";
	const evidence: string[] = [];
	const failedCalls = transcript.tool_calls.filter((call) => call.result === "error");
	const firstFailed = failedCalls[0];
	const timeoutCall =
		failedCalls.find((call) => call.timeout) ?? transcript.tool_calls.find((call) => call.timeout);
	const lastStop = transcript.assistant_stop_reasons.at(-1) ?? "";

	if (row.status === "succeeded") {
		return { failure_class: "none", component: "none", evidence: [] };
	}

	if (row.status === "cancelled") {
		pushEvidence(evidence, error);
		return { failure_class: "cancelled", component: "executor", evidence };
	}

	if (row.status === "lost") {
		pushEvidence(evidence, error);
		if (pending !== null)
			pushEvidence(evidence, "pending tool: " + pending.name + " " + pending.arguments_excerpt);
		if (/lease|租约/i.test(error)) {
			return { failure_class: "lease_failure", component: "executor", evidence };
		}
		if (/deadline|timeout/i.test(error)) {
			return { failure_class: "execution_timeout", component: "executor", evidence };
		}
		return { failure_class: "lost", component: "executor", evidence };
	}

	pushEvidence(evidence, error);
	if (error.includes(UNHEALTHY_ERROR_MARKER)) {
		return { failure_class: "endpoint_error", component: "model", evidence };
	}
	if (/lease|租约/i.test(error)) {
		return { failure_class: "lease_failure", component: "executor", evidence };
	}
	if (/budget exhausted|budget_exhausted|预算.*(耗尽|用完)/i.test(error)) {
		return { failure_class: "budget_exhausted", component: "executor", evidence };
	}
	if (timeoutCall !== undefined) {
		pushEvidence(
			evidence,
			"tool " + timeoutCall.name + ": " + (timeoutCall.error_excerpt ?? "timeout"),
		);
		const component = componentForToolCall(timeoutCall);
		return { failure_class: "tool_timeout", component, evidence };
	}
	if (firstFailed !== undefined) {
		pushEvidence(
			evidence,
			"tool " + firstFailed.name + ": " + (firstFailed.error_excerpt ?? "error"),
		);
		const component = componentForToolCall(firstFailed);
		const failedText = firstFailed.error_excerpt ?? "";
		if (failedText.includes("收尾阶段：世界工具已关闭")) {
			return { failure_class: "harvest_failure", component: "harvest", evidence };
		}
		return {
			failure_class: isUnknownToolText(failedText) ? "tool_selection" : "tool_execution",
			component,
			evidence,
		};
	}
	if (transcript.harvest_blocked_count > 0 || /harvest/i.test(error)) {
		pushEvidence(evidence, "harvest pass was blocked or failed");
		return { failure_class: "harvest_failure", component: "harvest", evidence };
	}
	if (/context.*(missing|length|window)|too many tokens|上下文/i.test(error)) {
		return { failure_class: "context_missing", component: "agent", evidence };
	}
	if (/deadline|timeout/i.test(error)) {
		return { failure_class: "execution_timeout", component: "executor", evidence };
	}
	if (lastStop === "length") {
		pushEvidence(evidence, "assistant stop reason: length");
		return { failure_class: "context_exhausted", component: "model", evidence };
	}
	if (/prompt|placeholder|占位符|渲染|配置/i.test(error)) {
		return { failure_class: "prompt_contract", component: "agent", evidence };
	}
	if (transcript.messages === 0) {
		pushEvidence(evidence, "no transcript messages were uploaded");
		return { failure_class: "prompt_contract", component: "agent", evidence };
	}
	if (lastStop === "error") {
		pushEvidence(evidence, "assistant stop reason: error");
		return { failure_class: "endpoint_error", component: "model", evidence };
	}
	if (transcript.tool_calls.length === 0) {
		pushEvidence(evidence, "assistant produced no tool calls");
		return { failure_class: "model_capability", component: "model", evidence };
	}
	if (pending !== null) {
		pushEvidence(evidence, "pending tool: " + pending.name + " " + pending.arguments_excerpt);
	}
	return { failure_class: "unknown", component: "unknown", evidence };
}

function toDigestToolCall(call: InternalToolCall): DigestToolCall {
	return {
		id: call.id,
		name: call.name,
		sequence: call.sequence,
		arguments_excerpt: call.arguments_excerpt,
		result: call.result,
		error_excerpt: call.error_excerpt,
		timeout: call.timeout,
		duration_ms: call.duration_ms,
	};
}

function normalizeLimit(
	value: number | undefined,
	fallback: number,
	max: number,
	label: string,
): number {
	const resolved = value ?? fallback;
	if (Number.isSafeInteger(resolved) === false || resolved < 1 || resolved > max) {
		throw new ApiError(400, "Invalid " + label + " (1-" + max + ")");
	}
	return resolved;
}

function readExecutionRows(
	db: Db,
	projectId: string,
	limit: number,
	stepId?: string,
): DigestExecutionRow[] {
	const where = ["project_id = ?"];
	const params: Array<string | number> = [projectId];
	if (stepId !== undefined) {
		where.push("step_id = ?");
		params.push(stepId);
	}
	params.push(limit);
	return db
		.prepare(
			"SELECT * FROM (" +
				" SELECT id, project_id, step_id, attempt, status, created_at, started_at, finished_at, result_outcome, summary, error, dropped_events" +
				" FROM executions WHERE " +
				where.join(" AND ") +
				" ORDER BY created_at DESC, id DESC LIMIT ?" +
				") ORDER BY created_at ASC, id ASC",
		)
		.all(...params) as unknown as DigestExecutionRow[];
}

/** digest 需要的最小 executions 列；读单条与列一串共用，避免两处漂移。 */
const EXECUTION_DIGEST_COLUMNS =
	"id, project_id, step_id, attempt, status, created_at, started_at, finished_at, " +
	"result_outcome, summary, error, dropped_events";

function readExecutionRow(db: Db, projectId: string, executionId: string): DigestExecutionRow {
	const row = db
		.prepare(`SELECT ${EXECUTION_DIGEST_COLUMNS} FROM executions WHERE id = ? AND project_id = ?`)
		.get(executionId, projectId) as DigestExecutionRow | undefined;
	if (row === undefined) throw new ApiError(404, "Execution not found");
	return row;
}

/** 单条执行的失败归类结果；与 ExecutionDigest 上的同名字段同源。 */
interface StoredExecutionClassification {
	failure_class: FailureClass;
	component: FailureComponent;
	evidence: string[];
}

/**
 * 只做「读轨迹 → 归一化 → 分类」，不查产出计数、用量与评测进度。
 *
 * 规划页要给前沿里的步骤附上「最近一次失败属于哪一类」，但不应为此付一次
 * 完整 digest 的代价；调用方负责把结果物化（见 core/execution-failure.ts），
 * 这里保持无副作用。非终态返回 null：运行中的执行没有可归类的失败。
 */
export function classifyStoredExecution(
	db: Db,
	executionId: string,
	eventLimit: number = DEFAULT_EVENT_LIMIT,
): StoredExecutionClassification | null {
	const row = db
		.prepare(`SELECT ${EXECUTION_DIGEST_COLUMNS} FROM executions WHERE id = ?`)
		.get(executionId) as DigestExecutionRow | undefined;
	if (row === undefined || !EXECUTION_TERMINAL_STATUSES.includes(row.status)) return null;
	// succeeded 的归类恒为 none，且不需要看轨迹；多数终态执行走这条捷径。
	if (row.status === "succeeded") {
		return { failure_class: "none", component: "none", evidence: [] };
	}
	const trace = readTranscript(db, row.id, eventLimit);
	const transcript = normalizeTranscript(trace.rows);
	return classify(row, transcript, pendingToolCall(transcript));
}

function readTranscript(
	db: Db,
	executionId: string,
	eventLimit: number,
): { rows: Array<{ seq: number; line: string }>; truncated: boolean } {
	const rows = db
		.prepare("SELECT seq, line FROM execution_events WHERE execution_id = ? ORDER BY seq LIMIT ?")
		.all(executionId, eventLimit + 1) as Array<{ seq: number; line: string }>;
	return { rows: rows.slice(0, eventLimit), truncated: rows.length > eventLimit };
}

function pendingToolCall(transcript: NormalizedTranscript): InternalToolCall | null {
	for (let index = transcript.tool_calls.length - 1; index >= 0; index -= 1) {
		const call = transcript.tool_calls[index];
		if (call.result === "missing") return call;
	}
	return null;
}

function digestExecution(db: Db, row: DigestExecutionRow, eventLimit: number): ExecutionDigest {
	const trace = readTranscript(db, row.id, eventLimit);
	const transcript = normalizeTranscript(trace.rows);
	const pending = pendingToolCall(transcript);
	const classified = classify(row, transcript, pending);
	const tokenTotal = transcript.tokens.input + transcript.tokens.output;
	const hasTokenUsage =
		tokenTotal > 0 || transcript.tokens.cache_read > 0 || transcript.tokens.cache_write > 0;

	const countRows = (sql: string): CountRow =>
		db.prepare(sql).get(row.project_id, row.id) as CountRow;
	const produced = {
		facts: countRows("SELECT COUNT(*) AS n FROM facts WHERE project_id = ? AND execution_id = ?").n,
		findings: countRows(
			"SELECT COUNT(*) AS n FROM findings WHERE project_id = ? AND execution_id = ?",
		).n,
	};
	const stepUsageRow = db
		.prepare(
			"SELECT COUNT(*) AS events, COALESCE(SUM(input_tokens), 0) AS input_tokens, COALESCE(SUM(output_tokens), 0) AS output_tokens" +
				" FROM usage_events WHERE project_id = ? AND step_id = ? AND activity = 'execute'",
		)
		.get(row.project_id, row.step_id) as StepUsageRow;
	const benchmarkRow = db
		.prepare(
			"SELECT unique_code, is_completed, correct_flag_count, flag_count, hint_used FROM benchmark_tasks WHERE project_id = ?",
		)
		.get(row.project_id) as BenchmarkDigestRow | undefined;

	return {
		execution_id: row.id,
		project_id: row.project_id,
		step_id: row.step_id,
		attempt: row.attempt,
		status: row.status,
		outcome: row.result_outcome,
		created_at: row.created_at,
		started_at: row.started_at,
		finished_at: row.finished_at,
		duration_seconds: executionSeconds(row),
		failure_class: classified.failure_class,
		component: classified.component,
		evidence: classified.evidence,
		error: row.error,
		summary: row.summary,
		transcript: {
			events: transcript.events,
			messages: transcript.messages,
			malformed: transcript.malformed,
			dropped: row.dropped_events,
			complete: row.dropped_events === 0 && transcript.malformed === 0 && trace.truncated === false,
			truncated: trace.truncated,
			assistant_stop_reasons: transcript.assistant_stop_reasons,
			assistant_text_chars: transcript.assistant_text_chars,
			pending_tool:
				pending === null
					? null
					: { name: pending.name, arguments_excerpt: pending.arguments_excerpt },
			harvested: transcript.harvested,
		},
		tokens: {
			input: transcript.tokens.input,
			output: transcript.tokens.output,
			cache_read: transcript.tokens.cache_read,
			cache_write: transcript.tokens.cache_write,
			total: tokenTotal,
			source: hasTokenUsage ? "transcript" : "none",
		},
		step_usage:
			stepUsageRow.events === 0
				? null
				: {
						scope: "step",
						events: stepUsageRow.events,
						input_tokens: stepUsageRow.input_tokens,
						output_tokens: stepUsageRow.output_tokens,
						total_tokens: stepUsageRow.input_tokens + stepUsageRow.output_tokens,
					},
		produced,
		benchmark:
			benchmarkRow === undefined
				? null
				: {
						unique_code: benchmarkRow.unique_code,
						is_completed: benchmarkRow.is_completed === 1,
						correct_flag_count: benchmarkRow.correct_flag_count,
						flag_count: benchmarkRow.flag_count,
						hint_used: benchmarkRow.hint_used === 1,
					},
		tool_calls: transcript.tool_calls.map(toDigestToolCall),
	};
}

function stepDigests(executions: ExecutionDigest[]): StepDigest[] {
	const byStep = Map.groupBy(executions, (execution) => execution.step_id);
	return [...byStep.entries()]
		.map(([stepId, rows]) => ({
			step_id: stepId,
			executions: rows.length,
			failure_history: rows.map((row) => ({
				attempt: row.attempt,
				status: row.status,
				failure_class: row.failure_class,
				component: row.component,
			})),
		}))
		.sort((a, b) => a.step_id.localeCompare(b.step_id));
}

export function buildExecutionDigest(
	db: Db,
	projectId: string,
	executionId: string,
	options: ExecutionDigestOptions = {},
): ExecutionDigest {
	getProjectOr404(db, projectId);
	const eventLimit = normalizeLimit(
		options.event_limit,
		DEFAULT_EVENT_LIMIT,
		MAX_EVENT_LIMIT,
		"event_limit",
	);
	const row = readExecutionRow(db, projectId, executionId);
	return digestExecution(db, row, eventLimit);
}

export function buildProjectDigest(
	db: Db,
	projectId: string,
	options: ProjectDigestOptions = {},
): ProjectDigest {
	const project = getProjectOr404(db, projectId);
	const limit = normalizeLimit(
		options.limit,
		DEFAULT_EXECUTION_LIMIT,
		MAX_EXECUTION_LIMIT,
		"limit",
	);
	const eventLimit = normalizeLimit(
		options.event_limit,
		DEFAULT_EVENT_LIMIT,
		MAX_EVENT_LIMIT,
		"event_limit",
	);
	const experiment = projectExperimentMetadata(db, project);
	const rows = readExecutionRows(db, projectId, limit, options.step_id);
	const executions = rows.map((row) => digestExecution(db, row, eventLimit));

	const byStatus = Object.fromEntries(
		["queued", "running", "succeeded", "failed", "cancelled", "lost"].map((status) => [status, 0]),
	) as Record<ExecutionStatus, number>;
	const failureClasses: FailureClass[] = [
		"none",
		"cancelled",
		"execution_timeout",
		"lease_failure",
		"endpoint_error",
		"budget_exhausted",
		"harvest_failure",
		"tool_timeout",
		"tool_execution",
		"tool_selection",
		"prompt_contract",
		"context_missing",
		"context_exhausted",
		"model_capability",
		"lost",
		"unknown",
	];
	const byFailureClass = Object.fromEntries(failureClasses.map((value) => [value, 0])) as Record<
		FailureClass,
		number
	>;
	const byComponent: Record<string, number> = {};
	let toolCalls = 0;
	let toolErrors = 0;
	let toolTimeouts = 0;
	let droppedEvents = 0;
	let input = 0;
	let output = 0;
	let cacheRead = 0;
	let cacheWrite = 0;

	for (const execution of executions) {
		byStatus[execution.status] += 1;
		byFailureClass[execution.failure_class] += 1;
		byComponent[execution.component] = (byComponent[execution.component] ?? 0) + 1;
		toolCalls += execution.tool_calls.length;
		toolErrors += execution.tool_calls.filter((call) => call.result === "error").length;
		toolTimeouts += execution.tool_calls.filter((call) => call.timeout).length;
		droppedEvents += execution.transcript.dropped;
		input += execution.tokens.input;
		output += execution.tokens.output;
		cacheRead += execution.tokens.cache_read;
		cacheWrite += execution.tokens.cache_write;
	}

	return {
		project_id: projectId,
		generated_at: utcnow(),
		experiment,
		executions,
		steps: stepDigests(executions),
		summary: {
			executions: executions.length,
			by_status: byStatus,
			by_failure_class: byFailureClass,
			by_component: byComponent,
			tool_calls: toolCalls,
			tool_errors: toolErrors,
			tool_timeouts: toolTimeouts,
			dropped_events: droppedEvents,
			tokens: {
				input,
				output,
				cache_read: cacheRead,
				cache_write: cacheWrite,
				total: input + output,
			},
		},
	};
}
