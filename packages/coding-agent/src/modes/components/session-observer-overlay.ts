/**
 * Session observer overlay component.
 *
 * Picker mode: lists main + active subagent sessions with live status.
 * Viewer mode: renders a read-only transcript of the selected subagent's session
 *   using the same components as the main session (AssistantMessage, UserMessage,
 *   ToolExecution) for visual consistency.
 *
 * Lifecycle:
 *   - shortcut opens picker
 *   - Enter on a subagent -> viewer
 *   - shortcut while in viewer -> back to picker
 *   - Esc from viewer -> back to picker
 *   - Esc from picker -> close overlay
 *   - Enter on main session -> close overlay (jump back)
 */
import type { ToolResultMessage } from "@oh-my-pi/pi-ai";
import { Container, matchesKey, type SelectItem, SelectList, Spacer, Text, type TUI } from "@oh-my-pi/pi-tui";
import { formatDuration, formatNumber, logger } from "@oh-my-pi/pi-utils";
import type { KeyId } from "../../config/keybindings";
import { settings } from "../../config/settings";
import type { SessionMessageEntry } from "../../session/session-manager";
import { parseSessionEntries } from "../../session/session-manager";
import { shortenPath, truncateToWidth } from "../../tools/render-utils";
import type { ObservableSession, SessionObserverRegistry } from "../session-observer-registry";
import { getSelectListTheme, theme } from "../theme/theme";
import { AssistantMessageComponent } from "./assistant-message";
import { DynamicBorder } from "./dynamic-border";
import { ToolExecutionComponent } from "./tool-execution";
import { UserMessageComponent } from "./user-message";

type Mode = "picker" | "viewer";

export class SessionObserverOverlayComponent extends Container {
	#registry: SessionObserverRegistry;
	#onDone: () => void;
	#mode: Mode = "picker";
	#selectList: SelectList;
	#viewerContainer: Container;
	#selectedSessionId?: string;
	#observeKeys: KeyId[];
	#ui: TUI;
	/** Cached parsed transcript per session file to avoid reparsing on every refresh */
	#transcriptCache?: { path: string; bytesRead: number; entries: SessionMessageEntry[] };
	/** Live stats text component, placed after transcript to avoid above-viewport diffs */
	#statsText?: Text;

	constructor(registry: SessionObserverRegistry, onDone: () => void, observeKeys: KeyId[], ui: TUI) {
		super();
		this.#registry = registry;
		this.#onDone = onDone;
		this.#observeKeys = observeKeys;
		this.#ui = ui;
		this.#selectList = new SelectList([], 0, getSelectListTheme());
		this.#viewerContainer = new Container();

		this.#setupPicker();
	}

	#setupPicker(): void {
		this.#mode = "picker";
		this.children = [];

		this.addChild(new DynamicBorder());
		this.addChild(new Text(theme.bold(theme.fg("accent", "Session Observer")), 1, 0));
		this.addChild(new Spacer(1));

		const items = this.#buildPickerItems();
		this.#selectList = new SelectList(items, Math.min(items.length, 12), getSelectListTheme());

		this.#selectList.onSelect = item => {
			if (item.value === "main") {
				this.#onDone();
				return;
			}
			this.#selectedSessionId = item.value;
			this.#setupViewer();
		};

		this.#selectList.onCancel = () => {
			this.#onDone();
		};

		this.addChild(this.#selectList);
		this.addChild(new DynamicBorder());
	}

	#setupViewer(): void {
		this.#mode = "viewer";
		this.children = [];
		this.#viewerContainer = new Container();
		this.#statsText = new Text("", 1, 0);
		this.#refreshViewer();

		this.addChild(new DynamicBorder());
		this.addChild(this.#viewerContainer);
		this.addChild(new Spacer(1));
		this.addChild(this.#statsText);
		this.addChild(new Text(theme.fg("dim", "Esc: back to picker  |  Ctrl+S: back to picker"), 1, 0));
		this.addChild(new DynamicBorder());
	}

	/** Rebuild content from live registry data */
	refreshFromRegistry(): void {
		if (this.#mode === "picker") {
			this.#refreshPickerItems();
		} else if (this.#mode === "viewer" && this.#selectedSessionId) {
			this.#refreshViewer();
		}
	}

	#refreshPickerItems(): void {
		// Preserve selection across refresh by matching on value
		const previousValue = this.#selectList.getSelectedItem()?.value;

		const items = this.#buildPickerItems();
		const newList = new SelectList(items, Math.min(items.length, 12), getSelectListTheme());
		newList.onSelect = this.#selectList.onSelect;
		newList.onCancel = this.#selectList.onCancel;

		if (previousValue) {
			const newIndex = items.findIndex(i => i.value === previousValue);
			if (newIndex >= 0) newList.setSelectedIndex(newIndex);
		}

		const idx = this.children.indexOf(this.#selectList);
		if (idx >= 0) {
			this.children[idx] = newList;
		}
		this.#selectList = newList;
	}

	#refreshViewer(): void {
		this.#viewerContainer.clear();

		const sessions = this.#registry.getSessions();
		const session = sessions.find(s => s.id === this.#selectedSessionId);
		if (!session) {
			this.#viewerContainer.addChild(new Text(theme.fg("dim", "Session no longer available."), 1, 0));
			this.#updateStats(undefined);
			return;
		}

		this.#renderSessionHeader(session);
		this.#renderSessionTranscript(session);
		this.#updateStats(session);
	}

	#renderSessionHeader(session: ObservableSession): void {
		const c = this.#viewerContainer;

		// Header: label + status + [agent]
		const statusColor = session.status === "active" ? "success" : session.status === "failed" ? "error" : "dim";
		const statusText = theme.fg(statusColor, session.status);
		const agentTag = session.agent ? theme.fg("dim", ` [${session.agent}]`) : "";
		c.addChild(new Text(`${theme.bold(theme.fg("accent", session.label))}  ${statusText}${agentTag}`, 1, 0));

		if (session.description) {
			c.addChild(new Text(theme.fg("muted", session.description), 1, 0));
		}

		if (session.sessionFile) {
			c.addChild(new Text(theme.fg("dim", `Session: ${shortenPath(session.sessionFile)}`), 1, 0));
		}

		c.addChild(new DynamicBorder());
	}

	/** Update live stats in-place (below transcript, within viewport). */
	#updateStats(session: ObservableSession | undefined): void {
		if (!this.#statsText) return;
		const progress = session?.progress;
		if (!progress) {
			this.#statsText.setText("");
			return;
		}
		const stats: string[] = [];
		if (progress.toolCount > 0) stats.push(`${formatNumber(progress.toolCount)} tools`);
		if (progress.tokens > 0) stats.push(`${formatNumber(progress.tokens)} tokens`);
		if (progress.durationMs > 0) stats.push(formatDuration(progress.durationMs));
		this.#statsText.setText(stats.length > 0 ? theme.fg("dim", stats.join(theme.sep.dot)) : "");
	}

	/** Incrementally read and parse the session JSONL, caching already-parsed entries. */
	#loadTranscript(sessionFile: string): SessionMessageEntry[] | null {
		// Invalidate cache if session file changed (e.g. switched to different subagent)
		if (this.#transcriptCache && this.#transcriptCache.path !== sessionFile) {
			this.#transcriptCache = undefined;
		}

		const fromByte = this.#transcriptCache?.bytesRead ?? 0;
		const result = readFileIncremental(sessionFile, fromByte);
		if (!result) {
			logger.debug("Session observer: failed to read session file", { path: sessionFile });
			return this.#transcriptCache?.entries ?? null;
		}

		// File shrank (compaction or pruning rewrote it) — invalidate and re-read from scratch
		if (result.newSize < fromByte) {
			this.#transcriptCache = undefined;
			return this.#loadTranscript(sessionFile);
		}

		if (!this.#transcriptCache) {
			this.#transcriptCache = { path: sessionFile, bytesRead: 0, entries: [] };
		}

		// Parse only new bytes, but only up to the last complete line.
		// A partial trailing record (mid-write) must not be consumed —
		// we leave those bytes for the next refresh.
		if (result.text.length > 0) {
			const lastNewline = result.text.lastIndexOf("\n");
			if (lastNewline >= 0) {
				const completeChunk = result.text.slice(0, lastNewline + 1);
				const newEntries = parseSessionEntries(completeChunk);
				for (const entry of newEntries) {
					if (entry.type === "message") {
						this.#transcriptCache.entries.push(entry as SessionMessageEntry);
					}
				}
				this.#transcriptCache.bytesRead = fromByte + Buffer.byteLength(completeChunk, "utf-8");
			}
			// If no newline found, the entire chunk is partial — leave bytesRead unchanged
		}
		return this.#transcriptCache.entries;
	}

	#renderSessionTranscript(session: ObservableSession): void {
		const c = this.#viewerContainer;

		if (!session.sessionFile) {
			c.addChild(new Text(theme.fg("dim", "No session file available yet."), 1, 0));
			return;
		}

		const messageEntries = this.#loadTranscript(session.sessionFile);
		if (!messageEntries) {
			c.addChild(new Text(theme.fg("dim", "Unable to read session file."), 1, 0));
			return;
		}
		if (messageEntries.length === 0) {
			c.addChild(new Text(theme.fg("dim", "No messages yet."), 1, 0));
			return;
		}

		// Build a tool call ID -> tool result map for matching
		const toolResults = new Map<string, ToolResultMessage>();
		for (const entry of messageEntries) {
			if (entry.message.role === "toolResult") {
				toolResults.set(entry.message.toolCallId, entry.message);
			}
		}

		for (const entry of messageEntries) {
			const msg = entry.message;

			if (msg.role === "assistant") {
				// Use real AssistantMessageComponent for text/thinking rendering
				const assistantComponent = new AssistantMessageComponent(msg);
				if (msg.usage) assistantComponent.setUsageInfo(msg.usage);
				c.addChild(assistantComponent);

				// Render tool calls with real ToolExecutionComponent
				for (const content of msg.content) {
					if (content.type !== "toolCall") continue;
					const component = new ToolExecutionComponent(
						content.name,
						content.arguments,
						{
							showImages: settings.get("terminal.showImages"),
							editFuzzyThreshold: settings.get("edit.fuzzyThreshold"),
							editAllowFuzzy: settings.get("edit.fuzzyMatch"),
						},
						undefined,
						this.#ui,
						undefined,
						content.id,
					);
					component.setArgsComplete(content.id);
					const result = toolResults.get(content.id);
					if (result) {
						component.updateResult(result, false, content.id);
					}
					component.stopAnimation();
					c.addChild(component);
				}
			} else if (msg.role === "user" || msg.role === "developer") {
				const text =
					typeof msg.content === "string"
						? msg.content
						: msg.content
								.filter((b): b is { type: "text"; text: string } => b.type === "text")
								.map(b => b.text)
								.join("\n");
				if (text.trim()) {
					const isSynthetic =
						msg.role === "developer" ? true : ((msg as { synthetic?: boolean }).synthetic ?? false);
					c.addChild(new UserMessageComponent(text.trim(), isSynthetic));
				}
			}
			// toolResult entries are rendered inline with their tool calls above
		}
	}

	#buildPickerItems(): SelectItem[] {
		const sessions = this.#registry.getSessions();
		return sessions.map(s => {
			const statusIcon =
				s.status === "active" ? "●" : s.status === "completed" ? "✓" : s.status === "failed" ? "✗" : "○";
			const statusColor = s.status === "active" ? "success" : s.status === "failed" ? "error" : "dim";
			const prefix = theme.fg(statusColor, statusIcon);
			const agentSuffix = s.agent ? theme.fg("dim", ` [${s.agent}]`) : "";
			const label = s.kind === "main" ? `${prefix} ${s.label} (return)` : `${prefix} ${s.label}${agentSuffix}`;

			// Show current activity in the picker description for subagents
			let description = s.description;
			if (s.progress?.currentTool) {
				const intent = s.progress.lastIntent;
				description = intent ? `${s.progress.currentTool}: ${truncateToWidth(intent, 40)}` : s.progress.currentTool;
			}

			return { value: s.id, label, description };
		});
	}

	handleInput(keyData: string): void {
		for (const key of this.#observeKeys) {
			if (matchesKey(keyData, key)) {
				if (this.#mode === "viewer") {
					this.#setupPicker();
					return;
				}
				this.#onDone();
				return;
			}
		}

		if (this.#mode === "picker") {
			this.#selectList.handleInput(keyData);
		} else if (this.#mode === "viewer") {
			if (matchesKey(keyData, "escape")) {
				this.#setupPicker();
				return;
			}
		}
	}
}

// Sync helpers for render path — avoid async in component rendering
import * as fs from "node:fs";

/**
 * Read new bytes from a file starting at the given byte offset.
 * Returns the new text and updated file size, or null on error.
 */
function readFileIncremental(filePath: string, fromByte: number): { text: string; newSize: number } | null {
	try {
		const stat = fs.statSync(filePath);
		if (stat.size <= fromByte) return { text: "", newSize: stat.size };
		const buf = Buffer.alloc(stat.size - fromByte);
		const fd = fs.openSync(filePath, "r");
		try {
			fs.readSync(fd, buf, 0, buf.length, fromByte);
		} finally {
			fs.closeSync(fd);
		}
		return { text: buf.toString("utf-8"), newSize: stat.size };
	} catch {
		return null;
	}
}
