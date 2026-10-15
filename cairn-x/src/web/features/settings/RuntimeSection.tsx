import type { Dispatch, SetStateAction } from "react";

import type { AgentProfile, AgentRole, RuntimeSettings } from "../../../contracts/configuration";
import type { Settings } from "../../../contracts/models";
import { NumberField } from "./Fields";

export function RuntimeSection({
	runtime,
	leases,
	setRuntime,
	setLeases,
	decideProfile,
	executeProfile,
	changeRoleProfile,
}: {
	runtime: RuntimeSettings;
	leases: Settings;
	setRuntime: Dispatch<SetStateAction<RuntimeSettings | null>>;
	setLeases: Dispatch<SetStateAction<Settings | null>>;
	decideProfile: AgentProfile | undefined;
	executeProfile: AgentProfile | undefined;
	changeRoleProfile: (role: AgentRole, p: Partial<AgentProfile>) => void;
}) {
	return (
		<div className="cfg-stack">
			<h2>运行设置</h2>
			<h3>调度与并发</h3>
			<div className="cfg-grid">
				{(
					[
						["max_workers", "总并发"],
						["max_running_projects", "活跃项目上限"],
						["max_project_workers", "单项目并发"],
						["decide_min_interval", "规划间隔（秒）"],
					] as const
				).map(([k, label]) => (
					<NumberField
						key={k}
						label={label}
						min={k === "decide_min_interval" ? 0 : 1}
						integer={k !== "decide_min_interval"}
						value={runtime[k]}
						onChange={(v) => setRuntime({ ...runtime, [k]: v })}
					/>
				))}
			</div>
			<small>
				项目容器的 CPU / 内存 / 进程配额由部署配置 dispatch.yaml 的 container
				段决定，不在此处调整。调度设置保存后由调度器同步。
			</small>
			{decideProfile && executeProfile && (
				<>
					<h3>Agent 运行时限</h3>
					<div className="cfg-grid">
						<NumberField
							label="Decide 运行时限（秒）"
							value={decideProfile.run_seconds}
							onChange={(v) => changeRoleProfile("decide", { run_seconds: v })}
						/>
						<NumberField
							label="Execute 探索时限（秒）"
							value={executeProfile.run_seconds}
							onChange={(v) => changeRoleProfile("execute", { run_seconds: v })}
						/>
						<NumberField
							label="Execute 收尾时限（秒）"
							value={executeProfile.harvest_seconds}
							onChange={(v) => changeRoleProfile("execute", { harvest_seconds: v })}
						/>
					</div>
					<small>
						这些时限保存在 Agent 配置中；保存后由下一次 Decide 或 Execute
						活动使用。运行中的活动沿用启动时的时限。
					</small>
				</>
			)}
			<details>
				<summary>高级：活动租约</summary>
				<small>
					心跳续租的失联判定窗口：超过对应秒数未收到心跳，租约过期并回收；不是 Agent 的运行时限。
				</small>
				<div className="cfg-grid">
					<NumberField
						label="步骤租约（秒）"
						value={leases.lease_timeout}
						onChange={(v) => setLeases({ ...leases, lease_timeout: v })}
					/>
					<NumberField
						label="规划租约（秒）"
						value={leases.decide_timeout}
						onChange={(v) => setLeases({ ...leases, decide_timeout: v })}
					/>
				</div>
			</details>
		</div>
	);
}
