import { expect, test, vi } from "vitest";
import { useLayoutEffect } from "react";

// The browser hook is typechecked by tsconfig.web; keep DOM libs out of the Node test program.
const modulePath = "../../src/web/hooks/useModalDialog.js";
const { useModalDialog } = await import(modulePath);

vi.mock("react", () => ({
	useRef: vi.fn(() => ({ current: undefined })),
	useLayoutEffect: vi.fn(),
}));

// Test our lifecycle/cancel glue; focus trapping and restoration belong to the browser.
test("native modal cancellation respects the business callback and cleans up", () => {
	const closed: string[] = [];
	const child = { close: vi.fn(() => closed.push("child")) };
	const dialog = Object.assign(new EventTarget(), {
		showModal: vi.fn(),
		close: vi.fn(() => closed.push("parent")),
		querySelectorAll: vi.fn(() => [child]),
	});
	const host = { current: dialog };
	const onCancel = vi.fn();
	useModalDialog(host, onCancel);
	const effect = vi.mocked(useLayoutEffect).mock.calls.at(-1)![0];
	const cleanup = effect();
	expect(dialog.showModal).toHaveBeenCalledOnce();
	const event = new Event("cancel", { cancelable: true });
	dialog.dispatchEvent(event);
	expect(event.defaultPrevented).toBe(true);
	expect(onCancel).toHaveBeenCalledOnce();
	if (typeof cleanup !== "function") throw new Error("missing modal cleanup");
	cleanup();
	expect(dialog.close).toHaveBeenCalledOnce();
	expect(closed).toEqual(["child", "parent"]);
	dialog.dispatchEvent(new Event("cancel"));
	expect(onCancel).toHaveBeenCalledOnce();

	useModalDialog(host, onCancel, false);
	expect(vi.mocked(useLayoutEffect).mock.calls.at(-1)![0]()).toBeUndefined();
	expect(dialog.showModal).toHaveBeenCalledOnce();
});
