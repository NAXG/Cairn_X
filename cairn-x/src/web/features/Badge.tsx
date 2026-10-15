import { statusLabels } from "../labels";

export const Badge = ({ status, label }: { status: string; label?: string }) => (
	<span className={"badge status-" + status}>{label ?? statusLabels[status] ?? status}</span>
);
