import type { WorkbenchRecord } from "../../../contracts/workbench.js";

/** 工作台里「提交并提示 + 成功后刷新」的统一操作签名（见 App 的 action）。 */
export type WorkspaceAction = (fn: () => Promise<unknown>, message: string) => Promise<void>;

/** 从 WorkbenchRecord 联合类型里取出指定分区的记录类型。 */
export type SelectedRecord<K extends WorkbenchRecord["type"]> = Extract<
	WorkbenchRecord,
	{ type: K }
>["record"];
