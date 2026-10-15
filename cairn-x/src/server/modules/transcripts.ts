import { conditionalRead } from "../core/read-versions.js";
import { readTraceRequest, INLINE_BYTES } from "../core/event-search.js";
import { open } from "node:fs/promises";
import path from "node:path";
import { Hono } from "hono";
import type { Db } from "../db.js";
import { ApiError } from "../core/base.js";
import { getProjectOr404, requireDecideLease } from "../core/project-guards.js";
import { SESSION_FILE_PATTERN } from "../../contracts/transcripts.js";
import type { TranscriptEntry } from "../../contracts/transcripts.js";

const PAGE_BYTES = 512 * 1024;
function integer(value: string | undefined, fallback: number, max = Number.MAX_SAFE_INTEGER) {
	const n = value === undefined ? fallback : Number(value);
	if (!Number.isSafeInteger(n) || n < 0 || n > max)
		throw new ApiError(400, "Invalid cursor or limit");
	return n;
}
function entry(line: string, seq: number, url: string): TranscriptEntry | null {
	let record: unknown;
	try {
		record = JSON.parse(line);
	} catch {
		return null;
	}
	if (!record || typeof record !== "object" || Array.isArray(record)) return null;
	const bytes = Buffer.byteLength(line);
	return bytes > INLINE_BYTES
		? { seq, bytes, content_url: url }
		: { seq, bytes, record: record as Record<string, unknown> };
}
export function transcriptRoutes(db: Db, dataRoot: string) {
	const app = new Hono();
	const execution = (pid: string, eid: string, worker?: string) => {
		if (worker !== undefined) requireDecideLease(db, pid, worker);
		getProjectOr404(db, pid);
		if (!db.prepare("SELECT id FROM executions WHERE project_id = ? AND id = ?").get(pid, eid))
			throw new ApiError(404, "Execution not found");
	};
	app.get("/projects/:id/activity-summary", (c) => {
		const pid = c.req.param("id");
		getProjectOr404(db, pid);
		return conditionalRead(c, db, pid, "overview", () => {
			const rows = ["decide", "execute"].flatMap((role) => {
				const row = db
					.prepare(
						"SELECT json_extract(body,'$.role') AS role, json_extract(body,'$.profile.model_id') AS model, json_extract(body,'$.provider.name') AS provider, json_extract(body,'$.created_at') AS created_at FROM activity_configurations WHERE json_valid(body) AND json_extract(body,'$.project_id')=? AND json_extract(body,'$.role')=? ORDER BY json_extract(body,'$.created_at') DESC, id DESC LIMIT 1",
					)
					.get(pid, role);
				return row ? [row] : [];
			});
			return rows;
		});
	});
	app.get("/projects/:id/executions/:eid/messages", (c) => {
		const { id, eid } = c.req.param();
		execution(id, eid, c.req.query("worker"));
		const result = readTraceRequest(db, id, eid, (name) => c.req.query(name), {
			pageBytes: PAGE_BYTES,
			skipInvalid: true,
			oversizedUrl: (seq) => `/projects/${id}/executions/${eid}/messages/${seq}`,
		});
		return c.json(
			"next_cursor" in result ? { ...result, next_cursor: String(result.next_cursor) } : result,
		);
	});
	app.get("/projects/:id/executions/:eid/messages/:seq", (c) => {
		const { id, eid } = c.req.param();
		execution(id, eid);
		const row = db
			.prepare("SELECT line FROM execution_events WHERE execution_id = ? AND seq = ?")
			.get(eid, integer(c.req.param("seq"), 0)) as { line: string } | undefined;
		if (!row) throw new ApiError(404, "Message not found");
		return c.body(row.line, 200, {
			"Content-Type": "application/json",
			"Cache-Control": "no-store",
		});
	});
	app.get("/projects/:id/sessions/:file/messages", async (c) => {
		const { id, file } = c.req.param();
		getProjectOr404(db, id);
		if (!SESSION_FILE_PATTERN.test(file)) throw new ApiError(404, "Session not found");
		const full = c.req.query("full") === "1";
		const requestedLimit = integer(c.req.query("limit"), 100, 200);
		const limit = full ? 1 : requestedLimit;
		if (!limit) throw new ApiError(400, "Invalid limit");
		const raw = c.req.query("cursor");
		let cursor = 0;
		let identity = "";
		if (raw) {
			const parts = raw.split(":");
			if (parts.length !== 2) throw new ApiError(400, "Invalid cursor");
			identity = parts[0];
			cursor = integer(parts[1], 0);
		}
		let handle;
		try {
			handle = await open(path.join(dataRoot, id, "sessions", file), "r");
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code === "ENOENT")
				throw new ApiError(404, "Session not found");
			throw e;
		}
		try {
			const info = await handle.stat();
			const key = `${info.dev}-${info.ino}`;
			if ((identity && identity !== key) || cursor > info.size)
				throw new ApiError(409, "Session changed; reload records");
			if (cursor) {
				const prior = Buffer.alloc(1);
				await handle.read(prior, 0, 1, cursor - 1);
				if (prior[0] !== 10) throw new ApiError(400, "Cursor must follow a complete line");
			}
			const entries: TranscriptEntry[] = [];
			let position = cursor;
			let bytes = 0;
			// Read bounded chunks. Never advance over an incomplete trailing line.
			let pending = Buffer.alloc(0);
			let scanned = cursor;
			while (scanned < info.size && entries.length < limit) {
				const chunk = Buffer.alloc(Math.min(64 * 1024, info.size - scanned));
				const read = await handle.read(chunk, 0, chunk.length, scanned);
				if (read.bytesRead === 0) throw new ApiError(409, "Session changed; reload records");
				scanned += read.bytesRead;
				pending = Buffer.concat([pending, chunk.subarray(0, read.bytesRead)]);
				if (pending.length > 16 * 1024 * 1024)
					throw new ApiError(413, "Session line exceeds 16 MB");
				let newline;
				while ((newline = pending.indexOf(10)) >= 0) {
					const line = pending.subarray(0, newline).toString("utf8");
					const url = `/projects/${id}/sessions/${encodeURIComponent(file)}/messages?cursor=${key}:${position}&limit=1&full=1`;
					let item = entry(line, position, url);
					if (full && item?.content_url)
						item = {
							seq: position,
							bytes: item.bytes,
							record: JSON.parse(line),
						};
					const size = item ? Buffer.byteLength(JSON.stringify(item)) : 0;
					if (!full && entries.length && bytes + size > PAGE_BYTES)
						return c.json({
							entries,
							next_cursor: `${key}:${position}`,
							has_more: true,
						});
					position += newline + 1;
					pending = pending.subarray(newline + 1);
					bytes += size;
					if (item) entries.push(item);
					if (entries.length >= limit) break;
				}
			}
			return c.json({
				entries,
				next_cursor: `${key}:${position}`,
				// pending 里可能只剩一条写了一半的尾行（没有换行符）：那不算"还有更多"，
				// 因为游标只在解析出完整行时才前进，报 true 会让调用方拿到同一个游标
				// 反复空转。只有缓冲里真的还留着一条完整行才算。
				has_more: scanned < info.size || pending.includes(10),
			});
		} finally {
			await handle.close();
		}
	});
	return app;
}
