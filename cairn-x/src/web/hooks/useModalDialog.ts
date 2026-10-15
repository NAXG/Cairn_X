import { useLayoutEffect, useRef, type RefObject } from "react";

/** 原生模态负责焦点与背景 inert；取消动作仍由业务决定（忙碌、未保存确认等）。 */
export function useModalDialog(
	host: RefObject<HTMLDialogElement | null>,
	onCancel: () => void,
	open = true,
) {
	const cancel = useRef(onCancel);
	cancel.current = onCancel;
	useLayoutEffect(() => {
		const dialog = host.current;
		if (!dialog || !open) return;
		const handleCancel = (event: Event) => {
			event.preventDefault();
			cancel.current();
		};
		dialog.addEventListener("cancel", handleCancel);
		dialog.showModal();
		return () => {
			dialog.removeEventListener("cancel", handleCancel);
			// 子弹窗必须先关闭，避免它卸载时把父弹窗已恢复的焦点覆盖掉。
			for (const child of [...dialog.querySelectorAll<HTMLDialogElement>("dialog[open]")].reverse())
				child.close();
			dialog.close();
		};
	}, [host, open]);
}
