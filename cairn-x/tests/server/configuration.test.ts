import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, onTestFinished, vi } from "vitest";
import type { ActivitySnapshot, ProviderConnection } from "../../src/contracts/configuration.js";
import { openDatabase } from "../../src/server/db.js";
import { createConfigurationControl, isConfigurationInitialized } from "../../src/control/index.js";
import { deploymentConfigSchema } from "../../src/scheduler/config.js";
import { createApp } from "../../src/server/app.js";
import { testConfig } from "../orchestrator/helpers.js";
import { serve } from "@hono/node-server";
import { createConfiguredSession } from "../../src/control/session.js";
import { createAssistantMessageEventStream, getCurrentSystemPrompt } from "@earendil-works/pi-ai";
import { randomUUID } from "node:crypto";
function setup(apiToken: string | null = "machine") {
	const root = mkdtempSync(path.join(tmpdir(), "cairn-config-"));
	const db = openDatabase(path.join(root, "db"));
	const control = createConfigurationControl(db, root, testConfig("http://unused"));
	const auth = { user: "admin", password: "test", apiToken: apiToken ?? undefined };
	const app = createApp(db, auth, undefined, root, {
		configuration: control,
		executions: {
			db,
			auth,
			configuration: control,
			workerControlUrl: "http://unused",
			bash_timeout_seconds: 120,
			dataRoot: root,
		},
	});
	onTestFinished(() => {
		db.close();
		rmSync(root, { recursive: true, force: true });
	});
	const req = (url: string, method = "GET", body?: unknown, token = "machine") =>
		app.request(url, {
			method,
			headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
			body: body === undefined ? undefined : JSON.stringify(body),
		});
	return { root, db, control, app, req };
}
test("fresh execute profile defaults to minimal persistent bash", () => {
	const { control } = setup();
	const profile = control.store.profile("execute");
	expect(profile.tools).toEqual(["bash"]);
	expect(profile.bash_mode).toBe("persistent");
});

test("deployment startup preserves saved models, budgets, prompts and concurrency", () => {
	const { root, db, control } = setup();
	expect(isConfigurationInitialized(db)).toBe(true);
	const original = control.store.profile("execute");
	control.store.saveProfile({ ...original, run_seconds: 42, prompt: "My saved instructions" });
	const runtime = control.store.get("runtime", "global");
	const deployment = deploymentConfigSchema.parse({
		...testConfig("http://unused"),
		models: { invalid: true },
		runtime: { max_workers: 999 },
		tasks: { execute: { step_timeout: 999 } },
	});
	const reopened = createConfigurationControl(db, root, deployment);
	expect(reopened.store.profile("execute")).toMatchObject({
		model_id: original.model_id,
		run_seconds: 42,
		prompt: "My saved instructions",
	});
	expect(reopened.store.get("runtime", "global")).toEqual(runtime);
});

test.each([null, "", "machine"])(
	"web password cannot authorize settings or internal activities (apiToken=%s)",
	async (apiToken) => {
		const { req } = setup(apiToken);
		expect((await req("/settings/providers", "GET", undefined, "test")).status).toBe(401);
		expect(
			(await req("/internal/activities/decide", "POST", { project_id: "p", worker: "w" }, "test"))
				.status,
		).toBe(401);
	},
);

test("configuration requires admin authentication and never returns credentials", async () => {
	const { req, control } = setup();
	expect((await req("/settings/providers", "GET", undefined, "bad")).status).toBe(401);
	const providers: any = await (await req("/settings/providers")).json();
	expect(JSON.stringify(providers)).not.toContain("api_key");
	expect(providers[0].configured).toBe(true);
	const p = control.models.connection("imported-decide");
	const runtime = await control.models.runtime(p);
	expect((await runtime.getAuth(p.sdk_id))?.auth.apiKey).toBe(
		testConfig("x").models.decide.api_key,
	);
});
test("prompt validation, optimistic revisions and snapshots are independent", async () => {
	const { req, control } = setup();
	const original = control.store.profile("decide");
	const invalid = await req("/settings/agents/decide", "PUT", {
		...original,
		prompt: "{unknown_variable}",
	});
	expect(invalid.status).toBe(400);
	const before = control.store.snapshot("a1", "decide", "project");
	const res = await req("/settings/agents/decide", "PUT", {
		...original,
		prompt: "New decide prompt",
	});
	expect(res.status).toBe(200);
	expect((await req("/settings/agents/decide", "PUT", original)).status).toBe(409);
	expect(control.store.readSnapshot("a1")!.profile.prompt).toBe(before.profile.prompt);
	expect(control.store.snapshot("a2", "decide", "project").profile.prompt).toBe(
		"New decide prompt",
	);
	expect(control.store.profile("execute").prompt).not.toBe("New decide prompt");
});

test("saved Decide and Execute time budgets apply to new activity snapshots", async () => {
	const { req, control } = setup();
	for (const role of ["decide", "execute"] as const) {
		const original = control.store.profile(role);
		const previous = control.store.snapshot(`before-${role}`, role, "project");
		const updated = {
			revision: original.revision,
			run_seconds: role === "decide" ? 900 : 1800,
			harvest_seconds: original.harvest_seconds,
		};
		const response = await req(`/settings/agents/${role}/budget`, "PATCH", updated);
		expect(response.status).toBe(200);
		expect(control.store.snapshot(`after-${role}`, role, "project").profile).toMatchObject({
			run_seconds: updated.run_seconds,
		});
		expect(previous.profile.run_seconds).toBe(original.run_seconds);
	}
});

test("time budgets save before a model is configured, with revision and bounds checks", async () => {
	const root = mkdtempSync(path.join(tmpdir(), "cairn-budget-"));
	const db = openDatabase(path.join(root, "db"));
	const control = createConfigurationControl(db, root);
	const auth = { user: "admin", password: "test", apiToken: "machine" };
	const app = createApp(db, auth, undefined, root, {
		configuration: control,
		executions: {
			db,
			auth,
			configuration: control,
			workerControlUrl: "http://unused",
			bash_timeout_seconds: 120,
			dataRoot: root,
		},
	});
	onTestFinished(() => {
		db.close();
		rmSync(root, { recursive: true, force: true });
	});
	const original = control.store.profile("decide");
	expect(original.provider_id).toBe("");
	const update = {
		revision: original.revision,
		run_seconds: 900,
		harvest_seconds: original.harvest_seconds,
	};
	const request = (payload: unknown) =>
		app.request("/settings/agents/decide/budget", {
			method: "PATCH",
			headers: { Authorization: "Bearer machine", "Content-Type": "application/json" },
			body: JSON.stringify(payload),
		});
	expect((await request({ ...update, run_seconds: 0 })).status).toBe(400);
	expect((await request(update)).status).toBe(200);
	expect(control.store.profile("decide")).toMatchObject({
		run_seconds: 900,
		provider_id: "",
	});
	expect((await request(update)).status).toBe(409);
});

test("an agent can be unbound from its provider so the provider becomes deletable", async () => {
	const { req, control, root } = setup();
	const credential = path.join(
		root,
		"configuration",
		"credentials",
		control.models.connection("imported-decide").credential_id + ".json",
	);
	expect(existsSync(credential)).toBe(true);
	expect(control.store.profile("decide").provider_id).toBe("imported-decide");
	const blocked = await req("/settings/providers/imported-decide", "DELETE");
	expect(blocked.status).toBe(409);
	expect(await blocked.text()).toContain("Dispatcher");
	const profile = control.store.profile("decide");
	const unbound = await req("/settings/agents/decide", "PUT", {
		...profile,
		provider_id: "",
		model_id: "",
		thinking: "off",
	});
	expect(unbound.status).toBe(200);
	expect(control.store.profile("decide")).toMatchObject({ provider_id: "", model_id: "" });
	expect((await req("/settings/providers/imported-decide", "DELETE")).status).toBe(200);
	expect(existsSync(credential)).toBe(false);
});

test("credential replacement rotates identity and removes the old credential file", async () => {
	const { req, control, root } = setup();
	const snap = control.store.snapshot("old", "decide", "p");
	const oldId = snap.provider.credential_id;
	const connection = control.models.connection("imported-decide");
	const saved = await req("/settings/providers/imported-decide", "PUT", {
		...connection,
		api_key: "replacement-secret",
	});
	expect(saved.status).toBe(200);
	const current: any = await saved.json();
	expect(current.credential_id).not.toBe(oldId);
	expect(JSON.stringify(current)).not.toContain("replacement-secret");
	// 历史快照仍引用旧 credential_id（不被改写）。
	expect(snap.provider.credential_id).toBe(oldId);
	const credentialFile = (id: string) =>
		path.join(root, "configuration", "credentials", id + ".json");
	// 轮换后旧凭据文件必须删除：明文 key 不能作为孤儿文件在磁盘上累积。
	expect(existsSync(credentialFile(oldId))).toBe(false);
	// 新凭据已落盘且内容为替换后的 key（此处不创建 ModelRuntime：其惰性
	// ensure 会在文件被删后重建空 stub，干扰后续 clear_key 的断言）。
	expect(JSON.parse(readFileSync(credentialFile(current.credential_id), "utf8"))).toEqual({
		"imported-decide": { type: "api_key", key: "replacement-secret" },
	});

	// clear_key 同样换发 credential_id，且同样不留旧文件。
	const cleared = await req("/settings/providers/imported-decide", "PUT", {
		...control.models.connection("imported-decide"),
		clear_key: true,
	});
	expect(cleared.status).toBe(200);
	const clearedBody: any = await cleared.json();
	expect(clearedBody.credential_id).not.toBe(current.credential_id);
	expect(clearedBody.configured).toBe(false);
	expect(existsSync(credentialFile(current.credential_id))).toBe(false);
});

test("rejected thinking level leaves the provider catalog unchanged", async () => {
	const { req, control } = setup();
	const before = control.models.connection("imported-execute");
	const profile = control.store.profile("execute");
	// 目录外模型 + 未映射 xhigh/max：思考等级校验失败。
	const rejected = await req("/settings/agents/execute", "PUT", {
		...profile,
		model_id: "manual-model",
		thinking: "max",
		context_window: 128000,
		max_output_tokens: 32768,
	});
	expect(rejected.status).toBe(400);
	// 校验失败不得留下目录副作用（旧实现先写目录再校验，revision 已 +1）。
	const after = control.models.connection("imported-execute");
	expect(after.revision).toBe(before.revision);
	expect(after.models.some((m) => m.id === "manual-model")).toBe(false);
	expect(control.store.profile("execute").model_id).toBe(profile.model_id);

	// 等级合法时同一请求成功并自动登记目录模型（原功能保留）。
	const accepted = await req("/settings/agents/execute", "PUT", {
		...profile,
		model_id: "manual-model",
		thinking: "high",
		context_window: 128000,
		max_output_tokens: 32768,
	});
	expect(accepted.status).toBe(200);
	const saved = control.models.connection("imported-execute");
	expect(saved.revision).toBe(before.revision + 1);
	expect(saved.models.some((m) => m.id === "manual-model")).toBe(true);
	expect(control.store.profile("execute").model_id).toBe("manual-model");
});
test("rejects invalid concurrency", async () => {
	const { req, control } = setup();
	expect(
		(
			await req("/settings/runtime", "PUT", {
				...(control.store.get("runtime", "global") as any),
				max_project_workers: 999,
			})
		).status,
	).toBe(400);
});
test("decide activity id is filename-safe even with colons/slashes in the worker name", async () => {
	const { req, db } = setup();
	const created: any = await (
		await req("/projects", "POST", { title: "Naming", origin: "start", goal: "finish" })
	).json();
	const pid = created.project.id;
	// 生产格式：decide:<model_id>:<suffix>:<uuid>（含冒号；model_id 可能含 "/"）。
	const worker = "decide:openai/gpt-5:abc-def:" + randomUUID();
	db.prepare("UPDATE projects SET decide_worker=?,decide_expires_at=? WHERE id=?").run(
		worker,
		new Date(Date.now() + 60000).toISOString(),
		pid,
	);
	const start = await req("/internal/activities/decide", "POST", { project_id: pid, worker });
	expect(start.status).toBe(200);
	const { snapshot } = (await start.json()) as any;
	// 回归防护：snapshot.id 直接用作会话文件名，必须匹配控制台的会话文件命名模式。
	expect(`${snapshot.id}.jsonl`).toMatch(/^(decide|execute)-[0-9A-Za-z-]+\.jsonl$/);
});
test.each(["off", "max"] as const)(
	"PI session streams with thinking=%s through activity-bound model service and records final prompt",
	async (thinking) => {
		const { app, req, control, db, root } = setup();
		const provider = control.models.connection("imported-decide");
		expect(
			(
				await req("/settings/providers/" + provider.id, "PUT", {
					...provider,
					models: provider.models.map((m) => ({
						...m,
						reasoning: true,
						thinkingLevelMap: { max: "high" },
					})),
				})
			).status,
		).toBe(200);
		expect(
			(
				await req("/settings/agents/decide", "PUT", {
					...control.store.profile("decide"),
					thinking,
				})
			).status,
		).toBe(200);
		const created: any = await (
			await req("/projects", "POST", {
				title: "Config integration",
				origin: "start",
				goal: "finish",
			})
		).json();
		const pid = created.project.id;
		const worker = randomUUID();
		db.prepare("UPDATE projects SET decide_worker=?,decide_expires_at=? WHERE id=?").run(
			worker,
			new Date(Date.now() + 60000).toISOString(),
			pid,
		);
		const start = await req("/internal/activities/decide", "POST", { project_id: pid, worker });
		expect(start.status).toBe(200);
		const { snapshot, token } = (await start.json()) as any;
		const runtime = await control.models.runtime(snapshot.provider);
		runtime.registerProvider(snapshot.provider.sdk_id, {
			baseUrl: "http://faux",
			api: "openai-completions",
			models: snapshot.provider.models.map((m: any) => ({
				...m,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			})),
			streamSimple: (model, context, options) => {
				expect(options?.reasoning).toBe(thinking === "off" ? undefined : thinking);
				expect(model.thinkingLevelMap).toEqual({ max: "high" });
				// 0.86 起 provider 收到 TranscriptContext：系统提示词折进 messages。
				expect(getCurrentSystemPrompt(context.messages)).toContain("waiting_on");
				const stream = createAssistantMessageEventStream();
				const message: any = {
					role: "assistant",
					content: [{ type: "text", text: "Verified" }],
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: {
						input: 3,
						output: 2,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 5,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
					timestamp: Date.now(),
				};
				stream.push({ type: "done", reason: "stop", message });
				stream.end();
				return stream;
			},
		});
		const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
		await new Promise<void>((r) => server.on("listening", r));
		const port = (server.address() as any).port;
		try {
			const session = await createConfiguredSession({
				snapshot,
				token,
				controlUrl: `http://127.0.0.1:${port}`,
				workspace: root,
				dataRoot: root,
				variables: {},
				tools: [],
				logger: { debug() {}, info() {}, warn() {}, error() {} },
			});
			try {
				await session.agent.prompt({ role: "user", content: "Test", timestamp: Date.now() });
				expect(session.usage().output_tokens).toBe(2);
				expect(control.store.readSnapshot(snapshot.id)!.final_prompt).toContain("waiting_on");
			} finally {
				session.dispose();
			}
			db.prepare("UPDATE projects SET status='stopped' WHERE id=?").run(pid);
			expect(
				(await req("/internal/activities/model", "POST", { context: { messages: [] } }, token))
					.status,
			).toBe(409);
		} finally {
			await new Promise<void>((r) => server.close(() => r()));
		}
	},
);
test("session initialization aborts a hanging control report after 30 seconds", async () => {
	const { req, db, root } = setup();
	const created = (await (
		await req("/projects", "POST", { title: "Timeout", origin: "o", goal: "g" })
	).json()) as { project: { id: string } };
	const pid = created.project.id;
	const worker = randomUUID();
	db.prepare("UPDATE projects SET decide_worker=?, decide_expires_at=? WHERE id=?").run(
		worker,
		new Date(Date.now() + 60_000).toISOString(),
		pid,
	);
	const response = await req("/internal/activities/decide", "POST", { project_id: pid, worker });
	expect(response.status).toBe(200);
	const { snapshot, token } = (await response.json()) as {
		snapshot: ActivitySnapshot;
		token: string;
	};
	const controller = new AbortController();
	const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
	const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
		expect(String(url)).toBe("http://unused/internal/activities/report");
		expect(init?.signal).toBe(controller.signal);
		expect(timeout).toHaveBeenCalledWith(30_000);
		return new Promise<Response>((_resolve, reject) => {
			init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
			controller.abort(new DOMException("Request timed out", "TimeoutError"));
		});
	});
	try {
		await expect(
			createConfiguredSession({
				snapshot,
				token,
				controlUrl: "http://unused",
				workspace: root,
				dataRoot: root,
				variables: {},
				tools: [],
				logger: { debug() {}, info() {}, warn() {}, error() {} },
			}),
		).rejects.toMatchObject({ name: "TimeoutError" });
		expect(fetchMock).toHaveBeenCalledTimes(1);
	} finally {
		fetchMock.mockRestore();
		timeout.mockRestore();
	}
});

test("decide snapshots are pruned to the keep limit and removed with the project", async () => {
	const { req, db } = setup();
	const created: any = await (
		await req("/projects", "POST", { title: "Prune", origin: "o", goal: "g" })
	).json();
	const pid = created.project.id;
	// 每次 decide 轮换 worker（生产语义：每次运行一个新 worker 身份）。
	for (let i = 0; i < 8; i++) {
		const worker = `decide:m:s:${randomUUID()}`;
		db.prepare("UPDATE projects SET decide_worker=?,decide_expires_at=? WHERE id=?").run(
			worker,
			new Date(Date.now() + 60000).toISOString(),
			pid,
		);
		const res = await req("/internal/activities/decide", "POST", { project_id: pid, worker });
		expect(res.status).toBe(200);
	}
	const count = () =>
		(
			db
				.prepare(
					"SELECT COUNT(*) c FROM activity_configurations WHERE json_extract(body,'$.project_id')=?",
				)
				.get(pid) as any
		).c;
	const tokens = () =>
		(
			db
				.prepare(
					"SELECT COUNT(*) c FROM configuration_objects WHERE kind='activity-token' AND json_extract(body,'$.project_id')=?",
				)
				.get(pid) as any
		).c;
	expect(count()).toBe(5);
	// 每次新认领都会清掉该项目旧的 activity-token 行：只保留当前一条，
	// 否则 configuration_objects 会随 decide 运行次数无界增长。
	expect(tokens()).toBe(1);
	db.prepare("UPDATE projects SET status='stopped' WHERE id=?").run(pid);
	expect((await req(`/projects/${pid}`, "DELETE")).status).toBe(204);
	expect(count()).toBe(0);
	expect(tokens()).toBe(0);
});
test("decide runner drives the configured activity path end to end", async () => {
	const { app, req, control, root } = setup();
	const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
	await new Promise<void>((r) => server.on("listening", r));
	const port = (server.address() as any).port;
	onTestFinished(() => new Promise<void>((r) => server.close(() => r())));
	const url = `http://127.0.0.1:${port}`;
	const { FgsClient } = await import("../../src/orchestrator/client.js");
	const { createDecideRunner } = await import("../../src/agents/decide/runner.js");
	const { fauxAssistantMessage, fauxToolCall } = await import("@earendil-works/pi-ai");
	const client = new FgsClient(url, 10_000, "machine");
	const created: any = await (
		await req("/projects", "POST", { title: "Configured decide", origin: "start", goal: "finish" })
	).json();
	const pid = created.project.id;
	const worker = `decide:mock:sfx:${randomUUID()}`;
	const claim = await client.claimDecide(pid, worker);
	expect(claim.ok).toBe(true);
	// 在控制面运行时上脚本化 decide 模型：先调用 add_step，然后收尾。
	const connection = control.models.connection("imported-decide");
	const runtime = await control.models.runtime(connection);
	let calls = 0;
	runtime.registerProvider(connection.sdk_id, {
		baseUrl: "http://faux",
		api: "openai-completions",
		models: connection.models.map((m: any) => ({
			...m,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		})),
		streamSimple: (model: any, _context: any) => {
			calls++;
			const message =
				calls === 1
					? fauxAssistantMessage([fauxToolCall("get_graph", { view: "planning" })], {
							stopReason: "toolUse",
						})
					: calls === 2
						? fauxAssistantMessage(
								[
									fauxToolCall("add_step", {
										from: ["origin"],
										description: "configured path step",
									}),
								],
								{ stopReason: "toolUse" },
							)
						: fauxAssistantMessage("Done.");
			const stream = createAssistantMessageEventStream();
			stream.push({
				type: "done",
				reason: message.stopReason as any,
				message: { ...message, api: model.api, provider: model.provider, model: model.id },
			});
			stream.end();
			return stream;
		},
	});
	const runner = createDecideRunner({
		client,
		logger: { debug() {}, info() {}, warn() {}, error() {} },
		dataRoot: root,
	});
	const outcome = await runner(
		{
			client,
			projectId: pid,
			projectTitle: claim.data!.title,
			trigger: "test",
			worker,
			planningVersion: 0,
		},
		new AbortController().signal,
	);
	expect(outcome).toBe("success");
	expect(calls).toBeGreaterThanOrEqual(2);
	const after = await client.getRecord(pid, "step", "s001");
	expect(after.description === "configured path step" && after.creator === worker).toBe(true);
	expect((await client.getProjectOverview(pid)).usage.decide.output_tokens).toBeGreaterThanOrEqual(
		0,
	);
	// 会话文件按规约命名，可在控制台"完整历史"中被发现。
	const snapshotId = "decide-" + worker.replace(/[^0-9A-Za-z-]/g, "-");
	const sessionFile = path.join(root, pid, "sessions", `${snapshotId}.jsonl`);
	expect(readFileSync(sessionFile, "utf8").length).toBeGreaterThan(0);
	expect(`${snapshotId}.jsonl`).toMatch(/^(decide|execute)-[0-9A-Za-z-]+\.jsonl$/);
});

// prompt 只在首次初始化时从仓库 .md 播种一次，之后以 DB 为准。于是"改了
// execute.md 却没生效"是一个静默失败 —— 必须有办法在启动时发现它。
test("prompt drift is reported once the DB profile diverges from the repo file", () => {
	const { control } = setup();
	// 新库刚从文件播种 → 两个角色都不漂移。
	expect(control.store.promptDrift("execute").drifted).toBe(false);
	expect(control.store.promptDrift("decide").drifted).toBe(false);
	// 模拟控制台编辑（这是 DB 版本的正常来源，所以只报警不覆盖）。
	const profile = control.store.profile("execute");
	const edited = control.store.saveProfile({ ...profile, prompt: `${profile.prompt}\n额外一行` });
	expect(edited.prompt.endsWith("额外一行")).toBe(true);
	const drift = control.store.promptDrift("execute");
	expect(drift.drifted).toBe(true);
	expect(drift.storedBytes).not.toBe(drift.fileBytes);
	// 另一个角色不受影响。
	expect(control.store.promptDrift("decide").drifted).toBe(false);
	// 恢复成文件内容 → 漂移消失。
	control.store.saveProfile({ ...control.store.profile("execute"), prompt: profile.prompt });
	expect(control.store.promptDrift("execute").drifted).toBe(false);
});

test("activity snapshot records profile revision and deterministic hashes", () => {
	const { control } = setup();
	const snap = control.store.snapshot("snap-1", "execute", "proj_test");
	expect(snap.profile_revision).toBeGreaterThan(0);
	expect(snap.prompt_hash).toMatch(/^[0-9a-f]{64}$/);
	expect(snap.tools_hash).toMatch(/^[0-9a-f]{64}$/);
	expect(snap.model_id).toBe(snap.profile.model_id);
});

test("builtin provider lists the live SDK catalog, so every offered model is savable", async () => {
	const { req, control } = setup();
	const catalog = (await control.models.catalog()).find((p) => p.id === "deepseek")!;
	// 配置当时的快照：内置目录后来换掉过型号，库里却还留着旧名字。
	// 控制台照这份快照渲染下拉框，保存 Agent 时用实时目录校验 → "选得到、存不进去"。
	const staleId = "cairn-retired-model";
	const stale = {
		id: staleId,
		name: staleId,
		contextWindow: 400000,
		maxTokens: 128000,
		reasoning: true,
		thinkingLevelMap: { high: "high" },
	};
	const saved = await req("/settings/providers/deepseek", "PUT", {
		revision: 0,
		name: "DeepSeek",
		kind: "builtin",
		sdk_id: "deepseek",
		base_url: "",
		api: "openai-completions",
		headers: {},
		models: [stale],
		api_key: "sk-test",
	});
	expect(saved.status).toBe(200);
	// 库里的快照本身不动（不是数据迁移，只是渲染口径统一到实时目录）。
	expect(control.models.connection("deepseek").models.map((m) => m.id)).toEqual([staleId]);
	const listed = ((await (await req("/settings/providers")).json()) as ProviderConnection[]).find(
		(p) => p.id === "deepseek",
	)!;
	expect(listed.models.map((m) => m.id)).toEqual(catalog.models.map((m) => m.id));
	expect(listed.models.some((m) => m.id === staleId)).toBe(false);
	// 目录外的名字依旧存不进去 —— 但它已经不会出现在下拉框里了。
	const profile = control.store.profile("decide");
	expect(
		(
			await req("/settings/agents/decide", "PUT", {
				...profile,
				provider_id: "deepseek",
				model_id: staleId,
				thinking: "high",
			})
		).status,
	).toBe(400);
	// 下拉框里的第一个模型必须真的能保存。
	expect(
		(
			await req("/settings/agents/decide", "PUT", {
				...profile,
				provider_id: "deepseek",
				model_id: listed.models[0].id,
				thinking: "high",
			})
		).status,
	).toBe(200);
});
