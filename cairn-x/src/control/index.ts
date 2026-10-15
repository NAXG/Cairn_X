import path from "node:path";
import type { Db } from "../server/db.js";
import type { DeploymentConfig, DispatchConfig } from "../scheduler/config.js";
import { ConfigurationStore } from "./store.js";
import { ModelService } from "./models.js";
import { pruneOrphanActivityResources } from "./resources.js";
import { PluginStore } from "../plugins/store.js";
import { consoleLogger } from "../shared/logger.js";
/** 首次导入必须在初始化前执行；不能悄悄覆盖控制台保存的配置。 */
export function isConfigurationInitialized(db: Db): boolean {
	if (
		!db
			.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='configuration_objects'")
			.get()
	)
		return false;
	return !!db
		.prepare("SELECT 1 FROM configuration_objects WHERE kind='meta' AND id='initialized'")
		.get();
}

export function createConfigurationControl(
	db: Db,
	root: string,
	config?: DispatchConfig | DeploymentConfig,
) {
	const plugins = new PluginStore(db);
	const store = new ConfigurationStore(db, config?.compaction, plugins);
	const fresh = !store.get("meta", "initialized");
	store.initialize(config);
	// 活动资源目录（agentDir）没有数据库引用，快照裁剪与项目删除都可能把它留在
	// 数据目录里。启动时按快照行扫一遍，把残留（含旧版本留下的）一次性收干净。
	const liveSnapshots = (
		db.prepare("SELECT id FROM activity_configurations").all() as Array<{ id: string }>
	).map((row) => row.id);
	const removedResources = pruneOrphanActivityResources(root, liveSnapshots);
	if (removedResources > 0) {
		consoleLogger.warn(`[cairn] removed ${removedResources} orphan activity resource dir(s)`);
	}
	// prompt 只在首次初始化时从仓库文件播种，之后以 DB 为准。文件改了而库没改
	// 是一个静默失效（行为不变、无报错），所以每次启动都显式检查一遍。
	for (const role of ["decide", "execute"] as const) {
		const drift = store.promptDrift(role);
		if (drift.drifted) {
			consoleLogger.warn(
				`[cairn] agent prompt drift: role=${role} 库内 prompt(${drift.storedBytes}B) 与仓库 ` +
					`${role}.md(${drift.fileBytes}B) 不一致 —— 改文件不会自动生效。` +
					`要让文件改动生效：控制台「活动配置」里恢复默认，或重新初始化数据库。`,
			);
		}
	}
	const models = new ModelService(store, path.join(root, "configuration", "credentials"));
	if (fresh && config && "models" in config) {
		for (const role of ["decide", "execute"] as const)
			models.setKey(models.connection(`imported-${role}`), config.models[role].api_key);
	}
	return { store, models, plugins };
}
export type ConfigurationControl = ReturnType<typeof createConfigurationControl>;
