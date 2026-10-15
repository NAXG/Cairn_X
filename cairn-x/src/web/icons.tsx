/**
 * 线性图标集：形状取自 pi-web 的 SettingsSectionIcon（MIT，见 THIRD_PARTY_NOTICES.md），
 * 用 Cairn 的 currentColor 规则重绘，不引入图标库。
 */
type IconProps = {
	size?: number;
	strokeWidth?: number;
};

function base(size: number, strokeWidth: number) {
	return {
		width: size,
		height: size,
		viewBox: "0 0 24 24",
		fill: "none",
		stroke: "currentColor",
		strokeWidth,
		strokeLinecap: "round" as const,
		strokeLinejoin: "round" as const,
		"aria-hidden": true,
		focusable: false,
	};
}

/** 常规：滑杆。 */
export function SettingsIcon({ size = 14, strokeWidth = 1.8 }: IconProps) {
	return (
		<svg {...base(size, strokeWidth)}>
			<path d="M20 7h-9M14 17H5" />
			<circle cx="7" cy="7" r="3" />
			<circle cx="17" cy="17" r="3" />
		</svg>
	);
}

/** 模型：芯片。 */
export function ModelsIcon({ size = 14, strokeWidth = 1.8 }: IconProps) {
	return (
		<svg {...base(size, strokeWidth)}>
			<rect x="4" y="4" width="16" height="16" rx="2" />
			<rect x="9" y="9" width="6" height="6" />
			<path d="M9 1v3M15 1v3M9 20v3M15 20v3M20 9h3M20 15h3M1 9h3M1 15h3" />
		</svg>
	);
}

/** 技能：层叠。 */
export function SkillsIcon({ size = 14, strokeWidth = 1.8 }: IconProps) {
	return (
		<svg {...base(size, strokeWidth)}>
			<path d="m12 2-10 5 10 5 10-5-10-5Z" />
			<path d="m2 12 10 5 10-5M2 17l10 5 10-5" />
		</svg>
	);
}

/** 子代理：机器人。 */
export function AgentsIcon({ size = 14, strokeWidth = 1.8 }: IconProps) {
	return (
		<svg {...base(size, strokeWidth)}>
			<rect x="5" y="7" width="14" height="11" rx="2" />
			<path d="M9 11h.01M15 11h.01M9 15h6M12 7V4M10 4h4" />
		</svg>
	);
}

/** 插件：插头。 */
export function PluginsIcon({ size = 14, strokeWidth = 1.8 }: IconProps) {
	return (
		<svg {...base(size, strokeWidth)}>
			<path d="M9 7V2M15 7V2M6 13V8a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v5a6 6 0 0 1-12 0ZM12 19v3" />
		</svg>
	);
}

/** 运行：仪表盘，Cairn 自有分区。 */
export function RuntimeIcon({ size = 14, strokeWidth = 1.8 }: IconProps) {
	return (
		<svg {...base(size, strokeWidth)}>
			<path d="M4 18a8 8 0 1 1 16 0" />
			<path d="m12 14 4-4" />
			<circle cx="12" cy="14" r="1.6" />
		</svg>
	);
}

export function LogoutIcon({ size = 14, strokeWidth = 1.8 }: IconProps) {
	return (
		<svg {...base(size, strokeWidth)}>
			<path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3" />
			<path d="M10 17 5 12l5-5M5 12h11" />
		</svg>
	);
}

/** 重置：继续沿用 pi-web 的旋转箭头。 */
export function ResetIcon({ size = 14, strokeWidth = 1.8 }: IconProps) {
	return (
		<svg {...base(size, strokeWidth)}>
			<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8M3 3v5h5" />
		</svg>
	);
}
