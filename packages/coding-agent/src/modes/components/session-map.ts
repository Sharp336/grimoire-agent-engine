import * as fs from "node:fs";
import {
	type Component,
	Container,
	matchesKey,
	padding,
	routeSgrMouseInput,
	ScrollView,
	Spacer,
	Text,
	truncateToWidth,
	visibleWidth,
} from "@oh-my-pi/pi-tui";
import { getTranscriptDbPath } from "@oh-my-pi/pi-utils";
import { theme } from "../../modes/theme/theme";
import { matchesAppInterrupt, matchesSelectDown, matchesSelectUp } from "../../modes/utils/keybinding-matchers";
import type { SessionInfo } from "../../session/session-listing";
import { TranscriptIndex } from "../../session/transcript-index";
import { shortenPath } from "../../tools/render-utils";
import { DynamicBorder } from "./dynamic-border";

/** How a child session relates to its parent — inferred from parentSession encoding. */
export type SessionLineageKind = "fork" | "handoff";

export interface SessionMapRow {
	session: SessionInfo;
	depth: number;
	/** Fork/handoff marker for child rows; omitted for depth-0 roots (including cycle re-roots). */
	lineage: SessionLineageKind | undefined;
	tags: string[];
}

export interface SessionMapOptions {
	/** Loads sessions across all projects for the all-projects scope toggle (Tab). */
	loadAllSessions?: () => Promise<SessionInfo[]>;
	/** Preloaded all-projects list; cached so the first Tab toggle is instant. */
	allSessions?: SessionInfo[];
	/**
	 * Reads the live terminal height so the visible window fits the viewport.
	 * Omitted only in tests; defaults to a conservative 24 rows.
	 */
	getTerminalRows?: () => number;
	/**
	 * Fill the whole viewport and pin the footer (hint + bottom border) to the
	 * last rows. Set by the fullscreen overlay path.
	 */
	fillHeight?: boolean;
	/** Optional tag lookup; when omitted, tags load from TranscriptIndex if its DB exists. */
	tagsFor?: (sessionId: string) => string[];
}

/**
 * fork()/forkFrom() persist parentSession as a session id; handoff (and tree
 * branch-nav) persist a session file path. That encoding is the only SessionInfo
 * signal available without new persistence — use it for the map marker.
 */
export function sessionLineageKind(parentRef: string): SessionLineageKind {
	if (parentRef.endsWith(".jsonl") || parentRef.includes("/") || parentRef.includes("\\")) {
		return "handoff";
	}
	return "fork";
}

function sanitizeSessionName(value: string | undefined): string | undefined {
	if (!value) return undefined;
	const firstLine = value.split(/\r?\n/)[0] ?? "";
	const stripped = firstLine.replace(/[\x00-\x1F\x7F]/g, "");
	const trimmed = stripped.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Mirrors session-listing's private sessionDisplayName — that helper is not
 * exported and this slice cannot edit session-listing.ts.
 */
export function sessionDisplayName(info: SessionInfo): string {
	const title = sanitizeSessionName(info.title);
	if (title) return title;
	const first =
		info.firstMessage && info.firstMessage !== "(no messages)" ? sanitizeSessionName(info.firstMessage) : undefined;
	if (first) return first;
	const created = info.created.getTime();
	const ts = Number.isFinite(created) ? created : info.modified.getTime();
	const date = new Date(ts);
	const time = date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
	return `Untitled · ${time}`;
}

function compareSessionRecency(a: SessionInfo, b: SessionInfo): number {
	return b.modified.getTime() - a.modified.getTime();
}

function resolveParent(
	session: SessionInfo,
	byPath: Map<string, SessionInfo>,
	byId: Map<string, SessionInfo>,
): SessionInfo | undefined {
	const parentRef = session.parentSessionPath;
	if (!parentRef) return undefined;
	return byPath.get(parentRef) ?? byId.get(parentRef);
}

/** Open TranscriptIndex once when its DB exists; otherwise return no tags. */
function createTagsLookup(): (sessionId: string) => string[] {
	const dbPath = getTranscriptDbPath();
	if (!fs.existsSync(dbPath)) return () => [];
	try {
		const index = TranscriptIndex.open(dbPath);
		return (sessionId: string) => {
			try {
				return index.tagsFor(sessionId);
			} catch {
				return [];
			}
		};
	} catch {
		return () => [];
	}
}

/**
 * Build a depth-first forest from parentSessionPath edges. Roots are sessions
 * whose parent is absent or outside the listed set. Cycles are broken by
 * tracking visited paths on the current walk and emitting a repeat as a new
 * root later rather than hanging.
 */
export function buildSessionMapRows(
	sessions: SessionInfo[],
	tagsFor: (sessionId: string) => string[] = createTagsLookup(),
): SessionMapRow[] {
	const byPath = new Map<string, SessionInfo>();
	const byId = new Map<string, SessionInfo>();
	for (const session of sessions) {
		byPath.set(session.path, session);
		byId.set(session.id, session);
	}

	const childrenOf = new Map<string, SessionInfo[]>();
	const roots: SessionInfo[] = [];

	for (const session of sessions) {
		const parent = resolveParent(session, byPath, byId);
		if (!parent) {
			roots.push(session);
			continue;
		}
		const list = childrenOf.get(parent.path);
		if (list) list.push(session);
		else childrenOf.set(parent.path, [session]);
	}

	for (const children of childrenOf.values()) {
		children.sort(compareSessionRecency);
	}
	roots.sort(compareSessionRecency);

	const rows: SessionMapRow[] = [];
	const emitted = new Set<string>();

	const walk = (session: SessionInfo, depth: number, ancestry: Set<string>): void => {
		if (ancestry.has(session.path)) {
			return;
		}
		if (emitted.has(session.path)) return;
		emitted.add(session.path);

		const parentRef = session.parentSessionPath;
		// Depth-0 rows (natural roots and cycle re-roots) omit the marker so the
		// forest reads cleanly; children keep fork vs handoff.
		rows.push({
			session,
			depth,
			lineage: depth > 0 && parentRef ? sessionLineageKind(parentRef) : undefined,
			tags: tagsFor(session.id),
		});

		const nextAncestry = new Set(ancestry);
		nextAncestry.add(session.path);
		const children = childrenOf.get(session.path) ?? [];
		for (const child of children) {
			walk(child, depth + 1, nextAncestry);
		}
	};

	for (const root of roots) {
		walk(root, 0, new Set());
	}

	// Cycle-only components: no natural root, so promote each unemitted node.
	const remaining = sessions.filter(session => !emitted.has(session.path)).sort(compareSessionRecency);
	for (const session of remaining) {
		if (emitted.has(session.path)) continue;
		walk(session, 0, new Set());
	}

	return rows;
}

function formatLineageMarker(kind: SessionLineageKind | undefined, styled: boolean): string {
	if (kind === undefined) return "";
	switch (kind) {
		case "fork":
			return styled ? `${theme.icon.branch} fork` : "fork";
		case "handoff":
			return styled ? `${theme.icon.context} handoff` : "handoff";
		default: {
			const _exhaustive: never = kind;
			return _exhaustive;
		}
	}
}

function formatTags(tags: string[]): string {
	if (tags.length === 0) return "";
	return tags.map(tag => `#${tag}`).join(" ");
}

function formatMapRowPlain(row: SessionMapRow): string {
	// Plain ASCII — ACP/RPC may call this before TUI theme init.
	const indent = "  ".repeat(row.depth);
	const connector = row.depth > 0 ? "|- " : "";
	const name = sessionDisplayName(row.session);
	const parts = [`${indent}${connector}${name}`];
	const marker = formatLineageMarker(row.lineage, false);
	if (marker) parts.push(marker);
	const tags = formatTags(row.tags);
	if (tags) parts.push(tags);
	return parts.join("  ");
}

/**
 * Plain-text session forest for non-TUI `/session map` handlers (ACP/RPC).
 * Same forest rules as the interactive panel.
 */
export function renderSessionMapText(sessions: SessionInfo[], tagsFor?: (sessionId: string) => string[]): string {
	const rows = buildSessionMapRows(sessions, tagsFor ?? createTagsLookup());
	if (rows.length === 0) return "No sessions.";
	return rows.map(formatMapRowPlain).join("\n");
}

class SessionMapList implements Component {
	#rows: SessionMapRow[] = [];
	#selectedIndex = 0;
	#hitRows: (number | undefined)[] = [];
	#showCwd = false;
	readonly #getTerminalRows: () => number;
	readonly #tagsFor: (sessionId: string) => string[];

	onSelect?: (session: SessionInfo) => void;
	onCancel?: () => void;
	onExit: () => void = () => {};
	onToggleScope?: () => void;

	constructor(
		sessions: SessionInfo[],
		showCwd = false,
		getTerminalRows: () => number = () => 24,
		tagsFor: (sessionId: string) => string[] = createTagsLookup(),
	) {
		this.#getTerminalRows = getTerminalRows;
		this.#tagsFor = tagsFor;
		this.#showCwd = showCwd;
		this.#rows = buildSessionMapRows(sessions, tagsFor);
	}

	#visibleCount(): number {
		const CHROME = 12;
		const PER_ROW = 2;
		const RESERVE = 1;
		const budget = this.#getTerminalRows() - CHROME - RESERVE;
		return Math.max(2, Math.floor(budget / PER_ROW));
	}

	setSessions(sessions: SessionInfo[], showCwd: boolean): void {
		this.#showCwd = showCwd;
		this.#rows = buildSessionMapRows(sessions, this.#tagsFor);
		this.#selectedIndex = Math.min(this.#selectedIndex, Math.max(0, this.#rows.length - 1));
	}

	hitTestSession(line: number): number | undefined {
		return this.#hitRows[line];
	}

	handleWheel(delta: -1 | 1): void {
		if (this.#rows.length === 0) return;
		this.#selectedIndex = Math.max(0, Math.min(this.#rows.length - 1, this.#selectedIndex + delta));
	}

	selectAndConfirm(index: number): void {
		const row = this.#rows[index];
		if (!row) return;
		this.#selectedIndex = index;
		this.onSelect?.(row.session);
	}

	invalidate(): void {}

	render(width: number): readonly string[] {
		const lines: string[] = [];
		this.#hitRows = [];

		if (this.#rows.length === 0) {
			if (this.#showCwd) {
				lines.push(truncateToWidth(theme.fg("muted", "  No sessions found"), width));
			} else {
				lines.push(
					truncateToWidth(theme.fg("muted", "  No sessions in current folder. Press Tab to view all."), width),
				);
			}
			return lines;
		}

		const maxVisible = this.#visibleCount();
		const startIndex = Math.max(
			0,
			Math.min(this.#selectedIndex - Math.floor(maxVisible / 2), this.#rows.length - maxVisible),
		);
		const endIndex = Math.min(startIndex + maxVisible, this.#rows.length);

		const sessionLines: string[] = [];
		const sessionRowIndex: number[] = [];
		const overflow = this.#rows.length > maxVisible;
		const rowWidth = Math.max(0, width - (overflow ? 1 : 0));

		for (let i = startIndex; i < endIndex; i++) {
			const blockStart = sessionLines.length;
			const row = this.#rows[i]!;
			const isSelected = i === this.#selectedIndex;
			const cursorSymbol = `${theme.nav.cursor} `;
			const cursorWidth = visibleWidth(cursorSymbol);
			const cursor = isSelected ? theme.fg("accent", cursorSymbol) : padding(cursorWidth);
			const maxWidth = rowWidth - cursorWidth;

			const indent = "  ".repeat(row.depth);
			const connector = row.depth > 0 ? `${theme.tree.branch} ` : "";
			const name = sessionDisplayName(row.session);
			const title = truncateToWidth(`${indent}${connector}${name}`, maxWidth);
			sessionLines.push(cursor + (isSelected ? theme.bold(title) : title));

			const dim = (s: string) => theme.fg("dim", s);
			const dot = dim(theme.sep.dot);
			const metaParts: string[] = [];
			const marker = formatLineageMarker(row.lineage, true);
			if (marker) metaParts.push(dim(marker));
			const tags = formatTags(row.tags);
			if (tags) metaParts.push(theme.fg("accent", tags));
			if (this.#showCwd && row.session.cwd) {
				metaParts.push(dim(shortenPath(row.session.cwd)));
			}
			if (metaParts.length > 0) {
				const meta = truncateToWidth(`  ${metaParts.join(` ${dot} `)}`, rowWidth);
				sessionLines.push(meta);
			}
			sessionLines.push("");
			for (let k = blockStart; k < sessionLines.length; k++) sessionRowIndex[k] = i;
		}

		const visibleCount = endIndex - startIndex;
		const linesPerItem = visibleCount > 0 ? sessionLines.length / visibleCount : 1;
		const sv = new ScrollView(sessionLines, {
			height: sessionLines.length,
			scrollbar: "auto",
			totalRows: Math.round(this.#rows.length * linesPerItem),
			theme: { track: t => theme.fg("muted", t), thumb: t => theme.fg("accent", t) },
		});
		sv.setScrollOffset(Math.round(startIndex * linesPerItem));
		const sessionRegionStart = lines.length;
		const svLines = sv.render(width);
		for (let k = 0; k < svLines.length; k++) this.#hitRows[sessionRegionStart + k] = sessionRowIndex[k];
		lines.push(...svLines);
		return lines;
	}

	handleInput(keyData: string): void {
		if (matchesSelectUp(keyData)) {
			this.#selectedIndex = Math.max(0, this.#selectedIndex - 1);
			return;
		}
		if (matchesSelectDown(keyData)) {
			this.#selectedIndex = Math.min(this.#rows.length - 1, this.#selectedIndex + 1);
			return;
		}
		if (matchesKey(keyData, "pageUp")) {
			this.#selectedIndex = Math.max(0, this.#selectedIndex - this.#visibleCount());
			return;
		}
		if (matchesKey(keyData, "pageDown")) {
			this.#selectedIndex = Math.min(this.#rows.length - 1, this.#selectedIndex + this.#visibleCount());
			return;
		}
		if (matchesKey(keyData, "enter") || matchesKey(keyData, "return") || keyData === "\n") {
			const row = this.#rows[this.#selectedIndex];
			if (row && this.onSelect) this.onSelect(row.session);
			return;
		}
		if (matchesAppInterrupt(keyData)) {
			this.onCancel?.();
			return;
		}
		if (matchesKey(keyData, "ctrl+c")) {
			this.onExit();
			return;
		}
		if (matchesKey(keyData, "tab")) {
			this.onToggleScope?.();
		}
	}
}

/**
 * Interactive session lineage map — same constructor/overlay conventions as
 * {@link SessionSelectorComponent}, with Tab project/all scope toggle.
 */
export class SessionMapComponent extends Container {
	#mapList: SessionMapList;
	#headerText: Text;
	#messageContainer: Container;
	#onRequestRender?: () => void;
	readonly #loadAllSessions?: () => Promise<SessionInfo[]>;
	#folderSessions: SessionInfo[];
	#globalSessions: SessionInfo[] | null = null;
	#scope: "folder" | "all" = "folder";
	#toggling = false;
	#inputLocked = false;
	#listLineOffset = 0;
	#footerStart = 0;
	readonly #getTerminalRows: () => number;
	readonly #fillHeight: boolean;
	readonly #bottomBorder = new DynamicBorder();

	constructor(
		sessions: SessionInfo[],
		onSelect: (session: SessionInfo) => void,
		onCancel: () => void,
		onExit: () => void,
		options: SessionMapOptions = {},
	) {
		super();

		this.#messageContainer = new Container();
		this.#loadAllSessions = options.loadAllSessions;
		this.#folderSessions = sessions;
		this.#globalSessions = options.allSessions ?? null;
		this.#getTerminalRows = options.getTerminalRows ?? (() => 24);
		this.#fillHeight = options.fillHeight ?? false;
		const tagsFor = options.tagsFor ?? createTagsLookup();

		this.addChild(new Spacer(1));
		this.#headerText = new Text(this.#headerLabel(), 1, 0);
		this.addChild(this.#headerText);
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));
		this.addChild(this.#messageContainer);

		this.#mapList = new SessionMapList(sessions, false, options.getTerminalRows, tagsFor);
		this.#mapList.onSelect = session => {
			onSelect(session);
		};
		this.#mapList.onCancel = () => {
			onCancel();
		};
		this.#mapList.onExit = () => {
			onExit();
		};
		if (this.#loadAllSessions || this.#globalSessions) {
			this.#mapList.onToggleScope = () => {
				void this.#toggleScope();
			};
		}
		this.addChild(this.#mapList);
	}

	#headerLabel(): string {
		const scopeLabel = this.#scope === "all" ? "all projects" : "current folder";
		return `${theme.bold("Session Map")} ${theme.fg("muted", `(${scopeLabel})`)}`;
	}

	async #toggleScope(): Promise<void> {
		if (this.#toggling) return;
		if (this.#scope === "folder") {
			let global = this.#globalSessions;
			if (!global) {
				if (!this.#loadAllSessions) return;
				this.#toggling = true;
				this.#messageContainer.clear();
				this.#messageContainer.addChild(new Text(theme.fg("muted", "  Loading all projects…"), 1, 0));
				this.#onRequestRender?.();
				try {
					global = await this.#loadAllSessions();
				} catch (err) {
					this.#messageContainer.clear();
					this.#messageContainer.addChild(
						new Text(theme.fg("error", `Error: ${err instanceof Error ? err.message : String(err)}`), 1, 0),
					);
					this.#toggling = false;
					this.#onRequestRender?.();
					return;
				}
				this.#globalSessions = global;
				this.#messageContainer.clear();
				this.#toggling = false;
			}
			this.#scope = "all";
			this.#mapList.setSessions(global, true);
		} else {
			this.#scope = "folder";
			this.#mapList.setSessions(this.#folderSessions, false);
		}
		this.#headerText.setText(this.#headerLabel());
		this.#onRequestRender?.();
	}

	setOnRequestRender(callback: () => void): void {
		this.#onRequestRender = callback;
	}

	lockInput(): void {
		this.#inputLocked = true;
	}

	unlockInput(): void {
		this.#inputLocked = false;
	}

	render(width: number): readonly string[] {
		const lines: string[] = [];
		for (const child of this.children) {
			const childLines = child.render(width);
			if (child === this.#mapList) this.#listLineOffset = lines.length;
			for (const line of childLines) lines.push(line);
		}
		const footer = this.#footerLines(width);
		if (this.#fillHeight) {
			const target = Math.max(0, this.#getTerminalRows() - footer.length);
			if (lines.length > target) lines.length = target;
			else for (let i = lines.length; i < target; i++) lines.push("");
		}
		this.#footerStart = lines.length;
		for (const line of footer) lines.push(line);
		return lines;
	}

	#footerLines(width: number): string[] {
		const scopeHint = this.#scope === "all" ? "current folder" : "all projects";
		const hint = theme.fg("muted", `  [Enter select · Tab ${scopeHint} · Esc cancel]`);
		return ["", hint, "", ...this.#bottomBorder.render(width)];
	}

	handleInput(keyData: string): void {
		if (this.#inputLocked) return;
		if (keyData.startsWith("\x1b[<")) {
			this.#handleMouse(keyData);
			return;
		}
		this.#mapList.handleInput(keyData);
	}

	#handleMouse(data: string): void {
		routeSgrMouseInput(data, event => {
			if (event.wheel !== null) {
				this.#mapList.handleWheel(event.wheel);
				return true;
			}
			if (!event.leftClick || event.row >= this.#footerStart) return true;
			const index = this.#mapList.hitTestSession(event.row - this.#listLineOffset);
			if (index !== undefined) this.#mapList.selectAndConfirm(index);
			return true;
		});
	}
}
