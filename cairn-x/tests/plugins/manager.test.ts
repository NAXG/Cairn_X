import {
	lstatSync,
	mkdtempSync,
	mkdirSync,
	readFileSync,
	readlinkSync,
	readdirSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { expect, test, onTestFinished } from "vitest";

import { openDatabase } from "../../src/server/db.js";
import { PluginManager } from "../../src/plugins/manager.js";
import { PluginStore } from "../../src/plugins/store.js";
import { createConfigurationControl } from "../../src/control/index.js";
import { testConfig } from "../orchestrator/helpers.js";

function setup(role: "decide" | "execute") {
	const root = mkdtempSync(path.join(tmpdir(), "cairn-plugin-manager-test-"));
	const db = openDatabase(path.join(root, "cairn.db"));
	const source = path.join(root, "plugin-sources", role, "example");
	mkdirSync(source, { recursive: true });
	writeFileSync(path.join(source, "index.js"), "export default function first() {}\n");
	const store = new PluginStore(db);
	const manager = new PluginManager(root, store);
	onTestFinished(() => {
		db.close();
		rmSync(root, { recursive: true, force: true });
	});
	return { root, db, source, store, manager };
}

test("uninstall clears installed files and reinstall starts a new installation at revision one", async () => {
	const { root, source, store, manager } = setup("decide");
	expect(await manager.run(store.enqueue("decide", "install", "./example"))).toBe("applied");
	const first = store.list("decide")!;
	expect(first.revision).toBe(1);
	expect(first.installation_id).toBeTruthy();
	expect(readFileSync(path.join(first.path, "sources", "._example", "index.js"), "utf8")).toContain(
		"first",
	);

	expect(await manager.run(store.enqueue("decide", "remove", "./example"))).toBe("applied");
	expect(store.current("decide")).toBeUndefined();
	expect(readdirSync(path.join(root, "plugins", "decide", "releases"))).toEqual([]);

	writeFileSync(path.join(source, "index.js"), "export default function second() {}\n");
	expect(await manager.run(store.enqueue("decide", "install", "./example"))).toBe("applied");
	const second = store.list("decide")!;
	expect(second.revision).toBe(1);
	expect(second.installation_id).not.toBe(first.installation_id);
	expect(
		readFileSync(path.join(second.path, "sources", "._example", "index.js"), "utf8"),
	).toContain("second");
});

test("update publishes a separate release while keeping the previous version available", async () => {
	const { source, store, manager } = setup("decide");
	await manager.run(store.enqueue("decide", "install", "./example"));
	const original = store.list("decide")!;
	writeFileSync(path.join(source, "index.js"), "export default function updated() {}\n");
	await manager.run(store.enqueue("decide", "update", "./example"));
	const updated = store.list("decide")!;
	expect(updated.revision).toBe(2);
	expect(updated.installation_id).toBe(original.installation_id);
	expect(
		readFileSync(path.join(original.path, "sources", "._example", "index.js"), "utf8"),
	).toContain("first");
	expect(
		readFileSync(path.join(updated.path, "sources", "._example", "index.js"), "utf8"),
	).toContain("updated");
});

test("a republished release keeps its relative symlinks pointing inside itself", async () => {
	// 复制上一版 release 时若不设 verbatimSymlinks，相对链接会被解析成指向上一版目录的
	// 绝对路径，新 release 的资源 realpath 落在自己的版本目录之外，活动装载时被拒。
	const { source, store, manager } = setup("decide");
	writeFileSync(path.join(source, "SKILL.md"), "# skill\n");
	symlinkSync("SKILL.md", path.join(source, "skill-link.md"));

	await manager.run(store.enqueue("decide", "install", "./example"));
	const installed = store.list("decide")!;
	const installedLink = path.join(installed.path, "sources", "._example", "skill-link.md");
	expect(lstatSync(installedLink).isSymbolicLink()).toBe(true);
	expect(path.isAbsolute(readlinkSync(installedLink))).toBe(false);

	// disable 走「复制上一版目录」这条路径，正是曾把链接改写成绝对路径的那一步。
	await manager.run(store.enqueue("decide", "disable"));
	const disabled = store.list("decide")!;
	expect(disabled.revision).toBe(installed.revision + 1);
	expect(disabled.enabled).toBe(false);

	const link = path.join(disabled.path, "sources", "._example", "skill-link.md");
	expect(lstatSync(link).isSymbolicLink()).toBe(true);
	expect(path.isAbsolute(readlinkSync(link))).toBe(false);
	// 与 session 的装载校验同口径：realpath 必须留在自己的版本目录内。
	expect(realpathSync(link).startsWith(realpathSync(disabled.path) + path.sep)).toBe(true);
});

test("removing one local package leaves the other package installed", async () => {
	const { root, store, manager } = setup("decide");
	const second = path.join(root, "plugin-sources", "decide", "second");
	mkdirSync(second, { recursive: true });
	writeFileSync(path.join(second, "index.js"), "export default function second() {}\n");
	await manager.run(store.enqueue("decide", "install", "./example"));
	await manager.run(store.enqueue("decide", "install", "./second"));
	expect(store.list("decide")?.packages).toEqual(["./example", "./second"]);

	await manager.run(store.enqueue("decide", "remove", "./example"));
	const remaining = store.list("decide")!;
	expect(remaining.packages).toEqual(["./second"]);
	expect(remaining.resources.extensions).not.toContain("sources/._example");
	expect(remaining.resources.extensions).toContain("sources/._second");
});

test("uninstall waits for an active execution and prevents new snapshots from loading the plugin", async () => {
	const { root, db, store, manager } = setup("execute");
	const control = createConfigurationControl(db, root, testConfig("http://127.0.0.1:1"));
	db.prepare("INSERT INTO projects (id,title,created_at) VALUES ('p001','project',?)").run(
		new Date().toISOString(),
	);
	db.prepare(
		"INSERT INTO steps (id,project_id,description,creator,created_at) VALUES ('s001','p001','step','test',?)",
	).run(new Date().toISOString());
	expect(await manager.run(store.enqueue("execute", "install", "./example"))).toBe("applied");
	const original = control.store.snapshot("e1", "execute", "p001");
	expect(original.plugins?.revision).toBe(1);
	db.prepare(
		`INSERT INTO executions (id,project_id,step_id,attempt,lease_version,status,created_at)
		 VALUES ('e1','p001','s001',1,0,'running',?)`,
	).run(new Date().toISOString());

	const operation = store.enqueue("execute", "remove", "./example");
	expect(await manager.run(operation)).toBe("deferred");
	expect(store.current("execute")?.retiring).toBe(true);
	expect(readdirSync(path.join(root, "plugins", "execute", "releases"))).toContain("1");
	expect(control.store.snapshot("e2", "execute", "p001").plugins).toBeUndefined();

	db.prepare("UPDATE executions SET status='succeeded' WHERE id='e1'").run();
	expect(await manager.run(operation)).toBe("applied");
	expect(store.current("execute")).toBeUndefined();
	expect(readdirSync(path.join(root, "plugins", "execute", "releases"))).toEqual([]);
});

test("a first install is not blocked by in-flight executions that predate it", async () => {
	const { root, db, store, manager } = setup("execute");
	createConfigurationControl(db, root, testConfig("http://127.0.0.1:1"));
	db.prepare("INSERT INTO projects (id,title,created_at) VALUES ('p001','project',?)").run(
		new Date().toISOString(),
	);
	db.prepare(
		"INSERT INTO steps (id,project_id,description,creator,created_at) VALUES ('s001','p001','step','test',?)",
	).run(new Date().toISOString());
	// 首次安装之前不存在任何插件快照，这个执行不可能引用即将安装的插件。
	db.prepare(
		`INSERT INTO executions (id,project_id,step_id,attempt,lease_version,status,created_at)
		 VALUES ('e1','p001','s001',1,0,'running',?)`,
	).run(new Date().toISOString());

	// 旧行为：beginRemoval 统计全库 queued/running 执行 → deferred；只要持续有负载就永远装不上。
	expect(await manager.run(store.enqueue("execute", "install", "./example"))).toBe("applied");
	expect(store.list("execute")?.revision).toBe(1);
});

test("uninstall is not blocked by executions that never loaded the plugin", async () => {
	const { root, db, store, manager } = setup("execute");
	const control = createConfigurationControl(db, root, testConfig("http://127.0.0.1:1"));
	db.prepare("INSERT INTO projects (id,title,created_at) VALUES ('p001','project',?)").run(
		new Date().toISOString(),
	);
	db.prepare(
		"INSERT INTO steps (id,project_id,description,creator,created_at) VALUES ('s001','p001','step','test',?)",
	).run(new Date().toISOString());
	expect(await manager.run(store.enqueue("execute", "install", "./example"))).toBe("applied");
	// e1 的快照含插件：它确实在用插件文件，卸载必须等它。
	expect(control.store.snapshot("e1", "execute", "p001").plugins?.revision).toBe(1);
	db.prepare(
		`INSERT INTO executions (id,project_id,step_id,attempt,lease_version,status,created_at)
		 VALUES ('e1','p001','s001',1,0,'running',?)`,
	).run(new Date().toISOString());
	const operation = store.enqueue("execute", "remove", "./example");
	expect(await manager.run(operation)).toBe("deferred");
	db.prepare("UPDATE executions SET status='succeeded' WHERE id='e1'").run();

	// e2 在 fence 之后才创建：快照里没有插件，它不使用插件文件。
	expect(control.store.snapshot("e2", "execute", "p001").plugins).toBeUndefined();
	db.prepare(
		`INSERT INTO executions (id,project_id,step_id,attempt,lease_version,status,created_at)
		 VALUES ('e2','p001','s001',2,0,'running',?)`,
	).run(new Date().toISOString());

	// 旧行为：只按「有没有 queued/running 执行」计数，e2 也被算进去 →
	// 持续负载下卸载永远排不上。
	expect(await manager.run(operation)).toBe("applied");
	expect(store.current("execute")).toBeUndefined();
});

test("a deferred operation yields the queue head to later operations", () => {
	const { store } = setup("decide");
	const first = store.enqueue("decide", "remove", "./example");
	// 调用方（dispatcher）在 manager 返回 deferred 时把它放回队列。
	store.deferOperation(first.id, "等待正在使用此插件的活动结束");
	const second = store.enqueue("decide", "install", "./other");

	// 旧行为：推迟过的操作 rowid 不变、仍是队头 → 每次都被它取到，同角色后续操作全被堵死。
	expect(store.claimNext("decide", "w1")?.id).toBe(second.id);
	store.updateOperation(second.id, { status: "succeeded" });

	// 只剩它一个时必须仍然尝试，否则队列再没人推进。
	expect(store.claimNext("decide", "w2")?.id).toBe(first.id);
});

test("uninstall waits for an active Decide lease", async () => {
	const { root, db, store, manager } = setup("decide");
	const control = createConfigurationControl(db, root, testConfig("http://127.0.0.1:1"));
	db.prepare(
		"INSERT INTO projects (id,title,created_at,decide_worker) VALUES ('p001','project',?,'decide:t0')",
	).run(new Date().toISOString());
	expect(await manager.run(store.enqueue("decide", "install", "./example"))).toBe("applied");
	expect(control.store.snapshot("decide-decide-t0", "decide", "p001").plugins).toBeDefined();
	db.prepare(
		"INSERT INTO configuration_objects (kind,id,body) VALUES ('activity-token','token',?)",
	).run(
		JSON.stringify({
			id: "decide-decide-t0",
			project_id: "p001",
			worker: "decide:t0",
			created_at: new Date().toISOString(),
		}),
	);
	const operation = store.enqueue("decide", "remove", "./example");
	expect(await manager.run(operation)).toBe("deferred");
	expect(control.store.snapshot("decide-new", "decide", "p001").plugins).toBeUndefined();
	db.prepare("UPDATE projects SET decide_worker=NULL WHERE id='p001'").run();
	expect(await manager.run(operation)).toBe("deferred");
	db.prepare("DELETE FROM configuration_objects WHERE kind='activity-token'").run();
	expect(await manager.run(operation)).toBe("applied");
	expect(store.current("decide")).toBeUndefined();
	expect(readdirSync(path.join(root, "plugins", "decide", "releases"))).toEqual([]);
});
