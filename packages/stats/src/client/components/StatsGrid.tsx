import { Activity, AlertCircle, BarChart3, Database, Download, Server, Star, Upload, Zap } from "lucide-react";
import type { AggregatedStats } from "../types";

interface StatsGridProps {
	stats: AggregatedStats;
}

const compactNumberFormatter = new Intl.NumberFormat(undefined, {
	notation: "compact",
	maximumFractionDigits: 1,
});

const currencyFormatter = new Intl.NumberFormat(undefined, {
	currency: "USD",
	maximumFractionDigits: 2,
	minimumFractionDigits: 2,
	style: "currency",
});

const preciseCurrencyFormatter = new Intl.NumberFormat(undefined, {
	currency: "USD",
	maximumFractionDigits: 4,
	minimumFractionDigits: 4,
	style: "currency",
});

const compactCurrencyFormatter = new Intl.NumberFormat(undefined, {
	currency: "USD",
	maximumFractionDigits: 1,
	notation: "compact",
	style: "currency",
});

function formatCompactNumber(value: number): string {
	return compactNumberFormatter.format(value);
}

function formatExactNumber(value: number): string {
	return value.toLocaleString();
}

function formatCurrency(value: number): string {
	return currencyFormatter.format(value);
}

function formatPreciseCurrency(value: number): string {
	return preciseCurrencyFormatter.format(value);
}

function formatCompactCurrency(value: number): string {
	return compactCurrencyFormatter.format(value);
}

interface StatCardConfig {
	key: string;
	title: string;
	icon: typeof Server;
	color: string;
	getValue: (stats: AggregatedStats) => string;
	getTitle?: (stats: AggregatedStats) => string;
	getDetail: (stats: AggregatedStats) => string;
}

const totalPromptCompletionTokens = (stats: AggregatedStats) => stats.totalInputTokens + stats.totalOutputTokens;

const statConfig: StatCardConfig[] = [
	{
		key: "requests",
		title: "Total Requests",
		icon: Server,
		color: "var(--accent-violet)",
		getValue: (s: AggregatedStats) => formatCompactNumber(s.totalRequests),
		getTitle: (s: AggregatedStats) => formatExactNumber(s.totalRequests),
		getDetail: (s: AggregatedStats) =>
			`${formatCompactNumber(s.successfulRequests)} success · ${formatCompactNumber(s.failedRequests)} errors`,
	},
	{
		key: "cost",
		title: "Total Cost",
		icon: Activity,
		color: "var(--accent-pink)",
		getValue: (s: AggregatedStats) => formatCompactCurrency(s.totalCost),
		getTitle: (s: AggregatedStats) => formatCurrency(s.totalCost),
		getDetail: (s: AggregatedStats) =>
			s.totalRequests > 0 ? `${formatPreciseCurrency(s.totalCost / s.totalRequests)} avg/req` : "-",
	},
	{
		key: "premiumRequests",
		title: "Premium Reqs",
		icon: Star,
		color: "var(--accent-amber)",
		getValue: (s: AggregatedStats) => formatCompactNumber(s.totalPremiumRequests),
		getTitle: (s: AggregatedStats) => formatExactNumber(s.totalPremiumRequests),
		getDetail: (s: AggregatedStats) =>
			s.totalRequests > 0 ? `${((s.totalPremiumRequests / s.totalRequests) * 100).toFixed(1)}% of requests` : "-",
	},
	{
		key: "cache",
		title: "Cache Rate",
		icon: Database,
		color: "var(--accent-cyan)",
		getValue: (s: AggregatedStats) => `${(s.cacheRate * 100).toFixed(1)}%`,
		getDetail: (s: AggregatedStats) => `${formatCompactNumber(s.totalCacheReadTokens)} cached tokens`,
	},
	{
		key: "inputTokens",
		title: "Input Tokens",
		icon: Download,
		color: "var(--accent-violet)",
		getValue: (s: AggregatedStats) => formatCompactNumber(s.totalInputTokens),
		getTitle: (s: AggregatedStats) => formatExactNumber(s.totalInputTokens),
		getDetail: (s: AggregatedStats) =>
			totalPromptCompletionTokens(s) > 0
				? `${((s.totalInputTokens / totalPromptCompletionTokens(s)) * 100).toFixed(1)}% of tokens`
				: "-",
	},
	{
		key: "outputTokens",
		title: "Output Tokens",
		icon: Upload,
		color: "var(--accent-pink)",
		getValue: (s: AggregatedStats) => formatCompactNumber(s.totalOutputTokens),
		getTitle: (s: AggregatedStats) => formatExactNumber(s.totalOutputTokens),
		getDetail: (s: AggregatedStats) =>
			totalPromptCompletionTokens(s) > 0
				? `${((s.totalOutputTokens / totalPromptCompletionTokens(s)) * 100).toFixed(1)}% of tokens`
				: "-",
	},
	{
		key: "errors",
		title: "Error Rate",
		icon: AlertCircle,
		color: "var(--accent-red)",
		getValue: (s: AggregatedStats) => `${(s.errorRate * 100).toFixed(1)}%`,
		getDetail: (s: AggregatedStats) => `${s.failedRequests.toLocaleString()} failed requests`,
	},
	{
		key: "tokens",
		title: "Tokens/Sec",
		icon: BarChart3,
		color: "var(--accent-green)",
		getValue: (s: AggregatedStats) => s.avgTokensPerSecond?.toFixed(1) ?? "-",
		getDetail: (s: AggregatedStats) => `${formatCompactNumber(totalPromptCompletionTokens(s))} tokens total`,
	},
	{
		key: "ttft",
		title: "TTFT",
		icon: Zap,
		color: "var(--accent-amber)",
		getValue: (s: AggregatedStats) => (s.avgTtft ? `${(s.avgTtft / 1000).toFixed(2)}s` : "-"),
		getDetail: () => "Time to first token",
	},
];

export function StatsGrid({ stats }: StatsGridProps) {
	return (
		<div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-9 gap-4 mb-8">
			{statConfig.map(stat => {
				const Icon = stat.icon;
				const value = stat.getValue(stats);
				const title = stat.getTitle?.(stats) ?? value;
				const detail = stat.getDetail(stats);
				return (
					<div key={stat.key} className="stat-card group min-w-0">
						<div className="flex items-center justify-between gap-3 mb-3">
							<span className="min-w-0 truncate text-sm font-medium text-[var(--text-secondary)]">
								{stat.title}
							</span>
							<div
								className="shrink-0 p-2 rounded-[var(--radius-sm)] transition-colors"
								style={{ backgroundColor: `${stat.color}15` }}
							>
								<Icon
									size={18}
									style={{ color: stat.color }}
									className="transition-transform group-hover:scale-110"
								/>
							</div>
						</div>
						<div
							className="truncate text-2xl font-bold tracking-tight tabular-nums text-[var(--text-primary)] mb-1"
							title={title}
						>
							{value}
						</div>
						<div className="text-xs leading-snug text-[var(--text-muted)]" title={detail}>
							{detail}
						</div>
					</div>
				);
			})}
		</div>
	);
}
