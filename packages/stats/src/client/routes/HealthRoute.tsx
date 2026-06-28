import { useMemo } from "react";
import { Line } from "react-chartjs-2";
import { getSessionHealthDashboardStats } from "../api";
import { buildSharedPlugins, buildSharedScales, CHART_THEMES, lineDatasetStyle } from "../components/chart-shared";
import { formatBytes, formatCompact, formatInteger } from "../data/formatters";
import { useResource } from "../data/useResource";
import type {
	HealthDimensionStats,
	HealthEventKind,
	HealthKindStats,
	HealthOverallStats,
	HealthTimeSeriesPoint,
	TimeRange,
} from "../types";
import { AsyncBoundary, DataTable, Panel } from "../ui";
import { useSystemTheme } from "../useSystemTheme";

export interface HealthRouteProps {
	active: boolean;
	range: TimeRange;
	refreshTrigger: number;
}

const KIND_LABELS: Record<HealthEventKind, string> = {
	retry: "Retries",
	tool_loop: "Tool loops",
	cancellation: "Cancellations",
	edit_churn: "Edit churn",
	compaction: "Compactions",
	model_switch: "Model switches",
	subagent_spawn: "Subagent fanout",
	large_result: "Large results",
};

const HEALTH_COLORS = {
	retries: "rgb(236, 72, 153)",
	cancellations: "rgb(239, 68, 68)",
	loops: "rgb(168, 85, 247)",
	edits: "rgb(34, 197, 94)",
	largeResults: "rgb(14, 165, 233)",
	fanout: "rgb(245, 158, 11)",
} as const;

export function HealthRoute({ active, range, refreshTrigger }: HealthRouteProps) {
	const {
		data: stats,
		error,
		loading,
	} = useResource(["health", range, refreshTrigger], signal => getSessionHealthDashboardStats(range, signal), {
		pollMs: 30_000,
		enabled: active,
	});

	return (
		<div className="stats-route-container space-y-6">
			<AsyncBoundary loading={loading} error={error} data={stats} empty={stats?.overall.totalEvents === 0}>
				{stats && (
					<>
						<HealthSummaryPanel overall={stats.overall} />
						<HealthTrendPanel healthSeries={stats.healthSeries} />
						<HealthKindTable rows={stats.byKind} />
						<HealthDimensionTable rows={stats.byTool} />
					</>
				)}
			</AsyncBoundary>
		</div>
	);
}

function HealthSummaryPanel({ overall }: { overall: HealthOverallStats }) {
	const editDelta = overall.editLinesAdded + overall.editLinesRemoved;
	return (
		<Panel title="Session Health" subtitle="Operational signals extracted from session transcripts">
			<div className="stats-metric-primary-grid">
				<div className="stats-metric-card primary">
					<div className="stats-metric-label">Health Events</div>
					<div className="stats-metric-value">{formatInteger(overall.totalEvents)}</div>
				</div>
				<div className="stats-metric-card primary">
					<div className="stats-metric-label">Retries</div>
					<div className="stats-metric-value">{formatInteger(overall.retryCount)}</div>
				</div>
				<div className="stats-metric-card primary">
					<div className="stats-metric-label">Cancellations</div>
					<div className="stats-metric-value">{formatInteger(overall.cancellationCount)}</div>
				</div>
				<div className="stats-metric-card primary">
					<div className="stats-metric-label">Tool Loop Repeats</div>
					<div className="stats-metric-value">{formatInteger(overall.toolLoopCount)}</div>
				</div>
			</div>
			<div className="stats-metric-secondary-grid mt-4">
				<div className="stats-metric-card secondary">
					<div className="stats-metric-label">Files Changed</div>
					<div className="stats-metric-value">{formatInteger(overall.editFilesChanged)}</div>
				</div>
				<div className="stats-metric-card secondary">
					<div className="stats-metric-label">Edit Line Churn</div>
					<div className="stats-metric-value">{formatInteger(editDelta)}</div>
				</div>
				<div className="stats-metric-card secondary">
					<div className="stats-metric-label">Compactions</div>
					<div className="stats-metric-value">{formatInteger(overall.compactionCount)}</div>
				</div>
				<div className="stats-metric-card secondary">
					<div className="stats-metric-label">Model Switches</div>
					<div className="stats-metric-value">{formatInteger(overall.modelSwitchCount)}</div>
				</div>
				<div className="stats-metric-card secondary">
					<div className="stats-metric-label">Subagent Fanout</div>
					<div className="stats-metric-value">{formatInteger(overall.subagentSpawnCount)}</div>
				</div>
				<div className="stats-metric-card secondary">
					<div className="stats-metric-label">Large Result Bytes</div>
					<div className="stats-metric-value">{formatBytes(overall.largeResultBytes)}</div>
				</div>
			</div>
		</Panel>
	);
}

function HealthTrendPanel({ healthSeries }: { healthSeries: HealthTimeSeriesPoint[] }) {
	const theme = useSystemTheme();
	const chartTheme = CHART_THEMES[theme];

	const { data, options } = useMemo(() => {
		const labelFormatter = new Intl.DateTimeFormat(undefined, {
			month: "short",
			day: "numeric",
			timeZone: "UTC",
		});
		const labels = healthSeries.map(point => labelFormatter.format(new Date(point.timestamp)));
		const chartData = {
			labels,
			datasets: [
				{
					label: "Retries",
					data: healthSeries.map(point => point.retryCount),
					...lineDatasetStyle(HEALTH_COLORS.retries),
				},
				{
					label: "Cancellations",
					data: healthSeries.map(point => point.cancellationCount),
					...lineDatasetStyle(HEALTH_COLORS.cancellations),
				},
				{
					label: "Tool loops",
					data: healthSeries.map(point => point.toolLoopCount),
					...lineDatasetStyle(HEALTH_COLORS.loops),
				},
				{
					label: "Edit lines",
					data: healthSeries.map(point => point.editLinesAdded + point.editLinesRemoved),
					...lineDatasetStyle(HEALTH_COLORS.edits),
				},
				{
					label: "Large results",
					data: healthSeries.map(point => point.largeResultCount),
					...lineDatasetStyle(HEALTH_COLORS.largeResults),
				},
				{
					label: "Subagents",
					data: healthSeries.map(point => point.subagentSpawnCount),
					...lineDatasetStyle(HEALTH_COLORS.fanout),
				},
			],
		};
		const plugins = buildSharedPlugins({
			chartTheme,
			showLegend: true,
			defaultLabel: "Events",
			formatValue: formatCompact,
		});
		const { sharedScaleBase, yScale } = buildSharedScales({ chartTheme, formatY: formatCompact });
		return {
			data: chartData,
			options: {
				responsive: true,
				maintainAspectRatio: false,
				interaction: { mode: "index" as const, intersect: false },
				plugins,
				scales: { x: sharedScaleBase, y: yScale },
			},
		};
	}, [healthSeries, chartTheme]);

	return (
		<Panel title="Health Trends" subtitle="Daily operational signals">
			{healthSeries.length > 0 ? (
				<div style={{ height: 320 }}>
					<Line data={data} options={options} />
				</div>
			) : (
				<div className="stats-table-empty">No health events in this range</div>
			)}
		</Panel>
	);
}

function HealthKindTable({ rows }: { rows: HealthKindStats[] }) {
	const columns = useMemo(
		() => [
			{ key: "kind", header: "Kind", render: (row: HealthKindStats) => KIND_LABELS[row.kind] },
			{
				key: "events",
				header: "Events",
				render: (row: HealthKindStats) => formatInteger(row.totalEvents),
				numeric: true,
			},
			{
				key: "retries",
				header: "Retries",
				render: (row: HealthKindStats) => formatInteger(row.retryCount),
				numeric: true,
			},
			{
				key: "loops",
				header: "Loops",
				render: (row: HealthKindStats) => formatInteger(row.toolLoopCount),
				numeric: true,
			},
			{
				key: "cancellations",
				header: "Cancels",
				render: (row: HealthKindStats) => formatInteger(row.cancellationCount),
				numeric: true,
			},
			{
				key: "edit",
				header: "Edit Δ",
				render: (row: HealthKindStats) => formatInteger(row.editLinesAdded + row.editLinesRemoved),
				numeric: true,
			},
			{
				key: "large",
				header: "Large",
				render: (row: HealthKindStats) => formatInteger(row.largeResultCount),
				numeric: true,
			},
		],
		[],
	);
	return (
		<Panel title="Health by Kind" subtitle="Aggregate event categories">
			<DataTable columns={columns} data={rows} keyExtractor={row => row.kind} emptyText="No health events" />
		</Panel>
	);
}

function dimensionLabel(row: HealthDimensionStats): string {
	if (row.toolName) return row.toolName;
	if (row.provider && row.model) return `${row.provider}/${row.model}`;
	return row.model ?? row.provider ?? "—";
}

function HealthDimensionTable({ rows }: { rows: HealthDimensionStats[] }) {
	const columns = useMemo(
		() => [
			{ key: "kind", header: "Kind", render: (row: HealthDimensionStats) => KIND_LABELS[row.kind] },
			{ key: "dimension", header: "Tool / Model", render: dimensionLabel },
			{
				key: "events",
				header: "Events",
				render: (row: HealthDimensionStats) => formatInteger(row.totalEvents),
				numeric: true,
			},
			{
				key: "signals",
				header: "Signals",
				render: (row: HealthDimensionStats) => signalSummary(row),
			},
			{
				key: "largeBytes",
				header: "Large Bytes",
				render: (row: HealthDimensionStats) => formatBytes(row.largeResultBytes),
				numeric: true,
			},
		],
		[],
	);
	return (
		<Panel title="Tool and Model Drilldown" subtitle="Loop, churn, large-result, retry, and model-switch dimensions">
			<DataTable
				columns={columns}
				data={rows}
				keyExtractor={row => `${row.kind}:${row.toolName ?? ""}:${row.provider ?? ""}:${row.model ?? ""}`}
				emptyText="No dimensional health events"
			/>
		</Panel>
	);
}

function signalSummary(row: HealthDimensionStats): string {
	const parts: string[] = [];
	if (row.retryCount) parts.push(`${formatInteger(row.retryCount)} retries`);
	if (row.toolLoopCount) parts.push(`${formatInteger(row.toolLoopCount)} loops`);
	if (row.cancellationCount) parts.push(`${formatInteger(row.cancellationCount)} cancels`);
	if (row.editFilesChanged) parts.push(`${formatInteger(row.editFilesChanged)} files`);
	if (row.editLinesAdded || row.editLinesRemoved) {
		parts.push(`+${formatInteger(row.editLinesAdded)} / -${formatInteger(row.editLinesRemoved)}`);
	}
	if (row.compactionCount) parts.push(`${formatInteger(row.compactionCount)} compactions`);
	if (row.modelSwitchCount) parts.push(`${formatInteger(row.modelSwitchCount)} switches`);
	if (row.subagentSpawnCount) parts.push(`${formatInteger(row.subagentSpawnCount)} spawns`);
	if (row.largeResultCount) parts.push(`${formatInteger(row.largeResultCount)} large`);
	return parts.join(" · ") || "—";
}
