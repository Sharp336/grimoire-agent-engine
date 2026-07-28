import { useMemo, useState } from "react";
import { Line } from "react-chartjs-2";
import { getSkillDashboardStats } from "../api";
import { CHART_THEMES, MODEL_COLORS } from "../components/chart-shared";
import { formatRangeTick, rangeMeta } from "../components/range-meta";
import { formatCompact, formatCost, formatInteger, formatPercent, formatRelativeTime } from "../data/formatters";
import { useAvailableSelection } from "../data/useAvailableSelection";
import { useResource } from "../data/useResource";
import { averageCostPerInvocation, buildSkillRows, type SkillRowView } from "../data/view-models";
import type { SkillModelStats, SkillTimeSeriesPoint, SkillUsageStats, TimeRange } from "../types";
import { AsyncBoundary, DataTable, Panel, StatusPill } from "../ui";
import { useSystemTheme } from "../useSystemTheme";

export interface SkillsRouteProps {
	active: boolean;
	range: TimeRange;
	refreshTrigger: number;
}

export function SkillsRoute({ active, range, refreshTrigger }: SkillsRouteProps) {
	const {
		data: stats,
		error,
		loading,
	} = useResource(["skills", range, refreshTrigger], signal => getSkillDashboardStats(range, signal), {
		pollMs: 30000,
		enabled: active,
	});

	return (
		<div className="stats-route-container space-y-6">
			<AsyncBoundary
				loading={loading}
				error={error}
				data={stats}
				emptyText="No skill invocations recorded for this range."
			>
				{stats && (
					<>
						<SkillsSummaryPanel bySkill={stats.bySkill} />
						<SkillInvocationsChart series={stats.series} timeRange={range} />
						<SkillsTable bySkill={stats.bySkill} />
						<SkillModelPanel bySkillModel={stats.bySkillModel} />
					</>
				)}
			</AsyncBoundary>
		</div>
	);
}

// ---------------------------------------------------------------------------
// Summary metrics
// ---------------------------------------------------------------------------

function SkillsSummaryPanel({ bySkill }: { bySkill: SkillUsageStats[] }) {
	const totals = useMemo(() => {
		let calls = 0;
		let errors = 0;
		let tokens = 0;
		let output = 0;
		let cost = 0;
		let resultChars = 0;
		let argsChars = 0;
		for (const skill of bySkill) {
			calls += skill.calls;
			errors += skill.errors;
			tokens += skill.totalTokensShare;
			output += skill.outputTokensShare;
			cost += skill.costShare;
			resultChars += skill.resultChars;
			argsChars += skill.argsChars;
		}
		return { calls, errors, tokens, output, cost, resultChars, argsChars, skills: bySkill.length };
	}, [bySkill]);

	return (
		<Panel
			title="Skill Usage"
			subtitle="Tokens/cost are the invoking turns' real provider usage, split across each turn's tool calls"
		>
			<div className="stats-metric-cluster">
				<div className="stats-metric-primary-grid">
					<div className="stats-metric-card primary">
						<div className="stats-metric-label">Skill Invocations</div>
						<div className="stats-metric-value">{formatInteger(totals.calls)}</div>
					</div>
					<div className="stats-metric-card primary">
						<div className="stats-metric-label">Skills Used</div>
						<div className="stats-metric-value">{formatInteger(totals.skills)}</div>
					</div>
					<div className="stats-metric-card primary">
						<div className="stats-metric-label">Error Rate</div>
						<div className="stats-metric-value">
							{formatPercent(totals.calls > 0 ? totals.errors / totals.calls : 0)}
						</div>
					</div>
					<div className="stats-metric-card primary">
						<div className="stats-metric-label">Attributed Cost</div>
						<div className="stats-metric-value">{formatCost(totals.cost)}</div>
					</div>
					<div className="stats-metric-card primary">
						<div className="stats-metric-label">Avg Cost / Invocation</div>
						<div className="stats-metric-value">
							{formatCost(averageCostPerInvocation(totals.cost, totals.calls))}
						</div>
					</div>
				</div>

				<div className="stats-metric-secondary-grid">
					<div className="stats-metric-card secondary">
						<div className="stats-metric-label">Attributed Tokens</div>
						<div className="stats-metric-value">{formatCompact(Math.round(totals.tokens))}</div>
					</div>
					<div className="stats-metric-card secondary">
						<div className="stats-metric-label">Attributed Output</div>
						<div className="stats-metric-value">{formatCompact(Math.round(totals.output))}</div>
					</div>
					<div className="stats-metric-card secondary">
						<div className="stats-metric-label">Result Text</div>
						<div className="stats-metric-value">{formatCompact(totals.resultChars)} chars</div>
					</div>
					<div className="stats-metric-card secondary">
						<div className="stats-metric-label">Call Arguments</div>
						<div className="stats-metric-value">{formatCompact(totals.argsChars)} chars</div>
					</div>
				</div>
			</div>
		</Panel>
	);
}

// ---------------------------------------------------------------------------
// Invocations over time (stacked by top skills)
// ---------------------------------------------------------------------------

const TOP_SKILLS = 6;
const OVERFLOW_SKILL_KEY = Symbol("skills-overflow");
type SkillBucketKey = string | typeof OVERFLOW_SKILL_KEY;

export function formatSkillSeriesLabel(skill: SkillBucketKey): string {
	return skill === OVERFLOW_SKILL_KEY ? "Other skills" : skill;
}

export function buildSkillInvocationSeries(points: SkillTimeSeriesPoint[]): {
	buckets: number[];
	skills: SkillBucketKey[];
	data: Map<number, Map<SkillBucketKey, number>>;
} {
	const totals = new Map<string, number>();
	for (const point of points) totals.set(point.skill, (totals.get(point.skill) ?? 0) + point.calls);
	const ranked = [...totals.entries()].sort((a, b) => b[1] - a[1]);
	const top = ranked.slice(0, TOP_SKILLS).map(([skill]) => skill);
	const topSet = new Set(top);
	const hasOther = ranked.length > top.length;
	const skills: SkillBucketKey[] = hasOther ? [...top, OVERFLOW_SKILL_KEY] : top;

	const buckets = [...new Set(points.map(point => point.timestamp))].sort((a, b) => a - b);
	const data = new Map<number, Map<SkillBucketKey, number>>();
	for (const bucket of buckets) data.set(bucket, new Map());
	for (const point of points) {
		const bucket = topSet.has(point.skill) ? point.skill : OVERFLOW_SKILL_KEY;
		const row = data.get(point.timestamp);
		if (row) row.set(bucket, (row.get(bucket) ?? 0) + point.calls);
	}
	return { buckets, skills, data };
}

function SkillInvocationsChart({ series, timeRange }: { series: SkillTimeSeriesPoint[]; timeRange: TimeRange }) {
	const theme = useSystemTheme();
	const chartTheme = CHART_THEMES[theme];
	const meta = rangeMeta(timeRange);

	const chartSeries = useMemo(() => buildSkillInvocationSeries(series), [series]);

	const data = useMemo(
		() => ({
			labels: chartSeries.buckets.map(timestamp => formatRangeTick(timestamp, timeRange)),
			datasets: chartSeries.skills.map((skill, index) => ({
				label: formatSkillSeriesLabel(skill),
				data: chartSeries.buckets.map(bucket => chartSeries.data.get(bucket)?.get(skill) ?? 0),
				borderColor: MODEL_COLORS[index % MODEL_COLORS.length],
				backgroundColor: `${MODEL_COLORS[index % MODEL_COLORS.length]}30`,
				fill: true,
				tension: 0.4,
				pointRadius: 0,
				pointHoverRadius: 4,
				borderWidth: 2,
			})),
		}),
		[chartSeries, timeRange],
	);

	const options = useMemo(
		() => ({
			responsive: true,
			maintainAspectRatio: false,
			interaction: { mode: "index" as const, intersect: false },
			plugins: {
				legend: {
					position: "top" as const,
					align: "start" as const,
					labels: {
						color: chartTheme.legendLabel,
						usePointStyle: true,
						padding: 16,
						font: { size: 12 },
						boxWidth: 8,
					},
				},
				tooltip: {
					backgroundColor: chartTheme.tooltipBackground,
					titleColor: chartTheme.tooltipTitle,
					bodyColor: chartTheme.tooltipBody,
					borderColor: chartTheme.tooltipBorder,
					borderWidth: 1,
					padding: 12,
					cornerRadius: 8,
					callbacks: {
						label: (context: { dataset: { label?: string }; parsed: { y: number | null } }) =>
							`${context.dataset.label ?? ""}: ${formatInteger(context.parsed.y ?? 0)} invocations`,
					},
				},
			},
			scales: {
				x: {
					stacked: true,
					grid: { color: chartTheme.grid, drawBorder: false },
					ticks: { color: chartTheme.tick, font: { size: 11 } },
				},
				y: {
					stacked: true,
					grid: { color: chartTheme.grid, drawBorder: false },
					ticks: { color: chartTheme.tick, font: { size: 11 }, precision: 0 },
					min: 0,
				},
			},
		}),
		[chartTheme],
	);

	return (
		<Panel title="Invocations Over Time" subtitle={`Skill invocations over ${meta.windowLabel}, stacked by skill`}>
			<div className="h-[280px]">
				{chartSeries.buckets.length === 0 ? (
					<div className="h-full flex items-center justify-center text-stats-muted text-sm">No data available</div>
				) : (
					<Line data={data} options={options} />
				)}
			</div>
		</Panel>
	);
}

// ---------------------------------------------------------------------------
// Per-skill table
// ---------------------------------------------------------------------------

function errorPillVariant(errorRate: number): "danger" | "warning" | "success" {
	return errorRate > 0.1 ? "danger" : errorRate > 0 ? "warning" : "success";
}

function SkillsTable({ bySkill }: { bySkill: SkillUsageStats[] }) {
	const rows = useMemo(() => buildSkillRows(bySkill), [bySkill]);

	const columns = useMemo(
		() => [
			{
				key: "skill",
				header: "Skill",
				render: (item: SkillRowView) => (
					<div
						className="stats-font-medium stats-text-primary font-mono truncate max-w-[280px]"
						title={item.skill}
					>
						{item.skill}
					</div>
				),
			},
			{
				key: "calls",
				header: "Invocations",
				numeric: true,
				render: (item: SkillRowView) => (
					<div className="stats-text-right">
						<div className="font-mono">{formatInteger(item.calls)}</div>
						<div className="stats-progress-bar-track mt-1 ml-auto w-24 h-1">
							<div
								className="stats-progress-bar-fill"
								data-variant="link"
								style={{ width: `${item.callsPercentage}%` }}
							/>
						</div>
					</div>
				),
			},
			{
				key: "errorRate",
				header: "Error Rate",
				numeric: true,
				render: (item: SkillRowView) => (
					<StatusPill variant={errorPillVariant(item.errorRate)}>{formatPercent(item.errorRate)}</StatusPill>
				),
			},
			{
				key: "tokens",
				header: "Attr. Tokens",
				numeric: true,
				render: (item: SkillRowView) => (
					<span className="font-mono" title="Invoking turns' total tokens, split across each turn's calls">
						{formatCompact(Math.round(item.totalTokensShare))}
					</span>
				),
			},
			{
				key: "cost",
				header: "Attr. Cost",
				numeric: true,
				render: (item: SkillRowView) => <span className="font-mono">{formatCost(item.costShare)}</span>,
			},
			{
				key: "averageCostPerInvocation",
				header: "Avg Cost / Inv.",
				numeric: true,
				render: (item: SkillRowView) => <span className="font-mono">{formatCost(item.avgCostPerInvocation)}</span>,
			},
			{
				key: "resultChars",
				header: "Result Text",
				numeric: true,
				render: (item: SkillRowView) => (
					<span className="font-mono" title="Characters of tool-result text fed back into context">
						{formatCompact(item.resultChars)}
					</span>
				),
			},
			{
				key: "lastUsed",
				header: "Last Used",
				numeric: true,
				render: (item: SkillRowView) => (
					<span className="stats-text-secondary">{formatRelativeTime(item.lastUsed)}</span>
				),
			},
		],
		[],
	);

	const renderMobileCard = (item: SkillRowView) => (
		<div className="stats-mobile-card">
			<div className="stats-mobile-card-header mb-2">
				<div className="stats-font-semibold stats-text-primary font-mono">{item.skill}</div>
				<StatusPill variant={errorPillVariant(item.errorRate)}>{formatPercent(item.errorRate)} Err</StatusPill>
			</div>
			<div className="stats-mobile-card-grid">
				<div>
					<div className="stats-mobile-card-label">Invocations</div>
					<div className="stats-mobile-card-value font-mono">{formatInteger(item.calls)}</div>
				</div>
				<div>
					<div className="stats-mobile-card-label">Attr. Tokens</div>
					<div className="stats-mobile-card-value font-mono">
						{formatCompact(Math.round(item.totalTokensShare))}
					</div>
				</div>
				<div>
					<div className="stats-mobile-card-label">Attr. Cost</div>
					<div className="stats-mobile-card-value font-mono">{formatCost(item.costShare)}</div>
				</div>
				<div>
					<div className="stats-mobile-card-label">Avg Cost</div>
					<div className="stats-mobile-card-value font-mono">{formatCost(item.avgCostPerInvocation)}</div>
				</div>
				<div>
					<div className="stats-mobile-card-label">Result Text</div>
					<div className="stats-mobile-card-value font-mono">{formatCompact(item.resultChars)}</div>
				</div>
			</div>
		</div>
	);

	return (
		<Panel title="By Skill" subtitle="Usage per skill, most invoked first">
			<DataTable
				columns={columns}
				data={rows}
				keyExtractor={item => item.skill}
				renderMobileCard={renderMobileCard}
				emptyText="No skill invocations recorded for this range."
			/>
		</Panel>
	);
}

// ---------------------------------------------------------------------------
// Per-(skill, model) breakdown
// ---------------------------------------------------------------------------

function SkillModelPanel({ bySkillModel }: { bySkillModel: SkillModelStats[] }) {
	const [skill, setSkill] = useState<string | null>(null);

	const skills = useMemo(() => [...new Set(bySkillModel.map(row => row.skill))].sort(), [bySkillModel]);
	const effectiveSkill = useAvailableSelection(skill, skills, setSkill);

	const rows = useMemo(() => {
		const filtered = effectiveSkill ? bySkillModel.filter(row => row.skill === effectiveSkill) : bySkillModel;
		return filtered.map(row => ({
			...row,
			errorRate: row.calls > 0 ? row.errors / row.calls : 0,
			avgCostPerInvocation: averageCostPerInvocation(row.costShare, row.calls),
		}));
	}, [bySkillModel, effectiveSkill]);

	const columns = useMemo(
		() => [
			{
				key: "skill",
				header: "Skill",
				render: (item: SkillModelStats & { errorRate: number; avgCostPerInvocation: number }) => (
					<span className="stats-font-medium stats-text-primary font-mono">{item.skill}</span>
				),
			},
			{
				key: "model",
				header: "Model",
				render: (item: SkillModelStats & { errorRate: number; avgCostPerInvocation: number }) => (
					<div>
						<div className="stats-text-primary">{item.model || "(unknown)"}</div>
						<div className="stats-text-secondary text-xs">{item.provider}</div>
					</div>
				),
			},
			{
				key: "calls",
				header: "Invocations",
				numeric: true,
				render: (item: SkillModelStats & { errorRate: number; avgCostPerInvocation: number }) => (
					<span className="font-mono">{formatInteger(item.calls)}</span>
				),
			},
			{
				key: "errorRate",
				header: "Error Rate",
				numeric: true,
				render: (item: SkillModelStats & { errorRate: number; avgCostPerInvocation: number }) => (
					<StatusPill variant={errorPillVariant(item.errorRate)}>{formatPercent(item.errorRate)}</StatusPill>
				),
			},
			{
				key: "tokens",
				header: "Attr. Tokens",
				numeric: true,
				render: (item: SkillModelStats & { errorRate: number; avgCostPerInvocation: number }) => (
					<span className="font-mono">{formatCompact(Math.round(item.totalTokensShare))}</span>
				),
			},
			{
				key: "cost",
				header: "Attr. Cost",
				numeric: true,
				render: (item: SkillModelStats & { errorRate: number; avgCostPerInvocation: number }) => (
					<span className="font-mono">{formatCost(item.costShare)}</span>
				),
			},
			{
				key: "averageCostPerInvocation",
				header: "Avg Cost / Inv.",
				numeric: true,
				render: (item: SkillModelStats & { errorRate: number; avgCostPerInvocation: number }) => (
					<span className="font-mono">{formatCost(item.avgCostPerInvocation)}</span>
				),
			},
		],
		[],
	);

	return (
		<Panel title="By Model" subtitle="Which models invoke which skills">
			<div className="mb-4" style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
				<span className="stats-text-secondary" style={{ fontSize: "0.875rem", whiteSpace: "nowrap" }}>
					Skill
				</span>
				<select
					className="stats-select"
					value={effectiveSkill ?? ""}
					onChange={event => setSkill(event.target.value || null)}
					style={{ maxWidth: "320px", flex: 1 }}
				>
					<option value="">All skills</option>
					{skills.map(name => (
						<option key={name} value={name}>
							{name}
						</option>
					))}
				</select>
			</div>
			<DataTable
				columns={columns}
				data={rows}
				keyExtractor={item => `${item.skill}::${item.model}::${item.provider}`}
				emptyText="No skill invocations recorded for this range."
			/>
		</Panel>
	);
}
