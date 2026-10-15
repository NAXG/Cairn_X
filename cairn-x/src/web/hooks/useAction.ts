import { useCallback, useRef, useState } from "react";

interface ActionHandlers {
	clear?: () => void;
	/** 操作成功后的回调，用于展示成功提示或刷新数据。 */
	success?: () => void;
	/** 操作失败后的回调；未提供时错误只写入 error 状态。 */
	failure?: (message: string) => void;
}

export function useAction() {
	const [busy, setBusy] = useState(false);
	const inFlight = useRef(false);
	const [error, setError] = useState("");
	const run = useCallback(async (fn: () => Promise<unknown>, handlers?: ActionHandlers) => {
		if (inFlight.current) return;
		inFlight.current = true;
		setBusy(true);
		setError("");
		try {
			handlers?.clear?.();
			await fn();
			handlers?.success?.();
		} catch (e) {
			const message = e instanceof Error ? e.message : String(e);
			setError(message);
			handlers?.failure?.(message);
		} finally {
			inFlight.current = false;
			setBusy(false);
		}
	}, []);
	return { busy, error, setError, run };
}
