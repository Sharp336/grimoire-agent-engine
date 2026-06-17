import { formatDistanceToNow } from "date-fns";
import { CheckCircle2, XCircle } from "lucide-react";
import type { MessageStats } from "../types";

interface RequestListProps {
	requests: MessageStats[];
	onSelect: (req: MessageStats) => void;
	title: string;
}

const requestCostFormatter = new Intl.NumberFormat(undefined, {
	currency: "USD",
	maximumFractionDigits: 4,
	minimumFractionDigits: 4,
	style: "currency",
});

export function RequestList({ requests, onSelect, title }: RequestListProps) {
	return (
		<div className="surface overflow-hidden flex flex-col h-full">
			<div className="px-5 py-4 border-b border-[var(--border-subtle)]">
				<h3 className="text-sm font-semibold text-[var(--text-primary)]">{title}</h3>
			</div>
			<div className="overflow-auto flex-1">
				<table className="w-full min-w-[720px] table-fixed">
					<colgroup>
						<col className="w-[29%]" />
						<col className="w-[17%]" />
						<col className="w-[15%]" />
						<col className="w-[15%]" />
						<col className="w-[13%]" />
						<col className="w-[11%]" />
					</colgroup>
					<thead className="bg-[var(--bg-elevated)] sticky top-0 z-10">
						<tr>
							<th className="text-left py-3 px-4 table-header">Model</th>
							<th className="text-left py-3 px-4 table-header">Time</th>
							<th className="text-right py-3 px-4 table-header">Tokens</th>
							<th className="text-right py-3 px-4 table-header">Cost</th>
							<th className="text-right py-3 px-4 table-header">Duration</th>
							<th className="text-center py-3 px-4 table-header">Status</th>
						</tr>
					</thead>
					<tbody>
						{requests.map(req => {
							const timeAgo = formatDistanceToNow(req.timestamp, { addSuffix: true });
							const tokens = req.usage.totalTokens.toLocaleString();
							const cost = requestCostFormatter.format(req.usage.cost.total);
							const duration = req.duration ? `${(req.duration / 1000).toFixed(1)}s` : "-";
							return (
								<tr
									key={`${req.sessionFile}-${req.entryId}`}
									onClick={() => onSelect(req)}
									className="table-row cursor-pointer border-b border-[var(--border-subtle)] last:border-b-0"
								>
									<td className="py-3 px-4 min-w-0">
										<div className="font-medium text-[var(--text-primary)] text-sm leading-snug break-words">
											{req.model}
										</div>
										<div className="text-xs text-[var(--text-muted)] truncate" title={req.provider}>
											{req.provider}
										</div>
									</td>
									<td className="py-3 px-4 text-sm text-[var(--text-secondary)]" title={timeAgo}>
										<div className="truncate">{timeAgo}</div>
									</td>
									<td
										className="py-3 px-4 text-right text-sm text-[var(--text-secondary)] font-mono"
										title={tokens}
									>
										<div className="truncate">{tokens}</div>
									</td>
									<td
										className="py-3 px-4 text-right text-sm text-[var(--text-secondary)] font-mono"
										title={cost}
									>
										<div className="truncate">{cost}</div>
									</td>
									<td
										className="py-3 px-4 text-right text-sm text-[var(--text-secondary)] font-mono"
										title={duration}
									>
										<div className="truncate">{duration}</div>
									</td>
									<td className="py-3 px-4 text-center">
										{req.errorMessage ? (
											<XCircle size={16} className="text-[var(--accent-red)] mx-auto" />
										) : (
											<CheckCircle2 size={16} className="text-[var(--accent-green)] mx-auto" />
										)}
									</td>
								</tr>
							);
						})}
						{requests.length === 0 && (
							<tr>
								<td colSpan={6} className="py-12 text-center text-[var(--text-muted)] text-sm">
									No requests found
								</td>
							</tr>
						)}
					</tbody>
				</table>
			</div>
		</div>
	);
}
