/**
 * Session observer overlay component.
 *
 * Picker mode: lists main + active subagent sessions with live status.
 * Viewer mode: renders a scrollable, interactive transcript of the selected subagent's session
 *   by reading its JSONL session file — shows thinking, text, tool calls, results
 *   with expand/collapse per entry and breadcrumb navigation for nested sub-agents.
 */
import { Container, matchesKey, ScrollView } from "@oh-my-pi/pi-tui";
import { formatDuration, formatNumber, sanitizeText } from "@oh-my-pi/pi-utils";
import type { KeyId } from "../../config/keybindings";
import { getFileSnapshotStore } from "../../edit/file-snapshot-store";
import { AgentRegistry, MAIN_AGENT_ID } from "../../registry/agent-registry";
import { TRUNCATE_LENGTHS } from "../../tools/render-utils";
import { TranscriptRenderer, type TranscriptRendererDeps } from "../controllers/transcript-renderer";
import type { ObservableSession, SessionObserverRegistry } from "../session-observer-registry";
import { theme } from "../theme/theme";
import type { TranscriptSource } from "../transcript-source";
import { HybridSource, LiveSource, ReplaySource } from "../transcript-source";
import { matchesSelectDown, matchesSelectUp } from "../utils/keybinding-matchers";
import { DynamicBorder } from "./dynamic-border";
import { formatContextUsage } from "./status-line/context-thresholds";

const PAGE_SIZE = 15;
const INDENT = "    ";

function contentWidth(indent = INDENT): number {
	return Math.max(TRUNCATE_LENGTHS.SHORT, (process.stdout.columns || 80) - indent.length - 2);
}

export class SessionObserverOverlayComponent extends Container {
	#registry: SessionObserverRegistry;
	#onDone: () => void;
	#selectedSessionId?: string;
	#observeKeys: KeyId[];
	#requestRender: () => void;

	// Scroll state
	#scrollOffset = 0;
	#renderedLines: string[] = [];
	#viewportHeight = 20;
	#wasAtBottom = true;

	// Breadcrumb navigation
	#onBack?: () => void;

	// Cached header/footer for viewer (rebuilt on refresh)
	#viewerHeaderLines: string[] = [];
	#viewerFooterLines: string[] = [];

	#renderer?: TranscriptRenderer;
	#source?: TranscriptSource;
	#sourceUnsub?: () => void;
	#followLive = true;
	#liveSession = false;
	#rendererDeps: Partial<TranscriptRendererDeps>;

	constructor(
		registry: SessionObserverRegistry,
		onDone: () => void,
		observeKeys: KeyId[],
		requestRender: () => void = () => {},
		options?: { initialSessionId?: string; onBack?: () => void; rendererDeps?: Partial<TranscriptRendererDeps> },
	) {
		super();
		this.#registry = registry;
		this.#onDone = onDone;
		this.#observeKeys = observeKeys;
		this.#requestRender = requestRender;
		this.#onBack = options?.onBack;
		this.#rendererDeps = options?.rendererDeps ?? {};

		const sessions = this.#registry.getSessions();
		let targetSession: ObservableSession | undefined;
		if (options?.initialSessionId) {
			targetSession = sessions.find(s => s.id === options.initialSessionId);
		}
		if (!targetSession) {
			targetSession = this.#getMostRecentSubagent();
		}

		if (targetSession) {
			this.#selectedSessionId = targetSession.id;
			this.#setupViewer();
		} else {
			// No sub-agents — close immediately
			queueMicrotask(() => this.#onDone());
		}
	}

	/** Find the most recently updated sub-agent session (prefer active ones) */
	#getMostRecentSubagent(): ObservableSession | undefined {
		const sessions = this.#registry.getSessions().filter(s => s.kind === "subagent");
		if (sessions.length === 0) return undefined;
		// Prefer active sessions, then sort by lastUpdate descending
		const active = sessions.filter(s => s.status === "active");
		const pool = active.length > 0 ? active : sessions;
		return pool.sort((a, b) => b.lastUpdate - a.lastUpdate)[0];
	}

	override render(width: number): string[] {
		return this.#renderViewer(width);
	}

	#disposeAll(): void {
		this.#sourceUnsub?.();
		this.#sourceUnsub = undefined;
		this.#source?.dispose();
		this.#source = undefined;
		this.#renderer?.dispose();
		this.#renderer = undefined;
	}

	#setupViewer(): void {
		this.#disposeAll();
		this.#scrollOffset = 0;
		this.#wasAtBottom = true;
		this.#liveSession = false;

		const sessions = this.#registry.getSessions();
		const session = sessions.find(s => s.id === this.#selectedSessionId);
		if (session) {
			this.#followLive = session.status === "active";
			const id = session.id;
			const sessionFile = session.sessionFile;
			const eventBus = this.#registry.getEventBus();

			if (session.status === "active") {
				if (sessionFile && eventBus) {
					this.#source = new HybridSource(sessionFile, eventBus, id, session);
				} else if (eventBus) {
					this.#source = new LiveSource(eventBus, id, session);
				} else if (sessionFile) {
					this.#source = new ReplaySource(sessionFile, session);
				}
			} else if (sessionFile) {
				this.#source = new ReplaySource(sessionFile, session);
			}

			if (!this.#source && sessionFile) {
				this.#source = new ReplaySource(sessionFile, session);
			}
			this.#liveSession = this.#source instanceof HybridSource || this.#source instanceof LiveSource;

			// Resolve tool/cwd/snapshot deps from the observed agent's OWN session while it
			// is still live, so a running subagent's edit/tool cards render against the
			// correct tool registry, cwd, and file snapshots. Completed agents fall back to
			// the main-session deps (their results are already materialized in the JSONL).
			const agentSession = AgentRegistry.global().get(id)?.session;
			const sessionDeps: Partial<TranscriptRendererDeps> = agentSession
				? {
						getToolByName: name => agentSession.getToolByName(name),
						getCwd: () => agentSession.sessionManager.getCwd(),
						getSnapshots: () => getFileSnapshotStore(agentSession),
					}
				: {};

			if (this.#source) {
				this.#renderer = new TranscriptRenderer({
					getSmoothStreaming: () => false,
					getHideThinkingBlock: () => false,
					getToolResultPreview: () => true,
					getToolOutputExpanded: () => false,
					getShowImages: () => true,
					...this.#rendererDeps,
					...sessionDeps,
					requestRender: () => {
						this.#requestRender();
					},
				});

				this.#renderer.seed(this.#source.backlog());
				this.#sourceUnsub = this.#source.subscribe(e => {
					this.#renderer!.feed(e);
					if (this.#followLive) this.#wasAtBottom = true;
					this.#rebuildViewerContent();
					this.#requestRender();
				});
			}
		}

		this.#rebuildViewerContent();
	}

	/** Rebuild content from live registry data */
	refreshFromRegistry(): void {
		if (!this.#selectedSessionId) return;
		// Seamless Live→Replay handoff: when a live agent finishes, rebuild the
		// view from its now-complete session file and tear down the live feed.
		if (this.#liveSession) {
			const session = this.#registry.getSessions().find(s => s.id === this.#selectedSessionId);
			if (session && session.status !== "active") {
				this.#setupViewer();
				return;
			}
		}
		this.#rebuildViewerContent();
	}

	/** Rebuild the transcript content lines (called on setup and refresh) */
	#rebuildViewerContent(): void {
		const sessions = this.#registry.getSessions();
		const session = sessions.find(s => s.id === this.#selectedSessionId);

		// Header
		this.#viewerHeaderLines = [];
		const breadcrumb = this.#buildBreadcrumb(session);
		this.#viewerHeaderLines.push(theme.fg("accent", breadcrumb));
		if (session) {
			const statusColor = session.status === "active" ? "success" : session.status === "failed" ? "error" : "dim";
			const statusText = theme.fg(statusColor, `[${sanitizeText(session.status)}]`);
			const agentTag = session.agent ? theme.fg("dim", ` ${sanitizeText(session.agent)}`) : "";
			const subagentIds = this.#getSubagentSessionIds();
			const posIdx = subagentIds.indexOf(this.#selectedSessionId ?? "");
			const posLabel =
				subagentIds.length > 1 && posIdx >= 0 ? theme.fg("dim", ` (${posIdx + 1}/${subagentIds.length})`) : "";
			const modelName = this.#source?.meta().model;
			const modelLabel = modelName ? theme.fg("muted", ` · ${sanitizeText(modelName)}`) : "";
			this.#viewerHeaderLines.push(
				`${theme.bold(sanitizeText(session.label))} ${statusText}${agentTag}${posLabel}${modelLabel}`,
			);
		}

		// Content
		if (!session) {
			this.#renderedLines = [theme.fg("dim", "Session no longer available.")];
		} else if (!session.sessionFile && session.status !== "active") {
			this.#renderedLines = [theme.fg("dim", "No session file available yet.")];
		} else if (!this.#renderer) {
			this.#renderedLines = [theme.fg("dim", "No renderer initialized.")];
		} else {
			this.#renderedLines = this.#renderer.getContainer().render(contentWidth());
		}

		// Footer
		this.#viewerFooterLines = [];
		const statsLine = this.#buildStatsLine(session);
		if (statsLine) this.#viewerFooterLines.push(statsLine);
		const backHint = this.#onBack ? "  u:back" : "";
		const activeSession = session?.status === "active";
		const followIndicator = activeSession ? (this.#followLive ? "  ●following" : "  ○paused") : "";
		const liveHints = activeSession ? "  f:follow  x:stop" : "";
		this.#viewerFooterLines.push(
			theme.fg(
				"dim",
				sanitizeText(`j/k:scroll  [/]:cycle  Esc:close${backHint}${liveHints}  g/G:top/bottom${followIndicator}`),
			),
		);

		// Auto-scroll to bottom if we were at bottom
		if (this.#wasAtBottom) {
			this.#scrollOffset = Math.max(0, this.#renderedLines.length - this.#viewportHeight);
		}
	}

	/** Produce the final viewer output for the overlay system */
	#renderViewer(width: number): string[] {
		const termHeight = process.stdout.rows || 40;

		const headerChrome = this.#viewerHeaderLines.length + 2;
		const footerChrome = this.#viewerFooterLines.length + 2;
		this.#viewportHeight = Math.max(5, termHeight - headerChrome - footerChrome);

		const maxScroll = Math.max(0, this.#renderedLines.length - this.#viewportHeight);
		this.#scrollOffset = Math.max(0, Math.min(this.#scrollOffset, maxScroll));

		const lines: string[] = [];

		// --- Header ---
		lines.push(...new DynamicBorder().render(width));
		for (const hl of this.#viewerHeaderLines) {
			lines.push(` ${hl}`);
		}
		lines.push(...new DynamicBorder().render(width));

		// --- Scrolled content viewport ---
		const sv = new ScrollView(
			this.#renderedLines.slice(this.#scrollOffset, this.#scrollOffset + this.#viewportHeight),
			{
				height: this.#viewportHeight,
				scrollbar: "auto",
				totalRows: this.#renderedLines.length,
				theme: { track: t => theme.fg("dim", t), thumb: t => theme.fg("accent", t) },
			},
		);
		sv.setScrollOffset(this.#scrollOffset);
		for (const row of sv.render(Math.max(1, width - 1))) lines.push(` ${row}`);

		// --- Footer ---
		lines.push("");
		lines.push(` ${this.#viewerFooterLines[0] ?? ""}`);
		for (let i = 1; i < this.#viewerFooterLines.length; i++) {
			lines.push(` ${this.#viewerFooterLines[i]}`);
		}
		lines.push(...new DynamicBorder().render(width));

		return lines;
	}

	#buildBreadcrumb(session: ObservableSession | undefined): string {
		if (!session) {
			return "Session Observer";
		}
		const sessions = this.#registry.getSessions();
		const chain: string[] = [];
		const isMain = session.kind === "main" || session.id === MAIN_AGENT_ID || session.id === "main";
		if (!isMain) {
			chain.push(sanitizeText(session.label));
			const visited = new Set<string>([session.id]);
			let current: ObservableSession | undefined = session;
			while (current) {
				const parentId: string | undefined = current.parentId;
				if (!parentId || parentId === MAIN_AGENT_ID || parentId === "main" || visited.has(parentId)) {
					break;
				}
				visited.add(parentId);
				const parent: ObservableSession | undefined = sessions.find(s => s.id === parentId);
				if (!parent) {
					break;
				}
				if (parent.kind === "main" || parent.id === MAIN_AGENT_ID || parent.id === "main") {
					break;
				}
				chain.unshift(sanitizeText(parent.label));
				current = parent;
			}
		}

		// Find the main session to get its label as root, or default to "Main"
		const mainSession = sessions.find(s => s.kind === "main" || s.id === MAIN_AGENT_ID || s.id === "main");
		const rootLabel = sanitizeText(mainSession?.label || "Main");
		chain.unshift(rootLabel);

		return chain.join(" › ");
	}

	#buildStatsLine(session: ObservableSession | undefined): string {
		const progress = session?.progress;
		if (!progress) return "";
		const stats: string[] = [];
		if (progress.contextTokens && progress.contextTokens > 0) {
			const ctx =
				progress.contextWindow && progress.contextWindow > 0
					? formatContextUsage((progress.contextTokens / progress.contextWindow) * 100, progress.contextWindow)
					: `${formatNumber(progress.contextTokens)}`;
			stats.push(ctx);
		}
		if (progress.durationMs > 0) {
			stats.push(formatDuration(progress.durationMs));
		}
		const parts: string[] = [];
		if (stats.length > 0 || progress.toolCount > 0) {
			const toolCountStat =
				progress.toolCount > 0 ? `${formatNumber(progress.toolCount)} ${theme.icon.extensionTool}` : undefined;
			const statSegments = [toolCountStat, ...stats].filter((segment): segment is string => Boolean(segment));
			parts.push(theme.fg("dim", statSegments.join(theme.sep.dot)));
		}
		if (progress.cost > 0) {
			parts.push(theme.fg("statusLineCost", `$${progress.cost.toFixed(2)}`));
		}
		return parts.join(theme.sep.dot);
	}

	handleInput(keyData: string): void {
		// Ctrl+S (observe key) always closes the overlay
		for (const key of this.#observeKeys) {
			if (matchesKey(keyData, key)) {
				this.#disposeAll();
				this.#onDone();
				return;
			}
		}

		this.#handleViewerInput(keyData);
	}

	#handleViewerInput(keyData: string): void {
		// Escape — close overlay
		if (matchesKey(keyData, "escape")) {
			this.#disposeAll();
			this.#onDone();
			return;
		}

		// u / Backspace — back navigation
		if (keyData === "u" || matchesKey(keyData, "backspace")) {
			if (this.#onBack) {
				this.#disposeAll();
				this.#onBack();
			}
			return;
		}

		// j / down — scroll down
		if (keyData === "j" || matchesSelectDown(keyData)) {
			const maxScroll = Math.max(0, this.#renderedLines.length - this.#viewportHeight);
			this.#scrollOffset = Math.min(this.#scrollOffset + 1, maxScroll);
			this.#wasAtBottom = this.#scrollOffset >= maxScroll;
			return;
		}

		// k / up — scroll up
		if (keyData === "k" || matchesSelectUp(keyData)) {
			this.#scrollOffset = Math.max(this.#scrollOffset - 1, 0);
			this.#wasAtBottom = false;
			this.#followLive = false;
			return;
		}

		// Page Down
		if (matchesKey(keyData, "pageDown")) {
			const maxScroll = Math.max(0, this.#renderedLines.length - this.#viewportHeight);
			this.#scrollOffset = Math.min(this.#scrollOffset + PAGE_SIZE, maxScroll);
			this.#wasAtBottom = this.#scrollOffset >= maxScroll;
			return;
		}

		// Page Up
		if (matchesKey(keyData, "pageUp")) {
			this.#scrollOffset = Math.max(this.#scrollOffset - PAGE_SIZE, 0);
			this.#wasAtBottom = false;
			this.#followLive = false;
			return;
		}

		// Enter — no-op
		if (matchesKey(keyData, "enter") || keyData === "\r" || keyData === "\n") {
			return;
		}

		// f — toggle follow-live (auto-scroll to tail as events stream)
		if (keyData === "f") {
			this.#followLive = !this.#followLive;
			if (this.#followLive) {
				this.#wasAtBottom = true;
				this.#scrollOffset = Math.max(0, this.#renderedLines.length - this.#viewportHeight);
			} else {
				this.#wasAtBottom = false;
			}
			return;
		}

		// x — stop the selected running agent (aborts its live session)
		if (keyData === "x") {
			const session = this.#registry.getSessions().find(s => s.id === this.#selectedSessionId);
			if (session && session.status === "active") {
				const ref = AgentRegistry.global().get(session.id);
				void ref?.session?.abort({ reason: "Stopped from session observer" });
			}
			return;
		}

		// G — jump to bottom
		if (keyData === "G") {
			const maxScroll = Math.max(0, this.#renderedLines.length - this.#viewportHeight);
			this.#scrollOffset = maxScroll;
			this.#wasAtBottom = true;
			this.#followLive = true;
			return;
		}

		// g — jump to top
		if (keyData === "g") {
			this.#scrollOffset = 0;
			this.#wasAtBottom = false;
			this.#followLive = false;
			return;
		}

		// ] / → / Tab — next sub-agent session
		if (keyData === "]" || matchesKey(keyData, "tab") || matchesKey(keyData, "right")) {
			this.#cycleSession(1);
			return;
		}

		// [ / ← / Shift+Tab — previous sub-agent session
		if (keyData === "[" || matchesKey(keyData, "shift+tab") || matchesKey(keyData, "left")) {
			this.#cycleSession(-1);
			return;
		}
	}

	/** Get the ordered list of sub-agent session IDs (excludes main) */
	#getSubagentSessionIds(): string[] {
		return this.#registry
			.getSessions()
			.filter(s => s.kind === "subagent")
			.map(s => s.id);
	}

	/** Cycle to next (+1) or previous (-1) sub-agent session */
	#cycleSession(direction: 1 | -1): void {
		const ids = this.#getSubagentSessionIds();
		if (ids.length <= 1) return;
		const currentIdx = ids.indexOf(this.#selectedSessionId ?? "");
		if (currentIdx < 0) return;
		const nextIdx = (currentIdx + direction + ids.length) % ids.length;
		this.#selectedSessionId = ids[nextIdx];
		this.#scrollOffset = 0;
		this.#wasAtBottom = true;
		this.#setupViewer();
	}
}
