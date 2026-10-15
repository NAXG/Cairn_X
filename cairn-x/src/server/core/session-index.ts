import type { Db } from "../db.js";

export function installSessionIndex(db: Db) {
	db.exec(`CREATE TABLE IF NOT EXISTS workbench_sessions (
	 project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,file TEXT NOT NULL,
	 activity TEXT NOT NULL,bytes INTEGER NOT NULL,modified_at TEXT NOT NULL,sort_at TEXT NOT NULL,
	 identity TEXT NOT NULL,entries INTEGER NOT NULL,retry INTEGER NOT NULL,step_id TEXT,attempt INTEGER,
	 PRIMARY KEY(project_id,file));
	 CREATE INDEX IF NOT EXISTS idx_workbench_sessions_attempt ON workbench_sessions(project_id,step_id,attempt,modified_at DESC);
	 CREATE INDEX IF NOT EXISTS idx_workbench_sessions_order ON workbench_sessions(project_id,sort_at DESC,file DESC);
	 CREATE INDEX IF NOT EXISTS idx_executions_created ON executions(project_id,created_at DESC,id DESC);`);
	for (const event of ["INSERT", "UPDATE", "DELETE"]) {
		const ref = event === "DELETE" ? "OLD" : "NEW";
		db.exec(
			`CREATE TRIGGER IF NOT EXISTS workbench_sessions_${event.toLowerCase()} AFTER ${event} ON workbench_sessions BEGIN UPDATE project_read_versions SET activities=activities+1 WHERE project_id=${ref}.project_id; END;`,
		);
	}
}
