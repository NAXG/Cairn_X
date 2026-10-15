import { expect, test } from "vitest";
import type { ProviderConnection } from "../../src/contracts/configuration.js";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { startExecutorTestServer } from "../orchestrator/helpers.js";
import { providerSchema } from "../../src/control/schemas.js";
import { supportedThinkingLevels, type ThinkingLevelMap } from "../../src/contracts/thinking.js";

async function setup() {
	const s = await startExecutorTestServer({
		api: "openai-completions",
		base_url: "http://unused",
		api_key: "test",
	});
	const request = (endpoint: string, data?: unknown) =>
		fetch(s.url + endpoint, {
			method: data ? "PUT" : "GET",
			headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
			body: data ? JSON.stringify(data) : undefined,
		});
	return { ...s, request };
}

test.each(["http://unused", "https://api.deepseek.com"])(
	"imported agents default to high without overwriting saved preferences (%s)",
	async (base_url) => {
		const { control } = await startExecutorTestServer({
			api: "openai-completions",
			base_url,
			api_key: "test",
		});
		for (const role of ["decide", "execute"] as const) {
			const profile = control.store.profile(role);
			expect(profile.thinking).toBe("high");
			const model = control.models.connection(profile.provider_id).models[0];
			expect(model.reasoning).toBe(true);
			expect(supportedThinkingLevels(model)).toContain("high");
		}
		control.store.saveProfile({ ...control.store.profile("execute"), thinking: "low" });
		control.store.initialize();
		expect(control.store.profile("execute").thinking).toBe("low");
	},
);

test("web capability rules match the installed PI SDK, including holes and extended levels", () => {
	for (const reasoning of [false, true])
		for (const thinkingLevelMap of [
			undefined,
			{},
			{ off: null, low: null, xhigh: null, max: "max" },
			{ xhigh: "high", max: "extreme" },
		] as Array<ThinkingLevelMap | undefined>) {
			const model = { reasoning, thinkingLevelMap };
			expect(supportedThinkingLevels(model)).toEqual(getSupportedThinkingLevels(model as any));
		}
});

test("model thinking mappings persist, remain snapshot-bound and reach provider request payloads", async () => {
	const { control, request } = await setup();
	const original = control.models.connection("imported-execute");
	const map: ThinkingLevelMap = { low: null, high: "medium", max: "high" };
	const response = await request("/settings/providers/" + original.id, {
		...original,
		models: original.models.map((m) => ({ ...m, reasoning: true, thinkingLevelMap: map })),
	});
	expect(response.status).toBe(200);
	const provider = (await response.json()) as ProviderConnection;
	expect(provider.models[0].thinkingLevelMap).toEqual(map);
	expect(
		((await (await request("/settings/providers")).json()) as ProviderConnection[]).find(
			(p) => p.id === original.id,
		)?.models[0].thinkingLevelMap,
	).toEqual(map);
	const profile = control.store.profile("execute");
	expect((await request("/settings/agents/execute", { ...profile, thinking: "max" })).status).toBe(
		200,
	);
	const snapshot = control.store.snapshot("thinking-snapshot", "execute", "test-project");
	expect(snapshot.profile.thinking).toBe("max");
	expect(snapshot.provider.models[0].thinkingLevelMap).toEqual(map);
	const { runtime, model } = await control.models.model(snapshot.provider, profile.model_id);
	expect(model.reasoning).toBe(true);
	expect(model.thinkingLevelMap).toEqual(map);
	let payload: any;
	await runtime.completeSimple(
		model,
		{ messages: [{ role: "user", content: "test", timestamp: Date.now() }] },
		{
			reasoning: "max",
			maxRetries: 0,
			onPayload: (body) => {
				payload = body;
				throw new Error("Stop before network: payload captured");
			},
		},
	);
	expect(payload.reasoning_effort).toBe("high");
	const savedProfile = control.store.profile("execute");
	expect(
		(await request("/settings/agents/execute", { ...savedProfile, thinking: "low" })).status,
	).toBe(400);
	expect(
		(await request("/settings/agents/execute", { ...savedProfile, thinking: "xhigh" })).status,
	).toBe(400);
	const cleared = await request("/settings/providers/" + original.id, {
		...provider,
		models: provider.models.map((m: any) => ({ ...m, thinkingLevelMap: undefined })),
	});
	expect(cleared.status).toBe(200);
	expect(
		control.store.readSnapshot("thinking-snapshot")!.provider.models[0].thinkingLevelMap,
	).toEqual(map);
	expect(
		(await control.models.model(control.models.connection(original.id), profile.model_id)).model
			.thinkingLevelMap,
	).toBeUndefined();
});

test("rejects invalid maps and all-disabled reasoning catalogs", async () => {
	const { control } = await setup();
	const provider = control.models.connection("imported-execute");
	for (const thinkingLevelMap of [
		{ high: "" },
		{ high: "  " },
		{ unknown: "high" },
		{ high: 4 },
		{ off: null, minimal: null, low: null, medium: null, high: null },
	]) {
		expect(
			providerSchema.safeParse({
				...provider,
				models: [{ ...provider.models[0], reasoning: true, thinkingLevelMap }],
			}).success,
		).toBe(false);
	}
});
