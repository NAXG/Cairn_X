import { activityPage } from "../core/activity-page.js";
import { pageLimit } from "../core/workbench.js";
import { conditionalRead } from "../core/read-versions.js";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { Hono } from "hono";
import type { Db } from "../db.js";
import { getProjectOr404 } from "../core/project-guards.js";
import { SESSION_FILE_PATTERN } from "../../contracts/transcripts.js";

/** 会话文件仅负责原始记录；消息读取统一走 transcripts.ts 的有界 /messages 接口。 */
export function sessionRoutes(db: Db, dataRoot: string): Hono {
	const app = new Hono();
	async function countEntries(
		file: string,
		activity: "decide" | "execute",
	): Promise<{ entries: number; retry: boolean }> {
		const input = createReadStream(file);
		const lines = createInterface({ input, crlfDelay: Infinity });
		let count = 0;
		let retry = false;
		let readTrigger = activity !== "decide";
		try {
			for await (const line of lines) {
				if (!line.trim()) continue;
				count++;
				if (readTrigger || !line.includes('"role":"user"')) continue;
				try {
					const record = JSON.parse(line) as {
						type?: string;
						message?: { role?: string; content?: unknown };
					};
					if (record.type !== "message" || record.message?.role !== "user") continue;
					readTrigger = true;
					retry =
						typeof record.message.content === "string" &&
						/调度触发[^\n]*decide_interrupted/.test(record.message.content);
				} catch {
					// 旧会话的损坏行不影响列表；原始轨迹仍由 messages 接口处理。
				}
			}
		} finally {
			lines.close();
			input.destroy();
		}
		const entries = Math.max(0, count - 1);
		return { entries, retry };
	}

	async function syncSessionIndex(pid: string): Promise<void> {
		getProjectOr404(db, pid);
		const dir = path.join(dataRoot, pid, "sessions");
		let names: string[];
		try {
			names = await readdir(dir);
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
			db.prepare("DELETE FROM workbench_sessions WHERE project_id=?").run(pid);
			return;
		}
		const files: string[] = [];
		for (const name of names) {
			const match = SESSION_FILE_PATTERN.exec(name);
			if (!match) continue;
			const filePath = path.join(dir, name);
			try {
				const info = await stat(filePath);
				if (!info.isFile()) continue;
				const activity = match[1] as "decide" | "execute";
				const identity = `${info.dev}:${info.ino}`;
				const cached = db
					.prepare(
						"SELECT bytes,modified_at,identity,entries,retry FROM workbench_sessions WHERE project_id=? AND file=?",
					)
					.get(pid, name) as
					| { bytes: number; modified_at: string; identity: string; entries: number; retry: number }
					| undefined;
				const counted =
					cached?.bytes === info.size &&
					cached.modified_at === info.mtime.toISOString() &&
					cached.identity === identity
						? { entries: cached.entries, retry: !!cached.retry }
						: await countEntries(filePath, activity);
				if (
					!cached ||
					cached.bytes !== info.size ||
					cached.modified_at !== info.mtime.toISOString() ||
					cached.identity !== identity
				) {
					const attempt = /^execute-(.+)-a(\d+)-/.exec(name);
					db.prepare(
						`INSERT INTO workbench_sessions(project_id,file,activity,bytes,modified_at,sort_at,identity,entries,retry,step_id,attempt) VALUES(?,?,?,?,?,?,?,?,?,?,?)
					 ON CONFLICT(project_id,file) DO UPDATE SET bytes=excluded.bytes,modified_at=excluded.modified_at,identity=excluded.identity,entries=excluded.entries,retry=excluded.retry`,
					).run(
						pid,
						name,
						activity,
						info.size,
						info.mtime.toISOString(),
						info.mtime.toISOString(),
						identity,
						counted.entries,
						Number(counted.retry),
						attempt?.[1] ?? null,
						attempt ? Number(attempt[2]) : null,
					);
				}
				files.push(name);
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
			}
		}
		db.prepare(
			"DELETE FROM workbench_sessions WHERE project_id=? AND file NOT IN (SELECT value FROM json_each(?))",
		).run(pid, JSON.stringify(files));
	}

	app.get("/projects/:id/activities/page", async (c) => {
		const pid = c.req.param("id");
		await syncSessionIndex(pid);
		return conditionalRead(c, db, pid, "activities", () =>
			activityPage(
				db,
				pid,
				pageLimit(c.req.query("limit")),
				c.req.query("cursor"),
				c.req.query("kind") ?? "all",
				c.req.query("step") ?? "",
			),
		);
	});
	return app;
}
