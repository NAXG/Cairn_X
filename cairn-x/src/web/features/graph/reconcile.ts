import type cytoscape from "cytoscape";
export function reconcileGraph(cy: cytoscape.Core, elements: cytoscape.ElementDefinition[]) {
	const wanted = new Set(elements.map((e) => e.data.id));
	const initial = cy.nodes().length === 0;
	const added: string[] = [];
	cy.batch(() => {
		const removed = cy.elements().filter((e) => !wanted.has(e.id()));
		removed.remove();
		for (const e of elements) {
			const old = cy.getElementById(e.data.id!);
			if (!old.length) {
				cy.add(e);
				if (!e.data.source) added.push(e.data.id!);
			} else {
				const focused = old.hasClass("focused");
				if (
					old.isEdge() &&
					(old.data("source") !== e.data.source || old.data("target") !== e.data.target)
				)
					old.move({ source: e.data.source!, target: e.data.target! });
				old.data(e.data);
				old.classes(typeof e.classes === "string" ? e.classes : "");
				if (focused) old.addClass("focused");
			}
		}
	});
	// 首次渲染整体走 dagre；之后只给新增节点就近找位置（紧跟其上游节点右侧，
	// 向下避让已占位置），已有节点和 viewport 保持不动，用户的缩放与平移不会被重置。
	// 需要重排时由「重新布局」按钮显式触发。
	if (initial)
		cy.layout({
			name: "dagre",
			rankDir: "LR",
			nodeSep: 35,
			rankSep: 100,
		} as cytoscape.LayoutOptions).run();
	else {
		const pending = new Set(added);
		const occupied = cy
			.nodes()
			.filter((n) => !pending.has(n.id()))
			.map((n) => (n as cytoscape.NodeSingular).position());
		while (pending.size) {
			const ready = [...pending].filter(
				(id) =>
					!cy
						.getElementById(id)
						.incomers("node")
						.some((n) => pending.has((n as cytoscape.NodeSingular).id())),
			);
			for (const id of ready.length ? ready : [[...pending][0]]) {
				const n = cy.getElementById(id);
				const p = n.incomers("node").filter((n) => !pending.has(n.id()));
				const x = p.length
					? Math.max(...p.map((n) => (n as cytoscape.NodeSingular).position("x"))) + 270
					: 0;
				let y = p.length ? p[0].position("y") : 0;
				while (occupied.some((v) => Math.abs(v.x - x) < 230 && Math.abs(v.y - y) < 100)) y += 110;
				n.position({ x, y });
				occupied.push({ x, y });
				pending.delete(id);
			}
		}
	}
}
