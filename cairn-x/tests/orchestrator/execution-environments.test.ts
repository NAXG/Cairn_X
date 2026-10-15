/** 附件目录存储回归：二进制安全、原子替换、大小限制和失败清理。 */
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

import { afterEach, expect, test } from "vitest";
import { listUploads, saveUpload, UploadTooLargeError } from "../../src/environments/uploads.js";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("uploads use a project directory and preserve binary bytes", async () => {
	const root = mkdtempSync(path.join(tmpdir(), "cairn-x-upload-dir-"));
	roots.push(root);
	const payload = Buffer.from([0, 1, 254, 255]);
	const saved = await saveUpload(root, "p001", "bytes.bin", Readable.from([payload]));
	expect(saved).toMatchObject({
		name: "bytes.bin",
		size: payload.length,
		path: "/workspace/uploads/bytes.bin",
	});
	expect(readFileSync(path.join(root, "uploads", "p001", "bytes.bin"))).toEqual(payload);
});

test("same-name uploads replace atomically and listings are sorted", async () => {
	const root = mkdtempSync(path.join(tmpdir(), "cairn-x-upload-dir-"));
	roots.push(root);
	await saveUpload(root, "p001", "b.txt", Readable.from(["old"]));
	await saveUpload(root, "p001", "b.txt", Readable.from(["new"]));
	await saveUpload(root, "p001", "a.txt", Readable.from(["a"]));
	expect(readFileSync(path.join(root, "uploads", "p001", "b.txt"), "utf8")).toBe("new");
	expect((await listUploads(root, "p001")).map((entry) => entry.name)).toEqual(["a.txt", "b.txt"]);
});

test("oversized uploads leave no temporary file", async () => {
	const root = mkdtempSync(path.join(tmpdir(), "cairn-x-upload-dir-"));
	roots.push(root);
	await expect(
		saveUpload(root, "p001", "big.bin", Readable.from([Buffer.alloc(4)]), 3),
	).rejects.toBeInstanceOf(UploadTooLargeError);
	expect(readdirSync(path.join(root, "uploads", "p001"))).toEqual([]);
});

test("a dropped upload stream becomes a catchable failure", async () => {
	const root = mkdtempSync(path.join(tmpdir(), "cairn-x-upload-dir-"));
	roots.push(root);
	const source = new Readable({ read() {} });
	const pending = saveUpload(root, "p001", "broken.bin", source);
	await new Promise((resolve) => setImmediate(resolve));
	source.emit("error", new Error("client disconnected"));
	await expect(pending).rejects.toThrow("client disconnected");
	expect(readdirSync(path.join(root, "uploads", "p001"))).toEqual([]);
});
