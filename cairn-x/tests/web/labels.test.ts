import { expect, test } from "vitest";
import { executionBadge } from "../../src/web/labels.js";

test("execution badge separates delivery from task verdict", () => {
	expect(
		executionBadge({ status: "succeeded", task_status: "satisfied", auto_inconclusive: false }),
	).toEqual({
		status: "succeeded",
		label: "已交付 · 验收达标",
	});
	expect(
		executionBadge({ status: "succeeded", task_status: "inconclusive", auto_inconclusive: false }),
	).toEqual({
		status: "inconclusive",
		label: "已交付 · 验收未确认",
	});
	expect(
		executionBadge({ status: "succeeded", task_status: "inconclusive", auto_inconclusive: true }),
	).toEqual({
		status: "inconclusive",
		label: "已交付 · 验收未确认（自动兜底）",
	});
	expect(
		executionBadge({ status: "succeeded", task_status: "blocked", auto_inconclusive: false }),
	).toEqual({
		status: "inconclusive",
		label: "已交付 · 执行受阻",
	});
	expect(
		executionBadge({ status: "succeeded", task_status: null, auto_inconclusive: false }).label,
	).toBe("已交付");
	expect(
		executionBadge({ status: "cancelled", task_status: null, auto_inconclusive: false }).label,
	).toBe("已取消");
});
