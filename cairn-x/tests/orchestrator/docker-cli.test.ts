import { execFile } from "node:child_process";
import { beforeEach, expect, test, vi } from "vitest";
import { docker } from "../../src/environments/docker.js";

vi.mock("node:child_process", () => ({ execFile: vi.fn(), spawn: vi.fn() }));

beforeEach(() => vi.resetAllMocks());

function reply(error: Error | null, stdout = "", stderr = "") {
	vi.mocked(execFile).mockImplementationOnce((...args: unknown[]) => {
		const callback = args.at(-1) as (error: Error | null, stdout: string, stderr: string) => void;
		callback(error, stdout, stderr);
		return undefined as never;
	});
}

test("returns successful output and nonzero CLI exits", async () => {
	reply(null, "running\n");
	await expect(docker(["inspect", "worker"], 30_000)).resolves.toEqual({
		stdout: "running\n",
		stderr: "",
		code: 0,
	});
	reply(Object.assign(new Error("exit"), { code: 1 }), "", "daemon unavailable");
	await expect(docker(["rm", "worker"], 30_000)).resolves.toEqual({
		stdout: "",
		stderr: "daemon unavailable",
		code: 1,
	});
});

test("a timeout kill returns a failed result with diagnostics", async () => {
	reply(Object.assign(new Error("timed out"), { code: null, killed: true, signal: "SIGTERM" }));
	await expect(docker(["rm", "--force", "worker"], 30_000)).resolves.toEqual({
		stdout: "",
		stderr: "docker CLI terminated (SIGTERM)",
		code: -1,
	});
});

test("a signal termination preserves captured output", async () => {
	reply(
		Object.assign(new Error("killed"), { code: null, signal: "SIGKILL" }),
		"partial",
		"diagnostic",
	);
	await expect(docker(["inspect", "worker"], 30_000)).resolves.toEqual({
		stdout: "partial",
		stderr: "diagnostic",
		code: -1,
	});
});

test("missing CLI and spawn failures remain explicit errors", async () => {
	reply(Object.assign(new Error("missing"), { code: "ENOENT" }));
	await expect(docker(["version"], 30_000)).rejects.toThrow("docker CLI not found on PATH");
	reply(Object.assign(new Error("permission denied"), { code: "EACCES" }));
	await expect(docker(["version"], 30_000)).rejects.toThrow("permission denied");
});
