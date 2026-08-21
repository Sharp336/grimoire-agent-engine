import { useMemo, useState } from "react";
import { Bar } from "react-chartjs-2";
import { getProviderDashboardStats } from "../api";
import {
	barDatasetStyle,
	buildSharedPlugins,
	buildSharedScales,
	buildTopNByModelSeries,
	CHART_THEMES,
	MODEL_COLORS,
	styleDatasets,
} from "../components/chart-shared";
import {
	formatCompact,
	formatInteger,
	formatPercent,
	formatRelativeTime,
	formatTokensPerSecond,
	useFormatCost,
} from "../data/formatters";
import { useResource } from "../data/useResource";
import { useTranslation } from "../i18n";
import type {
	ProviderAggregate,
	ProviderDashboardStats,
	ProviderHourlyPoint,
	ProviderWindowInsight,
	TimeRange,
	UsageWindowSeries,
} from "../types";
import { AsyncBoundary, DataTable, type DataTableColumn, EmptyState, Panel, SegmentedControl } from "../ui";
import { useSystemTheme } from "../useSystemTheme";

export interface ProvidersRouteProps {
	active: boolean;
	range: TimeRange;
	refreshTrigger: number;
}

export function ProvidersRoute({ active, range, refreshTrigger }: ProvidersRouteProps) {
	const {
		data: stats,
		error,
		loading,
	} = useResource(["providers", range, refreshTrigger], signal => getProviderDashboardStats(range, signal), {
		pollMs: 30000,
		enabled: active,
	});

	return (
		<div className="stats-route-container space-y-6">
			<AsyncBoundary loading={loading} error={error} data={stats}>
				{stats && (
					<>
						<ProviderTotalsPanel providers={stats.providers} />
						<ProviderTrendPanel stats={stats} />
						<PeakHoursPanel hourly={stats.hourly} providers={stats.providers} />
						<WindowInsightsPanel insights={stats.windowInsights} />
						<WindowUtilizationPanel usageSeries={stats.usageSeries} />
					</>
				)}
			</AsyncBoundary>
		</div>
	);
}

// ---------------------------------------------------------------------------
// Provider totals
// ---------------------------------------------------------------------------

function ProviderTotalsPanel({ providers }: { providers: ProviderAggregate[] }) {
	const { t, locale } = useTranslation();
	const formatCost = useFormatCost();
	const grandTotal = useMemo(() => providers.reduce((sum, p) => sum + p.totalTokens, 0), [providers]);
	const columns: DataTableColumn<ProviderAggregate>[] = [
		{
			key: "provider",
			header: t("providers.totals.col.provider"),
			render: p => <span className="font-medium">{p.provider}</span>,
		},
		{
			key: "requests",
			header: t("providers.totals.col.requests"),
			numeric: true,
			render: p => formatInteger(p.totalRequests),
		},
		{
			key: "errors",
			header: t("providers.totals.col.errorRate"),
			numeric: true,
			render: p => formatPercent(p.totalRequests > 0 ? p.failedRequests / p.totalRequests : 0),
		},
		{ key: "models", header: t("providers.totals.col.models"), numeric: true, render: p => formatInteger(p.models) },
		{
			key: "tokens",
			header: t("providers.totals.col.tokens"),
			numeric: true,
			render: p => (
				<span
					title={`${t("providers.totals.tooltip.input")} ${formatCompact(p.totalInputTokens, locale)} · ${t("providers.totals.tooltip.output")} ${formatCompact(p.totalOutputTokens, locale)} · ${t("providers.totals.tooltip.cacheRead")} ${formatCompact(p.totalCacheReadTokens, locale)} · ${t("providers.totals.tooltip.cacheWrite")} ${formatCompact(p.totalCacheWriteTokens, locale)}`}
				>
					{formatCompact(p.totalTokens, locale)}
				</span>
			),
		},
		{
			key: "share",
			header: t("providers.totals.col.share"),
			numeric: true,
			render: p => formatPercent(grandTotal > 0 ? p.totalTokens / grandTotal : 0),
		},
		{
			key: "cost",
			header: t("providers.totals.col.cost"),
			numeric: true,
			render: p => formatCost(p.totalCost, undefined, locale),
		},
		{
			key: "tps",
			header: t("providers.totals.col.tps"),
			numeric: true,
			render: p => formatTokensPerSecond(p.avgTokensPerSecond),
		},
	];

	return (
		<Panel title={t("providers.totals.title")} subtitle={t("providers.totals.subtitle")}>
			<DataTable
				columns={columns}
				data={providers}
				keyExtractor={p => p.provider}
				emptyText={t("providers.totals.empty")}
			/>
		</Panel>
	);
}

// ---------------------------------------------------------------------------
// Token / cost trend by provider
// ---------------------------------------------------------------------------

function ProviderTrendPanel({ stats }: { stats: ProviderDashboardStats }) {
	const { t, locale } = useTranslation();
	const formatCost = useFormatCost();
	const [metric, setMetric] = useState<"tokens" | "cost">("tokens");
	const theme = useSystemTheme();
	const chartTheme = CHART_THEMES[theme];

	// buildTopNByModelSeries keys on `model`; feed it the provider name so we
	// get the same top-N + "Other" rollup without a parallel implementation.
	const chartData = useMemo(() => {
		const points = stats.series.map(p => ({ ...p, model: p.provider }));
		return buildTopNByModelSeries<(typeof points)[number], { total: number }>(points, {
			topN: 6,
			rankWeight: p => (metric === "tokens" ? p.totalTokens : p.cost),
			initBucket: () => ({ total: 0 }),
			accumulate: (bucket, p) => {
				bucket.total += metric === "tokens" ? p.totalTokens : p.cost;
			},
			bucketToValue: bucket => bucket.total,
		});
	}, [stats.series, metric]);

	const formatValue =
		metric === "tokens" ? (v: number) => formatCompact(v, locale) : (v: number) => formatCost(v, undefined, locale);
	const options = useMemo(() => {
		const { sharedScaleBase, yScale } = buildSharedScales({ chartTheme, formatY: formatValue });
		return {
			responsive: true,
			maintainAspectRatio: false,
			interaction: { mode: "index" as const, intersect: false },
			plugins: buildSharedPlugins({
				chartTheme,
				showLegend: true,
				defaultLabel: metric === "tokens" ? t("providers.burn.metric.tokens") : t("providers.burn.metric.cost"),
				formatValue,
				footer: items => {
					if (items.length < 2) return undefined;
					const total = items.reduce((sum, item) => sum + (item.parsed.y ?? 0), 0);
					return `${t("providers.burn.tooltip.total")}: ${formatValue(total)}`;
				},
			}),
			scales: {
				x: { ...sharedScaleBase, stacked: true },
				y: { ...yScale, stacked: true },
			},
		};
	}, [chartTheme, metric, formatValue, t]);

	const data = useMemo(
		() => ({
			labels: chartData.labels,
			datasets: styleDatasets(chartData, i => barDatasetStyle(MODEL_COLORS[i % MODEL_COLORS.length])),
		}),
		[chartData],
	);

	return (
		<Panel
			title={t("providers.burn.title")}
			subtitle={t("providers.burn.subtitle")}
			actions={
				<SegmentedControl
					options={[
						{ value: "tokens" as const, label: t("providers.burn.metric.tokens") },
						{ value: "cost" as const, label: t("providers.burn.metric.cost") },
					]}
					value={metric}
					onChange={setMetric}
				/>
			}
		>
			<div className="h-[300px]">
				{chartData.labels.length === 0 ? (
					<EmptyState message={t("providers.burn.empty")} />
				) : (
					<Bar data={data} options={options} />
				)}
			</div>
		</Panel>
	);
}

// ---------------------------------------------------------------------------
// Peak burn hours
// ---------------------------------------------------------------------------

const ALL_PROVIDERS = "__all__";
function PeakHoursPanel({ hourly, providers }: { hourly: ProviderHourlyPoint[]; providers: ProviderAggregate[] }) {
	const { t, locale } = useTranslation();
	const [provider, setProvider] = useState(ALL_PROVIDERS);
	const theme = useSystemTheme();
	const chartTheme = CHART_THEMES[theme];

	const { tokensByHour, peakHour } = useMemo(() => {
		const tokens = new Array<number>(24).fill(0);
		for (const point of hourly) {
			if (provider !== ALL_PROVIDERS && point.provider !== provider) continue;
			tokens[point.hour] += point.totalTokens;
		}
		let peak = 0;
		for (let hour = 1; hour < 24; hour++) {
			if (tokens[hour] > tokens[peak]) peak = hour;
		}
		return { tokensByHour: tokens, peakHour: peak };
	}, [hourly, provider]);

	const hasData = tokensByHour.some(v => v > 0);

	const data = useMemo(
		() => ({
			labels: Array.from({ length: 24 }, (_, hour) => `${String(hour).padStart(2, "0")}:00`),
			datasets: [
				{
					label: t("providers.totals.col.tokens"),
					data: tokensByHour,
					...barDatasetStyle(MODEL_COLORS[2]),
					// Highlight the peak hour in the brand accent color.
					backgroundColor: tokensByHour.map((_, hour) => (hour === peakHour ? MODEL_COLORS[0] : MODEL_COLORS[2])),
				},
			],
		}),
		[tokensByHour, peakHour, t],
	);

	const options = useMemo(() => {
		const { sharedScaleBase, yScale } = buildSharedScales({
			chartTheme,
			formatY: (v: number) => formatCompact(v, locale),
		});
		return {
			responsive: true,
			maintainAspectRatio: false,
			plugins: buildSharedPlugins({
				chartTheme,
				showLegend: false,
				defaultLabel: t("providers.totals.col.tokens"),
				formatValue: (v: number) => formatCompact(v, locale),
			}),
			scales: { x: sharedScaleBase, y: yScale },
		};
	}, [chartTheme, t, locale]);

	return (
		<Panel
			title={t("providers.peak.title")}
			subtitle={
				hasData
					? t("providers.peak.subtitleWithPeak", { hour: String(peakHour).padStart(2, "0") })
					: t("providers.peak.subtitle")
			}
			actions={
				<select
					className="stats-select"
					value={provider}
					onChange={e => setProvider(e.target.value)}
					aria-label={t("providers.totals.col.provider")}
				>
					<option value={ALL_PROVIDERS}>{t("providers.peak.allProviders")}</option>
					{providers.map(p => (
						<option key={p.provider} value={p.provider}>
							{p.provider}
						</option>
					))}
				</select>
			}
		>
			<div className="h-[260px]">
				{hasData ? <Bar data={data} options={options} /> : <EmptyState message={t("providers.peak.empty")} />}
			</div>
		</Panel>
	);
}

// ---------------------------------------------------------------------------
// Subscription window insights
// ---------------------------------------------------------------------------

function WindowInsightsPanel({ insights }: { insights: ProviderWindowInsight[] }) {
	const { t, locale } = useTranslation();
	const columns: DataTableColumn<ProviderWindowInsight>[] = [
		{
			key: "provider",
			header: t("providers.windows.col.provider"),
			render: i => <span className="font-medium">{i.provider}</span>,
		},
		{ key: "window", header: t("providers.windows.col.window"), render: i => i.windowLabel },
		{
			key: "accounts",
			header: t("providers.windows.col.accounts"),
			numeric: true,
			render: i => formatInteger(i.accounts),
		},
		{
			key: "consumed",
			header: t("providers.windows.col.consumed"),
			numeric: true,
			render: i => <span title={t("providers.windows.tooltip.consumed")}>{i.fractionConsumed.toFixed(2)}</span>,
		},
		{
			key: "capacity",
			header: t("providers.windows.col.capacity"),
			numeric: true,
			render: i => (
				<span title={t("providers.windows.tooltip.capacity")}>
					{i.estTokensPerWindow !== null ? formatCompact(i.estTokensPerWindow, locale) : "—"}
				</span>
			),
		},
		{
			key: "peak",
			header: t("providers.windows.col.peak"),
			numeric: true,
			render: i => (
				<span title={t("providers.windows.tooltip.peak")}>{formatPercent(i.peakConcurrentFraction)}</span>
			),
		},
		{
			key: "ideal",
			header: t("providers.windows.col.ideal"),
			numeric: true,
			render: i => (
				<span
					title={t("providers.windows.tooltip.ideal")}
					className={i.idealAccounts > i.accounts ? "stats-text-warning font-semibold" : undefined}
				>
					{formatInteger(i.idealAccounts)}
					{i.idealAccounts > i.accounts ? ` ${t("providers.windows.idealHaveSuffix", { count: i.accounts })}` : ""}
				</span>
			),
		},
		{
			key: "exhausted",
			header: t("providers.windows.col.exhausted"),
			numeric: true,
			render: i => (
				<span className={i.exhaustedEvents > 0 ? "stats-text-warning" : undefined}>
					{formatInteger(i.exhaustedEvents)}
				</span>
			),
		},
	];

	return (
		<Panel title={t("providers.windows.title")} subtitle={t("providers.windows.subtitle")}>
			<DataTable
				columns={columns}
				data={insights}
				keyExtractor={i => `${i.provider}::${i.windowKey}`}
				emptyText={t("providers.windows.empty")}
			/>
		</Panel>
	);
}

// ---------------------------------------------------------------------------
// Window utilization
// ---------------------------------------------------------------------------

const UTILIZATION_COLORS = {
	ok: "#62d394",
	warning: "#f5c14b",
	exhausted: "#ff6b7d",
} as const;

function WindowUtilizationPanel({ usageSeries }: { usageSeries: UsageWindowSeries[] }) {
	const { t, locale } = useTranslation();
	const providers = useMemo(() => [...new Set(usageSeries.map(s => s.provider))], [usageSeries]);
	const [selected, setSelected] = useState<string | null>(null);
	const provider = selected !== null && providers.includes(selected) ? selected : (providers[0] ?? null);
	const theme = useSystemTheme();
	const chartTheme = CHART_THEMES[theme];

	// One row per (window, account): the latest recorded fraction. Snapshot
	// history is bursty (rows appear whenever usage is fetched), so a "how full
	// is each window right now" bar reads far better than a time axis.
	const rows = useMemo(() => {
		return usageSeries
			.filter(s => s.provider === provider)
			.map(s => {
				const latest = [...s.points].reverse().find(p => p.usedFraction !== null);
				return latest
					? {
							label: `${s.windowLabel} · ${s.accountLabel}`,
							fraction: latest.usedFraction ?? 0,
							exhausted: latest.exhausted,
							recordedAt: latest.timestamp,
						}
					: null;
			})
			.filter(row => row !== null)
			.sort((a, b) => b.fraction - a.fraction);
	}, [usageSeries, provider]);

	const data = useMemo(
		() => ({
			labels: rows.map(r => r.label),
			datasets: [
				{
					label: t("providers.utilization.labelUsed"),
					data: rows.map(r => r.fraction * 100),
					backgroundColor: rows.map(r =>
						r.exhausted
							? UTILIZATION_COLORS.exhausted
							: r.fraction >= 0.8
								? UTILIZATION_COLORS.warning
								: UTILIZATION_COLORS.ok,
					),
					borderWidth: 0,
					borderRadius: 4,
					barThickness: 18,
				},
			],
		}),
		[rows, t],
	);

	const options = useMemo(() => {
		const { sharedScaleBase, yScale } = buildSharedScales({ chartTheme, formatY: v => `${Math.round(v)}%` });
		const xMax = Math.max(100, ...rows.map(r => r.fraction * 100));
		const shared = buildSharedPlugins({
			chartTheme,
			showLegend: false,
			defaultLabel: t("providers.utilization.labelUsed"),
			formatValue: v => `${v.toFixed(1)}%`,
		});
		return {
			indexAxis: "y" as const,
			responsive: true,
			maintainAspectRatio: false,
			plugins: {
				...shared,
				tooltip: {
					...shared.tooltip,
					callbacks: {
						label: (ctx: { dataIndex: number; parsed: { x: number | null } }) => {
							const row = rows[ctx.dataIndex];
							const used = `${(ctx.parsed.x ?? 0).toFixed(1)}% ${t("providers.utilization.tooltipUsed")}`;
							return row
								? `${used} · ${t("providers.utilization.tooltipRecorded")} ${formatRelativeTime(row.recordedAt, locale)}`
								: used;
						},
					},
				},
			},
			scales: {
				x: { ...yScale, max: xMax },
				y: { ...sharedScaleBase, grid: { display: false } },
			},
		};
	}, [chartTheme, rows, t, locale]);

	return (
		<Panel
			title={t("providers.utilization.title")}
			subtitle={t("providers.utilization.subtitle")}
			actions={
				providers.length > 1 ? (
					<select
						className="stats-select"
						value={provider ?? ""}
						onChange={e => setSelected(e.target.value)}
						aria-label={t("providers.totals.col.provider")}
					>
						{providers.map(p => (
							<option key={p} value={p}>
								{p}
							</option>
						))}
					</select>
				) : undefined
			}
		>
			<div style={{ height: Math.max(160, rows.length * 34 + 60) }}>
				{rows.length === 0 ? (
					<EmptyState message={t("providers.utilization.empty")} />
				) : (
					<Bar data={data} options={options} />
				)}
			</div>
		</Panel>
	);
}
