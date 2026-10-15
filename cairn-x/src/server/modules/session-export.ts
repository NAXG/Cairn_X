/**
 * 完整历史导出：把项目的会话 JSONL 渲染成 PI 官方的独立 HTML 页面
 * （含会话树、分支导航、工具调用渲染），设计参照 pi-web 的
 * /api/sessions/:id/export（app/api/sessions/[id]/export/route.ts）。
 *
 * 渲染复用 @earendil-works/pi-coding-agent 内置的 export-html 模块，
 * 与 pi TUI 的 /export 命令同一份模板，因此任何 PI 会话文件都能导出。
 *
 * 深链防护：PI 模板里 sortChildren/mapNodes/markActive 是递归实现，
 * 超长线性会话（数千条）会爆调用栈。这里沿用 pi-web 的迭代化补丁；
 * 与 pi-web 的区别是补丁容错——模板随 PI 版本变化导致匹配不到时跳过
 * 该补丁（降级为未修补页面），而不是让整个导出失败。
 */
import { randomUUID } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { Hono } from "hono";
import type { Db } from "../db.js";
import { ApiError } from "../core/base.js";
import { getProjectOr404 } from "../core/project-guards.js";
import { consoleLogger } from "../../shared/logger.js";

// 与 modules/sessions.ts 一致：decide-<ts>.jsonl / execute-<step>-a<n>-<ts>.jsonl。
import { SESSION_FILE_PATTERN } from "../../contracts/transcripts.js";

interface ExportHtmlModule {
	// 该版本把 HTML 写到 outputPath 并返回输出文件路径。
	exportFromFile: (inputPath: string, options?: { outputPath?: string }) => Promise<string>;
}

let exporterPromise: Promise<ExportHtmlModule> | null = null;

async function loadExporter(): Promise<ExportHtmlModule> {
	exporterPromise ??= (async () => {
		const { getPackageDir } = await import("@earendil-works/pi-coding-agent");
		const url = pathToFileURL(
			path.join(getPackageDir(), "dist", "core", "export-html", "index.js"),
		).href;
		return (await import(url)) as ExportHtmlModule;
	})();
	try {
		return await exporterPromise;
	} catch (err) {
		// 失败的 Promise 不缓存：否则首次加载失败后导出将永久失败。
		exporterPromise = null;
		throw err;
	}
}

/**
 * 把带缩进的多行字面量转成精确正则（每行行首的空格数固定，
 * 行内容转义），这样同一模板在不同嵌入缩进（PI 版本/打包差异）下都能匹配。
 */
function toIndentRegex(search: string): RegExp {
	const body = search
		.split("\n")
		.map((line) => {
			const m = /^( +)(.*)$/.exec(line);
			if (!m) return line.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			return "[ ]{" + m[1].length + "}" + m[2].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		})
		.join("\\n");
	return new RegExp(body);
}

function replaceOptional(
	source: string,
	name: string,
	search: string,
	replacement: string,
): string {
	const re = toIndentRegex(search);
	const matches = source.match(new RegExp(re.source, "g")) ?? [];
	if (matches.length !== 1) {
		consoleLogger.warn(`session-export: skip patch ${name} (${matches.length} matches)`);
		return source;
	}
	return source.replace(re, replacement);
}

function patchExportHtml(html: string): string {
	html = replaceOptional(
		html,
		"sortChildren",
		`        function sortChildren(node) {
          node.children.sort((a, b) =>
            new Date(a.entry.timestamp).getTime() - new Date(b.entry.timestamp).getTime()
          );
          node.children.forEach(sortChildren);
        }`,
		`        function sortChildren(root) {
          const stack = [root];
          while (stack.length) {
            const node = stack.pop();
            node.children.sort((a, b) =>
              new Date(a.entry.timestamp).getTime() - new Date(b.entry.timestamp).getTime()
            );
            for (let i = node.children.length - 1; i >= 0; i--) {
              stack.push(node.children[i]);
            }
          }
        }`,
	);
	html = replaceOptional(
		html,
		"mapNodes",
		`          function mapNodes(node) {
            treeNodeMap.set(node.entry.id, node);
            node.children.forEach(mapNodes);
          }
          tree.forEach(mapNodes);`,
		`          const stack = [...tree].reverse();
          while (stack.length) {
            const node = stack.pop();
            treeNodeMap.set(node.entry.id, node);
            for (let i = node.children.length - 1; i >= 0; i--) {
              stack.push(node.children[i]);
            }
          }`,
	);
	html = replaceOptional(
		html,
		"markActive",
		`        function markActive(node) {
          let has = activePathIds.has(node.entry.id);
          for (const child of node.children) {
            if (markActive(child)) has = true;
          }
          containsActive.set(node, has);
          return has;
        }`,
		`        function markActive(root) {
          const stack1 = [root];
          const stack2 = [];
          while (stack1.length) {
            const node = stack1.pop();
            stack2.push(node);
            for (const child of node.children) {
              stack1.push(child);
            }
          }
          while (stack2.length) {
            const node = stack2.pop();
            let has = activePathIds.has(node.entry.id);
            for (const child of node.children) {
              if (containsActive.get(child)) has = true;
            }
            containsActive.set(node, has);
          }
        }`,
	);
	return html;
}

function contentDisposition(fileName: string, inline: boolean): string {
	const fallback = fileName.replace(/[^\x20-\x7E]|["\\;\r\n]/g, "_") || "session.html";
	const disposition = inline ? "inline" : "attachment";
	const encoded = encodeURIComponent(fileName).replace(
		/[!'()*]/g,
		(ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
	);
	return `${disposition}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

async function exportSessionFile(filePath: string, inline: boolean): Promise<Response> {
	const { exportFromFile } = await loadExporter();
	// 该 PI 版本的 exportFromFile 把 HTML 写到 outputPath 并返回路径，
	// 不是直接返回 HTML 字符串（与 pi-web 行为一致）。
	const outputPath = path.join(tmpdir(), `cairn-export-${randomUUID()}.html`);
	let html: string;
	try {
		await exportFromFile(filePath, { outputPath });
		html = patchExportHtml(readFileSync(outputPath, "utf8"));
	} finally {
		rmSync(outputPath, { force: true });
	}
	const base = path.basename(filePath, ".jsonl");
	return new Response(html, {
		headers: {
			"Content-Type": "text/html; charset=utf-8",
			"Content-Disposition": contentDisposition(`cairn-session-${base}.html`, inline),
			"Cache-Control": "no-cache",
			"Content-Security-Policy": "frame-ancestors 'none'",
			"X-Content-Type-Options": "nosniff",
			"X-Frame-Options": "DENY",
		},
	});
}

export function sessionExportRoutes(db: Db, dataRoot: string) {
	const app = new Hono();

	// 按会话文件导出（decide 规划 / execute 执行终态刷写的 jsonl）。
	app.get("/projects/:id/sessions/:file/export", async (c) => {
		const pid = c.req.param("id");
		const file = c.req.param("file");
		getProjectOr404(db, pid);
		if (SESSION_FILE_PATTERN.exec(file) === null) throw new ApiError(404, "Session not found");
		const inline = c.req.query("inline") === "1";
		const full = path.resolve(dataRoot, pid, "sessions", file);
		if (!full.startsWith(path.resolve(dataRoot, pid, "sessions") + path.sep))
			throw new ApiError(404, "Session not found");
		try {
			await stat(full);
		} catch {
			throw new ApiError(404, "Session not found");
		}
		return exportSessionFile(full, inline);
	});

	// 按执行记录导出：在 sessions 目录里找 execute-<step>-a<attempt>-* 文件。
	app.get("/projects/:id/executions/:eid/export", async (c) => {
		const { id, eid } = c.req.param();
		getProjectOr404(db, id);
		const row = db
			.prepare("SELECT step_id, attempt FROM executions WHERE project_id = ? AND id = ?")
			.get(id, eid) as { step_id: string; attempt: number } | undefined;
		if (!row) throw new ApiError(404, "Execution not found");
		const dir = path.join(dataRoot, id, "sessions");
		const prefix = `execute-${row.step_id}-a${row.attempt}-`;
		let names: string[];
		try {
			names = await readdir(dir);
		} catch {
			throw new ApiError(404, "该执行还没有完整历史文件");
		}
		const match = names
			.filter((n) => n.startsWith(prefix) && n.endsWith(".jsonl"))
			.sort()
			.pop();
		if (!match) throw new ApiError(404, "该执行还没有完整历史文件");
		return exportSessionFile(path.join(dir, match), c.req.query("inline") === "1");
	});

	return app;
}
