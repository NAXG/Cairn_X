import { createHash } from "node:crypto";
import type { Context } from "hono";
import type { Db } from "../db.js";
import { ApiError } from "./base.js";

type ReadDomain = "overview" | "graph" | "records" | "executions" | "history" | "activities";
const domains: ReadDomain[] = [
	"overview",
	"graph",
	"records",
	"executions",
	"history",
	"activities",
];

/** Versions follow all write paths, including direct database writes. No trace-event trigger. */
export function installReadVersions(db: Db) {
	db.exec(`CREATE TABLE IF NOT EXISTS project_read_versions (
		project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
		overview INTEGER NOT NULL DEFAULT 0, graph INTEGER NOT NULL DEFAULT 0,
		records INTEGER NOT NULL DEFAULT 0, executions INTEGER NOT NULL DEFAULT 0,
		history INTEGER NOT NULL DEFAULT 0, activities INTEGER NOT NULL DEFAULT 0);
		INSERT OR IGNORE INTO project_read_versions(project_id) SELECT id FROM projects;
		CREATE TABLE IF NOT EXISTS collection_read_versions(name TEXT PRIMARY KEY,revision INTEGER NOT NULL);
		INSERT OR IGNORE INTO collection_read_versions VALUES('projects',0);`);
	for (const event of ["INSERT", "UPDATE", "DELETE"])
		db.exec(
			`CREATE TRIGGER IF NOT EXISTS workbench_project_list_${event.toLowerCase()} AFTER ${event} ON project_read_versions ${event === "UPDATE" ? "WHEN OLD.overview IS NOT NEW.overview" : ""} BEGIN UPDATE collection_read_versions SET revision=revision+1 WHERE name='projects'; END;`,
		);
	const stepGraph = [
		"description",
		"status",
		"worker",
		"concluded_at",
		"created_at",
		"goal_id",
		"route_id",
		"waiting_on",
	];
	const executionView = [
		"step_id",
		"attempt",
		"status",
		"created_at",
		"started_at",
		"finished_at",
		"summary",
		"error",
	];
	const tables: Record<string, Partial<Record<ReadDomain, string[] | true>>> = {
		projects: {
			overview: true,
			records: ["title", "status", "created_at"],
			history: ["title", "created_at"],
		},
		facts: { overview: true, graph: true, records: true, history: true },
		goals: { overview: true, graph: true, records: true, history: true },
		findings: { overview: true, graph: true, records: true, history: true },
		hints: { graph: true, records: true, history: true, overview: true },
		routes: { graph: true, records: true },
		steps: {
			overview: ["status", "description", "created_at"],
			graph: stepGraph,
			records: [
				"description",
				"priority",
				"status",
				"creator",
				"summary",
				"waiting_on",
				"route_id",
				"goal_id",
				"created_at",
				"concluded_at",
			],
			history: ["description", "summary", "status", "created_at", "concluded_at"],
		},
		executions: {
			overview: executionView,
			graph: ["step_id", "attempt", "status", "summary", "error", "created_at"],
			records: executionView,
			executions: executionView,
			activities: executionView,
		},
		execution_results: { overview: true, records: true, executions: true, activities: true },
		usage_events: { overview: true, records: true },
		step_sources: { graph: true, records: true },
		goal_evidence: { graph: true, records: true },
		evidence_refs: { records: true },
		persistent_hints: { records: true, history: true },
		decide_checkpoints: { overview: true },
		decide_changes: { overview: true, activities: true },
	};
	db.transaction(() => {
		for (const [table, relevant] of Object.entries(tables))
			for (const action of ["INSERT", "UPDATE", "DELETE"] as const) {
				const name = `workbench_v1_${table}_${action.toLowerCase()}`;
				const project = (ref: string) =>
					table === "projects"
						? `${ref}.id`
						: table === "execution_results"
							? `(SELECT project_id FROM executions WHERE id=${ref}.execution_id)`
							: `${ref}.project_id`;
				const assignments = domains
					.filter((d) => relevant[d])
					.map((d) => {
						const fields = relevant[d];
						const columns =
							fields === true
								? (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
										(c) => c.name,
									)
								: (fields as string[]);
						const identity =
							table === "projects"
								? ["id"]
								: table === "execution_results"
									? ["execution_id"]
									: [
											"project_id",
											...(columns.includes("id") || table === "steps" || table === "executions"
												? ["id"]
												: []),
										];
						const condition =
							action !== "UPDATE"
								? "1"
								: [...new Set([...columns, ...identity])]
										.map((f) => `OLD."${f}" IS NOT NEW."${f}"`)
										.join(" OR ");
						return `${d}=${d}+CASE WHEN ${condition} THEN 1 ELSE 0 END`;
					})
					.join(",");
				const ref = action === "DELETE" ? "OLD" : "NEW";
				// An outer UPSERT can override a trigger's OR IGNORE policy. Avoid conflicts entirely.
				db.exec(`DROP TRIGGER IF EXISTS ${name}; CREATE TRIGGER ${name} AFTER ${action} ON ${table} BEGIN
				INSERT INTO project_read_versions(project_id) SELECT ${project(ref)} WHERE EXISTS(SELECT 1 FROM projects WHERE id=${project(ref)}) AND NOT EXISTS(SELECT 1 FROM project_read_versions WHERE project_id=${project(ref)});
				UPDATE project_read_versions SET ${assignments} WHERE project_id=${project(ref)};
				${action === "UPDATE" ? `UPDATE project_read_versions SET ${assignments} WHERE project_id=${project("OLD")} AND ${project("OLD")} IS NOT ${project("NEW")};` : ""}
			END;`);
			}
	})();
}

/** Authenticate in middleware, reap before calling; version and payload share this read snapshot. */
export function conditionalRead(
	c: Context,
	db: Db,
	projectId: string,
	domain: ReadDomain,
	build: () => unknown,
	validate?: () => void,
): Response {
	return db.transaction(() => {
		if (!db.prepare("SELECT 1 FROM projects WHERE id=?").get(projectId))
			throw new ApiError(404, "Project not found");
		validate?.();
		const version =
			(
				db
					.prepare(`SELECT ${domain} revision FROM project_read_versions WHERE project_id=?`)
					.get(projectId) as { revision: number } | undefined
			)?.revision ?? 0;
		return conditionalResponse(c, version, build);
	})();
}

function conditionalResponse(c: Context, version: number, build: () => unknown): Response {
	const url = new URL(c.req.url);
	url.searchParams.sort();
	const identity = createHash("sha256")
		.update(url.pathname + url.search)
		.digest("hex")
		.slice(0, 20);
	const etag = `W/"wb1-${identity}-${version}"`;
	c.header("ETag", etag);
	c.header("Cache-Control", "private, no-cache");
	c.header("Vary", "Cookie, Authorization");
	if (
		c.req
			.header("if-none-match")
			?.split(",")
			.map((s) => s.trim())
			.includes(etag)
	)
		return c.body(null, 304);
	try {
		return c.json(build());
	} catch (error) {
		c.header("ETag", undefined);
		c.header("Cache-Control", "no-store");
		throw error;
	}
}
export function conditionalProjects(c: Context, db: Db, build: () => unknown): Response {
	return db.transaction(() =>
		conditionalResponse(
			c,
			(
				db.prepare("SELECT revision FROM collection_read_versions WHERE name='projects'").get() as {
					revision: number;
				}
			).revision,
			build,
		),
	)();
}

/** Configuration tables are installed after the graph schema by ConfigurationStore. */
export function installActivityReadVersions(db: Db) {
	if (
		!db
			.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='project_read_versions'")
			.get()
	)
		return;
	db.exec(
		`CREATE INDEX IF NOT EXISTS idx_activity_summary ON activity_configurations(json_extract(body,'$.project_id'),json_extract(body,'$.role'),json_extract(body,'$.created_at') DESC,id DESC) WHERE json_valid(body);`,
	);
	for (const event of ["INSERT", "UPDATE", "DELETE"]) {
		const ref = event === "DELETE" ? "OLD" : "NEW";
		const fields = ["project_id", "role", "profile.model_id", "provider.name", "created_at"];
		const changed =
			event === "UPDATE"
				? `AND (OLD.id IS NOT NEW.id OR ${fields.map((f) => `json_extract(CASE WHEN json_valid(OLD.body) THEN OLD.body ELSE '{}' END,'$.${f}') IS NOT json_extract(NEW.body,'$.${f}')`).join(" OR ")})`
				: "";
		db.exec(`CREATE TRIGGER IF NOT EXISTS workbench_activity_summary_${event.toLowerCase()} AFTER ${event} ON activity_configurations WHEN json_valid(${ref}.body) ${changed} BEGIN
		 UPDATE project_read_versions SET overview=overview+1 WHERE project_id=json_extract(${ref}.body,'$.project_id');
		 ${event === "UPDATE" ? "UPDATE project_read_versions SET overview=overview+1 WHERE project_id=json_extract(CASE WHEN json_valid(OLD.body) THEN OLD.body ELSE '{}' END,'$.project_id') AND project_id IS NOT json_extract(NEW.body,'$.project_id');" : ""}
		END;`);
	}
}
