/** Database inspection for test assertions. Never exposed by a production API/client. */
import type { Hono } from "hono";
import type { FgsClient } from "../../src/orchestrator/client.js";
import type {
	Db,
	FactRow,
	GoalRow,
	FindingRow,
	StepRow,
	HintRow,
	RouteRow,
} from "../../src/server/db.js";
import { getProjectOr404 } from "../../src/server/core/project-guards.js";
import {
	projectMetaFromRow,
	factToModel,
	goalToModel,
	stepToModel,
	findingToModel,
	routeToModel,
	usageAggregates,
	planningInfo,
} from "../../src/server/core/model-mappers.js";

const databases = new WeakMap<object, Db>();
export function registerTestDatabase<T extends object>(subject: T, db: Db): T {
	databases.set(subject, db);
	return subject;
}
function database(subject: object): Db {
	const db = "prepare" in subject ? (subject as Db) : databases.get(subject);
	if (!db) throw new Error("Register the test database before inspecting project state");
	return db;
}
function inspectSteps(subject: object, pid: string) {
	const db = database(subject);
	return (
		db
			.prepare("SELECT * FROM steps WHERE project_id=? ORDER BY created_at,LENGTH(id),id")
			.all(pid) as StepRow[]
	).map((row) => stepToModel(db, row, pid));
}
export function inspectProject(subject: object, pid: string) {
	const db = database(subject);
	return db.transaction(() => {
		const project = projectMetaFromRow(getProjectOr404(db, pid));
		const rows = <T>(table: string, order = "rowid") =>
			db.prepare(`SELECT * FROM ${table} WHERE project_id=? ORDER BY ${order}`).all(pid) as T[];
		const steps = inspectSteps(db, pid);
		const pinned = new Set(
			(
				db.prepare("SELECT hint_id FROM persistent_hints WHERE project_id=?").all(pid) as Array<{
					hint_id: string;
				}>
			).map((row) => row.hint_id),
		);
		return {
			project,
			facts: rows<FactRow>("facts").map((row) => factToModel(db, row)),
			goals: rows<GoalRow>("goals").map((row) => goalToModel(db, row)),
			steps,
			findings: rows<FindingRow>("findings").map((row) => findingToModel(db, row)),
			hints: rows<HintRow>("hints", "created_at").map((row) => ({
				id: row.id,
				content: row.content,
				creator: row.creator,
				created_at: row.created_at,
				...(pinned.has(row.id) ? { persistent: true } : {}),
			})),
			routes: rows<RouteRow>("routes", "created_at,id").map((row) => {
				const related = steps.filter((step) => step.route_id === row.id);
				return routeToModel(row, {
					step_count: related.length,
					open_step_count: related.filter((step) => ["open", "claimed"].includes(step.status))
						.length,
					concluded_step_count: related.filter((step) => step.status === "concluded").length,
				});
			}),
			usage: usageAggregates(db, pid),
			planning: planningInfo(db, pid),
		};
	})();
}
export async function inspectClientProject(client: FgsClient, pid: string) {
	await client.getProjectOverview(pid);
	return inspectProject(client, pid);
}
interface InspectionResponse extends Response {
	json(): Promise<ReturnType<typeof inspectProject>>;
}
export async function inspectProjectResponse(app: Hono, pid: string): Promise<InspectionResponse> {
	const response = await app.request(`/projects/${encodeURIComponent(pid)}/overview`);
	if (!response.ok) return response as InspectionResponse;
	return Response.json(inspectProject(app, pid)) as InspectionResponse;
}
