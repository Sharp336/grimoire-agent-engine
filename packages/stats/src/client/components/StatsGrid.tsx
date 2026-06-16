import { Activity, AlertCircle, BarChart3, Database, Download, Server, Star, Upload, Zap } from "lucide-react";
import { useTranslation, type TranslationKey } from "../i18n";
import type { AggregatedStats } from "../types";

interface StatsGridProps {
	stats: AggregatedStats;
}

function formatCompactNumber(value: number, locale: string): string {
	return new Intl.NumberFormat(locale, {
		notation: "compact",
		maximumFractionDigits: 1,
	}).format(value);
}

function formatExactNumber(value: number, locale: string): string {
	return value.toLocaleString(locale);
}

const localeMap: Record<string, string> = { en: "en-US", zh: "zh-CN" };

const totalPromptCompletionTokens = (stats: AggregatedStats) => stats.totalInputTokens + stats.totalOutputTokens;

interface StatDef {
	key: string;
	titleKey: string;
	icon: typeof Server;
	color: string;
	getValue: (s: AggregatedStats, locale: string) => string;
	getDetail: (s: AggregatedStats, t: (key: string, params?: Record<string, string | number>) => string, locale: string) => string;
}

const statConfig: StatDef[] = [
	{
		key: "requests",
		titleKey: "statsGrid.totalRequests",
		icon: Server,
		color: "var(--accent-violet)",
		getValue: (s, locale) => formatExactNumber(s.totalRequests, locale),
		getDetail: (s, t, locale) =>
			`${formatExactNumber(s.successfulRequests, locale)} ${t("statsGrid.successErrors", { "0": formatExactNumber(s.failedRequests, locale) })}`,
	},
	{
		key: "cost",
		titleKey: "statsGrid.totalCost",
		icon: Activity,
		color: "var(--accent-pink)",
		getValue: s => `$${s.totalCost.toFixed(2)}`,
		getDetail: (s, t) =>
			s.totalRequests > 0 ? t("statsGrid.avgCostPerReq", { "0": (s.totalCost / s.totalRequests).toFixed(4) }) : "-",
	},
	{
		key: "premiumRequests",
		titleKey: "requestDetail.premiumReqs",
		icon: Star,
		color: "var(--accent-amber)",
		getValue: (s, locale) => formatExactNumber(s.totalPremiumRequests, locale),
		getDetail: (s, t) =>
			s.totalRequests > 0 ? `${((s.totalPremiumRequests / s.totalRequests) * 100).toFixed(1)}% ${t("statsGrid.ofRequests")}` : "-",
	},
	{
		key: "cache",
		titleKey: "statsGrid.cacheRead",
		icon: Database,
		color: "var(--accent-cyan)",
		getValue: s => `${(s.cacheRate * 100).toFixed(1)}%`,
		getDetail: (s, t, locale) => `${formatCompactNumber(s.totalCacheReadTokens, locale)} ${t("statsGrid.cachedTokens")}`,
	},
	{
		key: "inputTokens",
		titleKey: "statsGrid.inputTokens",
		icon: Download,
		color: "var(--accent-violet)",
		getValue: (s, locale) => formatCompactNumber(s.totalInputTokens, locale),
		getDetail: (s, t) =>
			totalPromptCompletionTokens(s) > 0
				? `${((s.totalInputTokens / totalPromptCompletionTokens(s)) * 100).toFixed(1)}% ${t("statsGrid.ofPromptCompletion")}`
				: "-",
	},
	{
		key: "outputTokens",
		titleKey: "statsGrid.outputTokens",
		icon: Upload,
		color: "var(--accent-pink)",
		getValue: (s, locale) => formatCompactNumber(s.totalOutputTokens, locale),
		getDetail: (s, t) =>
			totalPromptCompletionTokens(s) > 0
				? `${((s.totalOutputTokens / totalPromptCompletionTokens(s)) * 100).toFixed(1)}% ${t("statsGrid.ofPromptCompletion")}`
				: "-",
	},
	{
		key: "errors",
		titleKey: "requestDetail.error",
		icon: AlertCircle,
		color: "var(--accent-red)",
		getValue: s => `${(s.errorRate * 100).toFixed(1)}%`,
		getDetail: (s, t, locale) => `${formatExactNumber(s.failedRequests, locale)} ${t("statsGrid.failedRequests")}`,
	},
	{
		key: "tokens",
		titleKey: "statsGrid.avgThroughput",
		icon: BarChart3,
		color: "var(--accent-green)",
		getValue: s => s.avgTokensPerSecond?.toFixed(1) ?? "-",
		getDetail: (s, t, locale) =>
			`${formatCompactNumber(totalPromptCompletionTokens(s), locale)} ${t("statsGrid.totalPromptCompletion")}`,
	},
	{
		key: "ttft",
		titleKey: "statsGrid.avgTTFT",
		icon: Zap,
		color: "var(--accent-amber)",
		getValue: s => (s.avgTtft ? `${(s.avgTtft / 1000).toFixed(2)}s` : "-"),
		getDetail: (_s, t) => t("statsGrid.timeToFirstToken"),
	},
];

export function StatsGrid({ stats }: StatsGridProps) {
	const { t, locale } = useTranslation();
	const intlLocale = localeMap[locale] ?? locale;

	return (
		<div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-9 gap-4 mb-8">
			{statConfig.map(stat => {
				const Icon = stat.icon;
				return (
					<div key={stat.key} className="stat-card group">
						<div className="flex items-center justify-between mb-3">
							<span className="text-sm font-medium text-[var(--text-secondary)]">{t(stat.titleKey as TranslationKey)}</span>
							<div
								className="p-2 rounded-[var(--radius-sm)] transition-colors"
								style={{ backgroundColor: `${stat.color}15` }}
							>
								<Icon
									size={18}
									style={{ color: stat.color }}
									className="transition-transform group-hover:scale-110"
								/>
							</div>
						</div>
						<div className="text-2xl font-bold text-[var(--text-primary)] mb-1 truncate">{stat.getValue(stats, intlLocale)}</div>
						<div className="text-xs text-[var(--text-muted)] truncate">{stat.getDetail(stats, t, intlLocale)}</div>
					</div>
				);
			})}
		</div>
	);
}
