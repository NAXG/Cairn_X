import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { Readable } from "node:stream";
import { tmpdir } from "node:os";
import path from "node:path";

import { onTestFinished, expect, test } from "vitest";

import { sanitizeUploadFilename, saveUpload } from "../../src/environments/uploads.js";
import { createApp } from "../../src/server/app.js";
import { openDatabase } from "../../src/server/db.js";
import { createProject, get } from "./helpers.js";

function createUploadServer() {
	const dir = mkdtempSync(path.join(tmpdir(), "cairn-x-uploads-"));
	const db = openDatabase(path.join(dir, "cairn.db"));
	const app = createApp(db, undefined, { root: dir }, dir);
	onTestFinished(() => {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	});
	return { app, db, dir };
}

function postFile(app: unknown, url: string, content: string | Buffer): Promise<Response> {
	return (app as { request: (input: string, init?: RequestInit) => Promise<Response> }).request(
		url,
		{
			method: "POST",
			headers: { "Content-Type": "application/octet-stream" },
			body: content,
		},
	);
}

test("sanitizeUploadFilename strips directories and unsafe characters", () => {
	expect(sanitizeUploadFilename("../etc/passwd")).toBe("passwd");
	expect(sanitizeUploadFilename("/tmp/evil/../task.zip")).toBe("task.zip");
	expect(sanitizeUploadFilename("my file (1).tar.gz")).toBe("my_file__1_.tar.gz");
	expect(() => sanitizeUploadFilename("..")).toThrow();
	expect(() => sanitizeUploadFilename("")).toThrow();
	expect(() => sanitizeUploadFilename("   ")).toThrow();
});

test("upload streams bytes into the project directory and inserts a hint", async () => {
	const { app, db, dir } = createUploadServer();
	const pid = await createProject(app);
	const payload = Buffer.from([0x00, 0x01, 0xfe, 0xff, 0x42]);
	const res = await postFile(app, `/projects/${pid}/uploads?filename=task.bin`, payload);
	expect(res.status).toBe(201);
	const saved = (await res.json()) as { name: string; path: string; size: number };
	expect(saved).toEqual({ name: "task.bin", path: "/workspace/uploads/task.bin", size: 5 });
	expect(readFileSync(path.join(dir, "uploads", pid, "task.bin"))).toEqual(payload);
	const hints = db.prepare("SELECT * FROM hints WHERE project_id = ?").all(pid) as Array<{
		content: string;
		creator: string;
	}>;
	expect(hints.find((h) => h.content.includes("task.bin"))).toMatchObject({ creator: "human" });
});

test("list returns uploaded files and hides temporary files and symlinks", async () => {
	const { app, dir } = createUploadServer();
	const pid = await createProject(app);
	await postFile(app, `/projects/${pid}/uploads?filename=b.txt`, "bb");
	await postFile(app, `/projects/${pid}/uploads?filename=a.txt`, "aaaa");
	writeFileSync(path.join(dir, "uploads", pid, ".cairn-upload-left.tmp"), "hidden");
	symlinkSync(path.join(dir, "uploads", pid, "a.txt"), path.join(dir, "uploads", pid, "link.txt"));
	const entries = (await (await get(app, `/projects/${pid}/uploads`)).json()) as Array<{
		name: string;
		size: number;
	}>;
	expect(entries.map((e) => [e.name, e.size])).toEqual([
		["a.txt", 4],
		["b.txt", 2],
	]);
});

test("same-name upload replaces atomically and completed projects reject uploads", async () => {
	const { app, db, dir } = createUploadServer();
	const pid = await createProject(app);
	await postFile(app, `/projects/${pid}/uploads?filename=same.txt`, "old");
	await postFile(app, `/projects/${pid}/uploads?filename=same.txt`, "new");
	expect(readFileSync(path.join(dir, "uploads", pid, "same.txt"))).toEqual(Buffer.from("new"));
	db.prepare("UPDATE projects SET status = 'completed' WHERE id = ?").run(pid);
	expect((await postFile(app, `/projects/${pid}/uploads?filename=late.bin`, "x")).status).toBe(409);
});

test("upload stream errors are returned and leave no temporary files", async () => {
	const { dir } = createUploadServer();
	const source = new Readable({ read() {} });
	const request = saveUpload(dir, "proj_test", "broken.bin", source);
	await new Promise((resolve) => setImmediate(resolve));
	source.emit("error", new Error("client disconnected"));
	await expect(request).rejects.toThrow("client disconnected");
	await expect(
		(await import("node:fs/promises")).readdir(path.join(dir, "uploads", "proj_test")),
	).resolves.toEqual([]);
});
