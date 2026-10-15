import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";

import { resolveCompactionSettings } from "../../src/control/compaction.js";
import { createConfigurationControl } from "../../src/control/index.js";
import { openDatabase } from "../../src/server/db.js";
import { testConfig } from "./helpers.js";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("compaction settings use configured values when present", () => {
	expect(resolveCompactionSettings(128_000)).toEqual({
		reserveTokens: 16_384,
		keepRecentTokens: 20_000,
	});
	expect(
		resolveCompactionSettings(262_144, { reserve_tokens: 65_536, keep_recent_tokens: 40_000 }),
	).toEqual({ reserveTokens: 65_536, keepRecentTokens: 40_000 });
});

test("compaction settings clamp values into the context window", () => {
	expect(
		resolveCompactionSettings(16_000, { reserve_tokens: 8_000, keep_recent_tokens: 20_000 }),
	).toEqual({
		reserveTokens: 8_000,
		keepRecentTokens: 7_999,
	});
	expect(resolveCompactionSettings(8_192)).toEqual({
		reserveTokens: 2_048,
		keepRecentTokens: 2_730,
	});
	expect(resolveCompactionSettings(0)).toEqual({ reserveTokens: 16_384, keepRecentTokens: 20_000 });
});

test("activity snapshots freeze the configured compaction section", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "cairn-compaction-"));
	dirs.push(dir);
	const db = openDatabase(path.join(dir, "db"));
	try {
		const control = createConfigurationControl(
			db,
			dir,
			testConfig("http://unused", {
				compaction: { reserve_tokens: 12_345, keep_recent_tokens: 6_789 },
			}),
		);
		const snap = control.store.snapshot("activity-1", "decide", "project");
		expect(snap.compaction).toEqual({ reserve_tokens: 12_345, keep_recent_tokens: 6_789 });
		// 快照是只读冻结：后续读回同一个对象。
		expect(control.store.readSnapshot("activity-1")?.compaction).toEqual({
			reserve_tokens: 12_345,
			keep_recent_tokens: 6_789,
		});
	} finally {
		db.close();
	}
});
