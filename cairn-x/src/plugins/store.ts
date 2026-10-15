import type { PluginSnapshot } from "../contracts/plugins.js";
import { randomUUID } from "node:crypto";
import type { Db } from "../server/db.js";
import type { AgentRole } from "../contracts/configuration.js";
import type { PluginOperation, PluginOperationKind, PluginRelease } from "../contracts/plugins.js";

const ROLES = new Set<AgentRole>(["decide", "execute"]);
const KINDS = new Set<PluginOperationKind>(["install", "update", "remove", "enable", "disable"]);

function roleOf(value: string): AgentRole {
	if (!ROLES.has(value as AgentRole)) throw new Error("Invalid plugin role");
	return value as AgentRole;
}

export class PluginStore {
	constructor(private readonly db: Db) {
		db.exec(
			`CREATE TABLE IF NOT EXISTS plugin_objects (kind TEXT NOT NULL,id TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(kind,id));`,
		);
	}

	private read<T>(kind: string, id: string): T | undefined {
		const row = this.db
			.prepare("SELECT body FROM plugin_objects WHERE kind=? AND id=?")
			.get(kind, id) as { body: string } | undefined;
		return row ? (JSON.parse(row.body) as T) : undefined;
	}

	private write(kind: string, id: string, body: unknown): void {
		this.db
			.prepare(
				"INSERT INTO plugin_objects VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET body=excluded.body",
			)
			.run(kind, id, JSON.stringify(body));
	}

	list(role: AgentRole): PluginRelease | undefined {
		const release = this.current(role);
		// 一个包都没有的 release 等同未安装；顺带挡住字段缺失的残缺行。
		return release && Array.isArray(release.packages) && release.packages.length > 0
			? release
			: undefined;
	}

	/** Includes a retiring installation; unlike list(), no empty-release filtering. */
	current(role: AgentRole): PluginRelease | undefined {
		return this.read<PluginRelease>("current", role);
	}

	setCurrent(role: AgentRole, release: PluginRelease): void {
		this.write("current", role, release);
	}

	removeCurrent(role: AgentRole): void {
		this.db.prepare("DELETE FROM plugin_objects WHERE kind='current' AND id=?").run(role);
	}

	/**
	 * Fence new snapshots before checking whether existing activities still need the files.
	 *
	 * 只统计**快照确实引用了这个 installation** 的活动：fence 之后新建的活动不含该
	 * 插件，按角色放宽计数会让它在持续负载下永远不为 0。
	 */
	beginRemoval(role: AgentRole): number {
		return this.db
			.transaction(() => {
				const release = this.current(role);
				if (release && !release.retiring) this.setCurrent(role, { ...release, retiring: true });
				if (
					this.db
						.prepare(
							"SELECT 1 FROM sqlite_master WHERE type='table' AND name='activity_configurations'",
						)
						.get() === undefined
				)
					return 0;
				// 快照只记它引用的 installation_id，这是唯一依据；认不出归属（更早的部署没写
				// 这个字段）就等于没有活动能引用它，直接放行。
				const installation = release?.installation_id;
				if (installation === undefined) return 0;
				if (role === "execute") {
					// execute 快照的 id 就是 execution_id。
					return (
						this.db
							.prepare(
								`SELECT COUNT(*) AS n FROM executions e
							 JOIN activity_configurations a ON a.id = e.id
							 WHERE e.status IN ('queued','running')
							   AND json_extract(a.body,'$.plugins.installation_id') = ?`,
							)
							.get(installation) as { n: number }
					).n;
				}
				let count = 0;
				if (
					this.db
						.prepare(
							"SELECT 1 FROM sqlite_master WHERE type='table' AND name='configuration_objects'",
						)
						.get() !== undefined
				) {
					const tokens = this.db
						.prepare(
							`SELECT t.body AS token_body, a.body AS snapshot_body
						 FROM configuration_objects t
						 LEFT JOIN activity_configurations a ON a.id=json_extract(t.body,'$.id')
						 WHERE t.kind='activity-token' AND json_extract(t.body,'$.id') LIKE 'decide-%'`,
						)
						.all() as Array<{ token_body: string; snapshot_body: string | null }>;
					for (const token of tokens) {
						const lease = JSON.parse(token.token_body) as { created_at: string };
						const snapshot = token.snapshot_body
							? (JSON.parse(token.snapshot_body) as {
									profile?: { run_seconds?: number; harvest_seconds?: number };
									plugins?: PluginSnapshot;
								})
							: undefined;
						const budgetMs =
							((snapshot?.profile?.run_seconds ?? 300) +
								(snapshot?.profile?.harvest_seconds ?? 60) +
								180) *
							1000;
						const ageMs = Date.now() - Date.parse(lease.created_at);
						if (
							(!Number.isFinite(ageMs) || ageMs <= budgetMs) &&
							snapshot?.plugins?.installation_id === installation
						)
							count += 1;
					}
				}
				const projects = this.db
					.prepare("SELECT decide_worker FROM projects WHERE decide_worker IS NOT NULL")
					.all() as Array<{ decide_worker: string }>;
				// 只取判定所需的那一个字段：整份快照 body 有数 KB，没必要跨 SQLite→JS
				// 边界搬一趟再 JSON.parse。
				const installationOf = this.db.prepare(
					"SELECT json_extract(body,'$.plugins.installation_id') AS inst FROM activity_configurations WHERE id=?",
				);
				for (const project of projects) {
					const id = `decide-${project.decide_worker.replace(/[^0-9A-Za-z-]/g, "-")}`;
					const row = installationOf.get(id) as { inst: string | null } | undefined;
					if (row !== undefined && row.inst === installation) count += 1;
				}
				return count;
			})
			.immediate();
	}

	enqueue(role: AgentRole, kind: PluginOperationKind, source?: string): PluginOperation {
		if (!ROLES.has(role) || !KINDS.has(kind)) throw new Error("Invalid plugin operation");
		const now = new Date().toISOString();
		const operation: PluginOperation = {
			id: randomUUID(),
			role,
			kind,
			...(source === undefined ? {} : { source }),
			status: "queued",
			created_at: now,
			updated_at: now,
			progress: 0,
		};
		this.write("operation", operation.id, operation);
		return operation;
	}

	getOperation(id: string): PluginOperation | undefined {
		return this.read<PluginOperation>("operation", id);
	}

	/**
	 * 把操作放回队列并记下推迟时刻，下一次 claim 时据此让出队头。
	 *
	 * 推迟后 rowid 不变、仍排队首，否则每次认领都先取到它又立刻推迟，同角色后续
	 * 操作永远轮不上。这只影响优先级，不改变「有活动在用就不动文件」的等待语义。
	 */
	deferOperation(id: string, message: string): PluginOperation {
		return this.updateOperation(id, {
			status: "queued",
			worker: undefined,
			progress: 50,
			message,
			deferred_at: new Date().toISOString(),
		});
	}

	updateOperation(id: string, patch: Partial<PluginOperation>): PluginOperation {
		const old = this.getOperation(id);
		if (!old) throw new Error("Plugin operation not found");
		const next = { ...old, ...patch, updated_at: new Date().toISOString() };
		this.write("operation", id, next);
		return next;
	}

	claimNext(role: AgentRole, worker: string): PluginOperation | undefined {
		return this.db.transaction(() => this.claimNextInTransaction(role, worker)).immediate();
	}

	private claimNextInTransaction(role: AgentRole, worker: string): PluginOperation | undefined {
		const row = this.db
			.prepare("SELECT id,body FROM plugin_objects WHERE kind='operation' ORDER BY rowid")
			.all() as Array<{ id: string; body: string }>;
		// 优先取没被推迟过的操作；被推迟过的留作兜底 —— 队列里只剩它时仍要尝试，
		// 否则再没有人推进这个角色。
		let deferred: PluginOperation | undefined;
		let ready: PluginOperation | undefined;
		for (const item of row) {
			const operation = JSON.parse(item.body) as PluginOperation;
			const updatedAt = Date.parse(operation.updated_at);
			if (
				operation.status === "running" &&
				(!Number.isFinite(updatedAt) || Date.now() - updatedAt > 10 * 60_000)
			) {
				this.updateOperation(operation.id, {
					status: "queued",
					worker: undefined,
					message: "安装租约超时，已重新排队",
				});
				operation.status = "queued";
			}
			if (operation.role === role && operation.status === "running") return undefined;
			if (operation.role !== role || operation.status !== "queued") continue;
			// 被推迟过的操作让位给后面排队的操作，否则它作为队头会把整个角色堵死。
			if (operation.deferred_at !== undefined) {
				deferred ??= operation;
				continue;
			}
			ready = operation;
			break;
		}
		const chosen = ready ?? deferred;
		return chosen === undefined
			? undefined
			: this.updateOperation(chosen.id, { status: "running", worker, progress: 1 });
	}

	listOperations(role?: AgentRole): PluginOperation[] {
		const rows = this.db
			.prepare("SELECT body FROM plugin_objects WHERE kind='operation' ORDER BY rowid DESC")
			.all() as Array<{ body: string }>;
		return rows
			.map((row) => JSON.parse(row.body) as PluginOperation)
			.filter((operation) => role === undefined || operation.role === roleOf(role));
	}
}
