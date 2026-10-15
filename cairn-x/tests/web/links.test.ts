import { test, expect } from "vitest";
import { toolLinks } from "../../src/web/features/traces/links.js";
test("parallel calls pair by explicit identity, never by name", () => {
	const links = toolLinks([
		{
			seq: 1,
			bytes: 0,
			record: {
				message: {
					role: "assistant",
					content: [
						{ type: "toolCall", id: "a", name: "bash" },
						{ type: "toolCall", id: "b", name: "bash" },
					],
				},
			},
		},
		{
			seq: 2,
			bytes: 0,
			record: {
				message: { role: "toolResult", toolName: "bash", toolCallId: "b" },
			},
		},
		{
			seq: 3,
			bytes: 0,
			record: { message: { role: "toolResult", toolName: "bash" } },
		},
	]);
	expect(links.calls.get("a")).toBe(1);
	expect(links.results.get("b")).toBe(2);
	expect(links.results.has("a")).toBe(false);
	expect(links.results.size).toBe(1);
});
