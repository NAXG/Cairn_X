import type { Dispatch, SetStateAction } from "react";

import type { AgentProfile, AgentRole } from "../../../contracts/configuration";
import { supportedThinkingLevels, type ThinkingLevel } from "../../../contracts/thinking";
import { roleName } from "../../labels";
import { Field, NumberField, Toggle } from "./Fields";
import type { ProviderDraft } from "./ProviderEditor";

/** 「模型」下拉中代表“手动输入目录外模型”的哨兵值。 */
const CUSTOM_MODEL = "__custom__";

export function AgentSection({
	role,
	profile,
	savedProviders,
	customModel,
	setCustomModel,
	changeProfile,
	onRestoreDefaultPrompt,
}: {
	role: AgentRole;
	profile: AgentProfile;
	savedProviders: ProviderDraft[];
	customModel: Record<AgentRole, boolean>;
	setCustomModel: Dispatch<SetStateAction<Record<AgentRole, boolean>>>;
	changeProfile: (p: Partial<AgentProfile>) => void;
	onRestoreDefaultPrompt: () => void;
}) {
	// 当前选中的模型是否来自供应商目录；手动输入的未知模型为 undefined
	const catalogModel = savedProviders
		.find((p) => p.id === profile.provider_id)
		?.models.find((m) => m.id === profile.model_id);
	const thinkingLevels = supportedThinkingLevels(catalogModel ?? { reasoning: true });
	const thinkingAvailable = thinkingLevels.includes(profile.thinking as ThinkingLevel);
	// 当前供应商目录里的可选模型；手动输入的目录外模型不在其中。
	const catalogModels = savedProviders.find((p) => p.id === profile.provider_id)?.models ?? [];
	const customModelSelected =
		customModel[role] ||
		(profile.model_id !== "" && !catalogModels.some((m) => m.id === profile.model_id));
	return (
		<div className="cfg-stack">
			<div className="cfg-detail-heading">
				<div className="cfg-detail-title">
					<h2>{roleName(role)}</h2>
					<div className="cfg-chips">
						<span className="cfg-chip">内置</span>
						{role === "execute" && profile.bash_mode === "persistent" && (
							<span className="cfg-chip">持久 bash</span>
						)}
					</div>
				</div>
			</div>
			<div className="cfg-grid">
				<Field label="子代理 ID">
					<input readOnly value={role} />
				</Field>
				<Field label="显示名称">
					<input readOnly value={roleName(role)} />
				</Field>
			</div>
			<Field label="描述">
				<input
					readOnly
					value={
						role === "decide"
							? "规划目标和步骤，更新项目图谱"
							: "在独立 Worker 中执行步骤，提交事实和发现"
					}
				/>
			</Field>
			<div className="cfg-grid">
				<Field label="供应商 / 账号">
					<select
						aria-label="供应商 / 账号"
						value={profile.provider_id}
						onChange={(e) => {
							const p = savedProviders.find((p) => p.id === e.target.value);
							const m = p?.models[0];
							const levels = supportedThinkingLevels(m ?? { reasoning: true });
							setCustomModel((all) => ({ ...all, [role]: false }));
							changeProfile({
								provider_id: e.target.value,
								model_id: m?.id ?? "",
								thinking: levels.includes(profile.thinking as ThinkingLevel)
									? profile.thinking
									: (levels[0] ?? "off"),
								...(m ? { context_window: m.contextWindow, max_output_tokens: m.maxTokens } : {}),
							});
						}}
					>
						<option value="">请选择</option>
						{savedProviders.map((p) => (
							<option key={p.id} value={p.id}>
								{p.name}
							</option>
						))}
					</select>
				</Field>
				<Field label="模型">
					<select
						aria-label="模型"
						value={customModelSelected ? CUSTOM_MODEL : profile.model_id}
						onChange={(e) => {
							const id = e.target.value;
							if (id === CUSTOM_MODEL) {
								setCustomModel((all) => ({ ...all, [role]: true }));
								return;
							}
							setCustomModel((all) => ({ ...all, [role]: false }));
							// 命中目录模型时同步其参数；未知模型保留当前数值设置
							const m = catalogModels.find((x) => x.id === id);
							changeProfile({
								model_id: id,
								...(m
									? {
											context_window: m.contextWindow,
											max_output_tokens: m.maxTokens,
											thinking: supportedThinkingLevels(m).includes(
												profile.thinking as ThinkingLevel,
											)
												? profile.thinking
												: (supportedThinkingLevels(m)[0] ?? "off"),
										}
									: {}),
							});
						}}
					>
						<option value="">请选择</option>
						{catalogModels.map((m) => (
							<option value={m.id} key={m.id}>
								{m.name}
							</option>
						))}
						<option value={CUSTOM_MODEL}>自定义模型 ID…</option>
					</select>
					{customModelSelected && (
						<input
							aria-label="自定义模型 ID"
							placeholder="输入模型 ID"
							value={profile.model_id}
							onChange={(e) => changeProfile({ model_id: e.target.value })}
						/>
					)}
				</Field>
				<Field label="思考等级">
					<select
						aria-label="思考等级"
						value={profile.thinking}
						disabled={!profile.model_id || (thinkingLevels.length === 1 && thinkingAvailable)}
						onChange={(e) => changeProfile({ thinking: e.target.value })}
					>
						{!thinkingAvailable && (
							<option value={profile.thinking} disabled>
								{profile.thinking}（当前模型不可用）
							</option>
						)}
						{thinkingLevels.map((level) => (
							<option key={level} value={level}>
								{level}
							</option>
						))}
					</select>
					<small>
						{catalogModel?.reasoning === false
							? "模型未启用支持思考；可在「模型」页开启并配置等级。"
							: "此 Agent 下一次活动使用该等级；可用等级由模型设置决定。"}
					</small>
					{!thinkingAvailable && (
						<small className="cfg-error">模型能力已变更，请重新选择可用等级后保存。</small>
					)}
				</Field>
			</div>
			<Field label="系统提示词">
				<textarea
					className="cfg-prompt"
					value={profile.prompt}
					onChange={(e) => changeProfile({ prompt: e.target.value })}
				/>
			</Field>
			<small>
				系统提示词保持跨活动稳定；项目、步骤与执行状态会在运行时单独提供，无需写入变量。
			</small>
			<div className="cfg-inline">
				<button type="button" onClick={onRestoreDefaultPrompt}>
					恢复内置模板
				</button>
			</div>
			<div className="cfg-section">
				<h3>工具</h3>
				<small>图谱与结果提交工具由系统提供。</small>
				{role === "execute" && (
					<div className="cfg-inline">
						<button
							type="button"
							onClick={() =>
								changeProfile({
									tools: ["read", "bash", "edit", "write"],
									bash_mode: "one-shot",
								})
							}
						>
							完整（4 工具）
						</button>
						<button
							type="button"
							onClick={() => changeProfile({ tools: ["bash"], bash_mode: "persistent" })}
						>
							极简（仅持久 bash）
						</button>
					</div>
				)}
				{role === "execute" && (
					<div className="cfg-inline">
						{["read", "bash", "edit", "write"].map((t) => (
							<Toggle
								key={t}
								label={t}
								checked={profile.tools.includes(t)}
								onChange={(on) =>
									changeProfile({
										tools: on ? [...profile.tools, t] : profile.tools.filter((x) => x !== t),
									})
								}
							/>
						))}
					</div>
				)}
				<details>
					<summary>高级：窗口与时限</summary>
					<div className="cfg-grid">
						<NumberField
							label="上下文窗口"
							value={profile.context_window}
							onChange={(v) => changeProfile({ context_window: v })}
						/>
						<NumberField
							label="最大输出 Token"
							value={profile.max_output_tokens}
							onChange={(v) => changeProfile({ max_output_tokens: v })}
						/>
						<NumberField
							label="运行时限（秒）"
							value={profile.run_seconds}
							onChange={(v) => changeProfile({ run_seconds: v })}
						/>
						{role === "execute" && (
							<NumberField
								label="收尾时限（秒）"
								value={profile.harvest_seconds}
								onChange={(v) => changeProfile({ harvest_seconds: v })}
							/>
						)}
					</div>
					<small>运行时限为单次活动的预算，保存后下一次活动生效。</small>
				</details>
			</div>
		</div>
	);
}
