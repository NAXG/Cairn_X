import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { openDatabase, type Db } from "../../src/server/db.js";
import {
	applyChallengeState,
	applySubmitResult,
	createBenchmarkBinding,
	getBenchmarkBinding,
	markClosed,
} from "../../src/tsecbench/store.js";
import type { Challenge, SubmitFlagResult } from "../../src/tsecbench/types.js";

function makeDb(): Db {
	const dir = mkdtempSync(path.join(tmpdir(), "cairn-bench-store-"));
	const db = openDatabase(path.join(dir, "cairn.db"));
	db.prepare("INSERT INTO projects (id, title, status, created_at) VALUES (?, ?, 'active', ?)").run(
		"p1",
		"p1",
		new Date().toISOString(),
	);
	return db;
}

function challenge(overrides: Partial<Challenge> = {}): Challenge {
	return {
		unique_code: "web_01",
		description: "SQL injection",
		difficulty: "easy",
		level: 1,
		total_score: 100,
		flag_count: 2,
		correct_flag_count: 0,
		is_completed: false,
		container_status: "stopped",
		container_addr: [],
		...overrides,
	};
}

describe("benchmark store", () => {
	it("clears closed_at when the platform reports the container active again", () => {
		const db = makeDb();
		createBenchmarkBinding(db, { projectId: "p1", uniqueCode: "web_01", title: "web_01" });
		markClosed(db, "p1");
		expect(getBenchmarkBinding(db, "p1")?.closed_at).not.toBeNull();

		// worker 调过 benchmark_reset（close→start）：容器重新活跃，closed_at 必须清空，
		// 否则 driver.release() 永久短路、靶场容器泄漏并发槽。
		applyChallengeState(db, "p1", challenge({ container_status: "available" }));
		expect(getBenchmarkBinding(db, "p1")?.closed_at).toBeNull();

		// 平台确认 stopped 时保留既有 closed_at（刷新不应把它抹掉）。
		markClosed(db, "p1");
		const closed = getBenchmarkBinding(db, "p1")!.closed_at;
		applyChallengeState(db, "p1", challenge({ container_status: "stopped" }));
		expect(getBenchmarkBinding(db, "p1")?.closed_at).toBe(closed);
	});

	it("does not mark a binding completed before a flag count is known", () => {
		const db = makeDb();
		createBenchmarkBinding(db, { projectId: "p1", uniqueCode: "web_01", title: "web_01" });
		const result: SubmitFlagResult = {
			correct: false,
			awarded: 0,
			cumulative_score: 0,
			correct_flag_count: 0,
			total_flag_count: 0,
			matched_flag_index: null,
		};

		// flag_count 未知（0）时 0>=0 恒真，不能据此误标完成。
		applySubmitResult(db, "p1", result);
		expect(getBenchmarkBinding(db, "p1")?.is_completed).toBe(false);

		// 平台给出 flag 数后仍按原语义判定通关（2/2）。
		applySubmitResult(db, "p1", {
			...result,
			correct: true,
			correct_flag_count: 2,
			total_flag_count: 2,
		});
		expect(getBenchmarkBinding(db, "p1")?.is_completed).toBe(true);
	});
});
