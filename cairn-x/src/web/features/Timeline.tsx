import type { TimelineItem } from "../../contracts/workbench.js";
import { useReadPage } from "../hooks/useReadPage";
import { PageNavigation } from "./PageNavigation";
import { PollError } from "./PollError";
export function Timeline({
	projectId,
	onStep,
	onRecord,
}: {
	projectId: string;
	onStep: (id: string) => void;
	onRecord: (type: string, id: string) => void;
}) {
	const page = useReadPage<TimelineItem>(`/projects/${projectId}/timeline`);
	return (
		<>
			{page.error && <PollError error={page.error} onRetry={page.refresh} />}
			<div className="timeline">
				{page.items.map((e) => (
					<div key={e.key}>
						<small>{new Date(e.t).toLocaleString()}</small>
						<h4>
							{e.step ? <button onClick={() => onStep(e.step)}>{e.title} ↗</button> : e.title}
						</h4>
						<p>{e.body}</p>
						{e.truncated && e.record_type !== "project" && (
							<button onClick={() => onRecord(e.record_type, e.record_id)}>查看完整内容</button>
						)}
					</div>
				))}
			</div>
			<PageNavigation page={page} />
		</>
	);
}
