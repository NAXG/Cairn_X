import { ResetIcon } from "../../icons";
import { themeLabels } from "../../labels";
import {
	useDisplayPreferences,
	TRACE_FONT_DEFAULT,
	TRACE_FONT_RANGE,
	TRACE_WIDTH_DEFAULT,
	TRACE_WIDTH_RANGE,
} from "../../hooks/useDisplayPreferences";
import { useTheme } from "../../hooks/useTheme";
import { Toggle } from "./Fields";
import { ThemeSwatch } from "./ThemeSwatch";

export function GeneralSection() {
	const theme = useTheme();
	const display = useDisplayPreferences();
	return (
		<div className="cfg-general">
			<section className="cfg-general-section">
				<h3>外观</h3>
				<div className="cfg-theme-grid" role="radiogroup" aria-label="外观">
					{(["light", "dark", "mist", "rose", "pine", "auto"] as const).map((t) => (
						<button
							key={t}
							type="button"
							role="radio"
							aria-checked={theme.preference === t}
							data-theme-option={t}
							onClick={() => theme.setThemePreference(t)}
						>
							<ThemeSwatch option={t} />
							<span>{themeLabels[t]}</span>
						</button>
					))}
				</div>
			</section>
			<section className="cfg-general-section">
				<h3>对话</h3>
				<Toggle
					label="默认展开思考块"
					checked={display.prefs.thinkingOpen}
					onChange={display.setThinkingOpen}
				/>
				{/* 与 pi-web 一致：标签、px 数值、重置按钮同一行，滑块独占下一行并撑满内容列。 */}
				<div className="cfg-slider">
					<div className="cfg-slider-header">
						<label htmlFor="cfg-trace-width">轨迹内容宽度</label>
						<output htmlFor="cfg-trace-width">{display.prefs.traceWidth}px</output>
						<button
							type="button"
							className="cfg-slider-reset"
							title="重置轨迹内容宽度"
							aria-label="重置轨迹内容宽度"
							disabled={display.prefs.traceWidth === TRACE_WIDTH_DEFAULT}
							onClick={display.resetTraceWidth}
						>
							<ResetIcon />
						</button>
					</div>
					<input
						id="cfg-trace-width"
						type="range"
						aria-label="轨迹内容宽度"
						min={TRACE_WIDTH_RANGE.min}
						max={TRACE_WIDTH_RANGE.max}
						step={TRACE_WIDTH_RANGE.step}
						value={display.prefs.traceWidth}
						onChange={(e) => display.setTraceWidth(Number(e.target.value))}
					/>
				</div>
				<div className="cfg-slider">
					<div className="cfg-slider-header">
						<label htmlFor="cfg-trace-font">轨迹字号</label>
						<output htmlFor="cfg-trace-font">{display.prefs.traceFont}px</output>
						<button
							type="button"
							className="cfg-slider-reset"
							title="重置轨迹字号"
							aria-label="重置轨迹字号"
							disabled={display.prefs.traceFont === TRACE_FONT_DEFAULT}
							onClick={display.resetTraceFont}
						>
							<ResetIcon />
						</button>
					</div>
					<input
						id="cfg-trace-font"
						type="range"
						aria-label="轨迹字号"
						min={TRACE_FONT_RANGE.min}
						max={TRACE_FONT_RANGE.max}
						step={TRACE_FONT_RANGE.step}
						value={display.prefs.traceFont}
						onChange={(e) => display.setTraceFont(Number(e.target.value))}
					/>
				</div>
				<small>以上设置只影响当前浏览器。</small>
			</section>
		</div>
	);
}
