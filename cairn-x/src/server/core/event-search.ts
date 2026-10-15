/**
 * 受限过程检索（阶段三）：在 execution_events 上做有界关键词检索，
 * 并提供分页轨迹读取。
 *
 * 预算与边界：
 * - 查询 1–200 字符，空白切分为 1–5 个关键词（AND，大小写不敏感）。
 * - 单次最多扫描 scan_limit 行；命中数、摘录长度、响应总字节均有上限。
 * - 游标 keyset（execution_id:seq），结果确定性排序。
 * - 可检索字段只含用户消息、助手文本、工具调用与工具结果；思考块不参与。
 * - 不提供正则或无上限扫描；越界参数一律 400。
 * - 轨迹分页的字节预算按调用方分层：控制台宽（content_url 懒加载），Worker 窄
 *   （WORKER_INLINE_BYTES，超出即降级摘录），证据上下文最窄（单条按条给预算）。
 */

import type { Db } from "../db.js";
import { ApiError } from "./base.js";
import { getProjectOr404 } from "./project-guards.js";

const SEARCH_MAX_ROWS = 4000;
const SEARCH_MAX_HITS = 50;
const EXCERPT_CHARS = 240;
const RESPONSE_BYTES = 64 * 1024;
export const INLINE_BYTES = 64 * 1024;
/**
 * Worker 轨迹读取的单条内联上限。
 *
 * 远小于 INLINE_BYTES（控制台的预算）：控制台面向人，超大单条走 content_url 懒加载；
 * 而模型读轨迹的目的是**定位事件**，把整条工具输出塞进上下文纯属浪费——bash 输出的
 * 上限已是 16000 字符，任何工具结果都能轻松顶满旧预算。超过此上限的事件降级为可读
 * 摘录，真要全文时按 event_seq/offset 分片补读。
 */
export const WORKER_INLINE_BYTES = 8 * 1024;
/**
 * Worker 单次轨迹分页的总字节预算。
 *
 * 一次工具调用会把整页塞进模型上下文，所以最坏情况必须可控：页预算决定「一次最多看多少」。
 * 配合 WORKER_INLINE_BYTES（单条上限），单次读取从旧的 64 KiB 降到 24 KiB。
 */
export const WORKER_PAGE_BYTES = 24 * 1024;
/** 超限事件降级摘录的字符数：够判断「要不要读全文」，不够就分片。 */
const OVERSIZED_EXCERPT_CHARS = 800;
/** 证据上下文的单条内联上限：上下文只是佐证，主体由 evidence 事件本身承担。 */
export const EVIDENCE_CONTEXT_ENTRY_BYTES = 800;
/** 索引视图单条预览的字符数：够认出是哪条事件，不搬正文。 */
const INDEX_PREVIEW_CHARS = 200;

interface EventSearchHit {
	execution_id: string;
	step_id: string;
	seq: number;
	field: string;
	excerpt: string;
}
interface EventSearchResult {
	hits: EventSearchHit[];
	scanned: number;
	next_cursor: string | null;
	truncated: boolean;
}

interface TraceEntry {
	content_url?: string;
	seq: number;
	bytes: number;
	record?: Record<string, unknown>;
	omitted?: boolean;
	excerpt?: string;
}
interface ExecutionTraceResult {
	entries: TraceEntry[];
	next_cursor: number;
	has_more: boolean;
}
/** 索引视图条目：只用于定位，不含事件正文。 */
interface TraceIndexEntry {
	seq: number;
	bytes: number;
	role?: string;
	tool?: string;
	preview?: string;
}
interface ExecutionTraceIndex {
	entries: TraceIndexEntry[];
	next_cursor: number;
	has_more: boolean;
}

/** 检索参数：控制台路由与 Worker 内部路由共用同一套查询参数。 */
interface EventSearchOptions {
	executionId?: string;
	stepId?: string;
	cursor?: string;
	limit?: number;
}

/** 从请求查询参数提取检索选项（limit 保持字符串→数字的原始转换语义）。 */
export function eventSearchOptionsFromQuery(
	get: (name: string) => string | undefined,
): EventSearchOptions {
	const limit = get("limit");
	return {
		executionId: get("execution_id"),
		stepId: get("step_id"),
		cursor: get("cursor"),
		limit: limit === undefined ? undefined : Number(limit),
	};
}

function parseEventQuery(raw: string | undefined): string[] {
	if (raw === undefined) throw new ApiError(400, "q is required");
	if (raw.length > 200) throw new ApiError(400, "q exceeds 200 characters");
	const terms = raw.trim().split(/\s+/).filter(Boolean);
	if (terms.length === 0 || terms.length > 5 || terms.some((t) => t.length > 80)) {
		throw new ApiError(400, "q must contain 1-5 terms of at most 80 characters");
	}
	return terms.map((t) => t.toLowerCase());
}

function parseCursor(raw: string | undefined): { executionId: string; seq: number } | null {
	if (raw === undefined || raw === "") return null;
	const idx = raw.lastIndexOf(":");
	if (idx <= 0) throw new ApiError(400, "Invalid cursor");
	const seq = Number(raw.slice(idx + 1));
	if (!Number.isSafeInteger(seq) || seq < 0) throw new ApiError(400, "Invalid cursor");
	return { executionId: raw.slice(0, idx), seq };
}

/** 提取一条事件的可检索字段；思考块与非消息记录不参与检索。 */
function searchableFields(line: string): Array<{ field: string; text: string }> {
	let record: unknown;
	try {
		record = JSON.parse(line);
	} catch {
		return [];
	}
	if (!record || typeof record !== "object" || Array.isArray(record)) return [];
	const rec = record as Record<string, unknown>;
	if (rec.type !== "message") return [];
	const message = rec.message as Record<string, unknown> | undefined;
	if (!message || typeof message !== "object") return [];
	const out: Array<{ field: string; text: string }> = [];
	const blocks = message.content;
	if (typeof blocks === "string") {
		out.push({ field: String(message.role ?? "message"), text: blocks });
		return out;
	}
	if (!Array.isArray(blocks)) return [];
	for (const block of blocks) {
		if (!block || typeof block !== "object") continue;
		const b = block as Record<string, unknown>;
		if (b.type === "text" && typeof b.text === "string") {
			out.push({ field: `${String(message.role)}.text`, text: b.text });
		} else if (b.type === "toolCall") {
			out.push({
				field: "toolCall",
				text: `${String(b.name ?? "")} ${JSON.stringify(b.arguments ?? {})}`,
			});
		} else if (b.type === "thinking") {
			// 显式跳过：隐藏推理不进入检索。
			continue;
		}
	}
	// toolResult 角色的非 text 块（如图片占位）也提取可读文本。
	if (message.role === "toolResult" && Array.isArray(message.content)) {
		for (const block of message.content as unknown[]) {
			if (block && typeof block === "object") {
				const b = block as Record<string, unknown>;
				if (b.type !== "text" && typeof b.text === "string")
					out.push({ field: "toolResult", text: b.text });
			}
		}
	}
	return out;
}

function excerpt(text: string, terms: string[]): string {
	const lower = text.toLowerCase();
	let at = lower.length;
	for (const term of terms) {
		const i = lower.indexOf(term);
		if (i >= 0 && i < at) at = i;
	}
	let originalAt = 0;
	if (at !== lower.length) {
		let lowerAt = 0;
		for (const char of text) {
			if (lowerAt >= at) break;
			lowerAt += char.toLowerCase().length;
			originalAt += char.length;
		}
	}
	const start = Math.max(0, originalAt - 80);
	const slice = text.slice(start, start + EXCERPT_CHARS);
	return (start > 0 ? "…" : "") + slice + (start + EXCERPT_CHARS < text.length ? "…" : "");
}

/**
 * 超限事件的可读摘录。
 *
 * 复用检索用的字段抽取拿正文（跳过 JSON 信封与 thinking 块），抽不到再退回原始行。
 * 摘录只是「要不要读全文」的判断依据，不是内容契约——要原文请走 event_seq 分片。
 */
function eventExcerpt(line: string): string {
	const fields = searchableFields(line);
	const text = fields.length > 0 ? fields.map((f) => f.text).join("\n") : line;
	return text.length <= OVERSIZED_EXCERPT_CHARS
		? text
		: `${text.slice(0, OVERSIZED_EXCERPT_CHARS)}…`;
}

export function searchExecutionEvents(
	db: Db,
	projectId: string,
	rawQuery: string | undefined,
	options: EventSearchOptions = {},
): EventSearchResult {
	getProjectOr404(db, projectId);
	const terms = parseEventQuery(rawQuery);
	const cursor = parseCursor(options.cursor);
	const limit = options.limit ?? 20;
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > SEARCH_MAX_HITS) {
		throw new ApiError(400, `Invalid limit (1-${SEARCH_MAX_HITS})`);
	}
	const filters = ["e.project_id = ?"];
	const params: unknown[] = [projectId];
	if (options.executionId !== undefined) {
		filters.push("ee.execution_id = ?");
		params.push(options.executionId);
	}
	if (options.stepId !== undefined) {
		filters.push("e.step_id = ?");
		params.push(options.stepId);
	}
	if (cursor !== null) {
		filters.push("(ee.execution_id > ? OR (ee.execution_id = ? AND ee.seq > ?))");
		params.push(cursor.executionId, cursor.executionId, cursor.seq);
	}
	const rows = db
		.prepare(
			`SELECT ee.execution_id, e.step_id, ee.seq, ee.line
			 FROM execution_events ee JOIN executions e ON e.id = ee.execution_id
			 WHERE ${filters.join(" AND ")}
			 ORDER BY ee.execution_id, ee.seq LIMIT ${SEARCH_MAX_ROWS + 1}`,
		)
		.iterate(...params) as Iterable<{
		execution_id: string;
		step_id: string;
		seq: number;
		line: string;
	}>;
	const hits: EventSearchHit[] = [];
	let scanned = 0;
	let last: { execution_id: string; seq: number } | null = null;
	let truncated = false;
	let bytes = 0;
	for (const row of rows) {
		if (scanned >= SEARCH_MAX_ROWS) {
			truncated = true;
			break;
		}
		scanned += 1;
		last = { execution_id: row.execution_id, seq: row.seq };
		const fields = searchableFields(row.line);
		if (fields.length === 0) continue;
		const haystack = fields.map((f) => f.text.toLowerCase()).join("\n");
		if (!terms.every((t) => haystack.includes(t))) continue;
		const field = fields.find((f) => terms.some((t) => f.text.toLowerCase().includes(t)))!;
		const hit: EventSearchHit = {
			execution_id: row.execution_id,
			step_id: row.step_id,
			seq: row.seq,
			field: field.field,
			excerpt: excerpt(field.text, terms),
		};
		const size = Buffer.byteLength(JSON.stringify(hit));
		if (hits.length >= limit) {
			truncated = true;
			const previous = hits[hits.length - 1];
			last = { execution_id: previous.execution_id, seq: previous.seq };
			break;
		}
		if (hits.length && bytes + size > RESPONSE_BYTES) {
			truncated = true;
			// 游标必须指向最后一条已返回的命中；当前命中下一轮从它之后重新扫描。
			const previous = hits[hits.length - 1];
			if (previous !== undefined) {
				last = { execution_id: previous.execution_id, seq: previous.seq };
			}
			break;
		}
		bytes += size;
		hits.push(hit);
	}
	return {
		hits,
		scanned,
		next_cursor: truncated && last !== null ? `${last.execution_id}:${last.seq}` : null,
		truncated,
	};
}

/**
 * 最后一个「发出但没有结果」的工具调用。
 *
 * 执行被控制端硬杀（deadline → lost）时，Worker 来不及上报任何东西，执行记录里只剩
 * 一句 "deadline exceeded" —— 看不出它卡在哪。而轨迹是实时回传持久化的，所以这里从
 * execution_events 反推「中断时正在跑的那个工具」，让 lost 从黑盒变成可诊断的证据。
 *
 * 判定：倒序找到最后一个 toolCall；若窗口内没有同 id 的 toolResult，就是它没返回。
 */
export function lastPendingToolCall(
	db: Db,
	executionId: string,
	window = 300,
): { name: string; preview: string } | null {
	const rows = db
		.prepare("SELECT line FROM execution_events WHERE execution_id = ? ORDER BY seq DESC LIMIT ?")
		.all(executionId, window) as Array<{ line: string }>;
	const settled = new Set<string>();
	const calls: Array<{ id: string | null; name: string; preview: string }> = [];
	for (const row of rows) {
		let record;
		try {
			record = JSON.parse(row.line);
		} catch {
			continue;
		}
		const message = record?.message;
		if (!message || typeof message !== "object") continue;
		if (message.role === "toolResult" && typeof message.toolCallId === "string")
			settled.add(message.toolCallId);
		if (!Array.isArray(message.content)) continue;
		for (const block of [...message.content].reverse()) {
			if (block?.type === "toolCall" && typeof block.name === "string")
				calls.push({
					id: typeof block.id === "string" ? block.id : null,
					name: block.name,
					preview: JSON.stringify(block.arguments ?? {}).slice(0, 200),
				});
		}
	}
	const pending = calls.find((call) => call.id === null || !settled.has(call.id));
	return pending ? { name: pending.name, preview: pending.preview } : null;
}

/** 给「执行被硬杀」的 error 补上卡住的那个工具；查不到就原样返回。 */
export function annotateInterruptedTool(db: Db, executionId: string, error: string): string {
	const pending = lastPendingToolCall(db, executionId);
	if (pending === null) return error;
	const detail = pending.preview === "{}" ? "" : ` ${pending.preview}`;
	const text = `${error}；中断时最后发出且未返回的工具：${pending.name}${detail}`;
	return text.length > 800 ? `${text.slice(0, 799)}…` : text;
}
/** Shared execution scoping for pages and individual event fragments. */
function requireTrace(db: Db, projectId: string, executionId: string): void {
	getProjectOr404(db, projectId);
	if (
		!db
			.prepare("SELECT 1 FROM executions WHERE id = ? AND project_id = ?")
			.get(executionId, projectId)
	)
		throw new ApiError(404, "Execution not found");
}

interface TracePresentation {
	pageBytes?: number;
	/** 单条事件的内联上限；默认 INLINE_BYTES。Worker 路径收紧以省上下文 token。 */
	inlineBytes?: number;
	/** 页内单条的内联预算；默认与 pageBytes 相同。用于「页可以大、单条要小」。 */
	entryBytes?: number;
	/** 索引模式：只回定位字段。由调用方（Worker 路由）按 view 参数开启。 */
	index?: boolean;
	oversizedUrl?: (seq: number) => string;
	skipInvalid?: boolean;
}

/** One query/cursor implementation; public and worker routes retain their presentation. */
function readExecutionTrace(
	db: Db,
	projectId: string,
	executionId: string,
	afterSeq = 0,
	limit = 100,
	presentation: TracePresentation = {},
): ExecutionTraceResult {
	requireTrace(db, projectId, executionId);
	if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) throw new ApiError(400, "Invalid after_seq");
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200)
		throw new ApiError(400, "Invalid limit (1-200)");
	const rows = db
		.prepare(
			"SELECT seq, line FROM execution_events WHERE execution_id = ? AND seq > ? ORDER BY seq LIMIT ?",
		)
		.iterate(executionId, afterSeq, limit) as Iterable<{ seq: number; line: string }>;
	const entries: TraceEntry[] = [];
	let next = afterSeq,
		bytes = 0;
	const pageBytes = presentation.pageBytes ?? RESPONSE_BYTES;
	const inlineBytes = presentation.inlineBytes ?? INLINE_BYTES;
	const entryBytes = presentation.entryBytes ?? pageBytes;
	for (const row of rows) {
		let record: unknown;
		try {
			record = JSON.parse(row.line);
		} catch {
			record = undefined;
		}
		const valid = record !== null && typeof record === "object" && !Array.isArray(record);
		if (!valid && presentation.skipInvalid) {
			next = row.seq;
			continue;
		}
		const lineBytes = Buffer.byteLength(row.line);
		const oversized: TraceEntry = presentation.oversizedUrl
			? { seq: row.seq, bytes: lineBytes, content_url: presentation.oversizedUrl(row.seq) }
			: { seq: row.seq, bytes: lineBytes, omitted: true, excerpt: eventExcerpt(row.line) };
		let item: TraceEntry;
		if (lineBytes > inlineBytes) item = oversized;
		else
			item = valid
				? { seq: row.seq, bytes: lineBytes, record: record as Record<string, unknown> }
				: { seq: row.seq, bytes: lineBytes, omitted: true };
		// Include envelope overhead; an event at the inline limit may still need a fragment.
		if (Buffer.byteLength(JSON.stringify(item)) + 128 > entryBytes) item = oversized;
		const size = Buffer.byteLength(JSON.stringify(item)) + 1;
		if (entries.length && bytes + size + 128 > pageBytes) break;
		entries.push(item);
		bytes += size;
		next = row.seq;
	}
	return {
		entries,
		next_cursor: next,
		has_more: !!db
			.prepare("SELECT 1 FROM execution_events WHERE execution_id = ? AND seq > ? LIMIT 1")
			.get(executionId, next),
	};
}

/**
 * 索引视图的单条投影：正文压成短预览，其余只留定位字段。
 *
 * 复用检索的字段抽取（跳到正文），所以预览里不会掺 JSON 信封。
 */
function indexEntry(seq: number, line: string, lineBytes: number): TraceIndexEntry {
	const entry: TraceIndexEntry = { seq, bytes: lineBytes };
	const fields = searchableFields(line);
	if (fields.length > 0) {
		const text = fields.map((f) => f.text).join("\n");
		entry.preview =
			text.length <= INDEX_PREVIEW_CHARS ? text : `${text.slice(0, INDEX_PREVIEW_CHARS)}…`;
	}
	let record: unknown;
	try {
		record = JSON.parse(line);
	} catch {
		return entry;
	}
	if (!record || typeof record !== "object" || Array.isArray(record)) return entry;
	const message = (record as Record<string, unknown>).message;
	if (!message || typeof message !== "object" || Array.isArray(message)) return entry;
	const msg = message as Record<string, unknown>;
	if (typeof msg.role === "string") entry.role = msg.role;
	if (Array.isArray(msg.content)) {
		for (const block of msg.content as unknown[]) {
			if (!block || typeof block !== "object") continue;
			const call = block as Record<string, unknown>;
			if (call.type === "toolCall" && typeof call.name === "string") entry.tool = call.name;
		}
	}
	return entry;
}

/**
 * 索引视图：只回定位字段，不回正文。
 *
 * 与分页视图共用页预算，但单条只有一行预览，所以一页能覆盖的事件数高一个数量级。
 */
function readExecutionIndex(
	db: Db,
	projectId: string,
	executionId: string,
	afterSeq = 0,
	limit = 100,
): ExecutionTraceIndex {
	requireTrace(db, projectId, executionId);
	if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) throw new ApiError(400, "Invalid after_seq");
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200)
		throw new ApiError(400, "Invalid limit (1-200)");
	const rows = db
		.prepare(
			"SELECT seq, line FROM execution_events WHERE execution_id = ? AND seq > ? ORDER BY seq LIMIT ?",
		)
		.iterate(executionId, afterSeq, limit) as Iterable<{ seq: number; line: string }>;
	const entries: TraceIndexEntry[] = [];
	let next = afterSeq,
		bytes = 0;
	for (const row of rows) {
		const item = indexEntry(row.seq, row.line, Buffer.byteLength(row.line));
		const size = Buffer.byteLength(JSON.stringify(item)) + 1;
		if (entries.length && bytes + size + 128 > WORKER_PAGE_BYTES) break;
		entries.push(item);
		bytes += size;
		next = row.seq;
	}
	return {
		entries,
		next_cursor: next,
		has_more: !!db
			.prepare("SELECT 1 FROM execution_events WHERE execution_id = ? AND seq > ? LIMIT 1")
			.get(executionId, next),
	};
}

/** Raw JSON text fragments; concatenate text by next_offset before parsing. UTF-16 offsets. */
function readExecutionEventChunk(
	db: Db,
	projectId: string,
	executionId: string,
	seq: number,
	offset = 0,
) {
	requireTrace(db, projectId, executionId);
	if (!Number.isSafeInteger(seq) || seq < 1) throw new ApiError(400, "Invalid event_seq");
	if (!Number.isSafeInteger(offset) || offset < 0) throw new ApiError(400, "Invalid offset");
	const row = db
		.prepare("SELECT line FROM execution_events WHERE execution_id = ? AND seq = ?")
		.get(executionId, seq) as { line: string } | undefined;
	if (!row) throw new ApiError(404, "Event not found");
	if (offset > row.line.length) throw new ApiError(400, "Offset exceeds event length");
	const text = row.line.slice(offset, offset + 8000);
	return {
		seq,
		offset,
		text,
		next_offset: offset + text.length,
		has_more: offset + text.length < row.line.length,
	};
}

export function readTraceRequest(
	db: Db,
	projectId: string,
	executionId: string,
	get: (name: string) => string | undefined,
	presentation: TracePresentation = {},
) {
	const seq = get("event_seq");
	if (seq !== undefined)
		return readExecutionEventChunk(
			db,
			projectId,
			executionId,
			Number(seq),
			Number(get("offset") ?? 0),
		);
	if (get("offset") !== undefined) throw new ApiError(400, "offset requires event_seq");
	if (presentation.index)
		return readExecutionIndex(
			db,
			projectId,
			executionId,
			Number(get("after_seq") ?? 0),
			Number(get("limit") ?? 100),
		);
	return readExecutionTrace(
		db,
		projectId,
		executionId,
		Number(get("after_seq") ?? 0),
		Number(get("limit") ?? 100),
		presentation,
	);
}
