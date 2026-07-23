interface PaginationProps {
	currentPage: number;
	pageSize: number;
	total: number;
	onPageChange: (page: number) => void;
}

export function Pagination({ currentPage, pageSize, total, onPageChange }: PaginationProps) {
	const totalPages = Math.ceil(total / pageSize);

	if (totalPages <= 1) return null;

	return (
		<div className="stats-pagination">
			<button
				onClick={() => onPageChange(currentPage - 1)}
				disabled={currentPage === 1}
				className="stats-button"
			>
				Previous
			</button>
			<span className="stats-text-sm">
				Page {currentPage} of {totalPages}
			</span>
			<button
				onClick={() => onPageChange(currentPage + 1)}
				disabled={currentPage === totalPages}
				className="stats-button"
			>
				Next
			</button>
		</div>
	);
}
