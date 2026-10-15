import { expect, test } from "vitest";

import { agentSchema } from "../../src/control/schemas.js";

const base = {
	role: "execute" as const,
	revision: 1,
	provider_id: "p",
	model_id: "m",
	prompt: "x",
	thinking: "off" as const,
	context_window: 1000,
	max_output_tokens: 100,
	run_seconds: 10,
	harvest_seconds: 10,
	tools: ["read", "bash", "edit", "write"],
};

test("Execute 必须至少保留 bash", () => {
	expect(agentSchema.safeParse({ ...base, tools: [] }).success).toBe(false);
	expect(agentSchema.safeParse({ ...base, tools: ["read", "edit"] }).success).toBe(false);
	expect(agentSchema.safeParse({ ...base, tools: ["bash"] }).success).toBe(true);
});

test("Decide 允许空工具集", () => {
	expect(agentSchema.safeParse({ ...base, role: "decide", tools: [] }).success).toBe(true);
});

test("bash_mode 可选且受枚举约束", () => {
	expect(agentSchema.safeParse({ ...base, bash_mode: "persistent" }).success).toBe(true);
	expect(agentSchema.safeParse({ ...base, bash_mode: "bogus" }).success).toBe(false);
});

test("Decide 和 Execute 的运行时限可动态设置", () => {
	for (const role of ["decide", "execute"] as const) {
		const profile = {
			...base,
			role,
			run_seconds: 900,
		};
		expect(agentSchema.safeParse(profile).success).toBe(true);
		expect(agentSchema.safeParse({ ...profile, run_seconds: 0 }).success).toBe(false);
	}
});

test("未配置模型时供应商与模型必须同时留空", () => {
	expect(agentSchema.safeParse({ ...base, provider_id: "", model_id: "" }).success).toBe(true);
	expect(agentSchema.safeParse({ ...base, provider_id: "", model_id: "m" }).success).toBe(false);
	expect(agentSchema.safeParse({ ...base, provider_id: "p", model_id: "" }).success).toBe(false);
	expect(agentSchema.safeParse({ ...base, provider_id: "   ", model_id: "" }).success).toBe(false);
});
