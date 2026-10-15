import type { ExperimentMetadata } from "../../contracts/stats.js";
import type { Db, ProjectRow } from "../db.js";

/**
 * 实验元数据由项目行 + 最近一次活动配置快照组成。
 *
 * - experiment_id / harness_variant 在项目创建时写入，用于把同一回归批次
 *   的多道题归到同一个 candidate。
 * - profile_revision / prompt_hash / tools_hash / model_id 从 activity_configurations
 *   快照读取，用于回答“这一轮到底跑的是哪套 Harness”。
 */
export function projectExperimentMetadata(db: Db, project: ProjectRow): ExperimentMetadata {
	const snapshotRow = db
		.prepare(
			"SELECT body FROM activity_configurations WHERE json_extract(body, '$.project_id') = ? ORDER BY json_extract(body, '$.created_at') DESC, id DESC LIMIT 1",
		)
		.get(project.id) as { body: string } | undefined;
	let snapshot:
		| {
				profile_revision?: number;
				prompt_hash?: string;
				tools_hash?: string;
				model_id?: string;
				profile?: { revision?: number; model_id?: string };
		  }
		| undefined;
	if (snapshotRow !== undefined) {
		try {
			snapshot = JSON.parse(snapshotRow.body);
		} catch {
			snapshot = undefined;
		}
	}
	return {
		experiment_id: project.experiment_id,
		harness_variant: project.harness_variant,
		profile_revision: snapshot?.profile_revision ?? snapshot?.profile?.revision ?? null,
		prompt_hash: snapshot?.prompt_hash ?? null,
		tools_hash: snapshot?.tools_hash ?? null,
		model_id: snapshot?.model_id ?? snapshot?.profile?.model_id ?? null,
	};
}
