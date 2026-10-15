import { expect, test, vi } from "vitest";

import { docker } from "../../src/environments/docker.js";
import {
	ExecutionEnvironmentManager,
	type ExecutionContainerConfig,
} from "../../src/environments/execution-manager.js";

vi.mock("../../src/environments/docker.js", () => ({ docker: vi.fn() }));

test("failed docker run never removes a container created by another dispatcher", async () => {
	const run = vi.mocked(docker).mockResolvedValue({
		code: 125,
		stdout: "",
		stderr: "container name is already in use",
	});
	const config: ExecutionContainerConfig = {
		image: "cairn-x-worker:test",
		network: "cairn-workers",
		controlUrl: "http://server:8000/",
		dataRoot: "/tmp/cairn",
		dataHostRoot: "/tmp/cairn",
		resources: { cpus: 2, memoryMb: 2048, pidsLimit: 512 },
		stopGraceSeconds: 20,
	};
	const manager = new ExecutionEnvironmentManager(config);
	await expect(
		manager.createProjectWorkerContainer({
			projectId: "p001",
			projectToken: "secret",
			concurrency: 1,
			uploadsDirectory: "/tmp/cairn/uploads/p001",
		}),
	).rejects.toThrow("failed to create project worker container cairn-pw-p001");
	expect(run).toHaveBeenCalledTimes(1);
	expect(run.mock.calls[0]?.[0][0]).toBe("run");
});
