import { Component, type ReactNode } from "react";
export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
	state = { failed: false };
	static getDerivedStateFromError() {
		return { failed: true };
	}
	render() {
		return this.state.failed ? (
			<main className="history-page" role="alert">
				<h1>页面暂时无法显示</h1>
				<p>请重新加载页面后重试。</p>
				<button onClick={() => location.reload()}>重新加载页面</button>
			</main>
		) : (
			this.props.children
		);
	}
}
