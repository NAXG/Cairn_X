import { Readable } from "node:stream";

import { Hono } from "hono";

import {
	DEFAULT_MAX_UPLOAD_BYTES,
	listUploads,
	saveUpload,
	sanitizeUploadFilename,
	UploadTooLargeError,
} from "../../environments/uploads.js";
import type { Db } from "../db.js";
import { ApiError, utcnow } from "../core/base.js";
import { nextHintId } from "../core/ids.js";
import { getProjectOr404 } from "../core/project-guards.js";

export interface UploadDeps {
	/** 控制端可见的数据根；附件位于 root/uploads/<projectId>。 */
	root: string;
	maxBytes?: number;
}

function requireBackend(deps: UploadDeps | undefined): UploadDeps {
	if (deps === undefined) {
		throw new ApiError(501, "此服务器未配置文件上传，请启动 serve 时提供 --config 以配置上传后端");
	}
	return deps;
}

export function uploadRoutes(db: Db, deps?: UploadDeps): Hono {
	const app = new Hono();

	app.get("/projects/:id/uploads", async (c) => {
		const pid = c.req.param("id");
		getProjectOr404(db, pid);
		const d = requireBackend(deps);
		return c.json(await listUploads(d.root, pid));
	});

	app.post("/projects/:id/uploads", async (c) => {
		const pid = c.req.param("id");
		const project = getProjectOr404(db, pid);
		if (project.status === "completed") {
			throw new ApiError(409, "Project is completed; its uploads are read-only");
		}
		const d = requireBackend(deps);

		let filename: string;
		try {
			filename = sanitizeUploadFilename(c.req.query("filename") ?? "");
		} catch {
			throw new ApiError(400, "A valid ?filename= query parameter is required");
		}

		const body = c.req.raw.body;
		if (body === null) {
			throw new ApiError(400, "Request body is required (raw file bytes)");
		}
		const data = Readable.fromWeb(body as import("node:stream/web").ReadableStream);

		let saved;
		try {
			saved = await saveUpload(d.root, pid, filename, data, d.maxBytes ?? DEFAULT_MAX_UPLOAD_BYTES);
		} catch (err) {
			if (err instanceof UploadTooLargeError) {
				throw new ApiError(413, err.message);
			}
			throw err;
		}

		const now = utcnow();
		const sizeMb = (saved.size / 1024 / 1024).toFixed(2);
		db.transaction(() => {
			const hid = nextHintId(db, pid);
			db.prepare(
				"INSERT INTO hints (id, project_id, content, creator, created_at) VALUES (?, ?, ?, ?, ?)",
			).run(
				hid,
				pid,
				`用户上传了文件：${saved.path}（${saved.size} 字节 / ${sizeMb}MB）。解题时可直接使用该文件。`,
				"human",
				now,
			);
		}).immediate();

		return c.json(saved, 201);
	});

	return app;
}
