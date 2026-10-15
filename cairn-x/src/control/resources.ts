/**
 * 活动资源目录的生命周期。
 *
 * 每次活动运行都会给 SDK 一个 agentDir（`<dataRoot>/activity-resources/<快照 id>`），
 * 让框架放它自己的会话状态。这个目录没有进数据库，也没有任何读取方：会话列表、
 * 轨迹导出、消息读取都只看 `<dataRoot>/<projectId>/sessions`。
 *
 * 但它的产生频率是「每轮活动一个」：快照行会被裁剪（每项目每角色只保留最近若干条），
 * 项目也会被删除 —— 目录必须跟着一起清掉，否则数据目录会随运行次数堆满残留。
 */

import { readdirSync, rmSync } from "node:fs";
import { consoleLogger } from "../shared/logger.js";
import path from "node:path";

/** 资源根目录（serve 与 dispatcher 共享同一份 dataRoot）。 */
export function activityResourcesRoot(dataRoot: string): string {
	return path.join(dataRoot, "activity-resources");
}

/**
 * 快照 id → 资源目录。
 *
 * 规约方式沿用 control/session 的历史命名（非法字符换成下划线），保证清理能够
 * 命中既有目录，而不是删到一个新拼出来的空路径。
 */
export function activityResourceDir(dataRoot: string, snapshotId: string): string {
	const name = resourceDirName(snapshotId);
	if (name === "") throw new Error("Activity snapshot id is required");
	return path.join(activityResourcesRoot(dataRoot), name);
}

function resourceDirName(snapshotId: string): string {
	return snapshotId.replace(/[^a-zA-Z0-9_-]/g, "_");
}

/** 删除若干快照的资源目录（best-effort：删不掉只记日志，不打断调用方）。 */
export function discardActivityResources(dataRoot: string, snapshotIds: Iterable<string>): void {
	for (const id of snapshotIds) {
		try {
			rmSync(activityResourceDir(dataRoot, id), { recursive: true, force: true });
		} catch (err) {
			consoleLogger.error(`activity resources of ${id} could not be removed: ${String(err)}`);
		}
	}
}

/**
 * 清掉没有对应快照行的残留目录，返回删了几个。
 *
 * 快照裁剪是即时的，进程却是随时重启的：启动时扫一遍可以把崩溃/旧版本留下的
 * 残留一次性收干净，也覆盖「裁剪发生在按 id 清理不可用」的历史数据。
 */
export function pruneOrphanActivityResources(
	dataRoot: string,
	liveSnapshotIds: Iterable<string>,
): number {
	const keep = new Set([...liveSnapshotIds].map(resourceDirName));
	let entries: string[];
	try {
		entries = readdirSync(activityResourcesRoot(dataRoot));
	} catch (err) {
		// 没有 resources 根目录 = 从没跑过活动，不是错误。
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return 0;
		throw err;
	}
	let removed = 0;
	for (const entry of entries) {
		if (keep.has(entry)) continue;
		try {
			rmSync(path.join(activityResourcesRoot(dataRoot), entry), { recursive: true, force: true });
			removed += 1;
		} catch (err) {
			consoleLogger.error(`activity resources ${entry} could not be removed: ${String(err)}`);
		}
	}
	return removed;
}
