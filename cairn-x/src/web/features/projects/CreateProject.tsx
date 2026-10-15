import { useModalDialog } from "../../hooks/useModalDialog";
import { useRef, useState, type FormEvent } from "react";
import { api, json } from "../../api";
import type { CreatedProject } from "../../../contracts/models.js";

const TITLE_LIMIT = 120;
const DESCRIPTION_LIMIT = 12000;

export function CreateProject({
	onClose,
	onCreated,
}: {
	onClose: () => void;
	onCreated: (id: string) => void;
}) {
	const [title, setTitle] = useState(""),
		[origin, setOrigin] = useState(""),
		[goal, setGoal] = useState("");
	const [files, setFiles] = useState<File[]>([]);
	const [pid, setPid] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const host = useRef<HTMLDialogElement>(null);
	const submitting = useRef(false);
	useModalDialog(host, () => {
		if (!busy) {
			if (pid) onCreated(pid);
			else onClose();
		}
	});
	const submit = async (e: FormEvent) => {
		e.preventDefault();
		if (submitting.current) return;
		submitting.current = true;
		setBusy(true);
		setError("");
		let id = pid;
		try {
			if (!id) {
				if (!title.trim() || !origin.trim() || !goal.trim())
					throw new Error("标题、来源和目标不能为空");
				const d = await api<CreatedProject>(
					"/projects",
					json("POST", {
						title: title.trim(),
						origin: origin.trim(),
						goal: goal.trim(),
					}),
				);
				id = d.project.id;
				setPid(id);
			}
			const failed: File[] = [];
			const errors: string[] = [];
			for (const f of files) {
				try {
					await api(`/projects/${id}/uploads?filename=${encodeURIComponent(f.name)}`, {
						method: "POST",
						headers: { "Content-Type": "application/octet-stream" },
						body: f,
					});
				} catch (e) {
					failed.push(f);
					errors.push(f.name + ": " + (e instanceof Error ? e.message : String(e)));
				}
			}
			setFiles(failed);
			if (failed.length) setError("项目已创建。以下文件上传失败，可重试：" + errors.join("；"));
			else onCreated(id);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			submitting.current = false;
			setBusy(false);
		}
	};
	return (
		<dialog className="modal-backdrop" ref={host} aria-label="新建项目">
			<form className="modal project-modal" onSubmit={submit}>
				<header>
					<h2>新建项目</h2>
					<button type="button" disabled={busy} onClick={() => (pid ? onCreated(pid) : onClose())}>
						×
					</button>
				</header>
				<label>
					<span>项目名称</span>
					<input
						required
						disabled={!!pid}
						maxLength={TITLE_LIMIT}
						placeholder="用一句话说明要推进的工作"
						value={title}
						onChange={(e) => setTitle(e.target.value)}
					/>
					<small className="input-counter">
						{title.length} / {TITLE_LIMIT}
					</small>
				</label>
				<label>
					<span>起点</span>
					<textarea
						required
						disabled={!!pid}
						maxLength={DESCRIPTION_LIMIT}
						placeholder="已有信息、约束、环境或待验证的线索"
						value={origin}
						onChange={(e) => setOrigin(e.target.value)}
						rows={3}
					/>
					<small className="input-counter">
						{origin.length.toLocaleString()} / {DESCRIPTION_LIMIT.toLocaleString()}
					</small>
				</label>
				<label>
					<span>目标</span>
					<textarea
						required
						disabled={!!pid}
						maxLength={DESCRIPTION_LIMIT}
						placeholder="明确完成条件：最终希望获得什么结果"
						value={goal}
						onChange={(e) => setGoal(e.target.value)}
						rows={3}
					/>
					<small className="input-counter">
						{goal.length.toLocaleString()} / {DESCRIPTION_LIMIT.toLocaleString()}
					</small>
				</label>
				<label>
					上传文件
					<input
						type="file"
						multiple
						disabled={busy}
						onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
					/>
				</label>
				{files.length > 0 && (
					<ul className="upload-list" aria-label="待上传文件">
						{files.map((f, i) => (
							<li key={i} title={f.name}>
								{f.name}
							</li>
						))}
					</ul>
				)}
				{error && <p role="alert">{error}</p>}
				<footer>
					{pid && (
						<button type="button" disabled={busy} onClick={() => onCreated(pid)}>
							进入已创建项目
						</button>
					)}
					<button className="primary" disabled={busy}>
						{busy ? "处理中…" : pid ? "重试失败文件" : "创建项目"}
					</button>
				</footer>
			</form>
		</dialog>
	);
}
