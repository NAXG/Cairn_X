import { usePoll } from "../api";
import { PollError } from "./PollError";

export function Files({ pid }: { pid: string }) {
	const uploads = usePoll<{ name: string; size: number; modified_at: string }[]>(
		`/projects/${pid}/uploads`,
	);
	return (
		<div className="section">
			<div className="section-head">
				<h3>已上传文件</h3>
				{!!uploads.data?.length && <span className="section-note">{uploads.data.length} 个</span>}
			</div>
			{uploads.error ? (
				<PollError error={uploads.error} onRetry={uploads.refresh} label="重试上传列表" />
			) : uploads.loading ? (
				<p className="meta-line">加载上传文件…</p>
			) : uploads.data?.length ? (
				uploads.data.map((f, i) => (
					<div className="file-row" key={i}>
						<span>↗ {f.name}</span>
						<small>{f.size} bytes</small>
					</div>
				))
			) : (
				<p className="meta-line">暂无上传文件</p>
			)}
		</div>
	);
}
