/**
 * Docker CLI 基础设施（仅控制端使用）：
 * - docker()：execFile 包装的同步式 CLI 调用（inspect/run/stop/...）。
 *
 * Worker 容器内不存在 docker CLI，也不挂载 docker socket —— 容器生命周期
 * 管理是控制端独占能力。
 */

import { execFile } from "node:child_process";

interface DockerCliResult {
	stdout: string;
	stderr: string;
	code: number;
}

export async function docker(args: string[], timeoutMs: number): Promise<DockerCliResult> {
	return new Promise((resolve, reject) => {
		execFile(
			"docker",
			args,
			{ timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 },
			(error, stdout, stderr) => {
				if (error !== null && (error as NodeJS.ErrnoException).code === "ENOENT") {
					reject(new Error("docker CLI not found on PATH"));
					return;
				}
				if (error !== null && (error.killed || error.signal)) {
					resolve({
						stdout: String(stdout),
						stderr: String(stderr) || `docker CLI terminated (${error.signal ?? "killed"})`,
						code: -1,
					});
					return;
				}
				if (error !== null && typeof (error as { code?: unknown }).code !== "number") {
					reject(error);
					return;
				}
				const code = error === null ? 0 : (error as { code: number }).code;
				resolve({ stdout: String(stdout), stderr: String(stderr), code });
			},
		);
	});
}
