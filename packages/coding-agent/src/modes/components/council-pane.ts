import * as path from "node:path";
import {
	type Component,
	Container,
	matchesKey,
	type NativeScrollbackLiveRegion,
	ScrollView,
	visibleWidth,
} from "@oh-my-pi/pi-tui";
import { formatNumber, sanitizeText } from "@oh-my-pi/pi-utils";
import { formatDuration } from "../../slash-commands/helpers/format";
import {
	formatBadge,
	formatStatusIcon,
	PREVIEW_LIMITS,
	previewLine,
	replaceTabs,
	shortenEmbeddedPaths,
	shortenPath,
	TRUNCATE_LENGTHS,
	truncateToWidth,
} from "../../tools/render-utils";
import { theme } from "../theme/theme";
import { formatCost } from "./agent-hub-renderer";

/** Shared compact-HUD row ceiling used by subagents and Council. */
export const SUBAGENT_HUD_VISIBLE_LIMIT = 8;

/** Rows retained for transcript/status chrome after the editor and Council pane. */
const COUNCIL_TRANSCRIPT_RESERVED_ROWS = 4;
const COUNCIL_REVIEWER_CONFINEMENT = "read-only/root: prompt contract";
const COUNCIL_REVIEWER_CONFINEMENT_COMPACT = "read-only/root: prompt";
const COUNCIL_FULL_CONFINEMENT_MIN_WIDTH = 120;

export type CouncilPaneRowStatus = "queued" | "running" | "retry" | "succeeded" | "failed" | "interrupted";

export interface CouncilPaneRowSnapshot {
	key: string;
	label: string;
	model: string;
	effort: string | null;
	status: CouncilPaneRowStatus;
	attempts: number;
	lastIntent?: string;
	currentTool?: string;
	currentToolArgs?: string;
	recentOutput?: readonly string[];
	requests?: number;
	tokens?: number;
	cost?: number;
	error?: string;
}

export interface CouncilPaneUsageSnapshot {
	requests?: number;
	tokens?: number;
	cost?: number;
}

/** Immutable, renderer-focused projection of a coordinator snapshot. */
export interface CouncilPaneSnapshot {
	runId: string;
	state: string;
	round: number;
	totalRounds: number;
	startedAt?: string;
	outputPath: string;
	degraded: boolean;
	warnings?: readonly string[];
	failure?: string;
	usage?: CouncilPaneUsageSnapshot;
	rows: readonly CouncilPaneRowSnapshot[];
	terminal: boolean;
}

interface CouncilPaneRenderHost {
	requestRender(): void;
	requestComponentRender(component: Component): void;
}

export interface CouncilPaneOptions {
	tui: CouncilPaneRenderHost;
	getTerminalRows?: () => number;
	getEditorMaxHeight?: () => number;
	now?: () => number;
}

/**
 * Anchored live-region container for mutable rows between transcript and editor.
 * Subclasses may opt into pinning when their mutable suffix must remain wholly
 * viewport-local instead of entering native terminal history.
 */
export class AnchoredLiveContainer extends Container implements NativeScrollbackLiveRegion {
	getNativeScrollbackLiveRegionStart(): number | undefined {
		return this.children.length > 0 ? 0 : undefined;
	}

	isNativeScrollbackLiveRegionPinned(): boolean {
		return false;
	}

	/** Compatibility spelling retained for callers using the scrollable-region name. */
	isNativeScrollableLiveRegionPinned(): boolean {
		return this.isNativeScrollbackLiveRegionPinned();
	}
}

interface RenderedCouncilRow {
	primary: string;
	details: string[];
	finished: boolean;
}

function statusColor(status: CouncilPaneRowStatus): "muted" | "accent" | "warning" | "success" | "error" {
	switch (status) {
		case "queued":
			return "muted";
		case "running":
			return "accent";
		case "retry":
			return "warning";
		case "succeeded":
			return "success";
		case "failed":
		case "interrupted":
			return "error";
	}
}

function statusIcon(status: CouncilPaneRowStatus): string {
	switch (status) {
		case "queued":
			return formatStatusIcon("pending", theme);
		case "running":
			return formatStatusIcon("running", theme);
		case "retry":
			return formatStatusIcon("warning", theme);
		case "succeeded":
			return formatStatusIcon("success", theme);
		case "failed":
			return formatStatusIcon("error", theme);
		case "interrupted":
			return formatStatusIcon("aborted", theme);
	}
}

function sanitizedLine(value: unknown, width: number): string {
	const text = typeof value === "string" ? value : value === undefined || value === null ? "" : String(value);
	return previewLine(shortenEmbeddedPaths(replaceTabs(sanitizeText(text))), Math.max(1, width));
}

function attemptLabel(attempts: number): string {
	const count = Number.isFinite(attempts) ? Math.max(0, Math.trunc(attempts)) : 0;
	return `${count} ${count === 1 ? "attempt" : "attempts"}`;
}

function metricSegments(row: CouncilPaneRowSnapshot): string[] {
	const parts: string[] = [];
	if (row.requests !== undefined) parts.push(`${formatNumber(Math.max(0, row.requests))} req`);
	if (row.tokens !== undefined) parts.push(`${formatNumber(Math.max(0, row.tokens))} tok`);
	if (row.cost !== undefined) parts.push(formatCost(row.cost));
	return parts;
}

function headerStatusColor(state: string, degraded: boolean): "accent" | "warning" | "success" | "error" {
	if (state === "failed" || state === "interrupted") return "error";
	if (state === "cancelling" || degraded || state === "completed-degraded") return "warning";
	if (state === "completed") return "success";
	return "accent";
}

/**
 * Fixed-position, bounded Council run HUD. It never owns transcript children;
 * terminal snapshots therefore collapse to a truly blank footprint.
 */
export class CouncilPaneComponent extends AnchoredLiveContainer {
	readonly #tui: CouncilPaneRenderHost;
	readonly #getTerminalRows: () => number;
	readonly #getEditorMaxHeight: () => number;
	readonly #now: () => number;
	#snapshot: CouncilPaneSnapshot | undefined;
	#expanded = false;
	#nowMs: number;
	#topologyKey = "inactive";
	#scrollView: ScrollView | undefined;

	constructor(options: CouncilPaneOptions) {
		super();
		this.#tui = options.tui;
		this.#getTerminalRows = options.getTerminalRows ?? (() => process.stdout.rows ?? 24);
		this.#getEditorMaxHeight = options.getEditorMaxHeight ?? (() => 6);
		this.#now = options.now ?? Date.now;
		this.#nowMs = this.#now();
	}

	get snapshot(): CouncilPaneSnapshot | undefined {
		return this.#snapshot;
	}

	isExpanded(): boolean {
		return this.#expanded;
	}

	isActive(): boolean {
		return this.#snapshot !== undefined && !this.#snapshot.terminal;
	}

	override getNativeScrollbackLiveRegionStart(): number | undefined {
		return this.isActive() ? 0 : undefined;
	}

	override isNativeScrollbackLiveRegionPinned(): boolean {
		return this.isActive();
	}

	override isNativeScrollableLiveRegionPinned(): boolean {
		return this.isActive();
	}

	update(snapshot: CouncilPaneSnapshot | undefined): void {
		const previousActive = this.isActive();
		const next = snapshot && !snapshot.terminal ? snapshot : undefined;
		const nextTopology = next ? this.#snapshotTopology(next) : "inactive";
		if (this.#snapshot === next && this.#topologyKey === nextTopology) return;
		this.#snapshot = next;
		this.#nowMs = this.#now();
		const nextActive = this.isActive();
		const topologyChanged = this.#topologyKey !== nextTopology;
		this.#topologyKey = nextTopology;
		if (previousActive !== nextActive || topologyChanged) {
			this.#tui.requestRender();
		} else if (nextActive) {
			this.#tui.requestComponentRender(this);
		}
	}

	/** Elapsed-time repaint that deliberately preserves root geometry. */
	tick(now = this.#now()): void {
		if (!this.isActive()) return;
		this.#nowMs = now;
		this.#tui.requestComponentRender(this);
	}

	setExpanded(expanded: boolean): void {
		if (this.#expanded === expanded) return;
		this.#expanded = expanded;
		if (this.#snapshot) this.#topologyKey = this.#snapshotTopology(this.#snapshot);
		this.#scrollView = undefined;
		if (this.isActive()) this.#tui.requestRender();
	}

	toggleExpanded(): boolean {
		this.setExpanded(!this.#expanded);
		return this.#expanded;
	}

	/** Page keys are Council-owned only while its expanded viewport is visible. */
	handleInput(data: string): boolean {
		if (!this.isActive() || !this.#expanded || !this.#scrollView) return false;
		if (!matchesKey(data, "pageUp") && !matchesKey(data, "pageDown")) return false;
		if (!this.#scrollView.handleScrollKey(data)) return false;
		this.#tui.requestComponentRender(this);
		return true;
	}

	override render(width: number): readonly string[] {
		const snapshot = this.#snapshot;
		if (!snapshot || snapshot.terminal) return [];
		const safeWidth = Math.max(1, Math.trunc(width));
		const rows = snapshot.rows.map((row, index) =>
			this.#renderRow(row, index === snapshot.rows.length - 1, safeWidth),
		);
		const bodyLimit = this.#bodyHeight(rows);
		const body = this.#expanded
			? this.#renderExpandedBody(rows, bodyLimit, safeWidth)
			: this.#renderCompactBody(rows, bodyLimit, safeWidth);
		return [this.#renderHeader(snapshot, safeWidth), ...body];
	}

	#renderHeader(snapshot: CouncilPaneSnapshot, width: number): string {
		const state = sanitizedLine(snapshot.state, TRUNCATE_LENGTHS.TITLE) || "unknown";
		const stateBadge = formatBadge(state, headerStatusColor(state, snapshot.degraded), theme);
		const leading = [
			theme.bold(theme.fg("accent", "Council")),
			stateBadge,
			theme.fg(
				"dim",
				width >= COUNCIL_FULL_CONFINEMENT_MIN_WIDTH
					? COUNCIL_REVIEWER_CONFINEMENT
					: COUNCIL_REVIEWER_CONFINEMENT_COMPACT,
			),
			theme.fg("dim", `round ${Math.max(0, snapshot.round)}/${Math.max(1, snapshot.totalRounds)}`),
		];
		if (snapshot.startedAt) {
			const startedAt = Date.parse(snapshot.startedAt);
			if (Number.isFinite(startedAt)) leading.push(theme.fg("dim", formatDuration(this.#nowMs - startedAt)));
		}
		const trailing: string[] = [];
		const warnings = snapshot.warnings ?? [];
		if (snapshot.degraded || warnings.length > 0) {
			const markers = [snapshot.degraded ? "degraded" : "", warnings.length > 0 ? `${warnings.length}w` : ""].filter(
				Boolean,
			);
			trailing.push(theme.fg("warning", `${theme.icon.warning} ${markers.join("+")}`));
		}
		if (snapshot.usage) {
			const usage: string[] = [];
			if (snapshot.usage.requests !== undefined)
				usage.push(`${formatNumber(Math.max(0, snapshot.usage.requests))} req`);
			if (snapshot.usage.tokens !== undefined) usage.push(`${formatNumber(Math.max(0, snapshot.usage.tokens))} tok`);
			if (snapshot.usage.cost !== undefined) usage.push(formatCost(snapshot.usage.cost));
			if (usage.length > 0) trailing.push(theme.fg("dim", usage.join("/")));
		}
		const fixed = [...leading, ...trailing];
		const separatorWidth = visibleWidth(theme.sep.dot);
		const pathWidth = Math.max(
			0,
			width - fixed.reduce((total, segment) => total + visibleWidth(segment), 0) - fixed.length * separatorWidth,
		);
		const shortenedOutput = shortenPath(sanitizeText(snapshot.outputPath));
		const displayOutput =
			visibleWidth(shortenedOutput) > pathWidth ? path.basename(shortenedOutput) : shortenedOutput;
		const output = sanitizedLine(displayOutput, Math.max(1, pathWidth));
		const segments = pathWidth > 0 && output ? [...leading, theme.fg("statusLinePath", output), ...trailing] : fixed;
		return truncateToWidth(segments.join(theme.sep.dot), width);
	}

	#renderRow(row: CouncilPaneRowSnapshot, last: boolean, width: number): RenderedCouncilRow {
		const contentWidth = Math.max(1, width - 3);
		const label =
			sanitizedLine(row.label, Math.min(TRUNCATE_LENGTHS.TITLE, Math.max(4, Math.floor(contentWidth / 5)))) ||
			"member";
		const model =
			sanitizedLine(row.model, Math.min(TRUNCATE_LENGTHS.SHORT, Math.max(8, Math.floor(contentWidth / 3)))) ||
			"unknown model";
		const effort =
			sanitizedLine(
				row.effort ?? "default",
				Math.min(TRUNCATE_LENGTHS.TITLE, Math.max(4, Math.floor(contentWidth / 10))),
			) || "default";
		const status = formatBadge(row.status, statusColor(row.status), theme);
		const primarySegments = [
			`${statusIcon(row.status)} ${theme.bold(theme.fg("accent", label))}`,
			status,
			formatBadge(model, "muted", theme),
			formatBadge(effort, "muted", theme),
		];
		if (row.error)
			primarySegments.push(theme.fg("error", `error: ${sanitizedLine(row.error, TRUNCATE_LENGTHS.SHORT)}`));
		primarySegments.push(
			theme.fg("dim", attemptLabel(row.attempts)),
			...metricSegments(row).map(part => theme.fg("dim", part)),
		);
		const connector = last ? "└" : "├";
		const primary = truncateToWidth(` ${theme.fg("dim", connector)} ${primarySegments.join(theme.sep.dot)}`, width);

		const details: string[] = [];
		const detailPrefix = ` ${theme.fg("dim", last ? " " : "│")}  `;
		if (row.error) {
			const error = sanitizedLine(row.error, Math.min(TRUNCATE_LENGTHS.CONTENT, contentWidth));
			details.push(truncateToWidth(`${detailPrefix}${theme.fg("error", `error: ${error}`)}`, width));
		}
		if (row.currentTool) {
			const tool = row.currentTool;
			const args = row.currentToolArgs;
			let detail = `tool ${sanitizedLine(tool, TRUNCATE_LENGTHS.SHORT)}`;
			if (args !== undefined) detail += ` ${sanitizedLine(args, Math.min(TRUNCATE_LENGTHS.CONTENT, contentWidth))}`;
			details.push(truncateToWidth(`${detailPrefix}${theme.fg("toolOutput", detail)}`, width));
		}
		if (row.lastIntent) {
			const intent = sanitizedLine(row.lastIntent, Math.min(TRUNCATE_LENGTHS.CONTENT, contentWidth));
			if (intent) details.push(truncateToWidth(`${detailPrefix}${theme.fg("muted", intent)}`, width));
		}
		const outputLimit = this.#expanded ? PREVIEW_LIMITS.OUTPUT_EXPANDED : PREVIEW_LIMITS.OUTPUT_COLLAPSED;
		for (const output of (row.recentOutput ?? []).slice(-outputLimit)) {
			const line = sanitizedLine(output, Math.min(TRUNCATE_LENGTHS.LINE, contentWidth));
			if (line) details.push(truncateToWidth(`${detailPrefix}${theme.fg("toolOutput", line)}`, width));
		}
		return {
			primary,
			details,
			finished: row.status === "succeeded" || row.status === "failed" || row.status === "interrupted",
		};
	}

	#renderCompactBody(rows: readonly RenderedCouncilRow[], height: number, width: number): string[] {
		if (height <= 0) return [];
		if (rows.length >= height) {
			if (rows.length === height) return rows.map(row => row.primary);
			const visible = rows.slice(0, Math.max(0, height - 1)).map(row => row.primary);
			visible.push(
				theme.fg(
					"dim",
					truncateToWidth(` … ${rows.length - visible.length} more Council rows · Ctrl+O expand`, width),
				),
			);
			return visible;
		}
		let remaining = height - rows.length;
		const selected = new Map<RenderedCouncilRow, string[]>();
		const detailOrder = [...rows.filter(row => !row.finished), ...rows.filter(row => row.finished)];
		for (const row of detailOrder) {
			for (const detail of row.details) {
				if (remaining <= 0) break;
				const rowDetails = selected.get(row);
				if (rowDetails) rowDetails.push(detail);
				else selected.set(row, [detail]);
				remaining--;
			}
			if (remaining <= 0) break;
		}
		return rows.flatMap(row => [row.primary, ...(selected.get(row) ?? [])]);
	}

	#renderExpandedBody(rows: readonly RenderedCouncilRow[], height: number, width: number): readonly string[] {
		if (height <= 0) return [];
		const lines = rows.flatMap(row => [row.primary, ...row.details]);
		if (!this.#scrollView) {
			this.#scrollView = new ScrollView(lines, {
				height,
				scrollbar: "auto",
				theme: {
					track: text => theme.fg("borderMuted", text),
					thumb: text => theme.fg("accent", text),
				},
			});
		} else {
			this.#scrollView.setLines(lines);
			this.#scrollView.setHeight(height);
		}
		return this.#scrollView.render(width);
	}

	#bodyHeight(rows: readonly RenderedCouncilRow[]): number {
		const rawTerminalRows = this.#getTerminalRows();
		const terminalRows = Number.isFinite(rawTerminalRows) ? Math.max(1, Math.trunc(rawTerminalRows)) : 24;
		const rawEditorMaxHeight = this.#getEditorMaxHeight();
		const editorMaxHeight = Number.isFinite(rawEditorMaxHeight) ? Math.max(1, Math.trunc(rawEditorMaxHeight)) : 6;
		const logicalRows = rows.reduce((count, row) => count + 1 + (this.#expanded ? row.details.length : 0), 0);
		const terminalRoom = Math.max(0, terminalRows - editorMaxHeight - COUNCIL_TRANSCRIPT_RESERVED_ROWS - 1);
		const modeLimit = Math.min(SUBAGENT_HUD_VISIBLE_LIMIT, editorMaxHeight);
		return Math.min(logicalRows, terminalRoom, modeLimit);
	}

	#snapshotTopology(snapshot: CouncilPaneSnapshot): string {
		return [
			this.#expanded ? "expanded" : "compact",
			...snapshot.rows.map(row =>
				[
					row.key,
					row.currentTool === undefined ? 0 : 1,
					row.lastIntent === undefined ? 0 : 1,
					row.error === undefined ? 0 : 1,
					row.recentOutput?.length ?? 0,
				].join(":"),
			),
		].join("|");
	}
}
