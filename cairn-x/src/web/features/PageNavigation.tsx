export function PageNavigation({
	page,
}: {
	page: {
		hasNext: boolean;
		hasPrevious: boolean;
		loading: boolean;
		next: () => void;
		previous: () => void;
		latest: () => void;
	};
}) {
	return page.hasNext || page.hasPrevious ? (
		<div className="execution-navigation">
			{page.hasPrevious && (
				<>
					<button onClick={page.latest}>返回最新</button>
					<button disabled={page.loading} onClick={page.previous}>
						上一页
					</button>
				</>
			)}
			{page.hasNext && (
				<button disabled={page.loading} onClick={page.next}>
					更早记录
				</button>
			)}
		</div>
	) : null;
}
