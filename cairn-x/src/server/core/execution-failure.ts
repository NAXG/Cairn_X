/**
 * 失败归类的物化缓存。
 *
 * 归类本身（core/digest.ts）要读一遍该执行的事件流并归一化。规划页每隔几十秒
 * 就可能被读一次，为前沿里的每个失败尝试重算一遍是不可接受的；而执行一旦进入
 * 终态，它的归类就不再变化，天生适合算一次存下来。
 *
 * 因此这里做「读时物化」：第一次有人问起时算一次并写回 executions，之后只读列。
 * 首次读取发生在执行收尾之后（步骤交回规划器），此时事件流已经落盘；写回语句带
 * `failure_class IS NULL` 条件，并发读不会互相覆盖，重复调用是幂等的。
 */

import type { FailureClass, FailureComponent } from "../../contracts/digest.js";
import type { Db } from "../db.js";
import { classifyStoredExecution } from "./digest.js";

/**
 * 需要归类的终态。succeeded 恒为 none 且无需看轨迹，不在这里消耗事件流读取；
 * queued / running 尚未产生可归因的失败。
 */
const CLASSIFIED_STATUSES: readonly string[] = ["failed", "cancelled", "lost"];

interface ExecutionFailure {
	failure_class: FailureClass;
	component: FailureComponent;
}

interface ExecutionFailureRow {
	id: string;
	status: string;
	failure_class: string | null;
	failure_component: string | null;
}

/**
 * 该执行是否属于「失败尝试」——即需要向规划器解释原因的那一类终态。
 * 规划投影用它决定要不要把一个执行送进归类。
 */
export function isFailureStatus(status: string): boolean {
	return CLASSIFIED_STATUSES.includes(status);
}

/**
 * 取一次执行的失败归类，必要时现场计算并写回。非失败终态（以及未知 id）返回 null。
 *
 * 返回 null 与返回 { failure_class: "unknown" } 语义不同：前者是「这次执行不是
 * 失败，没有可解释的原因」，后者是「是失败，但现有证据不足以归因」。
 */
export function executionFailure(db: Db, executionId: string): ExecutionFailure | null {
	const row = db
		.prepare("SELECT id, status, failure_class, failure_component FROM executions WHERE id = ?")
		.get(executionId) as ExecutionFailureRow | undefined;
	if (row === undefined || !isFailureStatus(row.status)) return null;
	if (row.failure_class !== null) {
		return {
			failure_class: row.failure_class as FailureClass,
			component: (row.failure_component ?? "unknown") as FailureComponent,
		};
	}
	const classified = classifyStoredExecution(db, row.id);
	if (classified === null) return null;
	db.prepare(
		"UPDATE executions SET failure_class = ?, failure_component = ? WHERE id = ? AND failure_class IS NULL",
	).run(classified.failure_class, classified.component, row.id);
	return { failure_class: classified.failure_class, component: classified.component };
}
