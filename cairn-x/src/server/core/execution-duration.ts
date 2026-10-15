export function executionSeconds(row: {
	created_at: string;
	started_at: string | null;
	finished_at: string | null;
}): number | null {
	const start = Date.parse(row.started_at ?? row.created_at);
	const end = row.finished_at === null ? Date.now() : Date.parse(row.finished_at);
	if (Number.isFinite(start) === false || Number.isFinite(end) === false || end < start)
		return null;
	return Math.round(((end - start) / 1000) * 10) / 10;
}
