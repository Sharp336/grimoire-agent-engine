import {
	Container,
	fuzzyMatch,
	Input,
	matchesKey,
	replaceTabs,
	ScrollView,
	truncateToWidth,
	visibleWidth,
} from "@oh-my-pi/pi-tui";
import { formatNumber } from "@oh-my-pi/pi-utils";
import type { ObservableSession, ObserverTreeNode, SessionObserverRegistry } from "../session-observer-registry";
import type { ThemeColor } from "../theme/theme";
import { theme } from "../theme/theme";
import { matchesAppInterrupt, matchesSelectDown, matchesSelectUp } from "../utils/keybinding-matchers";

function getSearchableText(session: ObservableSession): string {
	const parts = [session.id, session.label ?? "", session.agent ?? "", session.description ?? ""];
	return parts.filter(Boolean).join(" ").toLowerCase();
}

function tokenizeSessionQuery(query: string): string[] {
	const trimmed = query.trim().toLowerCase();
	return trimmed ? trimmed.split(/\s+/) : [];
}

function filterTree(nodes: ObserverTreeNode[], tokens: string[]): ObserverTreeNode[] {
	const result: ObserverTreeNode[] = [];
	for (const node of nodes) {
		const searchableText = getSearchableText(node.session);
		const selfMatched = tokens.length > 0 && tokens.every(token => fuzzyMatch(token, searchableText).matches);
		const filteredChildren = filterTree(node.children, tokens);
		if (selfMatched || filteredChildren.length > 0) {
			result.push({
				session: node.session,
				children: filteredChildren,
			});
		}
	}
	return result;
}

function flattenTree(
	nodes: ObserverTreeNode[],
	collapsedIds: Set<string>,
	depth = 0,
): Array<{ node: ObserverTreeNode; depth: number }> {
	const result: Array<{ node: ObserverTreeNode; depth: number }> = [];
	for (const node of nodes) {
		result.push({ node, depth });
		if (!collapsedIds.has(node.session.id)) {
			result.push(...flattenTree(node.children, collapsedIds, depth + 1));
		}
	}
	return result;
}

export class SubagentBrowserComponent extends Container {
	#registry: SessionObserverRegistry;
	#options: {
		onSelect: (session: ObservableSession) => void;
		onDone: () => void;
		requestRender: () => void;
	};
	#collapsedIds = new Set<string>();
	#selectedIndex = 0;
	#searchActive = false;
	#searchInput = new Input();
	#flatView: Array<{ node: ObserverTreeNode; depth: number }> = [];

	constructor(
		registry: SessionObserverRegistry,
		options: {
			onSelect: (session: ObservableSession) => void;
			onDone: () => void;
			requestRender: () => void;
		},
	) {
		super();
		this.#registry = registry;
		this.#options = options;

		this.#searchInput.onSubmit = () => {
			const selected = this.#flatView[this.#selectedIndex];
			if (selected) {
				this.#options.onSelect(selected.node.session);
			}
		};

		this.#rebuildFlatView();
	}

	refresh(): void {
		const selectedNode = this.#flatView[this.#selectedIndex];
		const selectedId = selectedNode?.node.session.id;

		this.#rebuildFlatView();

		if (selectedId) {
			const index = this.#flatView.findIndex(item => item.node.session.id === selectedId);
			if (index !== -1) {
				this.#selectedIndex = index;
			} else {
				this.#selectedIndex = Math.max(0, Math.min(this.#selectedIndex, this.#flatView.length - 1));
			}
		} else {
			this.#selectedIndex = Math.max(0, Math.min(this.#selectedIndex, this.#flatView.length - 1));
		}
	}

	#rebuildFlatView(): void {
		const tree = this.#registry.getTree();
		const query = this.#searchInput.getValue().trim();
		if (query.length > 0) {
			const tokens = tokenizeSessionQuery(query);
			const filteredTree = filterTree(tree, tokens);
			this.#flatView = flattenTree(filteredTree, new Set(), 0);
		} else {
			this.#flatView = flattenTree(tree, this.#collapsedIds, 0);
		}

		if (this.#flatView.length === 0) {
			this.#selectedIndex = 0;
		} else {
			this.#selectedIndex = Math.max(0, Math.min(this.#selectedIndex, this.#flatView.length - 1));
		}
	}

	invalidate(): void {
		// No cached state to invalidate currently
	}

	handleInput(keyData: string): void {
		if (matchesAppInterrupt(keyData)) {
			if (this.#searchActive) {
				this.#searchActive = false;
				this.#searchInput.setValue("");
				this.#rebuildFlatView();
				this.#options.requestRender();
				return;
			}
			this.#options.onDone();
			return;
		}

		if (matchesKey(keyData, "enter") || matchesKey(keyData, "return") || keyData === "\n") {
			const selected = this.#flatView[this.#selectedIndex];
			if (selected) {
				this.#options.onSelect(selected.node.session);
			}
			return;
		}

		if (this.#searchActive) {
			if (matchesSelectUp(keyData)) {
				this.#selectedIndex = Math.max(0, this.#selectedIndex - 1);
				this.#options.requestRender();
				return;
			}
			if (matchesSelectDown(keyData)) {
				this.#selectedIndex = Math.min(this.#flatView.length - 1, this.#selectedIndex + 1);
				this.#options.requestRender();
				return;
			}

			this.#searchInput.handleInput(keyData);
			this.#rebuildFlatView();
			this.#options.requestRender();
			return;
		}

		if (matchesSelectUp(keyData) || keyData === "k") {
			this.#selectedIndex = Math.max(0, this.#selectedIndex - 1);
			this.#options.requestRender();
			return;
		}
		if (matchesSelectDown(keyData) || keyData === "j") {
			this.#selectedIndex = Math.min(this.#flatView.length - 1, this.#selectedIndex + 1);
			this.#options.requestRender();
			return;
		}

		if (matchesKey(keyData, "right") || keyData === "›" || keyData === ">") {
			const selected = this.#flatView[this.#selectedIndex];
			if (selected && selected.node.children.length > 0) {
				const id = selected.node.session.id;
				if (this.#collapsedIds.has(id)) {
					this.#collapsedIds.delete(id);
					this.#rebuildFlatView();
					this.#options.requestRender();
				}
			}
			return;
		}
		if (matchesKey(keyData, "left") || keyData === "‹" || keyData === "<") {
			const selected = this.#flatView[this.#selectedIndex];
			if (selected && selected.node.children.length > 0) {
				const id = selected.node.session.id;
				if (!this.#collapsedIds.has(id)) {
					this.#collapsedIds.add(id);
					this.#rebuildFlatView();
					this.#options.requestRender();
				}
			}
			return;
		}

		if (keyData === "/") {
			this.#searchActive = true;
			this.#options.requestRender();
			return;
		}
	}

	#renderNode(node: ObserverTreeNode, depth: number, isSelected: boolean, width: number): string {
		const cursorSymbol = `${theme.nav.cursor} `;
		const cursorWidth = visibleWidth(cursorSymbol);
		const cursor = isSelected ? theme.fg("accent", cursorSymbol) : " ".repeat(cursorWidth);

		const indent = "  ".repeat(depth);

		let expandCollapse = " ";
		if (node.children.length > 0) {
			const isCollapsed = this.#collapsedIds.has(node.session.id);
			expandCollapse = isCollapsed ? theme.nav.expand : theme.nav.collapse;
		}
		const expandPart = `${expandCollapse} `;

		const status = node.session.status;
		const progress = node.session.progress;
		const preset = theme.getSymbolPreset();
		const isAscii = preset === "ascii";

		let statusGlyph = "";
		let statusColor: ThemeColor = "text";
		if (status === "active") {
			if (!progress) {
				statusGlyph = isAscii ? "*" : "●";
				statusColor = "accent";
			} else {
				statusGlyph = isAscii ? "~" : "⟳";
				statusColor = "accent";
			}
		} else if (status === "completed") {
			statusGlyph = isAscii ? "ok" : "✓";
			statusColor = "success";
		} else if (status === "failed") {
			statusGlyph = isAscii ? "!!" : "✗";
			statusColor = "error";
		} else if (status === "aborted") {
			statusGlyph = isAscii ? "-" : "⊘";
			statusColor = "muted";
		}
		const statusPart = `${theme.fg(statusColor, statusGlyph)} `;

		const label = replaceTabs(node.session.label || node.session.id);
		const agentPart = node.session.agent ? ` ${theme.fg("dim", replaceTabs(node.session.agent))}` : "";

		let suffixPart = "";
		if (progress) {
			const tokens = formatNumber(progress.tokens);
			if (status === "active") {
				let toolSuffix = "";
				if (progress.currentTool) {
					toolSuffix = replaceTabs(progress.currentTool);
					const detail = progress.lastIntent || progress.currentToolArgs;
					if (detail) {
						toolSuffix += ` ${replaceTabs(detail)}`;
					}
				}
				suffixPart = ` · ${tokens} tok${toolSuffix ? ` · ${toolSuffix}` : ""}`;
			} else if (status === "completed") {
				suffixPart = ` · ✓ ${tokens} tok`;
			}
		}

		const prefixWidth = cursorWidth + visibleWidth(indent) + visibleWidth(expandPart) + visibleWidth(statusGlyph) + 1;
		const suffixWidth = suffixPart ? visibleWidth(suffixPart) : 0;
		const agentWidth = agentPart ? visibleWidth(agentPart) : 0;

		const availWidth = width - prefixWidth - agentWidth - suffixWidth - 1;
		const truncatedLabel = truncateToWidth(label, Math.max(5, availWidth));

		let content = isSelected ? theme.bold(truncatedLabel) : truncatedLabel;
		content += agentPart;
		if (suffixPart) {
			content += theme.fg("dim", suffixPart);
		}

		let line = cursor + theme.fg("dim", indent) + theme.fg("dim", expandPart) + statusPart + content;

		if (isSelected) {
			line = theme.bg("selectedBg", line);
		}

		return line;
	}

	override render(width: number): string[] {
		const lines: string[] = [];

		const allSessions = this.#registry.getSessions();
		const runningCount = allSessions.filter(s => s.status === "active").length;
		const doneCount = allSessions.filter(
			s => s.status === "completed" || s.status === "failed" || s.status === "aborted",
		).length;

		lines.push("");
		const titleLabel = `${theme.bold("Agents")} ${theme.fg("muted", `(${runningCount} running · ${doneCount} done)`)}`;
		lines.push(`  ${titleLabel}`);
		lines.push("");

		lines.push(theme.fg("border", theme.boxSharp.horizontal.repeat(Math.max(1, width))));
		lines.push("");

		const searchLabel = "Search: ";
		const searchLabelDim = theme.fg("dim", searchLabel);
		const labelWidth = visibleWidth(`  ${searchLabel}`);
		this.#searchInput.setUseTerminalCursor(this.#searchActive);
		const searchInputLines = this.#searchInput.render(Math.max(1, width - labelWidth - 2));

		if (searchInputLines.length > 0) {
			lines.push(`  ${searchLabelDim}${searchInputLines[0]}`);
			for (let i = 1; i < searchInputLines.length; i++) {
				lines.push(" ".repeat(labelWidth) + searchInputLines[i]);
			}
		} else {
			lines.push(`  ${searchLabelDim}`);
		}
		lines.push("");

		const termHeight = process.stdout.rows || 24;
		const chromeHeight = 12;
		const maxVisible = Math.max(3, termHeight - chromeHeight);

		let startIndex = 0;
		if (this.#flatView.length > maxVisible) {
			startIndex = Math.max(
				0,
				Math.min(this.#selectedIndex - Math.floor(maxVisible / 2), this.#flatView.length - maxVisible),
			);
		}
		const endIndex = Math.min(startIndex + maxVisible, this.#flatView.length);

		const listLines: string[] = [];
		if (this.#flatView.length === 0) {
			listLines.push(`  ${theme.fg("dim", "No agents found")}`);
		} else {
			const overflow = this.#flatView.length > maxVisible;
			const rowWidth = Math.max(1, width - (overflow ? 1 : 0));
			for (let i = startIndex; i < endIndex; i++) {
				const item = this.#flatView[i];
				const isSelected = i === this.#selectedIndex;
				listLines.push(this.#renderNode(item.node, item.depth, isSelected, rowWidth));
			}
		}

		const sv = new ScrollView(listLines, {
			height: listLines.length,
			scrollbar: "auto",
			totalRows: this.#flatView.length || 1,
			theme: { track: t => theme.fg("muted", t), thumb: t => theme.fg("accent", t) },
		});
		sv.setScrollOffset(startIndex);
		lines.push(...sv.render(width));

		lines.push("");
		lines.push(theme.fg("border", theme.boxSharp.horizontal.repeat(Math.max(1, width))));
		lines.push("");
		lines.push(theme.fg("muted", "  ↑↓ select · ›/‹ expand · ↵ open · / search · esc close"));
		lines.push("");

		return lines;
	}
}
