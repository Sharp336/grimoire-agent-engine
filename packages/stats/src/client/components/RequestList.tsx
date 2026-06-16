import { formatDistanceToNow } from "date-fns";
import { CheckCircle2, XCircle } from "lucide-react";
import { useTranslation } from "../i18n";
import type { MessageStats } from "../types";

interface RequestListProps {
	requests: MessageStats[];
	total: number;
	page: number;
	pageSize: number;
	onPageChange: (page: number) => void;
	onSelect: (req: MessageStats) => void;
	title: string;
	compact?: boolean;
}

export function RequestList({ requests, total, page, pageSize, onPageChange, onSelect, title, compact = false }: RequestListProps) {

	const { t } = useTranslation();

	const calculateTPS = (req: MessageStats): string => {
		if (!req.duration || req.duration === 0 || req.usage.output === 0) return "-";
		return ((req.usage.output * 1000) / req.duration).toFixed(1);
	};

	return (
		<div className="surface overflow-hidden flex flex-col h-full">
			<div className="px-5 py-4 border-b border-[var(--border-subtle)]">
				<h3 className="text-sm font-semibold text-[var(--text-primary)]">{title}</h3>
			</div>
			<div className="overflow-auto flex-1">
				<table className="w-full">
					<thead className="bg-[var(--bg-elevated)] sticky top-0 z-10">
						<tr>
							<th className="text-left py-2 px-3 table-header">{t("requestList.model")}</th>
							<th className="text-left py-2 px-3 table-header">{t("requestList.provider")}</th>
							<th className="text-left py-2 px-3 table-header">{t("requestList.time")}</th>
							{!compact && <th className="text-right py-2 px-3 table-header">{t("requestList.input")}</th>}
							{!compact && <th className="text-right py-2 px-3 table-header">{t("requestList.output")}</th>}
							<th className="text-right py-2 px-3 table-header">{t("requestList.tokens")}</th>
							<th className="text-right py-2 px-3 table-header">{t("requestList.cost")}</th>
							{!compact && <th className="text-right py-2 px-3 table-header">{t("requestList.tps")}</th>}
							<th className="text-right py-2 px-3 table-header">{t("requestList.duration")}</th>
							<th className="text-center py-2 px-3 table-header">{t("requestList.status")}</th>
						</tr>
					</thead>
					<tbody>
						{requests.map(req => (
							<tr
								key={`${req.sessionFile}-${req.entryId}`}
								onClick={() => onSelect(req)}
								className="table-row cursor-pointer border-b border-[var(--border-subtle)] last:border-b-0"
							>
								<td className="py-2 px-3">
									<div className="font-medium text-[var(--text-primary)] text-sm">{req.model}</div>
								</td>
								<td className="py-2 px-3 text-sm text-[var(--text-muted)]">{req.provider}</td>
								<td className="py-2 px-3 text-sm text-[var(--text-secondary)]">
									{formatDistanceToNow(req.timestamp, { addSuffix: true })}
								</td>
								{!compact && (
									<td className="py-2 px-3 text-right text-sm text-[var(--text-secondary)] font-mono">
										{req.usage.input.toLocaleString()}
									</td>
								)}
								{!compact && (
									<td className="py-2 px-3 text-right text-sm text-[var(--text-secondary)] font-mono">
										{req.usage.output.toLocaleString()}
									</td>
								)}
								<td className="py-2 px-3 text-right text-sm text-[var(--text-secondary)] font-mono">
									{req.usage.totalTokens.toLocaleString()}
								</td>
								<td className="py-2 px-3 text-right text-sm text-[var(--text-secondary)] font-mono">
									${req.usage.cost.total.toFixed(4)}
								</td>
								{!compact && (
									<td className="py-2 px-3 text-right text-sm text-[var(--text-secondary)] font-mono">
										{calculateTPS(req)}
									</td>
								)}
								<td className="py-2 px-3 text-right text-sm text-[var(--text-secondary)] font-mono">
									{req.duration ? `${(req.duration / 1000).toFixed(1)}s` : "-"}
								</td>
								<td className="py-2 px-3 text-center">
									{req.errorMessage ? (
										<XCircle size={16} className="text-[var(--accent-red)] mx-auto" />
									) : (
										<CheckCircle2 size={16} className="text-[var(--accent-green)] mx-auto" />
									)}
								</td>
							</tr>
						))}
						{requests.length === 0 && (
							<tr>
								<td colSpan={compact ? 7 : 10} className="py-12 text-center text-[var(--text-muted)] text-sm">
									{t("requestList.noRequests")}
								</td>
							</tr>
						)}
					</tbody>
				</table>
			</div>
			<div className="px-5 py-3 border-t border-[var(--border-subtle)] flex items-center justify-between">
				<div className="text-sm text-[var(--text-muted)]">
					{t("requestList.showing", { start: page * pageSize + 1, end: Math.min((page + 1) * pageSize, total), total })}
				</div>
				<div className="flex gap-2 items-center">
					<button
						onClick={() => onPageChange(page - 1)}
						disabled={page === 0}
						className="px-3 py-1 text-sm rounded bg-[var(--bg-elevated)] text-[var(--text-primary)] disabled:opacity-50 disabled:cursor-not-allowed hover:bg-[var(--bg-hover)]"
					>
						{t("common.previous")}
					</button>
					<div className="flex gap-1">
						{Array.from({ length: Math.min(5, Math.ceil(total / pageSize)) }, (_, i) => {
							const totalPages = Math.ceil(total / pageSize);
							let pageNum = i;
							if (totalPages > 5) {
								if (page < 3) {
									pageNum = i;
								} else if (page > totalPages - 4) {
									pageNum = totalPages - 5 + i;
								} else {
									pageNum = page - 2 + i;
								}
							}
							return (
								<button
									key={pageNum}
									onClick={() => onPageChange(pageNum)}
									className={`px-3 py-1 text-sm rounded ${
										page === pageNum
											? "bg-[var(--accent)] text-white"
											: "bg-[var(--bg-elevated)] text-[var(--text-primary)] hover:bg-[var(--bg-hover)]"
									}`}
								>
									{pageNum + 1}
								</button>
							);
						})}
					</div>
					<button
						onClick={() => onPageChange(page + 1)}
						disabled={(page + 1) * pageSize >= total}
						className="px-3 py-1 text-sm rounded bg-[var(--bg-elevated)] text-[var(--text-primary)] disabled:opacity-50 disabled:cursor-not-allowed hover:bg-[var(--bg-hover)]"
					>
						{t("common.next")}
					</button>
				</div>
			</div>
		</div>
	);
}
