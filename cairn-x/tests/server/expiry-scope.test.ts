import { expect, test } from "vitest";

import type { Db } from "../../src/server/db.js";
import { createProject, createTestServer, post, readPlanningGraph } from "./helpers.js";

/** 模拟旧库中依赖已放弃步骤的 open 记录；新 API 已禁止创建这种步骤。 */
async function blockedStep(app: Parameters<typeof post>[0], db: Db, pid: string): Promise<string> {
	const s1 = await post(app, `/projects/${pid}/steps`, {
		actor: "human",
		creator: "human",
		from: ["origin"],
		description: "dead dependency",
	});
	const s1id = (await s1.json()).id;
	await post(app, `/projects/${pid}/steps/${s1id}/claim`, { worker: "ex" });
	await post(app, `/projects/${pid}/steps/${s1id}/abandon`, { worker: "ex" });
	db.prepare(
		"INSERT INTO steps (id, project_id, description, creator, waiting_on, created_at) VALUES ('s002', ?, 'blocked follower', 'human', ?, ?)",
	).run(pid, JSON.stringify([s1id]), new Date().toISOString());
	return "s002";
}

test("reading project A does not cancel project B's blocked steps", async () => {
	const { app, db } = createTestServer();
	const a = await createProject(app, { title: "A" });
	const b = await createProject(app, { title: "B" });
	const s2 = await blockedStep(app, db, b);
	expect(
		(db.prepare("SELECT status FROM steps WHERE id = ?").get(s2) as { status: string }).status,
	).toBe("open");

	// 读 A 的规划图（会做 A 自己的租约回收）不能顺手改写 B。
	await post(app, `/projects/${a}/decide/claim`, { worker: "reader" });
	await readPlanningGraph(app, a, "reader");

	expect(
		(db.prepare("SELECT status FROM steps WHERE id = ?").get(s2) as { status: string }).status,
	).toBe("open");
});
