import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	getObservabilityTimeline,
	getRun,
	getRuns,
	getSession,
	getSessions,
	revealObservabilityFields,
} from "../api";
import { formatBytes, formatRelativeTime } from "../data/formatters";
import {
	behaviorTimelineItems,
	displaySessionTitle,
	normalizeObservabilityOutcome,
	OBSERVABILITY_OUTCOME_AXIS_LABELS,
	observabilityResourceUri,
	type ObservabilityOutcomeView,
} from "../data/view-models";
import { formatStatsHash, OBSERVABILITY_TABS, type ObservabilityTab } from "../data/hash-route";
import { useResource } from "../data/useResource";
import type { TimeRange } from "../types";
import type {
	ObservabilityPage,
	RunDetail,
	RunSummary,
	SessionDetail,
	SessionSummary,
	TimelineItem,
} from "../../shared-types";
import { AsyncBoundary, DataTable, EmptyState, ErrorState, JsonBlock, Panel, StatusPill } from "../ui";
import {
	ResourceLogsEmpty,
	ResourceRequestsPanel,
	ResourceToolsPanel,
	ResourceUsagePanel,
	UsageStrip,
} from "./ObservabilityFacts";

const TAB_LABELS: Record<ObservabilityTab, string> = {
	timeline: "Timeline",
	requests: "Requests",
	tools: "Tools",
	failures: "Failures",
	behavior: "Behavior",
	tokens: "Tokens",
	"models-routes": "Models & routes",
	"logs-raw": "Logs / Raw",
};

function isHardRedacted(value: unknown): boolean {
	return Boolean(value && typeof value === "object" && (value as { redacted?: string }).redacted === "hard");
}

function statusVariant(status: string): "success" | "danger" | "warning" | "info" | "default" {
	if (status === "active") return "info";
	if (status === "completed") return "success";
	if (status === "interrupted") return "danger";
	return "default";
}

function copyText(value: string): void {
	void navigator.clipboard?.writeText(value);
}

function FreshnessStrip(props: {
	truncated: boolean;
	indexedAt: number;
	indexedThrough: number;
	sourceModifiedAt: number;
	sourceSize: number;
	generation: number;
}) {
	return (
		<div className="stats-obs-freshness">
			<span>{props.truncated ? "Truncated" : "Current"}</span>
			<span>Generation {props.generation}</span>
			<span>Indexed {formatRelativeTime(props.indexedAt)}</span>
			<span>Through {formatBytes(props.indexedThrough)}</span>
			<span>Source {formatRelativeTime(props.sourceModifiedAt)}</span>
			<span>{formatBytes(props.sourceSize)}</span>
		</div>
	);
}

function OutcomeCluster({
	outcome,
}: {
	outcome: ObservabilityOutcomeView;
}) {
	return (
		<div className="stats-obs-outcome">
			{Object.entries(outcome).map(([axis, value]) => (
				<div key={axis} className="stats-obs-outcome-axis">
					<div className="stats-text-xs stats-text-muted">
						{OBSERVABILITY_OUTCOME_AXIS_LABELS[axis as keyof ObservabilityOutcomeView] ?? axis}
					</div>
					<div>{value}</div>
				</div>
			))}
		</div>
	);
}

function RevealList({
	available,
	revealed,
	onReveal,
	active,
}: {
	available: string[];
	revealed: Record<string, unknown>;
	onReveal: (field: string) => void;
	active: boolean;
}) {
	if (!active || available.length === 0) return null;
	return (
		<div className="stats-obs-reveal">
			{available.map(field => {
				const value = revealed[field];
				if (isHardRedacted(value)) {
					return (
						<div key={field} className="stats-text-xs stats-text-muted">
							{field}: hard-redacted
						</div>
					);
				}
				return (
					<button key={field} type="button" className="stats-button stats-button-secondary" onClick={() => onReveal(field)}>
						Reveal {field}
					</button>
				);
			})}
			{Object.entries(revealed).map(([field, value]) =>
				isHardRedacted(value) ? null : (
					<JsonBlock key={`revealed-${field}`} data={value} title={field} initialCollapsed={false} />
				),
			)}
		</div>
	);
}

function TimelineList({ items, empty }: { items: TimelineItem[]; empty: string }) {
	if (items.length === 0) return <EmptyState message={empty} />;
	return (
		<ol className="stats-obs-timeline">
			{items.map(item => (
				<li key={`${item.entryId}:${item.timestamp}`}>
					<div className="stats-font-medium">{item.kind}</div>
					<div className="stats-text-xs stats-text-muted">
						{item.executionId} · {formatRelativeTime(item.timestamp)}
						{item.decisionId ? ` · ${item.decisionId}` : ""}
					</div>
					<JsonBlock data={item.payload} title={item.entryId} initialCollapsed />
				</li>
			))}
		</ol>
	);
}

function TimelinePanel({
	kind,
	id,
	active,
	status,
	sourceKey,
	mode,
}: {
	kind: "sessions" | "runs";
	id: string;
	active: boolean;
	status: string;
	sourceKey: string;
	mode: "timeline" | "behavior";
}) {
	const [items, setItems] = useState<TimelineItem[]>([]);
	const [error, setError] = useState<Error | null>(null);
	const cursorRef = useRef<string | undefined>(undefined);
	const seenRef = useRef(new Set<string>());
	const terminalCheckedRef = useRef(false);

	useEffect(() => {
		cursorRef.current = undefined;
		seenRef.current = new Set();
		terminalCheckedRef.current = false;
		setItems([]);
		setError(null);
	}, [id, kind, sourceKey]);

	useEffect(() => {
		if (!active) return;
		let cancelled = false;
		const load = async (after?: string) => {
			try {
				let cursor = after;
				let replace = !after;
				const known = after ? new Set(seenRef.current) : new Set<string>();
				const merged: TimelineItem[] = [];
				for (;;) {
					const page = await getObservabilityTimeline(kind, id, cursor);
					if (cancelled) return;
					if (cursor && page.truncated && page.items.length === 0) {
						cursorRef.current = undefined;
						seenRef.current = new Set();
						known.clear();
						merged.length = 0;
						replace = true;
						cursor = undefined;
						continue;
					}
					for (const item of page.items) {
						const key = `${item.entryId}:${item.timestamp}`;
						if (known.has(key)) continue;
						known.add(key);
						merged.push(item);
					}
					if (page.nextCursor) {
						cursorRef.current = page.nextCursor;
						cursor = page.nextCursor;
						continue;
					}
					cursorRef.current = undefined;
					if (status === "completed" || status === "interrupted") {
						terminalCheckedRef.current = true;
					}
					break;
				}
				if (cancelled) return;
				seenRef.current = known;
				setError(null);
				setItems(current => {
					if (replace) return merged;
					const next = [...current];
					const have = new Set(next.map(item => `${item.entryId}:${item.timestamp}`));
					for (const item of merged) {
						const key = `${item.entryId}:${item.timestamp}`;
						if (have.has(key)) continue;
						have.add(key);
						next.push(item);
					}
					return next;
				});
			} catch (err) {
				if (!cancelled) setError(err instanceof Error ? err : new Error(String(err)));
			}
		};
		void load(cursorRef.current);
		const timer = window.setInterval(() => {
			if (terminalCheckedRef.current) return;
			void load(cursorRef.current);
		}, 3000);
		return () => {
			cancelled = true;
			window.clearInterval(timer);
		};
	}, [active, id, kind, status, sourceKey]);
	if (error && items.length === 0) return <ErrorState error={error} />;
	const visible = mode === "behavior" ? behaviorTimelineItems(items) : items;
	return (
		<TimelineList
			items={visible}
			empty={
				mode === "behavior"
					? "No stored segment or progress facts"
					: "No stored observability facts yet. Indexed LLM calls are on the Requests tab."
			}
		/>
	);
}


export interface ObservabilitySectionProps {
	kind: "sessions" | "runs";
	active: boolean;
	id: string | null;
	tab: ObservabilityTab | null;
	range: TimeRange;
	status: string | null;
	project: string | null;
	failure: string | null;
	q: string | null;
	refreshTrigger: number;
	onOpen: (id: string) => void;
	onTab: (tab: ObservabilityTab) => void;
	onRequestClick?: (id: number) => void;
}

export function ObservabilitySection({
	kind,
	active,
	id,
	tab,
	range,
	status,
	project,
	failure,
	q,
	refreshTrigger,
	onOpen,
	onTab,
	onRequestClick,
}: ObservabilitySectionProps) {
	const listKey = [kind, "list", range, status, project, failure, q, refreshTrigger] as const;
	const list = useResource<ObservabilityPage<SessionSummary | RunSummary>>(
		listKey,
		signal =>
			kind === "sessions"
				? getSessions(
						{ range, status, project, failure: failure === "true", q },
						signal,
					)
				: getRuns({ range, status, project, failure: failure === "true", q }, signal),
		{ pollMs: 30_000, enabled: active && !id },
	);

	const detail = useResource<SessionDetail | RunDetail | null>(
		[kind, "detail", id, refreshTrigger],
		signal => (id ? (kind === "sessions" ? getSession(id, signal) : getRun(id, signal)) : Promise.resolve(null)),
		{ pollMs: 30_000, enabled: active && Boolean(id) },
	);

	const [revealed, setRevealed] = useState<Record<string, unknown>>({});
	useEffect(() => {
		setRevealed({});
	}, [id, active]);

	const reveal = useCallback(
		async (field: string) => {
			if (!id || !active) return;
			const result = await revealObservabilityFields(kind, id, [field]);
			setRevealed(current => ({ ...current, ...(result && typeof result === "object" ? (result as Record<string, unknown>) : { [field]: result }) }));
		},
		[active, id, kind],
	);

	const columns = useMemo(
		() => [
			{
				key: "id",
				header: kind === "sessions" ? "Session" : "Run",
				render: (item: SessionSummary | RunSummary) => {
					if ("sessionId" in item) {
						return (
							<div>
								<div className="stats-font-medium stats-text-primary">{displaySessionTitle(item.title)}</div>
								<div className="stats-text-xs stats-text-muted">{item.sessionId}</div>
							</div>
						);
					}
					return (
						<div>
							<div className="stats-font-medium stats-text-primary">{item.runId}</div>
							<div className="stats-text-xs stats-text-muted">
								{item.sessionIds.length} session{item.sessionIds.length === 1 ? "" : "s"}
							</div>
						</div>
					);
				},
			},
			{
				key: "status",
				header: "Status",
				render: (item: SessionSummary | RunSummary) => (
					<StatusPill variant={statusVariant(item.status)}>{item.status}</StatusPill>
				),
			},
			{
				key: "started",
				header: "Started",
				render: (item: SessionSummary | RunSummary) => formatRelativeTime(item.startedAt),
			},
		],
		[kind],
	);

	if (id) {
		const record = detail.data as SessionDetail | RunDetail | null;
		const currentTab = tab ?? "requests";
		const outcome = normalizeObservabilityOutcome(record?.outcome);
		const resourceId = kind === "sessions" ? (record as SessionDetail | null)?.sessionId ?? id : (record as RunDetail | null)?.runId ?? id;
		const executionId =
			kind === "sessions"
				? (record as SessionDetail | null)?.executionId ?? id
				: ((record as RunDetail | null)?.executionIds.join(", ") ?? "");
		const session = kind === "sessions" ? (record as SessionDetail | null) : null;
		const title = session ? displaySessionTitle(session.title) : null;
		const related = session?.relatedExecutions ?? [];
		const relatedCounts = related.reduce<Record<string, number>>((acc, item) => {
			acc[item.kind] = (acc[item.kind] ?? 0) + 1;
			return acc;
		}, {});
		const viewHash = formatStatsHash({
			section: kind,
			id: resourceId,
			range,
			tab: currentTab,
			status: null,
			project: null,
			failure: null,
			q: null,
		});
		const lineage =
			kind === "sessions"
				? `${(record as SessionDetail | null)?.runIds.length ? `runs: ${(record as SessionDetail).runIds.join(", ")}` : "unassigned"}${
						related.length
							? ` · related: ${related.length} (${Object.entries(relatedCounts)
									.map(([kindName, count]) => `${kindName} ${count}`)
									.join(", ")})`
							: ""
					}`
				: `sessions: ${(record as RunDetail | null)?.sessionIds.join(", ") || "none"}`;
		return (
			<div className="stats-obs-detail">
				<AsyncBoundary loading={detail.loading} error={detail.error} data={record} empty={!record} emptyText="Unknown resource">
					{record && (
						<>
							<header className="stats-obs-header">
								<div>
									<h2 className="stats-page-title">{title || resourceId}</h2>
									<div className="stats-text-xs stats-text-muted">
										{resourceId}
										{kind === "sessions" && session?.folder ? ` · ${session.folder}` : ""}
										{executionId && executionId !== resourceId ? ` · execution ${executionId}` : ""}
									</div>
								</div>
								<div className="stats-obs-copies">
									<button type="button" className="stats-button stats-button-secondary" onClick={() => copyText(resourceId)}>
										Copy ID
									</button>
									<button
										type="button"
										className="stats-button stats-button-secondary"
										onClick={() => copyText(observabilityResourceUri(kind, resourceId, currentTab))}
									>
										Copy stats://
									</button>
									<button
										type="button"
										className="stats-button stats-button-secondary"
										onClick={() => copyText(viewHash)}
									>
										Copy hash
									</button>
								</div>
							</header>
							<FreshnessStrip
								truncated={record.truncated}
								indexedAt={record.indexedAt}
								indexedThrough={record.indexedThrough}
								sourceModifiedAt={record.sourceModifiedAt}
								sourceSize={record.sourceSize}
								generation={record.generation}
							/>
							<OutcomeCluster outcome={outcome} />
							<UsageStrip usage={record.usage} />
							<div className="stats-obs-lineage">{lineage}</div>
							<div className="stats-obs-tabs" role="tablist">
								{OBSERVABILITY_TABS.map(item => (
									<button
										key={item}
										type="button"
										role="tab"
										aria-selected={currentTab === item}
										className="stats-segmented-control-btn"
										data-active={currentTab === item ? "true" : "false"}
										onClick={() => onTab(item)}
									>
										{TAB_LABELS[item]}
									</button>
								))}
							</div>
							{(currentTab === "timeline" || currentTab === "behavior") && (
								<TimelinePanel
									kind={kind}
									id={id}
									active={active}
									status={record.status}
									sourceKey={`${record.generation}:${record.sourceSize}:${record.sourceModifiedAt}`}
									mode={currentTab === "behavior" ? "behavior" : "timeline"}
								/>
							)}
							{currentTab === "requests" && (
								<ResourceRequestsPanel kind={kind} id={id} active={active} onRequestClick={onRequestClick} />
							)}
							{currentTab === "failures" && (
								<ResourceRequestsPanel
									kind={kind}
									id={id}
									active={active}
									errorsOnly
									onRequestClick={onRequestClick}
								/>
							)}
							{currentTab === "tools" && <ResourceToolsPanel kind={kind} id={id} active={active} />}
							{currentTab === "tokens" && (
								<ResourceUsagePanel kind={kind} id={id} active={active} mode="tokens" />
							)}
							{currentTab === "models-routes" && (
								<ResourceUsagePanel kind={kind} id={id} active={active} mode="models" />
							)}
							{currentTab === "logs-raw" && <ResourceLogsEmpty />}
							<RevealList available={record.softAvailable} revealed={revealed} onReveal={reveal} active={active} />
						</>
					)}
				</AsyncBoundary>
			</div>
		);
	}

	const page = list.data as ObservabilityPage<SessionSummary | RunSummary> | null;
	return (
		<Panel title={kind === "sessions" ? "Sessions" : "Runs"} subtitle="Indexed local transcripts">
			<AsyncBoundary
				loading={list.loading}
				error={list.error}
				data={page}
				empty={page !== null && page.items.length === 0}
				emptyText={`No ${kind}`}
			>
				{page && (
					<DataTable
						columns={columns}
						data={page.items}
						keyExtractor={item => ("sessionId" in item ? item.sessionId : item.runId)}
						onRowClick={item => onOpen("sessionId" in item ? item.sessionId : item.runId)}
						renderMobileCard={(item, onClick) => (
							<div className="stats-mobile-card" onClick={onClick}>
								<div className="stats-font-semibold">{"sessionId" in item ? displaySessionTitle(item.title) : item.runId}</div>
								<div className="stats-text-xs stats-text-muted">{"sessionId" in item ? item.sessionId : item.status}</div>
							</div>
						)}
					/>
				)}
			</AsyncBoundary>
		</Panel>
	);
}
