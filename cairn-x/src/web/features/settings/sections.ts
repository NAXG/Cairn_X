export type SettingsSection = "general" | "models" | "skills" | "agents" | "plugins" | "runtime";

export const sections: [SettingsSection, string][] = [
	["general", "常规"],
	["models", "模型"],
	["skills", "技能"],
	["agents", "子代理"],
	["plugins", "插件"],
	["runtime", "运行"],
];
