import { useEffect, useState } from "react";
import { usePoll } from "../api";
import type { ReadPage } from "../../contracts/workbench.js";

/** One bounded page, with stable keyset boundaries and back navigation. */
export function useReadPage<T>(url: string | null, interval = 3000) {
	const [navigation, setNavigation] = useState<{
		url: string | null;
		cursors: Array<string | undefined>;
	}>({ url, cursors: [undefined] });
	useEffect(
		() => setNavigation((old) => (old.url === url ? old : { url, cursors: [undefined] })),
		[url],
	);
	const cursors = navigation.url === url ? navigation.cursors : [undefined];
	const cursor = cursors.at(-1);
	const pageUrl = url
		? `${url}${url.includes("?") ? "&" : "?"}limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`
		: null;
	const page = usePoll<ReadPage<T>>(pageUrl, interval);
	return {
		...page,
		items: page.data?.items ?? [],
		hasNext: !!page.data?.next_cursor,
		hasPrevious: cursors.length > 1,
		next: () => {
			if (page.data?.next_cursor)
				setNavigation({ url, cursors: [...cursors, page.data.next_cursor] });
		},
		previous: () => setNavigation({ url, cursors: cursors.slice(0, -1) }),
		latest: () => setNavigation({ url, cursors: [undefined] }),
	};
}

export type ReadPageState<T> = ReturnType<typeof useReadPage<T>>;
