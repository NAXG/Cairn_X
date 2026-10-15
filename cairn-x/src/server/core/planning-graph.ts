import type {
	PlanningGraphRequest,
	PlanningGraphResponse,
} from "../../contracts/planning-graph.js";
import type { Db } from "../db.js";
import { readPlanningGraph } from "./planning-graph/page.js";
import { readGraphRecord } from "./planning-graph/record.js";
import { readGraphSection } from "./planning-graph/sections.js";

export function readDecideGraph(
	db: Db,
	projectId: string,
	request: PlanningGraphRequest,
): PlanningGraphResponse {
	if (request.view === "planning")
		return readPlanningGraph(db, projectId, request.worker, request.cursor);
	if (request.view === "section")
		return readGraphSection(db, projectId, request.section, request.cursor, {
			query: request.query,
			status: request.status,
			goal_id: request.goal_id,
			route_id: request.route_id,
		});
	return readGraphRecord(db, projectId, request);
}
