import { type Component, truncateToWidth } from "@oh-my-pi/pi-tui";

export interface ExpandableTranscriptComponent extends Component {
	setExpanded(expanded: boolean): void;
}

interface VersionedTranscriptComponent extends Component {
	getTranscriptBlockVersion(): number;
}

interface FinalizableTranscriptComponent extends Component {
	isTranscriptBlockFinalized(): boolean;
}

export interface TurnActivityCommentaryChild {
	readonly kind: "commentary";
	readonly component: Component;
	readonly textSignature?: unknown;
	readonly textSignatures?: readonly unknown[];
}

export interface TurnActivityToolCallChild {
	readonly kind: "tool";
	readonly component: Component;
	readonly toolCallId?: string;
	readonly toolCallIds?: readonly string[];
}

export type TurnActivityChild = TurnActivityCommentaryChild | TurnActivityToolCallChild;

export interface TurnActivityCounts {
	readonly toolCalls: number;
	readonly messages: number;
}

interface ChildEntry {
	readonly child: TurnActivityChild;
	readonly component: Component;
	readonly commentaryIds: readonly string[];
	readonly toolCallIds: readonly string[];
}

const EMPTY_LINES: readonly string[] = Object.freeze([]);
const EMPTY_CONTRIBUTIONS: readonly (readonly string[])[] = Object.freeze([]);
const NON_WHITESPACE = /\S/u;

function isPlainBlank(line: string): boolean {
	return !NON_WHITESPACE.test(line);
}

function stripPlainBlankEdges(lines: readonly string[]): readonly string[] {
	let start = 0;
	let end = lines.length;
	while (start < end && isPlainBlank(lines[start]!)) start++;
	while (end > start && isPlainBlank(lines[end - 1]!)) end--;
	if (start === end) return EMPTY_LINES;
	return start === 0 && end === lines.length ? lines : lines.slice(start, end);
}

function parseCommentaryTextSignatureId(signature: unknown): string | undefined {
	if (typeof signature !== "string" || signature.length === 0 || !signature.startsWith("{")) {
		return undefined;
	}

	try {
		const parsed: unknown = JSON.parse(signature);
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
		const record = parsed as Record<string, unknown>;
		if (record.v !== 1) return undefined;
		if (record.phase !== "commentary") return undefined;
		return typeof record.id === "string" && record.id.length > 0 ? record.id : undefined;
	} catch {
		return undefined;
	}
}

function hasSetExpanded(component: Component): component is ExpandableTranscriptComponent {
	return typeof (component as Partial<ExpandableTranscriptComponent>).setExpanded === "function";
}

function hasTranscriptBlockVersion(component: Component): component is VersionedTranscriptComponent {
	return "getTranscriptBlockVersion" in component && typeof component.getTranscriptBlockVersion === "function";
}

function hasTranscriptBlockFinalized(component: Component): component is FinalizableTranscriptComponent {
	return "isTranscriptBlockFinalized" in component && typeof component.isTranscriptBlockFinalized === "function";
}

function uniqueStrings(values: Iterable<string | undefined>): readonly string[] {
	const ids = new Set<string>();
	for (const value of values) {
		if (typeof value === "string" && value.length > 0) ids.add(value);
	}
	return Array.from(ids);
}

function commentarySignatures(child: TurnActivityCommentaryChild): readonly unknown[] {
	const signatures: unknown[] = [];
	if (child.textSignature !== undefined) signatures.push(child.textSignature);
	if (child.textSignatures !== undefined) signatures.push(...child.textSignatures);
	return signatures;
}

function normalizeChild(child: TurnActivityChild): ChildEntry {
	if (child.kind === "commentary") {
		return {
			child,
			component: child.component,
			commentaryIds: uniqueStrings(commentarySignatures(child).map(parseCommentaryTextSignatureId)),
			toolCallIds: EMPTY_LINES,
		};
	}

	return {
		child,
		component: child.component,
		commentaryIds: EMPTY_LINES,
		toolCallIds: uniqueStrings([child.toolCallId, ...(child.toolCallIds ?? [])]),
	};
}

function formatCountRow(counts: TurnActivityCounts): string {
	const toolLabel = counts.toolCalls === 1 ? "tool call" : "tool calls";
	const messageLabel = counts.messages === 1 ? "message" : "messages";
	return `› ${counts.toolCalls} ${toolLabel}, ${counts.messages} ${messageLabel}`;
}

function formatCollapsedRow(counts: TurnActivityCounts, latestSummary: string | undefined, width: number): string {
	const countRow = formatCountRow(counts);
	if (latestSummary === undefined) return truncateToWidth(countRow, width);
	const summaryWidth = width - Bun.stringWidth(countRow) - 2;
	if (summaryWidth < 1) return truncateToWidth(countRow, width);
	return `${truncateToWidth(latestSummary, summaryWidth)}  ${countRow}`;
}

function contributionsEqual(left: readonly string[], right: readonly string[]): boolean {
	if (left === right) return true;
	if (left.length !== right.length) return false;
	for (let i = 0; i < left.length; i++) {
		if (left[i] !== right[i]) return false;
	}
	return true;
}

/**
 * Root transcript component that collapses one assistant turn's commentary and
 * tool activity into a single count row while preserving the native child
 * components for ordered Ctrl+O expansion.
 */
export class TurnActivityGroup implements Component {
	#entries: ChildEntry[] = [];
	#expanded = false;
	#finalized = false;
	#disposed = false;
	#localVersion = 0;
	#counts: TurnActivityCounts = { toolCalls: 0, messages: 0 };
	#commentaryIds = new Set<string>();
	#toolCallIds = new Set<string>();
	#assistantMessages = new WeakSet<Component>();
	#assistantMessageCount = 0;
	#latestThinkingSummary: string | undefined;
	#collapsedRows: readonly string[] | undefined;
	#collapsedVersion = -1;
	#collapsedWidth = -1;
	#expandedRows: readonly string[] | undefined;
	#expandedVersion = -1;
	#expandedWidth = -1;
	#lastVersionFingerprint: string | undefined;
	#reportedBlockVersion = 0;
	#expandedContributions: readonly (readonly string[])[] = EMPTY_CONTRIBUTIONS;

	constructor(children: readonly TurnActivityChild[] = []) {
		for (const child of children) this.addChild(child);
	}

	get expanded(): boolean {
		return this.#expanded;
	}

	getCounts(): TurnActivityCounts {
		return this.#counts;
	}

	observeCommentarySignatures(signatures: readonly unknown[]): void {
		this.#assertNotDisposed();
		if (this.#addCommentarySignatures(signatures)) this.#touch();
	}

	observeToolCallIds(ids: readonly string[]): void {
		this.#assertNotDisposed();
		if (this.#addToolCallIds(ids)) this.#touch();
	}

	observeThinkingSummaries(summaries: readonly string[]): void {
		this.#assertNotDisposed();
		const latest = summaries[summaries.length - 1];
		if (latest === undefined || latest === this.#latestThinkingSummary) return;
		this.#latestThinkingSummary = latest;
		this.#touch();
	}

	observeAssistantMessages(components: readonly Component[]): void {
		this.#assertNotDisposed();
		let changed = false;
		for (const component of components) {
			if (this.#assistantMessages.has(component)) continue;
			this.#assistantMessages.add(component);
			this.#assistantMessageCount++;
			changed = true;
		}
		if (!changed) return;
		this.#refreshCounts();
		this.#touch();
	}

	addChild(child: TurnActivityChild): void {
		this.#assertNotDisposed();
		if (this.#entries.some(entry => entry.component === child.component)) {
			throw new Error("TurnActivityGroup cannot own the same child component twice");
		}
		const entry = normalizeChild(child);
		this.#entries.push(entry);
		if (hasSetExpanded(entry.component)) entry.component.setExpanded(this.#expanded);
		this.#addEntryCounts(entry);
		this.#touch();
	}

	detachChild(component: Component): TurnActivityChild | undefined {
		const index = this.#entries.findIndex(entry => entry.component === component);
		if (index < 0) return undefined;
		const [entry] = this.#entries.splice(index, 1);
		this.#refreshCounts();
		this.#touch();
		return entry?.child;
	}

	setExpanded(expanded: boolean): void {
		if (this.#expanded === expanded) return;
		this.#expanded = expanded;
		for (const entry of this.#entries) {
			if (hasSetExpanded(entry.component)) entry.component.setExpanded(expanded);
		}
		this.#touch();
	}

	isTranscriptBlockFinalized(): boolean {
		if (!this.#finalized) return false;
		for (const entry of this.#entries) {
			if (hasTranscriptBlockFinalized(entry.component) && !entry.component.isTranscriptBlockFinalized())
				return false;
		}
		return true;
	}

	getTranscriptBlockSettledRows(): number {
		return 0;
	}

	getTranscriptBlockVersion(): number {
		const fingerprint = this.#versionFingerprint();
		if (fingerprint !== this.#lastVersionFingerprint) {
			this.#lastVersionFingerprint = fingerprint;
			this.#reportedBlockVersion++;
		}
		return this.#reportedBlockVersion;
	}

	markTranscriptBlockFinalized(): void {
		if (this.#finalized) return;
		this.#finalized = true;
		this.#touch();
	}

	finalize(): void {
		this.markTranscriptBlockFinalized();
	}

	invalidate(): void {
		for (const entry of this.#entries) entry.component.invalidate?.();
		this.#touch();
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		for (const entry of this.#entries) entry.component.dispose?.();
		this.#entries = [];
		this.#counts = { toolCalls: 0, messages: 0 };
		this.#commentaryIds.clear();
		this.#toolCallIds.clear();
		this.#assistantMessageCount = 0;
		this.#latestThinkingSummary = undefined;
		this.#touch();
	}

	render(width: number): readonly string[] {
		const normalizedWidth = Math.max(1, Math.trunc(width));
		return this.#expanded ? this.#renderExpanded(normalizedWidth) : this.#renderCollapsed(normalizedWidth);
	}

	#renderCollapsed(width: number): readonly string[] {
		if (
			this.#collapsedRows !== undefined &&
			this.#collapsedVersion === this.#localVersion &&
			this.#collapsedWidth === width
		) {
			return this.#collapsedRows;
		}
		const rows = [formatCollapsedRow(this.#counts, this.#latestThinkingSummary, width)];
		this.#collapsedRows = rows;
		this.#collapsedVersion = this.#localVersion;
		this.#collapsedWidth = width;
		return rows;
	}

	#renderExpanded(width: number): readonly string[] {
		let stable =
			this.#expandedRows !== undefined &&
			this.#expandedVersion === this.#localVersion &&
			this.#expandedWidth === width;
		const contributions: (readonly string[])[] = [];

		for (let i = 0; i < this.#entries.length; i++) {
			const contribution = stripPlainBlankEdges(this.#entries[i]!.component.render(width));
			contributions.push(contribution);
			if (!stable || !contributionsEqual(this.#expandedContributions[i] ?? EMPTY_LINES, contribution)) {
				stable = false;
			}
		}
		if (stable && this.#expandedContributions.length !== contributions.length) stable = false;
		if (stable && this.#expandedRows !== undefined) return this.#expandedRows;

		const rows: string[] = [];
		for (const contribution of contributions) {
			if (contribution.length === 0) continue;
			if (rows.length > 0) rows.push("");
			rows.push(...contribution);
		}
		this.#expandedRows = rows;
		this.#expandedContributions = contributions;
		this.#expandedVersion = this.#localVersion;
		this.#expandedWidth = width;
		return rows;
	}

	#addEntryCounts(entry: ChildEntry): void {
		for (const id of entry.commentaryIds) this.#commentaryIds.add(id);
		for (const id of entry.toolCallIds) this.#toolCallIds.add(id);
		this.#refreshCounts();
	}

	#addCommentarySignatures(signatures: readonly unknown[]): boolean {
		let changed = false;
		for (const signature of signatures) {
			const id = parseCommentaryTextSignatureId(signature);
			if (id === undefined || this.#commentaryIds.has(id)) continue;
			this.#commentaryIds.add(id);
			changed = true;
		}
		if (changed) this.#refreshCounts();
		return changed;
	}

	#addToolCallIds(ids: readonly string[]): boolean {
		let changed = false;
		for (const id of ids) {
			if (id.length === 0 || this.#toolCallIds.has(id)) continue;
			this.#toolCallIds.add(id);
			changed = true;
		}
		if (changed) this.#refreshCounts();
		return changed;
	}

	#refreshCounts(): void {
		this.#counts = {
			toolCalls: this.#toolCallIds.size,
			messages: this.#commentaryIds.size + this.#assistantMessageCount,
		};
	}

	#touch(): void {
		this.#localVersion++;
		this.#collapsedRows = undefined;
		this.#expandedRows = undefined;
	}

	#versionFingerprint(): string {
		const parts = [`g:${this.#localVersion}`];
		for (const entry of this.#entries) {
			if (!hasTranscriptBlockVersion(entry.component)) {
				parts.push("-");
				continue;
			}
			const version = entry.component.getTranscriptBlockVersion();
			parts.push(Number.isFinite(version) ? String(Math.trunc(version)) : "nan");
		}
		return parts.join("|");
	}
	#assertNotDisposed(): void {
		if (this.#disposed) throw new Error("TurnActivityGroup has been disposed");
	}
}
