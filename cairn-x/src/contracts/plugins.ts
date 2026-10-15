import type { AgentRole } from "./configuration.js";

interface PluginResourceSummary {
	extensions: string[];
	skills: string[];
}

export interface PluginSnapshot {
	role: AgentRole;
	installation_id?: string;
	revision: number;
	sources: string[];
	resources: PluginResourceSummary;
}

export type PluginOperationKind = "install" | "update" | "remove" | "enable" | "disable";
type PluginOperationStatus = "queued" | "running" | "succeeded" | "failed";

export interface PluginRelease {
	role: AgentRole;
	/** Fresh identity for each installation; numeric revisions may restart after uninstall. */
	installation_id?: string;
	revision: number;
	source: string;
	enabled: boolean;
	created_at: string;
	resources: PluginResourceSummary;
	packages: string[];
	path: string;
	install_platform?: string;
	install_node?: string;
	worker_image?: string;
	/** Final removal is waiting for activities that use this installation to finish. */
	retiring?: boolean;
}

export interface PluginOperation {
	id: string;
	role: AgentRole;
	kind: PluginOperationKind;
	/** 上一次被推迟的时刻；claim 时据此让出队头。 */
	deferred_at?: string;
	source?: string;
	status: PluginOperationStatus;
	created_at: string;
	updated_at: string;
	worker?: string;
	message?: string;
	progress?: number;
	release?: PluginRelease;
}
