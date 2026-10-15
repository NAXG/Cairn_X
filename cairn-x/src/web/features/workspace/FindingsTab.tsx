import type { RecordPreview } from "../../../contracts/workbench.js";
import type { Nav } from "../../hooks/useWorkspaceNav";
import type { ReadPageState } from "../../hooks/useReadPage";
import { Files } from "../Files";
import { PageNavigation } from "../PageNavigation";
import { PollError } from "../PollError";
import { Markdown } from "../traces/Transcript";

export function FindingsTab({
	navProject,
	findings,
	navigate,
	setInspect,
}: {
	navProject: string;
	findings: ReadPageState<RecordPreview>;
	navigate: (patch: Partial<Nav>) => void;
	setInspect: (inspect: boolean) => void;
}) {
	return (
		<div className="page">
			<h2>发现</h2>
			{findings.items.length ? (
				findings.items.map((f) => (
					<article className="card" key={f.id}>
						<h3>{f.title}</h3>
						<Markdown text={f.description ?? ""} />
						<button
							onClick={() => {
								navigate({ node: f.id, step: "" });
								setInspect(true);
							}}
						>
							查看发现详情
						</button>
					</article>
				))
			) : (
				<p className="meta-line">{findings.loading ? "加载发现…" : "尚无发现"}</p>
			)}
			{findings.error && <PollError error={findings.error} onRetry={findings.refresh} />}
			<PageNavigation page={findings} />
			<Files key={navProject} pid={navProject} />
		</div>
	);
}
