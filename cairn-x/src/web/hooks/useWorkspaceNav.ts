import { useEffect, useState } from "react";

import type { ExecutionSummary } from "../../contracts/transcripts.js";

export type Nav = {
	project: string;
	tab: string;
	step: string;
	execution: string;
	session: string;
	node: string;
	event: string;
};

const readNav = (): Nav => {
	const p = new URLSearchParams(location.hash.slice(1));
	const requested = p.get("tab") ?? "";
	return {
		project: p.get("project") ?? "",
		tab: ["overview", "graph", "traces", "findings"].includes(requested) ? requested : "overview",
		step: p.get("step") ?? "",
		execution: p.get("execution") ?? "",
		session: p.get("session") ?? "",
		node: p.get("node") ?? "",
		event: p.get("event") ?? "",
	};
};

/** hash 路由：读取当前导航、订阅 hashchange，并提供带补丁的跳转。 */
export function useWorkspaceNav() {
	const [nav, setNav] = useState(readNav);
	useEffect(() => {
		const h = () => {
			const next = readNav();
			setNav((current) =>
				current.project === next.project &&
				current.tab === next.tab &&
				current.step === next.step &&
				current.execution === next.execution &&
				current.session === next.session &&
				current.node === next.node &&
				current.event === next.event
					? current
					: next,
			);
		};
		addEventListener("hashchange", h);
		return () => removeEventListener("hashchange", h);
	}, []);
	const navigate = (patch: Partial<Nav>) => {
		const next = { ...nav, ...patch };
		if (
			patch.event === undefined &&
			(patch.tab !== undefined ||
				patch.execution !== undefined ||
				patch.session !== undefined ||
				patch.project !== undefined)
		)
			next.event = "";
		location.hash = new URLSearchParams(Object.entries(next).filter(([, v]) => v)).toString();
		setNav(next);
	};
	const openExecution = (e: ExecutionSummary) =>
		navigate({
			tab: "traces",
			execution: e.id,
			session: "",
			step: e.step_id,
			node: "_step_" + e.step_id,
		});
	return { nav, navigate, openExecution };
}
