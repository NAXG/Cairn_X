/**
 * 项目输入附件（uploads）存储：dataRoot 下的项目目录。
 *
 * Server 直接写入目录，Worker 只读挂载对应项目目录。附件不再需要
 * docker CLI、一次性容器或 Docker volume，因此 Server 可以完全脱离
 * Docker Socket 运行。
 */

import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { lstat, mkdir, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform, Readable } from "node:stream";

import { CONTAINER_UPLOADS_DIR } from "../contracts/execution.js";

export const DEFAULT_MAX_UPLOAD_BYTES = 500 * 1024 * 1024;
const UPLOADS_DIR = "uploads";
const TEMP_FILE_MARKER = ".cairn-upload-";

export class UploadTooLargeError extends Error {
	constructor(maxBytes: number) {
		super(`upload exceeds the ${Math.round(maxBytes / 1024 / 1024)}MB limit`);
	}
}

interface UploadEntry {
	name: string;
	size: number;
	modified_at: string;
}

interface SavedUpload {
	name: string;
	path: string;
	size: number;
}

/** 将用户提供的文件名规约成安全的纯文件名（不含目录、不含点文件）。 */
export function sanitizeUploadFilename(raw: string): string {
	const original = path.basename(raw.trim());
	if (original === "" || /^\.+$/.test(original)) throw new Error("invalid filename");
	const base = original.replace(/[^A-Za-z0-9._+\-@%]/g, "_").replace(/^\.+/, "_");
	if (Buffer.byteLength(base, "utf8") > 255) throw new Error("filename is too long");
	return base;
}

/** 返回并校验项目附件目录，projectId 不能跳出 uploads 根目录。 */
function projectUploadsDir(dataRoot: string, projectId: string): string {
	const root = path.resolve(dataRoot, UPLOADS_DIR);
	const dir = path.resolve(root, projectId);
	const relative = path.relative(root, dir);
	if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`)) {
		throw new Error("invalid project id for uploads path");
	}
	return dir;
}

/** 在流式传输过程中统计字节数；超过 maxBytes 即报错。 */
function byteLimiter(maxBytes: number): Transform & { readonly received: number } {
	const state = { received: 0 };
	const stream = new Transform({
		transform(chunk: Buffer, _enc, callback) {
			state.received += chunk.length;
			if (state.received > maxBytes) {
				callback(new UploadTooLargeError(maxBytes));
				return;
			}
			callback(null, chunk);
		},
	});
	Object.defineProperty(stream, "received", {
		get() {
			return state.received;
		},
		configurable: true,
	});
	return stream as Transform & { readonly received: number };
}

/**
 * 将上传字节流写入临时文件，完成后原子替换目标文件。
 * 失败时删除临时文件，已有同名文件不会被破坏。
 */
export async function saveUpload(
	dataRoot: string,
	projectId: string,
	filename: string,
	data: Readable,
	maxBytes: number = DEFAULT_MAX_UPLOAD_BYTES,
): Promise<SavedUpload> {
	let earlyError: unknown;
	const onEarlyError = (err: unknown) => {
		earlyError = err;
	};
	data.once("error", onEarlyError);
	const dir = projectUploadsDir(dataRoot, projectId);
	await mkdir(dir, { recursive: true });
	const safeName = sanitizeUploadFilename(filename);
	const tempPath = path.join(dir, `${TEMP_FILE_MARKER}${randomUUID()}.tmp`);
	const targetPath = path.join(dir, safeName);
	const limiter = byteLimiter(maxBytes);
	data.removeListener("error", onEarlyError);
	if (earlyError !== undefined) throw earlyError;
	try {
		await pipeline(data, limiter, createWriteStream(tempPath, { flags: "wx", mode: 0o600 }));
		await rename(tempPath, targetPath);
		return { name: safeName, path: `${CONTAINER_UPLOADS_DIR}/${safeName}`, size: limiter.received };
	} catch (err) {
		await rm(tempPath, { force: true }).catch(() => undefined);
		throw err;
	}
}

/** 只列出普通文件；临时文件、目录和符号链接均不对外暴露。 */
export async function listUploads(dataRoot: string, projectId: string): Promise<UploadEntry[]> {
	const dir = projectUploadsDir(dataRoot, projectId);
	await mkdir(dir, { recursive: true });
	const entries = await readdir(dir, { withFileTypes: true });
	const result: UploadEntry[] = [];
	for (const entry of entries) {
		if (!entry.isFile() || entry.name.startsWith(TEMP_FILE_MARKER)) continue;
		const filePath = path.join(dir, entry.name);
		const info = await lstat(filePath);
		if (!info.isFile()) continue;
		result.push({ name: entry.name, size: info.size, modified_at: info.mtime.toISOString() });
	}
	return result.sort((a, b) => a.name.localeCompare(b.name));
}

export async function removeUploads(dataRoot: string, projectId: string): Promise<void> {
	await rm(projectUploadsDir(dataRoot, projectId), { recursive: true, force: true });
}
