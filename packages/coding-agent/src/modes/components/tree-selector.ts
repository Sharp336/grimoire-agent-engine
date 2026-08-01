import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import {
	type Component,
	extractPrintableText,
	fuzzyMatch,
	Input,
	matchesKey,
	replaceTabs,
	truncateToWidth,
	visibleWidth,
} from "@oh-my-pi/pi-tui";
import type { TreeFilterMode } from "../../config/settings-schema";
import { theme } from "../../modes/theme/theme";
import { matchesAppInterrupt, matchesSelectDown, matchesSelectUp } from "../../modes/utils/keybinding-matchers";
import type { SessionTreeNode } from "../../session/session-entries";
import { toPathList } from "../../tools/path-utils";
import { shortenPath } from "../../tools/render-utils";
import { canonicalizeMessage } from "../../utils/thinking-display";
import { resolveAssistantErrorPresentation } from "../utils/transcript-render-helpers";
import { DynamicBorder } from "./dynamic-border";
import { centeredWindow, contentRowWidth, renderScrollableList } from "./selector-helpers";

const MIN_SPLIT_WIDTH = 100;
const MAX_BRANCH_MAP_NODES = 5_000;

type TreeViewMode = "list" | "map" | "split";

/** Gutter info: position (displayIndent where connector was) and whether to show │ */
interface GutterInfo {
	position: number; // displayIndent level where the connector was shown
	show: boolean; // true = show │, false = show spaces
}

/** Flattened tree node for navigation */
interface FlatNode {
	node: SessionTreeNode;
	/** Indentation level (each level = 3 chars) */
	indent: number;
	/** Whether to show connector (├─ or └─) - true if parent has multiple children */
	showConnector: boolean;
	/** If showConnector, true = last sibling (└─), false = not last (├─) */
	isLast: boolean;
	/** Gutter info for each ancestor branch point */
	gutters: GutterInfo[];
	/** True if this node is a root under a virtual branching root (multiple roots) */
	isVirtualRootChild: boolean;
}

/** Filter mode for tree display */
type FilterMode = TreeFilterMode;

/**
 * Tree list component with selection and ASCII art visualization
 */
/** Tool call info for lookup */
interface ToolCallInfo {
	name: string;
	arguments: Record<string, unknown>;
}

class TreeList implements Component {
	#roots: SessionTreeNode[];
	#flatNodes: FlatNode[] = [];
	#filteredNodes: FlatNode[] = [];
	#selectedIndex = 0;
	#filterMode: FilterMode;
	#searchQuery = "";
	#toolCallMap: Map<string, ToolCallInfo> = new Map();
	#multipleRoots = false;
	#activePathIds: Set<string> = new Set();
	#lastSelectedId: string | null = null;
	#visibleTree: SessionTreeNode[] | undefined;

	onSelect?: (entryId: string, options: { summarize: boolean }) => void;
	onCancel?: () => void;
	onLabelEdit?: (entryId: string, currentLabel: string | undefined) => void;

	constructor(
		tree: SessionTreeNode[],
		private readonly currentLeafId: string | null,
		private maxVisibleLines: number,
		initialFilterMode: FilterMode = "default",
		initialSelectedId?: string,
	) {
		this.#roots = tree;
		this.#filterMode = initialFilterMode;
		this.#multipleRoots = tree.length > 1;
		this.#flatNodes = this.#flattenTree(tree);
		this.#buildActivePath();
		this.#applyFilter();

		// Start with initialSelectedId if provided, otherwise current leaf
		const targetId = initialSelectedId ?? currentLeafId;
		this.#selectedIndex = this.#findNearestVisibleIndex(targetId);
		this.#lastSelectedId = this.#filteredNodes[this.#selectedIndex]?.node.entry.id ?? null;
	}

	/** Build the set of entry IDs on the path from root to current leaf */
	#buildActivePath(): void {
		this.#activePathIds.clear();
		if (!this.currentLeafId) return;

		// Build a map of id -> entry for parent lookup
		const entryMap = new Map<string, FlatNode>();
		for (const flatNode of this.#flatNodes) {
			entryMap.set(flatNode.node.entry.id, flatNode);
		}

		// Walk from leaf to root
		let currentId: string | null = this.currentLeafId;
		while (currentId) {
			this.#activePathIds.add(currentId);
			const node = entryMap.get(currentId);
			if (!node) break;
			currentId = node.node.entry.parentId ?? null;
		}
	}

	/**
	 * Find the index of the nearest visible entry, walking up the parent chain if needed.
	 * Returns the index in filteredNodes, or the last index as fallback.
	 */
	#findNearestVisibleIndex(entryId: string | null): number {
		if (this.#filteredNodes.length === 0) return 0;

		// Build a map for parent lookup
		const entryMap = new Map<string, FlatNode>();
		for (const flatNode of this.#flatNodes) {
			entryMap.set(flatNode.node.entry.id, flatNode);
		}

		// Build a map of visible entry IDs to their indices in filteredNodes
		const visibleIdToIndex = new Map<string, number>(this.#filteredNodes.map((node, i) => [node.node.entry.id, i]));

		// Walk from entryId up to root, looking for a visible entry
		let currentId = entryId;
		while (currentId !== null) {
			const index = visibleIdToIndex.get(currentId);
			if (index !== undefined) return index;
			const node = entryMap.get(currentId);
			if (!node) break;
			currentId = node.node.entry.parentId ?? null;
		}

		// Fallback: last visible entry
		return this.#filteredNodes.length - 1;
	}

	#flattenTree(roots: SessionTreeNode[]): FlatNode[] {
		const result: FlatNode[] = [];
		this.#toolCallMap.clear();

		// Indentation rules:
		// - At indent 0: stay at 0 unless parent has >1 children (then +1)
		// - At indent 1: children always go to indent 2 (visual grouping of subtree)
		// - At indent 2+: stay flat for single-child chains, +1 only if parent branches

		// Stack items: [node, indent, justBranched, showConnector, isLast, gutters, isVirtualRootChild]
		type StackItem = [SessionTreeNode, number, boolean, boolean, boolean, GutterInfo[], boolean];
		const stack: StackItem[] = [];

		// Determine which subtrees contain the active leaf (to sort current branch first)
		// Use iterative post-order traversal to avoid stack overflow
		const containsActive = new Map<SessionTreeNode, boolean>();
		const leafId = this.currentLeafId;
		{
			// Build list in pre-order, then process in reverse for post-order effect
			const allNodes: SessionTreeNode[] = [];
			const preOrderStack: SessionTreeNode[] = [...roots];
			while (preOrderStack.length > 0) {
				const node = preOrderStack.pop()!;
				allNodes.push(node);
				// Push children in reverse so they're processed left-to-right
				for (let i = node.children.length - 1; i >= 0; i--) {
					preOrderStack.push(node.children[i]);
				}
			}
			// Process in reverse (post-order): children before parents
			for (let i = allNodes.length - 1; i >= 0; i--) {
				const node = allNodes[i];
				let has = leafId !== null && node.entry.id === leafId;
				for (const child of node.children) {
					if (containsActive.get(child)) {
						has = true;
					}
				}
				containsActive.set(node, has);
			}
		}

		// Add roots in reverse order, prioritizing the one containing the active leaf
		// If multiple roots, treat them as children of a virtual root that branches
		const multipleRoots = roots.length > 1;
		const orderedRoots = [...roots].sort((a, b) => Number(containsActive.get(b)) - Number(containsActive.get(a)));
		for (let i = orderedRoots.length - 1; i >= 0; i--) {
			const isLast = i === orderedRoots.length - 1;
			stack.push([orderedRoots[i], multipleRoots ? 1 : 0, multipleRoots, multipleRoots, isLast, [], multipleRoots]);
		}

		while (stack.length > 0) {
			const [node, indent, justBranched, showConnector, isLast, gutters, isVirtualRootChild] = stack.pop()!;

			// Extract tool calls from assistant messages for later lookup
			const entry = node.entry;
			if (entry.type === "message" && entry.message.role === "assistant") {
				const content = (entry.message as { content?: unknown }).content;
				if (Array.isArray(content)) {
					for (const block of content) {
						if (typeof block === "object" && block !== null && "type" in block && block.type === "toolCall") {
							const tc = block as { id: string; name: string; arguments: Record<string, unknown> };
							this.#toolCallMap.set(tc.id, { name: tc.name, arguments: tc.arguments });
						}
					}
				}
			}

			result.push({ node, indent, showConnector, isLast, gutters, isVirtualRootChild });

			const children = node.children;
			const multipleChildren = children.length > 1;

			// Order children so the branch containing the active leaf comes first
			const orderedChildren = (() => {
				const prioritized: SessionTreeNode[] = [];
				const rest: SessionTreeNode[] = [];
				for (const child of children) {
					if (containsActive.get(child)) {
						prioritized.push(child);
					} else {
						rest.push(child);
					}
				}
				return [...prioritized, ...rest];
			})();

			// Calculate child indent
			let childIndent: number;
			if (multipleChildren) {
				// Parent branches: children get +1
				childIndent = indent + 1;
			} else if (justBranched && indent > 0) {
				// First generation after a branch: +1 for visual grouping
				childIndent = indent + 1;
			} else {
				// Single-child chain: stay flat
				childIndent = indent;
			}

			// Build gutters for children
			// If this node showed a connector, add a gutter entry for descendants
			// Only add gutter if connector is actually displayed (not suppressed for virtual root children)
			const connectorDisplayed = showConnector && !isVirtualRootChild;
			// When connector is displayed, add a gutter entry at the connector's position
			// Connector is at position (displayIndent - 1), so gutter should be there too
			const currentDisplayIndent = this.#multipleRoots ? Math.max(0, indent - 1) : indent;
			const connectorPosition = Math.max(0, currentDisplayIndent - 1);
			const childGutters: GutterInfo[] = connectorDisplayed
				? [...gutters, { position: connectorPosition, show: !isLast }]
				: gutters;

			// Add children in reverse order
			for (let i = orderedChildren.length - 1; i >= 0; i--) {
				const childIsLast = i === orderedChildren.length - 1;
				stack.push([
					orderedChildren[i],
					childIndent,
					multipleChildren,
					multipleChildren,
					childIsLast,
					childGutters,
					false,
				]);
			}
		}

		return result;
	}

	#applyFilter(): void {
		// Update lastSelectedId only when we have a valid selection (non-empty list)
		// This preserves the selection when switching through empty filter results
		if (this.#filteredNodes.length > 0) {
			this.#lastSelectedId = this.#filteredNodes[this.#selectedIndex]?.node.entry.id ?? this.#lastSelectedId;
		}
		this.#visibleTree = undefined;

		const searchTokens = this.#searchQuery.toLowerCase().split(/\s+/).filter(Boolean);

		this.#filteredNodes = this.#flatNodes.filter(flatNode => {
			const entry = flatNode.node.entry;
			const isCurrentLeaf = entry.id === this.currentLeafId;

			// Skip assistant messages with only tool calls (no text) unless error/aborted
			// Always show current leaf so active position is visible
			if (entry.type === "message" && entry.message.role === "assistant" && !isCurrentLeaf) {
				const msg = entry.message as { stopReason?: string; content?: unknown };
				const hasText = this.#hasTextContent(msg.content);
				const isErrorOrAborted = msg.stopReason && msg.stopReason !== "stop" && msg.stopReason !== "toolUse";
				// Only hide if no text AND not an error/aborted message
				if (!hasText && !isErrorOrAborted) {
					return false;
				}
			}

			// Apply filter mode
			let passesFilter = true;
			// Entry types hidden in default view (settings/bookkeeping)
			const isSettingsEntry =
				entry.type === "label" ||
				entry.type === "custom" ||
				entry.type === "model_change" ||
				entry.type === "thinking_level_change";

			switch (this.#filterMode) {
				case "user-only":
					// Just user messages
					passesFilter = entry.type === "message" && entry.message.role === "user";
					break;
				case "no-tools":
					// Default minus tool results
					passesFilter = !isSettingsEntry && !(entry.type === "message" && entry.message.role === "toolResult");
					break;
				case "labeled-only":
					// Just labeled entries
					passesFilter = flatNode.node.label !== undefined;
					break;
				case "all":
					// Show everything
					passesFilter = true;
					break;
				default:
					// Default mode: hide settings/bookkeeping entries
					passesFilter = !isSettingsEntry;
					break;
			}

			if (!passesFilter) return false;

			// Apply fuzzy search filter
			if (searchTokens.length > 0) {
				const nodeText = this.#getSearchableText(flatNode.node);
				return searchTokens.every(token => fuzzyMatch(token, nodeText).matches);
			}

			return true;
		});

		// Try to preserve cursor on the same node, or find nearest visible ancestor
		if (this.#lastSelectedId) {
			this.#selectedIndex = this.#findNearestVisibleIndex(this.#lastSelectedId);
		} else if (this.#selectedIndex >= this.#filteredNodes.length) {
			// Clamp index if out of bounds
			this.#selectedIndex = Math.max(0, this.#filteredNodes.length - 1);
		}

		// Update lastSelectedId to the actual selection (may have changed due to parent walk)
		if (this.#filteredNodes.length > 0) {
			this.#lastSelectedId = this.#filteredNodes[this.#selectedIndex]?.node.entry.id ?? this.#lastSelectedId;
		}
	}

	/** Get searchable text content from a node */
	#getSearchableText(node: SessionTreeNode): string {
		const entry = node.entry;
		const parts: string[] = [];

		if (node.label) {
			parts.push(node.label);
		}

		switch (entry.type) {
			case "message": {
				const msg = entry.message;
				parts.push(msg.role);
				if ("content" in msg && msg.content) {
					parts.push(this.#extractContent(msg.content));
				}
				if (msg.role === "bashExecution") {
					const bashMsg = msg as { command?: string };
					if (bashMsg.command) parts.push(bashMsg.command);
				}
				break;
			}
			case "custom_message": {
				parts.push(entry.customType);
				if (typeof entry.content === "string") {
					parts.push(entry.content);
				} else {
					parts.push(this.#extractContent(entry.content));
				}
				break;
			}
			case "compaction":
				parts.push("compaction");
				break;
			case "branch_summary":
				parts.push("branch summary", entry.summary);
				break;
			case "model_change":
				parts.push("model", entry.model);
				break;
			case "thinking_level_change":
				parts.push("thinking", entry.thinkingLevel ?? ThinkingLevel.Off);
				break;
			case "custom":
				parts.push("custom", entry.customType);
				break;
			case "label":
				parts.push("label", entry.label ?? "");
				break;
		}

		return parts.join(" ");
	}

	invalidate(): void {}

	getSearchQuery(): string {
		return this.#searchQuery;
	}

	getSelectedNode(): SessionTreeNode | undefined {
		return this.#filteredNodes[this.#selectedIndex]?.node;
	}

	getFilterMode(): FilterMode {
		return this.#filterMode;
	}

	getVisibleNodeCount(): number {
		return this.#filteredNodes.length;
	}

	setMaxVisibleLines(maxVisibleLines: number): void {
		this.maxVisibleLines = Math.max(1, maxVisibleLines);
	}

	getVisibleCurrentLeafId(): string | null {
		if (this.#filteredNodes.length === 0) return null;
		return this.#filteredNodes[this.#findNearestVisibleIndex(this.currentLeafId)]?.node.entry.id ?? null;
	}

	getVisibleTree(): SessionTreeNode[] {
		if (this.#visibleTree) return this.#visibleTree;

		const visibleIds = new Set(this.#filteredNodes.map(node => node.node.entry.id));
		const roots: SessionTreeNode[] = [];
		type ProjectionItem = { node: SessionTreeNode; destination: SessionTreeNode[] };
		const stack: ProjectionItem[] = [];
		for (let index = this.#roots.length - 1; index >= 0; index--) {
			stack.push({ node: this.#roots[index]!, destination: roots });
		}
		while (stack.length > 0) {
			const { node, destination } = stack.pop()!;
			const children: SessionTreeNode[] = [];
			const visible = visibleIds.has(node.entry.id);
			if (visible) destination.push({ ...node, children });
			const childDestination = visible ? children : destination;
			for (let index = node.children.length - 1; index >= 0; index--) {
				stack.push({ node: node.children[index]!, destination: childDestination });
			}
		}

		this.#visibleTree = roots;
		return roots;
	}

	updateNodeLabel(entryId: string, label: string | undefined): void {
		for (const flatNode of this.#flatNodes) {
			if (flatNode.node.entry.id === entryId) {
				flatNode.node.label = label;
				break;
			}
		}
		this.#visibleTree = undefined;
	}

	#selectFirstVisibleInSubtree(root: SessionTreeNode): boolean {
		const visibleIndices = new Map<string, number>(
			this.#filteredNodes.map((node, index) => [node.node.entry.id, index]),
		);
		const stack = [root];
		while (stack.length > 0) {
			const node = stack.pop()!;
			const index = visibleIndices.get(node.entry.id);
			if (index !== undefined) {
				this.#selectedIndex = index;
				this.#lastSelectedId = node.entry.id;
				return true;
			}
			for (let childIndex = node.children.length - 1; childIndex >= 0; childIndex--) {
				stack.push(node.children[childIndex]!);
			}
		}
		return false;
	}

	#moveToSiblingBranch(direction: -1 | 1): void {
		const selected = this.getSelectedNode();
		if (!selected) return;

		const nodeById = new Map<string, SessionTreeNode>(this.#flatNodes.map(node => [node.node.entry.id, node.node]));
		if (selected.children.length > 1) {
			const target = selected.children[direction === 1 ? 0 : selected.children.length - 1]!;
			this.#selectFirstVisibleInSubtree(target);
			return;
		}

		let branchChild = selected;
		let parentId = selected.entry.parentId;
		while (parentId) {
			const parent = nodeById.get(parentId);
			if (!parent) return;
			if (parent.children.length > 1) {
				const currentIndex = parent.children.findIndex(child => child.entry.id === branchChild.entry.id);
				if (currentIndex === -1) return;
				const targetIndex = (currentIndex + direction + parent.children.length) % parent.children.length;
				this.#selectFirstVisibleInSubtree(parent.children[targetIndex]!);
				return;
			}
			branchChild = parent;
			parentId = parent.entry.parentId;
		}

		if (this.#roots.length > 1) {
			const currentIndex = this.#roots.findIndex(root => root.entry.id === branchChild.entry.id);
			if (currentIndex === -1) return;
			const targetIndex = (currentIndex + direction + this.#roots.length) % this.#roots.length;
			this.#selectFirstVisibleInSubtree(this.#roots[targetIndex]!);
		}
	}

	#getFilterLabel(): string {
		switch (this.#filterMode) {
			case "no-tools":
				return " [no-tools]";
			case "user-only":
				return " [user]";
			case "labeled-only":
				return " [labeled]";
			case "all":
				return " [all]";
			default:
				return "";
		}
	}

	render(width: number): readonly string[] {
		const lines: string[] = [];

		if (this.#filteredNodes.length === 0) {
			// Three empty-state shapes:
			//  - flatNodes empty               → no entries at all (truly fresh session).
			//  - search query rejects everything → tell the user the search is the cause.
			//  - filter mode rejects everything  → tell the user the filter is the cause and
			//    how to widen it. Otherwise fresh sessions whose only persisted entries are
			//    `model_change` + `thinking_level_change` (both hidden by the default filter)
			//    read as "broken /tree" — see #1909.
			if (this.#flatNodes.length === 0) {
				lines.push(truncateToWidth(theme.fg("muted", "  No entries found"), width));
				lines.push(truncateToWidth(theme.fg("muted", `  (0/0)${this.#getFilterLabel()}`), width));
			} else if (this.#searchQuery.length > 0) {
				lines.push(truncateToWidth(theme.fg("muted", `  No entries match search "${this.#searchQuery}"`), width));
				lines.push(truncateToWidth(theme.fg("muted", "  Press Backspace to clear the search"), width));
				lines.push(
					truncateToWidth(theme.fg("muted", `  (0/${this.#flatNodes.length})${this.#getFilterLabel()}`), width),
				);
			} else {
				const filterLabel = this.#getFilterLabel().trim() || "[default]";
				lines.push(
					truncateToWidth(
						theme.fg("muted", `  ${this.#flatNodes.length} entries hidden by the current filter ${filterLabel}`),
						width,
					),
				);
				lines.push(truncateToWidth(theme.fg("muted", "  Press Alt+A to show all, Alt+D for default"), width));
				lines.push(
					truncateToWidth(theme.fg("muted", `  (0/${this.#flatNodes.length})${this.#getFilterLabel()}`), width),
				);
			}
			return lines;
		}

		const { startIndex, endIndex } = centeredWindow(
			this.#selectedIndex,
			this.#filteredNodes.length,
			this.maxVisibleLines,
		);

		// Cap the per-row gutter prefix so a content budget is always preserved.
		// Each indent level renders as 3 cells; deep branching would otherwise eat the
		// entire viewport (issue #1144). Reserve at least MIN_CONTENT_COLS for entry
		// text — or half the viewport, whichever is larger — and compress older gutter
		// levels off-screen behind a leading ellipsis when the row would exceed budget.
		const MIN_CONTENT_COLS = 24;
		const OVERHEAD_COLS = 4; // cursor (2) + a touch of breathing room
		const contentReserve = Math.max(MIN_CONTENT_COLS, Math.floor(width / 2));
		const maxIndentLevels = Math.max(1, Math.floor((width - contentReserve - OVERHEAD_COLS) / 3));

		const rowWidth = contentRowWidth(width, this.#filteredNodes.length, this.maxVisibleLines);
		const rows: string[] = [];

		for (let i = startIndex; i < endIndex; i++) {
			const flatNode = this.#filteredNodes[i];
			const entry = flatNode.node.entry;
			const isSelected = i === this.#selectedIndex;

			// Build line: cursor + prefix + path marker + label + content
			const cursor = isSelected ? theme.fg("accent", "› ") : "  ";

			// If multiple roots, shift display (roots at 0, not 1)
			const displayIndent = this.#multipleRoots ? Math.max(0, flatNode.indent - 1) : flatNode.indent;

			// Build prefix with gutters at their correct positions, clamped to
			// `maxIndentLevels` cells so the content always fits. When clamped, the
			// leftmost cells represent the deepest visible ancestors and a `…` marker
			// indicates older branch context has been compressed.
			const hasConnector = flatNode.showConnector && !flatNode.isVirtualRootChild;
			const connectorSymbol = hasConnector ? (flatNode.isLast ? theme.tree.last : theme.tree.branch) : "";
			const connectorChars = hasConnector ? Array.from(connectorSymbol) : [];
			const renderedIndent = Math.min(displayIndent, maxIndentLevels);
			const scrollOffset = displayIndent - renderedIndent;
			const connectorPositionDisplay = hasConnector ? renderedIndent - 1 : -1;
			// Chain rows (no connector of their own) under a last-sibling (`└─`)
			// branch stay anchored by a vertical drawn one level RIGHT of the
			// suppressed gutter — the column where the row's own connector would
			// sit, directly below the branch head's content. Drawing it in the
			// `└─` column itself contradicts the corner and leaves dangling,
			// drifting verticals once the chain branches deeper (#2298, #2325).
			// Chains under `├─` heads need no extra anchor: the sibling line
			// (`show: true` gutter) already ties them to their branch.
			const nearestGutter = !hasConnector ? flatNode.gutters[flatNode.gutters.length - 1] : undefined;
			const chainAnchorLevel = nearestGutter && !nearestGutter.show ? nearestGutter.position + 1 : -1;

			// Build prefix char by char, placing gutters and connector at their positions
			const totalChars = renderedIndent * 3;
			const prefixChars: string[] = [];
			for (let i = 0; i < totalChars; i++) {
				const level = Math.floor(i / 3);
				const originalLevel = level + scrollOffset;
				const posInLevel = i % 3;

				// Check if there's a gutter at this level (translated to original tree depth)
				const gutter = flatNode.gutters.find(g => g.position === originalLevel);
				if (gutter) {
					// Gutters follow standard tree semantics: `│` only while more
					// siblings continue below (`show`), space below a `└─`.
					if (posInLevel === 0) {
						prefixChars.push(gutter.show ? theme.tree.vertical : " ");
					} else {
						prefixChars.push(" ");
					}
				} else if (originalLevel === chainAnchorLevel) {
					// Chain anchor for rows under a `└─` branch head.
					prefixChars.push(posInLevel === 0 ? theme.tree.vertical : " ");
				} else if (hasConnector && level === connectorPositionDisplay) {
					// Connector at this level
					if (posInLevel === 0) {
						prefixChars.push(connectorChars[0] ?? " ");
					} else if (posInLevel === 1) {
						prefixChars.push(connectorChars[1] ?? theme.tree.horizontal);
					} else {
						prefixChars.push(connectorChars[2] ?? " ");
					}
				} else {
					prefixChars.push(" ");
				}
			}
			// Mark the leftmost cell when ancestors were compressed off-screen.
			if (scrollOffset > 0 && prefixChars.length > 0) {
				prefixChars[0] = "…";
			}
			const prefix = prefixChars.join("");

			// Active path marker - shown right before the entry text
			const isOnActivePath = this.#activePathIds.has(entry.id);
			const pathMarker = isOnActivePath ? theme.fg("accent", `${theme.md.bullet} `) : "";

			const label = flatNode.node.label ? theme.fg("warning", `[${flatNode.node.label}] `) : "";
			const content = this.#getEntryDisplayText(flatNode.node, isSelected);

			let line = cursor + theme.fg("dim", prefix) + pathMarker + label + content;
			if (isSelected) {
				line = theme.bg("selectedBg", line);
			}
			rows.push(truncateToWidth(line, rowWidth));
		}

		lines.push(
			...renderScrollableList(rows, {
				width,
				totalRows: this.#filteredNodes.length,
				scrollOffset: startIndex,
			}),
		);

		const filterLabel = this.#getFilterLabel();
		if (filterLabel) {
			lines.push(truncateToWidth(theme.fg("muted", `  ${filterLabel.trim()}`), width));
		}

		return lines;
	}

	#getEntryDisplayText(node: SessionTreeNode, isSelected: boolean): string {
		const entry = node.entry;
		let result: string;

		const normalize = (s: string) => s.replace(/[\n\t]/g, " ").trim();

		switch (entry.type) {
			case "message": {
				const msg = entry.message;
				const role = msg.role;
				if (role === "user") {
					const msgWithContent = msg as { content?: unknown };
					const content = normalize(this.#extractContent(msgWithContent.content));
					result = theme.fg("accent", "user: ") + content;
				} else if (role === "developer") {
					const msgWithContent = msg as { content?: unknown };
					const content = normalize(this.#extractContent(msgWithContent.content));
					result = theme.fg("dim", "developer: ") + theme.fg("muted", content);
				} else if (role === "assistant") {
					const presentation = resolveAssistantErrorPresentation(msg);
					if (presentation.kind === "compact-recovered") {
						result = theme.fg("success", "assistant: ") + theme.fg("dim", presentation.text);
						break;
					}
					const msgWithContent = msg as { content?: unknown; stopReason?: string; errorMessage?: string };
					const textContent = normalize(this.#extractContent(msgWithContent.content));
					if (textContent) {
						result = theme.fg("success", "assistant: ") + textContent;
					} else if (presentation.kind === "full") {
						result =
							theme.fg("success", "assistant: ") + theme.fg("error", normalize(presentation.text).slice(0, 80));
					} else if (msgWithContent.stopReason === "aborted") {
						result = theme.fg("success", "assistant: ") + theme.fg("muted", "(aborted)");
					} else {
						result = theme.fg("success", "assistant: ") + theme.fg("muted", "(no content)");
					}
				} else if (role === "toolResult") {
					const toolMsg = msg as { toolCallId?: string; toolName?: string };
					const toolCall = toolMsg.toolCallId ? this.#toolCallMap.get(toolMsg.toolCallId) : undefined;
					if (toolCall) {
						result = theme.fg("muted", this.#formatToolCall(toolCall.name, toolCall.arguments));
					} else {
						result = theme.fg("muted", `[${toolMsg.toolName ?? "tool"}]`);
					}
				} else if (role === "bashExecution") {
					const bashMsg = msg as { command?: string };
					result = theme.fg("dim", `[bash]: ${normalize(bashMsg.command ?? "")}`);
				} else {
					result = theme.fg("dim", `[${role}]`);
				}
				break;
			}
			case "custom_message": {
				const content =
					typeof entry.content === "string"
						? entry.content
						: entry.content
								.filter((c): c is { type: "text"; text: string } => c.type === "text")
								.map(c => c.text)
								.join("");
				result = theme.fg("customMessageLabel", `[${entry.customType}]: `) + normalize(content);
				break;
			}
			case "compaction": {
				const tokens = Math.round(entry.tokensBefore / 1000);
				result = theme.fg("borderAccent", `[compaction: ${tokens}k tokens]`);
				break;
			}
			case "branch_summary":
				result = theme.fg("warning", `[branch summary]: `) + normalize(entry.summary);
				break;
			case "model_change":
				result = theme.fg("dim", `[model: ${entry.model}]`);
				break;
			case "thinking_level_change":
				result = theme.fg("dim", `[thinking: ${entry.thinkingLevel ?? ThinkingLevel.Off}]`);
				break;
			case "custom":
				result = theme.fg("dim", `[custom: ${entry.customType}]`);
				break;
			case "label":
				result = theme.fg("dim", `[label: ${entry.label ?? "(cleared)"}]`);
				break;
			default:
				result = "";
		}

		return isSelected ? theme.bold(result) : result;
	}

	#extractContent(content: unknown): string {
		const maxLen = 200;
		if (typeof content === "string") return content.slice(0, maxLen);
		if (Array.isArray(content)) {
			let result = "";
			for (const c of content) {
				if (typeof c === "object" && c !== null && "type" in c && c.type === "text") {
					result += (c as { text: string }).text;
					if (result.length >= maxLen) return result.slice(0, maxLen);
				}
			}
			return result;
		}
		return "";
	}

	#hasTextContent(content: unknown): boolean {
		if (typeof content === "string") return Boolean(canonicalizeMessage(content));
		if (Array.isArray(content)) {
			for (const c of content) {
				if (typeof c === "object" && c !== null && "type" in c && c.type === "text") {
					const text = (c as { text?: string }).text;
					if (text && canonicalizeMessage(text)) return true;
				}
			}
		}
		return false;
	}

	#formatToolCall(name: string, args: Record<string, unknown>): string {
		switch (name) {
			case "read": {
				const path = shortenPath(String(args.path || args.file_path || ""));
				const offset = args.offset as number | undefined;
				const limit = args.limit as number | undefined;
				let display = path;
				if (offset !== undefined || limit !== undefined) {
					const start = offset ?? 1;
					const end = limit !== undefined ? start + limit - 1 : "";
					display += `:${start}${end ? `-${end}` : ""}`;
				}
				return `[read: ${display}]`;
			}
			case "write": {
				const path = shortenPath(String(args.path || args.file_path || ""));
				return `[write: ${path}]`;
			}
			case "edit": {
				const path = shortenPath(String(args.path || args.file_path || ""));
				return `[edit: ${path}]`;
			}
			case "bash": {
				const rawCmd = String(args.command || "");
				const cmd = rawCmd
					.replace(/[\n\t]/g, " ")
					.trim()
					.slice(0, 50);
				return `[bash: ${cmd}${rawCmd.length > 50 ? "..." : ""}]`;
			}
			case "grep": {
				const pattern = String(args.pattern || "");
				const searchPathsInput =
					typeof args.paths === "string" || Array.isArray(args.paths)
						? args.paths
						: typeof args.path === "string"
							? args.path
							: undefined;
				const paths = toPathList(searchPathsInput);
				const scope = paths.length > 0 ? paths.join(", ") : ".";
				return `[grep: /${pattern}/ in ${shortenPath(scope)}]`;
			}
			case "glob": {
				const globInput =
					typeof args.path === "string"
						? args.path
						: typeof args.paths === "string" || Array.isArray(args.paths)
							? args.paths
							: undefined;
				const paths = toPathList(globInput);
				const scope = paths.length > 0 ? paths.join(", ") : ".";
				return `[glob: ${shortenPath(scope)}]`;
			}
			case "ls": {
				const path = shortenPath(String(args.path || "."));
				return `[ls: ${path}]`;
			}
			default: {
				// Custom tool - show name and truncated JSON args
				const argsStr = JSON.stringify(args).slice(0, 40);
				return `[${name}: ${argsStr}${JSON.stringify(args).length > 40 ? "..." : ""}]`;
			}
		}
	}

	handleInput(keyData: string): void {
		if (matchesSelectUp(keyData)) {
			this.#selectedIndex = this.#selectedIndex === 0 ? this.#filteredNodes.length - 1 : this.#selectedIndex - 1;
		} else if (matchesSelectDown(keyData)) {
			this.#selectedIndex = this.#selectedIndex === this.#filteredNodes.length - 1 ? 0 : this.#selectedIndex + 1;
		} else if (matchesKey(keyData, "shift+left")) {
			this.#moveToSiblingBranch(-1);
		} else if (matchesKey(keyData, "shift+right")) {
			this.#moveToSiblingBranch(1);
		} else if (matchesKey(keyData, "left")) {
			// Page up
			this.#selectedIndex = Math.max(0, this.#selectedIndex - this.maxVisibleLines);
		} else if (matchesKey(keyData, "right")) {
			// Page down
			this.#selectedIndex = Math.min(this.#filteredNodes.length - 1, this.#selectedIndex + this.maxVisibleLines);
		} else if (matchesKey(keyData, "shift+enter") || matchesKey(keyData, "shift+return")) {
			// Summarize-and-switch: fork with a branch summary without the extra prompt.
			const selected = this.#filteredNodes[this.#selectedIndex];
			if (selected && this.onSelect) {
				this.onSelect(selected.node.entry.id, { summarize: true });
			}
		} else if (matchesKey(keyData, "enter") || matchesKey(keyData, "return") || keyData === "\n") {
			const selected = this.#filteredNodes[this.#selectedIndex];
			if (selected && this.onSelect) {
				this.onSelect(selected.node.entry.id, { summarize: false });
			}
		} else if (matchesAppInterrupt(keyData)) {
			if (this.#searchQuery) {
				this.#searchQuery = "";
				this.#applyFilter();
			} else {
				this.onCancel?.();
			}
		} else if (matchesKey(keyData, "ctrl+c")) {
			this.onCancel?.();
		} else if (matchesKey(keyData, "shift+ctrl+o") || matchesKey(keyData, "ctrl+shift+o")) {
			// Cycle filter backwards
			const modes: FilterMode[] = ["default", "no-tools", "user-only", "labeled-only", "all"];
			const currentIndex = modes.indexOf(this.#filterMode);
			this.#filterMode = modes[(currentIndex - 1 + modes.length) % modes.length];
			this.#applyFilter();
		} else if (matchesKey(keyData, "ctrl+o")) {
			// Cycle filter forwards: default → no-tools → user-only → labeled-only → all → default
			const modes: FilterMode[] = ["default", "no-tools", "user-only", "labeled-only", "all"];
			const currentIndex = modes.indexOf(this.#filterMode);
			this.#filterMode = modes[(currentIndex + 1) % modes.length];
			this.#applyFilter();
		} else if (matchesKey(keyData, "alt+d")) {
			this.#filterMode = "default";
			this.#applyFilter();
		} else if (matchesKey(keyData, "alt+t")) {
			this.#filterMode = "no-tools";
			this.#applyFilter();
		} else if (matchesKey(keyData, "alt+u")) {
			this.#filterMode = "user-only";
			this.#applyFilter();
		} else if (matchesKey(keyData, "alt+l")) {
			this.#filterMode = "labeled-only";
			this.#applyFilter();
		} else if (matchesKey(keyData, "alt+a")) {
			this.#filterMode = "all";
			this.#applyFilter();
		} else if (matchesKey(keyData, "backspace")) {
			if (this.#searchQuery.length > 0) {
				this.#searchQuery = this.#searchQuery.slice(0, -1);
				this.#applyFilter();
			}
		} else if (matchesKey(keyData, "shift+l") && !this.#searchQuery) {
			const selected = this.#filteredNodes[this.#selectedIndex];
			if (selected && this.onLabelEdit) {
				this.onLabelEdit(selected.node.entry.id, selected.node.label);
			}
		} else {
			const printableText = extractPrintableText(keyData);
			if (printableText) {
				this.#searchQuery += printableText;
				this.#applyFilter();
			}
		}
	}
}

/** Component that displays the current search query */
class SearchLine implements Component {
	constructor(private treeList: TreeList) {}

	invalidate(): void {}

	render(width: number): readonly string[] {
		const query = this.treeList.getSearchQuery();
		if (query) {
			return [truncateToWidth(`  ${theme.fg("muted", "Search:")} ${theme.fg("accent", query)}`, width)];
		}
		return [truncateToWidth(`  ${theme.fg("muted", "Search:")}`, width)];
	}

	handleInput(_keyData: string): void {}
}

/** Label input component shown when editing a label */
class LabelInput implements Component {
	#input: Input;
	onSubmit?: (entryId: string, label: string | undefined) => void;
	onCancel?: () => void;

	constructor(
		private readonly entryId: string,
		currentLabel: string | undefined,
	) {
		this.#input = new Input();
		if (currentLabel) {
			this.#input.setValue(currentLabel);
		}
	}

	invalidate(): void {}

	render(width: number): readonly string[] {
		const lines: string[] = [];
		const indent = "  ";
		const availableWidth = width - indent.length;
		lines.push(truncateToWidth(`${indent}${theme.fg("muted", "Label (empty to remove):")}`, width));
		lines.push(...this.#input.render(availableWidth).map(line => truncateToWidth(`${indent}${line}`, width)));
		lines.push(truncateToWidth(`${indent}${theme.fg("dim", "enter: save  esc: cancel")}`, width));
		return lines;
	}

	handleInput(keyData: string): void {
		if (matchesKey(keyData, "enter") || matchesKey(keyData, "return") || keyData === "\n") {
			const value = this.#input.getValue().trim();
			this.onSubmit?.(this.entryId, value || undefined);
		} else if (matchesAppInterrupt(keyData)) {
			this.onCancel?.();
		} else {
			this.#input.handleInput(keyData);
		}
	}
}

interface BranchMapNode {
	node: SessionTreeNode;
	number: number;
	children: BranchMapNode[];
	x: number;
	y: number;
	width: number;
}

interface BranchMapLayout {
	tree: SessionTreeNode[];
	nodeWidth: number;
	roots: BranchMapNode[];
	nodes: BranchMapNode[];
	nodesById: Map<string, BranchMapNode>;
	nodesByY: Map<number, BranchMapNode[]>;
	width: number;
	height: number;
}

/**
 * A top-down tree view. Nodes remain visible instead of collapsing linear
 * runs, so the drawing retains the familiar trunk-and-branches shape.
 */
class BranchMap implements Component {
	#layoutCache: BranchMapLayout | undefined;
	#maxVisibleLines: number;

	constructor(
		private readonly getVisibleTree: () => SessionTreeNode[],
		private readonly getVisibleCurrentLeafId: () => string | null,
		private readonly getSelectedId: () => string | null,
		maxVisibleLines: number,
	) {
		this.#maxVisibleLines = maxVisibleLines;
	}

	invalidate(): void {
		this.#layoutCache = undefined;
	}

	setMaxVisibleLines(maxVisibleLines: number): void {
		this.#maxVisibleLines = Math.max(1, maxVisibleLines);
	}

	#getLayout(nodeWidth: number): BranchMapLayout {
		const tree = this.getVisibleTree();
		if (this.#layoutCache?.tree === tree && this.#layoutCache.nodeWidth === nodeWidth) return this.#layoutCache;

		let number = 1;
		const roots: BranchMapNode[] = [];
		const nodes: BranchMapNode[] = [];
		const nodesById = new Map<string, BranchMapNode>();
		type BuildItem = { node: SessionTreeNode; destination: BranchMapNode[] };
		const buildStack: BuildItem[] = [];
		for (let index = tree.length - 1; index >= 0; index--) {
			buildStack.push({ node: tree[index]!, destination: roots });
		}
		while (buildStack.length > 0) {
			const { node, destination } = buildStack.pop()!;
			const mapNode: BranchMapNode = { node, number: number++, children: [], x: 0, y: 0, width: 0 };
			destination.push(mapNode);
			nodes.push(mapNode);
			nodesById.set(node.entry.id, mapNode);
			for (let index = node.children.length - 1; index >= 0; index--) {
				buildStack.push({ node: node.children[index]!, destination: mapNode.children });
			}
		}

		const siblingGap = 4;
		type MeasureItem = { node: BranchMapNode; measured: boolean };
		const measureStack: MeasureItem[] = roots.map(node => ({ node, measured: false }));
		while (measureStack.length > 0) {
			const item = measureStack.pop()!;
			if (item.measured) {
				const childrenWidth = item.node.children.reduce(
					(total, child, index) => total + child.width + (index > 0 ? siblingGap : 0),
					0,
				);
				item.node.width = Math.max(nodeWidth, childrenWidth);
				continue;
			}
			measureStack.push({ node: item.node, measured: true });
			for (const child of item.node.children) measureStack.push({ node: child, measured: false });
		}

		const width = roots.reduce((total, node, index) => total + node.width + (index > 0 ? siblingGap : 0), 0);
		let left = 0;
		let maxY = 0;
		type PositionItem = { node: BranchMapNode; left: number; depth: number };
		const positionStack: PositionItem[] = [];
		const rootPositions: PositionItem[] = [];
		for (const node of roots) {
			rootPositions.push({ node, left, depth: 0 });
			left += node.width + siblingGap;
		}
		for (let index = rootPositions.length - 1; index >= 0; index--) positionStack.push(rootPositions[index]!);
		while (positionStack.length > 0) {
			const item = positionStack.pop()!;
			const { node } = item;
			node.x = item.left + Math.floor(node.width / 2);
			node.y = item.depth * 4;
			maxY = Math.max(maxY, node.y);
			const childrenWidth = node.children.reduce(
				(total, child, index) => total + child.width + (index > 0 ? siblingGap : 0),
				0,
			);
			let childLeft = item.left + Math.floor((node.width - childrenWidth) / 2);
			const childPositions: PositionItem[] = [];
			for (const child of node.children) {
				childPositions.push({ node: child, left: childLeft, depth: item.depth + 1 });
				childLeft += child.width + siblingGap;
			}
			for (let index = childPositions.length - 1; index >= 0; index--) positionStack.push(childPositions[index]!);
		}

		const nodesByY = new Map<number, BranchMapNode[]>();
		for (const node of nodes) {
			const row = nodesByY.get(node.y);
			if (row) row.push(node);
			else nodesByY.set(node.y, [node]);
		}
		for (const row of nodesByY.values()) row.sort((a, b) => a.x - b.x);

		const layout = { tree, nodeWidth, roots, nodes, nodesById, nodesByY, width, height: maxY + 1 };
		this.#layoutCache = layout;
		return layout;
	}

	render(width: number, showSummaries = true): readonly string[] {
		const nodeWidth = showSummaries ? Math.max(18, Math.min(30, width - 4)) : Math.max(11, Math.min(14, width - 4));
		const layout = this.#getLayout(nodeWidth);
		const { width: mapWidth, height } = layout;
		const selectedId = this.getSelectedId();
		const selected = selectedId ? layout.nodesById.get(selectedId) : undefined;
		const graphWidth = Math.max(1, width - 2);
		const selectedLeft = selected ? selected.x - Math.floor(nodeWidth / 2) : 0;
		const startX = Math.max(0, Math.min(selectedLeft - 2, mapWidth - graphWidth));
		const endX = Math.min(mapWidth, startX + graphWidth);
		const visibleRows = Math.max(1, this.#maxVisibleLines - 1);
		const startY = Math.max(0, Math.min((selected?.y ?? 0) - Math.floor(visibleRows / 2), height - visibleRows));
		const endY = Math.min(height, startY + visibleRows);
		const north = 1;
		const east = 2;
		const south = 4;
		const west = 8;
		const canvas = Array.from({ length: Math.max(0, endY - startY) }, () =>
			Array.from({ length: graphWidth }, () => 0),
		);
		const connect = (x: number, y: number, dx: number, dy: number): void => {
			const nextX = x + dx;
			const nextY = y + dy;
			if (
				x < startX ||
				x >= endX ||
				y < startY ||
				y >= endY ||
				nextX < startX ||
				nextX >= endX ||
				nextY < startY ||
				nextY >= endY
			)
				return;
			if (dx === 0 && dy === 1) {
				canvas[y - startY]![x - startX]! |= south;
				canvas[nextY - startY]![nextX - startX]! |= north;
			} else if (dx === 1 && dy === 0) {
				canvas[y - startY]![x - startX]! |= east;
				canvas[nextY - startY]![nextX - startX]! |= west;
			}
		};
		const vertical = (x: number, from: number, to: number): void => {
			if (x < startX || x >= endX) return;
			for (let y = Math.max(from, startY); y < Math.min(to, endY); y++) connect(x, y, 0, 1);
		};
		const horizontal = (from: number, to: number, y: number): void => {
			if (y < startY || y >= endY) return;
			for (let x = Math.max(from, startX); x < Math.min(to, endX); x++) connect(x, y, 1, 0);
		};
		const drawStack = [...layout.roots];
		while (drawStack.length > 0) {
			const node = drawStack.pop()!;
			if (node.children.length === 1) {
				vertical(node.x, node.y + 1, node.children[0]!.y);
			} else if (node.children.length > 1) {
				const branchY = node.children[0]!.y - 2;
				vertical(node.x, node.y + 1, branchY + 1);
				horizontal(node.children[0]!.x, node.children[node.children.length - 1]!.x, branchY);
				for (const child of node.children) vertical(child.x, branchY, child.y);
			}
			for (let index = node.children.length - 1; index >= 0; index--) drawStack.push(node.children[index]!);
		}

		const lines: string[] = [];
		for (let y = startY; y < endY; y++) {
			const row = canvas[y - startY]!.map(cell => this.#connector(cell)).join("");
			const rowNodes = (layout.nodesByY.get(y) ?? [])
				.filter(
					node =>
						node.y === y &&
						node.x - Math.floor(nodeWidth / 2) >= startX &&
						node.x + Math.ceil(nodeWidth / 2) <= endX,
				)
				.toSorted((a, b) => a.x - b.x);
			const parts: string[] = [];
			let cursor = 0;
			for (const node of rowNodes) {
				const left = node.x - Math.floor(nodeWidth / 2) - startX;
				const label = this.#nodeLabel(node, nodeWidth, showSummaries, selectedId);
				parts.push(row.slice(cursor, left), label);
				cursor = left + nodeWidth;
			}
			parts.push(row.slice(cursor));
			let rendered = parts.join("");
			if (startX > 0) rendered = `…${rendered.slice(1)}`;
			if (endX < mapWidth) rendered = `${rendered.slice(0, -1)}…`;
			lines.push(truncateToWidth(`  ${rendered.trimEnd()}`, width));
		}
		if (startY > 0 && lines.length > 0) lines[0] = theme.fg("muted", "  … ↑");
		if (endY < height && lines.length > 0) lines[lines.length - 1] = theme.fg("muted", "  … ↓");
		lines.push(truncateToWidth(theme.fg("muted", "  › selected  • current session"), width));
		return lines;
	}

	#connector(cell: number): string {
		if (theme.tree.horizontal === "-") {
			return cell === 0 ? " " : cell === 1 || cell === 4 || cell === 5 ? "|" : cell === 10 ? "-" : "+";
		}
		switch (cell) {
			case 0:
				return " ";
			case 1:
			case 4:
			case 5:
				return "│";
			case 2:
			case 8:
			case 10:
				return "─";
			case 3:
				return "└";
			case 6:
				return "┌";
			case 9:
				return "┘";
			case 12:
				return "┐";
			case 7:
				return "├";
			case 13:
				return "┤";
			case 11:
				return "┴";
			case 14:
				return "┬";
			default:
				return "┼";
		}
	}

	#nodeLabel(node: BranchMapNode, nodeWidth: number, showSummary: boolean, selectedId: string | null): string {
		const entry = node.node.entry;
		const selected = entry.id === selectedId;
		const current = entry.id === this.getVisibleCurrentLeafId();
		const role = entry.type === "message" ? entry.message.role : entry.type.replaceAll("_", " ");
		const summary = showSummary ? this.#summary(entry) : "";
		const prefix = selected ? "›" : current ? "•" : " ";
		const content = `${prefix}#${node.number} ${role}${summary ? `: ${summary}` : ""}`;
		const truncated = truncateToWidth(content, nodeWidth - 2, "");
		const label = `[${truncated}${" ".repeat(Math.max(0, nodeWidth - 2 - visibleWidth(truncated)))}]`;
		if (selected) return theme.bg("selectedBg", theme.bold(theme.fg("accent", label)));
		return current ? theme.fg("success", label) : theme.fg("dim", label);
	}

	#summary(entry: SessionTreeNode["entry"]): string {
		if (entry.type === "message") {
			const message = entry.message as { content?: unknown; command?: string };
			if (typeof message.content === "string") return this.#normalizeSummary(message.content);
			if (Array.isArray(message.content)) {
				const text = message.content
					.filter(
						(block): block is { type: "text"; text: string } =>
							typeof block === "object" &&
							block !== null &&
							"type" in block &&
							block.type === "text" &&
							"text" in block &&
							typeof block.text === "string",
					)
					.map(block => block.text)
					.join(" ");
				if (text) return this.#normalizeSummary(text);
			}
			return message.command ? this.#normalizeSummary(message.command) : "";
		}
		if (entry.type === "branch_summary") return this.#normalizeSummary(entry.summary);
		if (entry.type === "label") return this.#normalizeSummary(entry.label ?? "");
		return "";
	}

	#normalizeSummary(text: string): string {
		return replaceTabs(text).replace(/\s+/g, " ").trim();
	}
}

/**
 * Component that renders a session tree selector for navigation.
 *
 * The entry list stays the interaction surface. The adjacent branch map is a
 * read-only topology overview that can be hidden or expanded with Ctrl+G.
 */
export class TreeSelectorComponent implements Component {
	#treeList: TreeList;
	#branchMap: BranchMap;
	#labelInput: LabelInput | null = null;
	#viewMode: TreeViewMode = "split";
	#border = new DynamicBorder();

	constructor(
		tree: SessionTreeNode[],
		currentLeafId: string | null,
		terminalHeight: number,
		onSelect: (entryId: string, options: { summarize: boolean }) => void,
		onCancel: () => void,
		private readonly onLabelChangeCallback?: (entryId: string, label: string | undefined) => void,
		initialFilterMode: FilterMode = "default",
		private readonly getTerminalRows: () => number = () => terminalHeight,
	) {
		const maxVisibleLines = Math.max(1, terminalHeight);

		this.#treeList = new TreeList(tree, currentLeafId, maxVisibleLines, initialFilterMode);
		this.#treeList.onSelect = onSelect;
		this.#treeList.onCancel = onCancel;
		this.#treeList.onLabelEdit = (entryId, currentLabel) => this.#showLabelInput(entryId, currentLabel);
		this.#branchMap = new BranchMap(
			() => this.#treeList.getVisibleTree(),
			() => this.#treeList.getVisibleCurrentLeafId(),
			() => this.#treeList.getSelectedNode()?.entry.id ?? null,
			maxVisibleLines,
		);

		if (tree.length === 0) {
			setTimeout(() => onCancel(), 100);
		}
	}

	#showLabelInput(entryId: string, currentLabel: string | undefined): void {
		this.#labelInput = new LabelInput(entryId, currentLabel);
		this.#labelInput.onSubmit = (id, label) => {
			this.#treeList.updateNodeLabel(id, label);
			this.onLabelChangeCallback?.(id, label);
			this.#hideLabelInput();
		};
		this.#labelInput.onCancel = () => this.#hideLabelInput();
	}

	#hideLabelInput(): void {
		this.#labelInput = null;
	}

	invalidate(): void {
		this.#treeList.invalidate();
		this.#branchMap.invalidate();
		this.#labelInput?.invalidate();
		this.#border.invalidate();
	}

	render(width: number): readonly string[] {
		const terminalRows = Math.max(1, this.getTerminalRows());
		const lines: string[] = [""];
		const border = this.#border.render(width)[0]!;
		lines.push(border);
		if (this.#labelInput) {
			lines.push(truncateToWidth(theme.bold("  Session Tree"), width));
			lines.push(border);
			lines.push("");
			const bodyRows = Math.max(1, terminalRows - 7);
			lines.push(...this.#labelInput.render(width).slice(0, bodyRows));
		} else {
			const requestedMode = this.#viewMode === "split" && width < MIN_SPLIT_WIDTH ? "list" : this.#viewMode;
			const visibleNodeCount = this.#treeList.getVisibleNodeCount();
			const mapUnavailable = requestedMode !== "list" && visibleNodeCount > MAX_BRANCH_MAP_NODES;
			const effectiveMode = mapUnavailable ? "list" : requestedMode;
			const compactChrome = terminalRows < 24;
			const minimalChrome = terminalRows < 16;
			const title =
				effectiveMode === "map"
					? "  Branch Map"
					: effectiveMode === "split"
						? `  Session Tree${" ".repeat(
								Math.max(2, this.#splitListWidth(width) + 3 - visibleWidth("  Session Tree")),
							)}Branch Map`
						: "  Session Tree";
			lines.push(truncateToWidth(theme.bold(title), width));
			const filterLines = this.#renderFilterStatus(width, compactChrome);
			const shortcutLines = this.#renderShortcutHelp(width, compactChrome, minimalChrome);
			const searchLines = effectiveMode !== "map" ? [new SearchLine(this.#treeList).render(width)[0]!] : [];
			const mapLimitLines = mapUnavailable ? [this.#renderMapLimitStatus(width, visibleNodeCount)] : [];
			const bodyRows = Math.max(
				1,
				terminalRows - 7 - filterLines.length - shortcutLines.length - searchLines.length - mapLimitLines.length,
			);
			this.#treeList.setMaxVisibleLines(bodyRows);
			this.#branchMap.setMaxVisibleLines(bodyRows);
			lines.push(...filterLines, ...mapLimitLines, ...shortcutLines, ...searchLines);
			lines.push(border);
			lines.push("");
			let bodyLines: readonly string[];
			if (effectiveMode === "split") {
				bodyLines = this.#renderSplitView(width);
			} else if (effectiveMode === "map" && visibleNodeCount > 0) {
				bodyLines = this.#branchMap.render(width, true);
			} else {
				bodyLines = this.#treeList.render(width);
			}
			lines.push(...bodyLines.slice(0, bodyRows));
		}
		lines.push("");
		lines.push(border);
		return lines.slice(0, terminalRows);
	}

	#renderSplitView(width: number): readonly string[] {
		const separator = " │ ";
		const listWidth = this.#splitListWidth(width);
		const mapWidth = Math.max(1, width - separator.length - listWidth);
		const listLines = this.#treeList.render(listWidth);
		const mapLines = this.#branchMap.render(mapWidth, false);
		const rowCount = Math.max(listLines.length, mapLines.length);
		const lines: string[] = [];
		for (let index = 0; index < rowCount; index++) {
			const left = truncateToWidth(listLines[index] ?? "", listWidth);
			const paddedLeft = left + " ".repeat(Math.max(0, listWidth - visibleWidth(left)));
			const right = truncateToWidth(mapLines[index] ?? "", mapWidth);
			lines.push(truncateToWidth(`${paddedLeft}${theme.fg("border", separator)}${right}`, width));
		}
		return lines;
	}

	#renderShortcutHelp(width: number, compact: boolean, minimal: boolean): readonly string[] {
		if (minimal) return [];
		const key = (text: string): string => theme.fg("accent", text);
		const description = (text: string): string => theme.fg("muted", text);
		if (compact) {
			return [
				truncateToWidth(
					`  ${key("↑/↓")}${description(" select   ")}${key("Enter")}${description(" confirm   ")}${key("Ctrl+G")}${description(" view   ")}${key("Ctrl+O")}${description(" filter")}`,
					width,
				),
			];
		}
		const line = (section: string, parts: readonly string[]): string =>
			truncateToWidth(`  ${theme.fg("accent", section.padEnd(11))}${parts.join("")}`, width);
		return [
			line("Navigate", [
				key("↑/↓"),
				description(" select   "),
				key("Shift+←/→"),
				description(" sibling branch (wraps)   "),
				key("Enter"),
				description(" confirm"),
			]),
			line("Actions", [
				key("Shift+Enter"),
				description(" summarize + switch   "),
				key("Shift+L"),
				description(" label   "),
				key("Ctrl+O"),
				description(" filter"),
			]),
			line("View", [key("Ctrl+G"), description(" list / tree / split   "), key("Type"), description(" to search")]),
		];
	}

	#renderFilterStatus(width: number, compact: boolean): readonly string[] {
		const mode = this.#treeList.getFilterMode();
		const filters: Array<{ mode: FilterMode; label: string }> = [
			{ mode: "default", label: "Default" },
			{ mode: "no-tools", label: "No tools" },
			{ mode: "user-only", label: "User only" },
			{ mode: "labeled-only", label: "Labeled" },
			{ mode: "all", label: "All" },
		];
		const chips = filters
			.map(filter =>
				filter.mode === mode
					? theme.bg("selectedBg", theme.bold(theme.fg("accent", `[${filter.label}]`)))
					: theme.fg("muted", filter.label),
			)
			.join("  ");
		const description = (() => {
			switch (mode) {
				case "no-tools":
					return "content entries; tool results hidden";
				case "user-only":
					return "user messages only";
				case "labeled-only":
					return "labeled entries only";
				case "all":
					return "all persisted entries";
				default:
					return "content entries; labels and internal events hidden";
			}
		})();
		if (compact) {
			const active = filters.find(filter => filter.mode === mode)!;
			return [
				truncateToWidth(
					`  ${theme.fg("muted", "Filter:")} ${theme.bold(theme.fg("accent", active.label))} ${theme.fg("dim", `— ${description}`)}`,
					width,
				),
			];
		}
		return [
			truncateToWidth(`  ${theme.fg("muted", "Filter")}  ${chips}`, width),
			truncateToWidth(`  ${theme.fg("muted", "Showing:")} ${theme.fg("dim", description)}`, width),
		];
	}

	#renderMapLimitStatus(width: number, visibleNodeCount: number): string {
		return truncateToWidth(
			theme.fg(
				"warning",
				`  Branch Map unavailable for ${visibleNodeCount.toLocaleString()} visible entries (limit ${MAX_BRANCH_MAP_NODES.toLocaleString()}). Search or filter to narrow the tree.`,
			),
			width,
		);
	}

	#splitListWidth(width: number): number {
		return Math.max(40, Math.floor((width - 3) * 0.62));
	}

	handleInput(keyData: string): void {
		if (this.#labelInput) {
			this.#labelInput.handleInput(keyData);
		} else if (matchesKey(keyData, "ctrl+g")) {
			const modes: TreeViewMode[] = ["split", "map", "list"];
			this.#viewMode = modes[(modes.indexOf(this.#viewMode) + 1) % modes.length]!;
		} else {
			this.#treeList.handleInput(keyData);
		}
	}

	getTreeList(): TreeList {
		return this.#treeList;
	}
}
