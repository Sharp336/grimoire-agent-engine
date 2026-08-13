import { useMemo } from "react";
import { getResourceRequests, getResourceTools, getResourceUsage } from "../api";
import { formatCost, formatInteger, formatRelativeTime } from "../data/formatters";
import { useResource } from "../data/useResource";
import type {
	ObservabilityPage,
	ObservabilityRequest,
	SessionUsageSummary,
	ToolUsageStats,
} from "../../shared-types";
import { AsyncBoundary, DataTable, EmptyState, Panel, StatusPill } from "../ui";

function usageTokens(value: unknown): number | null {
	if (!value || typeof value !== "object") return null;
	const total = (value as { totalTokens?: unknown }).totalTokens;
	return typeof total === "number" ? total : null;
}

function usageCost(value: unknown): number | null {
	if (!value || typeof value !== "object") return null;
	const cost = (value as { cost?: { total?: unknown } }).cost;
	return cost && typeof cost.total === "number" ? cost.total : null;
}

export function UsageStrip({ usage }: { usage: SessionUsageSummary }) {
	return (
		<div className="stats-obs-freshness">
			<span>{formatInteger(usage.requests)} requests</span>
			<span>{formatInteger(usage.errors)} failed</span>
			<span>{formatInteger(usage.tools)} tools</span>
			<span>{formatInteger(usage.totalTokens)} tokens</span>
			<span>{formatCost(usage.cost, usage.cost > 0 && usage.cost < 0.01 ? 4 : 2)}</span>
		</div>
	);
}

export function ResourceRequestsPanel({
	kind,
	id,
	active,
	errorsOnly,
	onRequestClick,
}: {
	kind: "sessions" | "runs";
	id: string;
	active: boolean;
	errorsOnly?: boolean;
	onRequestClick?: (id: number) => void;
}) {
	const page = useResource<ObservabilityPage<ObservabilityRequest>>(
		[kind, id, errorsOnly ? "failures" : "requests"],
		signal => getResourceRequests(kind, id, { errorsOnly, limit: 100 }, signal),
		{ pollMs: 30_000, enabled: active },
	);
	const columns = useMemo(
		() => [
			{
				key: "model",
				header: "Model",
				render: (item: ObservabilityRequest) => (
					<div>
						<div className="stats-font-medium stats-text-primary">{item.model}</div>
						<div className="stats-text-xs stats-text-muted">{item.provider}</div>
					</div>
				),
			},
			{
				key: "timestamp",
				header: "Time",
				render: (item: ObservabilityRequest) => formatRelativeTime(item.timestamp),
			},
			{
				key: "tokens",
				header: "Tokens",
				numeric: true,
				render: (item: ObservabilityRequest) => {
					const tokens = usageTokens(item.usage);
					return tokens === null ? "—" : formatInteger(tokens);
				},
			},
			{
				key: "cost",
				header: "Cost",
				numeric: true,
				render: (item: ObservabilityRequest) => {
					const cost = usageCost(item.usage);
					return cost === null ? "—" : formatCost(cost, 4);
				},
			},
			{
				key: "status",
				header: "Status",
				render: (item: ObservabilityRequest) => (
					<StatusPill variant={item.errorMessage ? "danger" : "success"}>
						{item.errorMessage ? "Failed" : item.stopReason || "ok"}
					</StatusPill>
				),
			},
		],
		[],
	);
	return (
		<Panel
			title={errorsOnly ? "Failed requests" : "Requests"}
			subtitle={errorsOnly ? "Indexed LLM calls that ended in error" : "Indexed LLM calls for this transcript"}
		>
			<AsyncBoundary
				loading={page.loading}
				error={page.error}
				data={page.data}
				empty={page.data !== null && page.data.items.length === 0}
				emptyText={errorsOnly ? "No failed requests in this transcript" : "No indexed LLM requests in this transcript"}
			>
				{page.data && (
					<DataTable
						columns={columns}
						data={page.data.items}
						keyExtractor={item => item.id ?? item.entryId}
						onRowClick={item => item.id && onRequestClick?.(item.id)}
						emptyText={errorsOnly ? "No failed requests in this transcript" : "No indexed LLM requests in this transcript"}
					/>
				)}
			</AsyncBoundary>
		</Panel>
	);
}

export function ResourceToolsPanel({
	kind,
	id,
	active,
}: {
	kind: "sessions" | "runs";
	id: string;
	active: boolean;
}) {
	const page = useResource<ObservabilityPage<ToolUsageStats>>(
		[kind, id, "tools"],
		signal => getResourceTools(kind, id, signal),
		{ pollMs: 30_000, enabled: active },
	);
	const columns = useMemo(
		() => [
			{
				key: "tool",
				header: "Tool",
				render: (item: ToolUsageStats) => item.tool,
			},
			{
				key: "calls",
				header: "Calls",
				numeric: true,
				render: (item: ToolUsageStats) => formatInteger(item.calls),
			},
			{
				key: "errors",
				header: "Errors",
				numeric: true,
				render: (item: ToolUsageStats) => formatInteger(item.errors),
			},
			{
				key: "lastUsed",
				header: "Last used",
				render: (item: ToolUsageStats) => formatRelativeTime(item.lastUsed),
			},
		],
		[],
	);
	return (
		<Panel title="Tools" subtitle="Tool calls recorded in this transcript">
			<AsyncBoundary
				loading={page.loading}
				error={page.error}
				data={page.data}
				empty={page.data !== null && page.data.items.length === 0}
				emptyText="No tool calls in this transcript"
			>
				{page.data && (
					<DataTable
						columns={columns}
						data={page.data.items}
						keyExtractor={item => item.tool}
						emptyText="No tool calls in this transcript"
					/>
				)}
			</AsyncBoundary>
		</Panel>
	);
}

export function ResourceUsagePanel({
	kind,
	id,
	active,
	mode,
}: {
	kind: "sessions" | "runs";
	id: string;
	active: boolean;
	mode: "tokens" | "models";
}) {
	const usage = useResource<SessionUsageSummary>(
		[kind, id, "usage"],
		signal => getResourceUsage(kind, id, signal),
		{ pollMs: 30_000, enabled: active },
	);
	const columns = useMemo(
		() => [
			{
				key: "model",
				header: "Model",
				render: (item: SessionUsageSummary["byModel"][number]) => (
					<div>
						<div className="stats-font-medium stats-text-primary">{item.model}</div>
						<div className="stats-text-xs stats-text-muted">{item.provider}</div>
					</div>
				),
			},
			{
				key: "requests",
				header: "Requests",
				numeric: true,
				render: (item: SessionUsageSummary["byModel"][number]) => formatInteger(item.requests),
			},
			{
				key: "tokens",
				header: "Tokens",
				numeric: true,
				render: (item: SessionUsageSummary["byModel"][number]) => formatInteger(item.totalTokens),
			},
			{
				key: "cost",
				header: "Cost",
				numeric: true,
				render: (item: SessionUsageSummary["byModel"][number]) => formatCost(item.cost, 4),
			},
		],
		[],
	);
	return (
		<Panel
			title={mode === "tokens" ? "Tokens" : "Models & routes"}
			subtitle={
				mode === "tokens"
					? "Provider usage already indexed for this transcript"
					: "Observe-only. No canary or promote controls."
			}
		>
			<AsyncBoundary
				loading={usage.loading}
				error={usage.error}
				data={usage.data}
				empty={usage.data !== null && usage.data.byModel.length === 0}
				emptyText="No indexed model usage in this transcript"
			>
				{usage.data && (
					<>
						{mode === "tokens" && <UsageStrip usage={usage.data} />}
						<DataTable
							columns={columns}
							data={usage.data.byModel}
							keyExtractor={item => `${item.provider}/${item.model}`}
							emptyText="No indexed model usage in this transcript"
						/>
					</>
				)}
			</AsyncBoundary>
		</Panel>
	);
}

export function ResourceLogsEmpty() {
	return <EmptyState message="No stored observability log facts. Indexed LLM calls are on the Requests tab." />;
}
