import { useState } from "react";
import {
	THINKING_LEVELS,
	type ThinkingLevel,
	type ThinkingLevelMap,
} from "../../../contracts/thinking";

const colors: Record<ThinkingLevel, string> = {
	off: "var(--cfg-muted)",
	minimal: "#6b7280",
	low: "#60a5fa",
	medium: "#a78bfa",
	high: "#f472b6",
	xhigh: "#fb923c",
	max: "#ef4444",
};

/** pi-web-style per-level Default / Disabled / Custom controls. */
export function ThinkingLevelMapEditor({
	value,
	onChange,
}: {
	value?: ThinkingLevelMap;
	onChange: (value: ThinkingLevelMap | undefined) => void;
}) {
	const [drafts, setDrafts] = useState<Partial<Record<ThinkingLevel, string>>>({});
	const draft = (level: ThinkingLevel, text: string | undefined) => {
		setDrafts((previous) => {
			const next = { ...previous };
			if (text === undefined) delete next[level];
			else next[level] = text;
			return next;
		});
	};
	const set = (level: ThinkingLevel, entry: string | null | undefined) => {
		const next = { ...value };
		if (entry === undefined) delete next[level];
		else next[level] = entry;
		onChange(Object.keys(next).length ? next : undefined);
	};
	return (
		<section className="cfg-thinking-map" aria-label="思考等级映射">
			<div className="cfg-detail-heading">
				<h3>思考等级映射</h3>
				<button type="button" disabled={!value} onClick={() => onChange(undefined)}>
					清除全部
				</button>
			</div>
			<small>
				Default 使用默认映射；Disabled 禁用该等级；Custom 设置发送给供应商的值。xhigh / max
				需显式设置 Custom 才启用。
			</small>
			{THINKING_LEVELS.map((level) => {
				const raw = value?.[level];
				const mode = raw === undefined ? "default" : raw === null ? "disabled" : "custom";
				return (
					<div
						className="cfg-thinking-row"
						role="group"
						aria-label={`${level} 思考等级`}
						key={level}
						data-mode={mode}
					>
						<span className="cfg-thinking-label">
							<i style={{ background: colors[level] }} />
							<code>{level}</code>
						</span>
						<div className="cfg-thinking-segments">
							<button
								type="button"
								aria-pressed={mode === "default"}
								onClick={() => set(level, undefined)}
							>
								Default
							</button>
							<button
								type="button"
								className="cfg-thinking-disabled"
								aria-pressed={mode === "disabled"}
								onClick={() => set(level, null)}
							>
								Disabled
							</button>
						</div>
						<div className="cfg-thinking-custom" data-active={mode === "custom"}>
							<button
								type="button"
								aria-pressed={mode === "custom"}
								onClick={() => set(level, typeof raw === "string" ? raw : level)}
							>
								Custom
							</button>
							<input
								aria-label={`${level} 自定义值`}
								value={drafts[level] ?? (typeof raw === "string" ? raw : "")}
								placeholder={level}
								maxLength={100}
								onFocus={() => {
									if (mode !== "custom") draft(level, level);
								}}
								onChange={(event) => draft(level, event.target.value)}
								onBlur={() => {
									const next = drafts[level]?.trim();
									if (next && (mode === "custom" || next !== level)) set(level, next);
									draft(level, undefined);
								}}
							/>
						</div>
					</div>
				);
			})}
		</section>
	);
}
