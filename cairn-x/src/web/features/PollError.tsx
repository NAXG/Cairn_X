/** 轮询/加载失败的统一提示：错误文本 + 重试按钮。 */
export function PollError({
	error,
	onRetry,
	label = "重试",
	notice = false,
}: {
	error: string;
	onRetry: () => void;
	label?: string;
	/** 使用 .notice 容器样式（App 顶部项目级提示）。 */
	notice?: boolean;
}) {
	return (
		<p role="alert" className={notice ? "notice" : undefined}>
			{error}
			<button onClick={onRetry}>{label}</button>
		</p>
	);
}
