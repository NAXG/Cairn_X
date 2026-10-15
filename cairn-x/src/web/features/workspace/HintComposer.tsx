export function HintComposer({
	value,
	onChange,
	onSave,
	busy,
}: {
	value: string;
	onChange: (value: string) => void;
	onSave: (content: string) => void;
	busy: boolean;
}) {
	return (
		<form
			className="composer"
			onSubmit={(e) => {
				e.preventDefault();
				if (!value.trim()) return;
				onSave(value.trim());
			}}
		>
			<textarea
				aria-label="补充提示"
				placeholder="为项目补充提示、线索或约束…"
				value={value}
				onChange={(e) => onChange(e.target.value)}
				rows={2}
			/>
			<button className="primary" disabled={busy || !value.trim()}>
				保存提示 ↑
			</button>
		</form>
	);
}
