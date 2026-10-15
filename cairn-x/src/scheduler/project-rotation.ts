/**
 * 对项目列表做轮转排序：让上一次排在末尾的项目下一次排到前面，避免固定顺序
 * 把空闲项目饿死。游标由调用方持有并逐轮递增（取模在函数内完成）。
 */
export function rotateProjects<T extends { id: string }>(projects: T[], cursor: number): T[] {
	if (projects.length === 0) {
		return [];
	}
	const sorted = projects.toSorted((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
	const offset = cursor % sorted.length;
	return sorted.slice(offset).concat(sorted.slice(0, offset));
}
