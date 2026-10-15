import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { expect, onTestFinished, test } from "vitest";

import {
	activityResourceDir,
	activityResourcesRoot,
	discardActivityResources,
	pruneOrphanActivityResources,
} from "../../src/control/resources.js";

function fixture() {
	const root = mkdtempSync(path.join(tmpdir(), "cairn-resources-"));
	onTestFinished(() => rmSync(root, { recursive: true, force: true }));
	return root;
}

test("resource dirs are keyed by snapshot id with the historical filename rules", () => {
	const root = fixture();
	// 会话文件用的是 id 本身，资源目录沿用 control/session 的规约：非法字符换成下划线。
	expect(activityResourceDir(root, "decide-deepseek:u-1")).toBe(
		path.join(activityResourcesRoot(root), "decide-deepseek_u-1"),
	);
	expect(activityResourcesRoot(root)).toBe(path.join(root, "activity-resources"));
});

test("discard removes exactly the given snapshot resources", () => {
	const root = fixture();
	for (const id of ["decide-a", "decide-b"]) {
		mkdirSync(activityResourceDir(root, id), { recursive: true });
		writeFileSync(path.join(activityResourceDir(root, id), "state.json"), "{}\n");
	}

	discardActivityResources(root, ["decide-a"]);

	expect(existsSync(activityResourceDir(root, "decide-a"))).toBe(false);
	expect(existsSync(activityResourceDir(root, "decide-b"))).toBe(true);
	// 目录本来就不存在时是幂等的（force: true），不抛错也不影响其他目录。
	discardActivityResources(root, ["decide-a"]);
	expect(existsSync(activityResourceDir(root, "decide-b"))).toBe(true);
});

test("orphan sweep keeps live snapshots and clears the rest", () => {
	const root = fixture();
	for (const id of ["decide-live", "decide-pruned", "execute-stale"]) {
		mkdirSync(activityResourceDir(root, id), { recursive: true });
	}

	expect(pruneOrphanActivityResources(root, ["decide-live"])).toBe(2);
	expect(existsSync(activityResourceDir(root, "decide-live"))).toBe(true);
	expect(existsSync(activityResourceDir(root, "decide-pruned"))).toBe(false);
	expect(existsSync(activityResourceDir(root, "execute-stale"))).toBe(false);
	// 没有残留时再来一次不做事。
	expect(pruneOrphanActivityResources(root, ["decide-live"])).toBe(0);
	// 还没有 resources 根目录（从没跑过活动）时同样安静。
	const empty = fixture();
	expect(pruneOrphanActivityResources(empty, [])).toBe(0);
});
