import { useState } from "react";
import { usePoll } from "../../api";
import { PollError } from "../PollError";
import { roleName } from "../../labels";
import type { ActivitySnapshot } from "../../../contracts/configuration";
export function ActivityConfiguration({
	projectId,
	activityId,
}: {
	projectId: string;
	activityId: string;
}) {
	const [open, setOpen] = useState(false);
	const poll = usePoll<ActivitySnapshot>(
		open
			? `/projects/${projectId}/activities/${encodeURIComponent(activityId)}/configuration`
			: null,
		5000,
	);
	const value = poll.data;
	return (
		<details onToggle={(e) => setOpen(e.currentTarget.open)}>
			<summary>查看本次配置</summary>
			{open && (
				<>
					<button onClick={poll.refresh}>刷新本次配置</button>
					{poll.error && <PollError error={poll.error} onRetry={poll.refresh} label="重试配置" />}
					{value ? (
						<div>
							<p>
								{roleName(value.role)} · {value.provider.name} / {value.profile.model_id}
							</p>
							<p>工具：{value.tools?.join("、") ?? "尚未记录加载结果"}</p>
							{value.plugins && <p>PI 插件：{value.plugins.sources.join("、") || "无来源"}</p>}
							{value.diagnostics?.map((d, i) => (
								<p key={i}>{d}</p>
							))}
							<h4>实际系统提示词</h4>
							<pre>{value.final_prompt ?? "活动尚未上报实际提示词，页面会自动刷新"}</pre>
						</div>
					) : poll.loading ? (
						<p>读取中…</p>
					) : null}
				</>
			)}
		</details>
	);
}
