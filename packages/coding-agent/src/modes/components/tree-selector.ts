import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import {
	type Component,
	Container,
	extractPrintableText,
	fuzzyMatch,
	Input,
	matchesKey,
	Spacer,
	Text,
	TruncatedText,
	truncateToWidth,
} from "@oh-my-pi/pi-tui";
import type { TreeFilterMode } from "../../config/settings-schema";
import { theme } from "../../modes/theme/theme";
import {
	matchesAppInterrupt,
	matchesSelectDown,
	matchesSelectPageDown,
	matchesSelectPageUp,
	matchesSelectUp,
} from "../../modes/utils/keybinding-matchers";
import type { SessionTreeNode } from "../../session/session-entries";
import { toPathList } from "../../tools/path-utils";
import { shortenPath } from "../../tools/render-utils";
import { canonicalizeMessage } from "../../utils/thinking-display";
import { resolveAssistantErrorPresentation } from "../utils/transcript-render-helpers";
import { DynamicBorder } from "./dynamic-border";
import { centeredWindow, contentRowWidth, renderScrollableList } from "./selector-helpers";

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
	#flatNodes: FlatNode[] = [];
	#filteredNodes: FlatNode[] = [];
	#selectedIndex = 0;
	#filterMode: FilterMode;
	#searchQuery = "";
	#toolCallMap: Map<string, ToolCallInfo> = new Map();
	#multipleRoots = false;
	#activePathIds: Set<string> = new Set();
	#lastSelectedId: string | null = null;
	#collapsedIds: Set<string> = new Set();
	#hiddenDescendantCounts: Map<string, number> = new Map();

	onSelect?: (entryId: string, options: { summarize: boolean }) => void;
	onCancel?: () => void;
	onLabelEdit?: (entryId: string, currentLabel: string | undefined) => void;

	constructor(
		tree: SessionTreeNode[],
		private readonly currentLeafId: string | null,
		private readonly maxVisibleLines: number,
		initialFilterMode: FilterMode = "default",
		initialSelectedId?: string,
	) {
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

		// A real branch point adds one indentation level. Linear conversation
		// chains retain that level so their text stays aligned with the branch
		// head instead of drifting right after every fork.

		// Stack items: [node, indent, showConnector, isLast, gutters, isVirtualRootChild]
		type StackItem = [SessionTreeNode, number, boolean, boolean, GutterInfo[], boolean];
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
			stack.push([orderedRoots[i], multipleRoots ? 1 : 0, multipleRoots, isLast, [], multipleRoots]);
		}

		while (stack.length > 0) {
			const [node, indent, showConnector, isLast, gutters, isVirtualRootChild] = stack.pop()!;

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

			// Real branch points add visual depth, and a virtual root's direct
			// children (the session roots) nest one level under the shared column-0
			// root. Linear continuations otherwise stay aligned with their head.
			const childIndent = multipleChildren || isVirtualRootChild ? indent + 1 : indent;

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
				stack.push([orderedChildren[i], childIndent, multipleChildren, childIsLast, childGutters, false]);
			}
		}

		return result;
	}

	/**
	 * Drop the descendants of collapsed nodes and record how many each collapse
	 * hides. `#flatNodes` is pre-order, so a node's parent is always classified
	 * before the node itself — one linear pass, no per-node ancestor walk.
	 *
	 * Connector metadata is deliberately left alone. A collapsed subtree is
	 * hidden the same way a filtered one is, so the gutters of the rows that
	 * survive keep describing the real tree they belong to.
	 */
	#hideCollapsedDescendants(flatNodes: FlatNode[]): FlatNode[] {
		this.#hiddenDescendantCounts.clear();
		if (this.#collapsedIds.size === 0) return flatNodes;

		// id -> the collapsed ancestor that hid it, so counts land on the node the
		// user actually collapsed rather than on intermediate descendants.
		const hiddenUnder = new Map<string, string>();
		return flatNodes.filter(flatNode => {
			const parentId = flatNode.node.entry.parentId;
			if (!parentId) return true;
			// An already-hidden parent wins over a collapsed one: a collapse nested
			// inside another collapse is invisible, so its descendants belong to the
			// outermost fold — the only one whose count the user can see.
			const collapseRoot = hiddenUnder.get(parentId) ?? (this.#collapsedIds.has(parentId) ? parentId : undefined);
			if (collapseRoot === undefined) return true;
			hiddenUnder.set(flatNode.node.entry.id, collapseRoot);
			this.#hiddenDescendantCounts.set(collapseRoot, (this.#hiddenDescendantCounts.get(collapseRoot) ?? 0) + 1);
			return false;
		});
	}

	/**
	 * Whether a row survives the current filter mode and search, ignoring
	 * collapse. Split out of {@link #applyFilter} because folding a branch has to
	 * know which of its rows the user can actually see.
	 */
	#passesFilter(flatNode: FlatNode, searchTokens: string[]): boolean {
		const entry = flatNode.node.entry;
		const isCurrentLeaf = entry.id === this.currentLeafId;

		// Skip assistant messages with only tool calls (no text) unless error/aborted
		// Always show current leaf so active position is visible
		if (entry.type === "message" && entry.message.role === "assistant" && !isCurrentLeaf) {
			const msg = entry.message as { stopReason?: string; content?: unknown };
			const hasText = this.#hasTextContent(msg.content);
			const isErrorOrAborted = msg.stopReason && msg.stopReason !== "stop" && msg.stopReason !== "toolUse";
			// Only hide if no text AND not an error/aborted message
			if (!hasText && !isErrorOrAborted) return false;
		}

		// Entry types hidden in default view (settings/bookkeeping)
		const isSettingsEntry =
			entry.type === "label" ||
			entry.type === "custom" ||
			entry.type === "model_change" ||
			entry.type === "thinking_level_change";

		let passesFilter: boolean;
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
	}

	#applyFilter(): void {
		// Update lastSelectedId only when we have a valid selection (non-empty list)
		// This preserves the selection when switching through empty filter results
		if (this.#filteredNodes.length > 0) {
			this.#lastSelectedId = this.#filteredNodes[this.#selectedIndex]?.node.entry.id ?? this.#lastSelectedId;
		}

		// Collapse first, filter second: a collapsed subtree is gone regardless of
		// which filter mode is active.
		const searchTokens = this.#searchQuery.toLowerCase().split(/\s+/).filter(Boolean);
		this.#filteredNodes = this.#hideCollapsedDescendants(this.#flatNodes).filter(flatNode =>
			this.#passesFilter(flatNode, searchTokens),
		);

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

	/** Entry ids currently drawn, in display order. */
	getVisibleEntryIds(): string[] {
		return this.#filteredNodes.map(flatNode => flatNode.node.entry.id);
	}

	isCollapsed(entryId: string): boolean {
		return this.#collapsedIds.has(entryId);
	}

	/**
	 * Collapse or expand the selected node's subtree. Childless nodes are left
	 * alone so the key is a no-op instead of a silent state change the user
	 * cannot see or undo.
	 */
	toggleCollapse(): void {
		const selected = this.#filteredNodes[this.#selectedIndex];
		if (!selected || selected.node.children.length === 0) return;
		const entryId = selected.node.entry.id;
		if (!this.#collapsedIds.delete(entryId)) this.#collapsedIds.add(entryId);
		this.#applyFilter();
	}

	/**
	 * Fold every branch that hangs off the current thread, leaving the path to
	 * the active leaf fully expanded and each abandoned branch showing as a
	 * single row. Pressing it again expands everything.
	 *
	 * This is the useful shape of a bulk collapse: folding *all* fork points also
	 * folds the thread you are reading, which is the one thing you never want
	 * hidden.
	 */
	focusCurrentThread(): void {
		if (this.#collapsedIds.size > 0) {
			this.#collapsedIds.clear();
			this.#applyFilter();
			return;
		}
		const searchTokens = this.#searchQuery.toLowerCase().split(/\s+/).filter(Boolean);
		const byId = new Map(this.#flatNodes.map(flatNode => [flatNode.node.entry.id, flatNode]));
		for (const flatNode of this.#flatNodes) {
			const { id, parentId } = flatNode.node.entry;
			// One fold per off-thread branch, anchored at its head — the first node
			// that leaves the active path. Folding its descendants too would be
			// invisible (they are already hidden) and would leave stale collapse
			// state behind once the head is reopened.
			if (this.#activePathIds.has(id)) continue;
			if (!parentId || !this.#activePathIds.has(parentId)) continue;

			// The head itself is often filtered away (a bare tool call, say). Folding
			// it would hide the branch entirely, marker and count included, so the
			// fold slides down to the first row the user can actually see.
			let anchor: FlatNode | undefined = flatNode;
			while (anchor && !this.#passesFilter(anchor, searchTokens)) {
				anchor = anchor.node.children.length === 1 ? byId.get(anchor.node.children[0]!.entry.id) : undefined;
			}
			if (!anchor || anchor.node.children.length === 0) continue;
			this.#collapsedIds.add(anchor.node.entry.id);
		}
		this.#applyFilter();
	}

	/**
	 * Move the cursor along the branch you are on: `-1` climbs to the nearest
	 * fork above the selection, `1` descends to the nearest fork below it. Both
	 * follow parent links rather than screen order, so a fork on a sibling branch
	 * is never what you land on — with the active branch drawn first, the row
	 * above the cursor often belongs to another thread entirely. Row depth cannot
	 * stand in for this: linear continuations share their branch head's indent.
	 *
	 * A fork whose branches are hidden (collapsed, or filtered away) is not a
	 * fork worth stopping at, so what counts is the visible child count. With no
	 * fork left in the chosen direction the cursor rides the chain to its end.
	 */
	jumpToBranchPoint(direction: 1 | -1): void {
		const nodes = this.#filteredNodes;
		const current = nodes[this.#selectedIndex];
		if (!current) return;

		const indexById = new Map<string, number>();
		const visibleChildCounts = new Map<string, number>();
		const firstChildByParent = new Map<string, number>();
		for (let i = 0; i < nodes.length; i++) {
			indexById.set(nodes[i].node.entry.id, i);
			const parentId = nodes[i].node.entry.parentId;
			if (!parentId) continue;
			visibleChildCounts.set(parentId, (visibleChildCounts.get(parentId) ?? 0) + 1);
			if (!firstChildByParent.has(parentId)) firstChildByParent.set(parentId, i);
		}
		const isFork = (index: number): boolean => (visibleChildCounts.get(nodes[index].node.entry.id) ?? 0) > 1;
		// Ancestry comes off the full tree: a hidden parent still links its child
		// to the fork above it.
		const parentByChild = new Map<string, string | null>(
			this.#flatNodes.map(flatNode => [flatNode.node.entry.id, flatNode.node.entry.parentId]),
		);

		if (direction < 0) {
			// Skip straight over ancestors the filter hid, or the climb would stop
			// dead at the first gap instead of reaching the fork above it.
			let parentId = current.node.entry.parentId;
			let highest = -1;
			const seen = new Set<string>();
			while (parentId && !seen.has(parentId)) {
				seen.add(parentId);
				const index = indexById.get(parentId);
				if (index !== undefined) {
					highest = index;
					if (isFork(index)) {
						this.#selectedIndex = index;
						return;
					}
				}
				parentId = parentByChild.get(parentId) ?? null;
			}
			if (highest >= 0) this.#selectedIndex = highest;
			return;
		}

		// The first child listed is the one on the active branch, which is the
		// thread being read.
		let index = firstChildByParent.get(current.node.entry.id);
		let deepest = -1;
		while (index !== undefined) {
			deepest = index;
			if (isFork(index)) {
				this.#selectedIndex = index;
				return;
			}
			index = firstChildByParent.get(nodes[index].node.entry.id);
		}
		if (deepest >= 0) this.#selectedIndex = deepest;
	}

	updateNodeLabel(entryId: string, label: string | undefined): void {
		for (const flatNode of this.#flatNodes) {
			if (flatNode.node.entry.id === entryId) {
				flatNode.node.label = label;
				break;
			}
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
			// Linear rows reuse their branch head's depth. Existing sibling
			// gutters remain visible; terminal gutters remain terminated.

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

			// Only collapsed rows carry a marker. Reserving a chevron column for
			// every row would push all content right and stamp one on each link of
			// every single-child chain — noise on the common case, and it disturbs
			// the connector geometry the tree is read by.
			const hidden = this.#hiddenDescendantCounts.get(entry.id) ?? 0;
			const collapseMarker = hidden > 0 ? theme.fg("warning", `${theme.nav.expand} `) : "";
			const hiddenCount = hidden > 0 ? theme.fg("muted", ` (+${hidden})`) : "";

			const label = flatNode.node.label ? theme.fg("warning", `[${flatNode.node.label}] `) : "";
			const content = this.#getEntryDisplayText(flatNode.node, isSelected);

			let line = cursor + theme.fg("dim", prefix) + collapseMarker + pathMarker + label + content + hiddenCount;
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

	#moveToAdjacentTurn(direction: -1 | 1): void {
		for (
			let index = this.#selectedIndex + direction;
			index >= 0 && index < this.#filteredNodes.length;
			index += direction
		) {
			const entry = this.#filteredNodes[index]?.node.entry;
			if (entry?.type === "message" && (entry.message.role === "user" || entry.message.role === "assistant")) {
				this.#selectedIndex = index;
				return;
			}
		}
	}

	handleInput(keyData: string): void {
		if (matchesSelectUp(keyData)) {
			this.#selectedIndex = this.#selectedIndex === 0 ? this.#filteredNodes.length - 1 : this.#selectedIndex - 1;
		} else if (matchesSelectDown(keyData)) {
			this.#selectedIndex = this.#selectedIndex === this.#filteredNodes.length - 1 ? 0 : this.#selectedIndex + 1;
		} else if (matchesKey(keyData, "alt+up")) {
			this.#moveToAdjacentTurn(-1);
		} else if (matchesKey(keyData, "alt+down")) {
			this.#moveToAdjacentTurn(1);
		} else if (matchesKey(keyData, "home")) {
			this.#selectedIndex = 0;
		} else if (matchesKey(keyData, "end")) {
			this.#selectedIndex = Math.max(0, this.#filteredNodes.length - 1);
		} else if (matchesKey(keyData, "left")) {
			this.jumpToBranchPoint(-1);
		} else if (matchesKey(keyData, "right")) {
			this.jumpToBranchPoint(1);
		} else if (matchesSelectPageUp(keyData)) {
			this.#selectedIndex = Math.max(0, this.#selectedIndex - this.maxVisibleLines);
		} else if (matchesSelectPageDown(keyData)) {
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
		} else if (matchesKey(keyData, "shift+tab")) {
			this.focusCurrentThread();
		} else if (matchesKey(keyData, "tab") || (matchesKey(keyData, "space") && !this.#searchQuery)) {
			// Space is the natural collapse key, but it is also a search character,
			// so it only collapses while no search is being typed. Tab always works.
			this.toggleCollapse();
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

/**
 * Component that renders a session tree selector for navigation
 */
export class TreeSelectorComponent extends Container {
	#treeList: TreeList;
	#labelInput: LabelInput | null = null;
	#labelInputContainer: Container;
	#treeContainer: Container;

	constructor(
		tree: SessionTreeNode[],
		currentLeafId: string | null,
		terminalHeight: number,
		onSelect: (entryId: string, options: { summarize: boolean }) => void,
		onCancel: () => void,
		private readonly onLabelChangeCallback?: (entryId: string, label: string | undefined) => void,
		initialFilterMode: FilterMode = "default",
	) {
		super();
		const maxVisibleLines = Math.max(5, Math.floor(terminalHeight / 2));

		this.#treeList = new TreeList(tree, currentLeafId, maxVisibleLines, initialFilterMode);
		this.#treeList.onSelect = onSelect;
		this.#treeList.onCancel = onCancel;
		this.#treeList.onLabelEdit = (entryId, currentLabel) => this.#showLabelInput(entryId, currentLabel);

		this.#treeContainer = new Container();
		this.#treeContainer.addChild(this.#treeList);

		this.#labelInputContainer = new Container();
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());
		this.addChild(new Text(theme.bold("  Session Tree"), 1, 0));
		this.addChild(
			new TruncatedText(
				theme.fg(
					"muted",
					"Enter: switch. Space: collapse. Alt+↑/↓: previous/next turn. ←/→: fork above/below. PgUp/PgDn: page. Home/End: first/last item. Shift+Tab: focus thread. Shift+Enter: summarize & switch. Shift+L: label. Ctrl+O: filter. Alt+D/T/U/L/A: filter. Type to search",
				),
				0,
				0,
			),
		);
		this.addChild(new SearchLine(this.#treeList));
		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));
		this.addChild(this.#treeContainer);
		this.addChild(this.#labelInputContainer);
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());

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

		this.#treeContainer.clear();
		this.#labelInputContainer.clear();
		this.#labelInputContainer.addChild(this.#labelInput);
	}

	#hideLabelInput(): void {
		this.#labelInput = null;
		this.#labelInputContainer.clear();
		this.#treeContainer.clear();
		this.#treeContainer.addChild(this.#treeList);
	}

	handleInput(keyData: string): void {
		if (this.#labelInput) {
			this.#labelInput.handleInput(keyData);
		} else {
			this.#treeList.handleInput(keyData);
		}
	}

	getTreeList(): TreeList {
		return this.#treeList;
	}
}
