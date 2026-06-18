/**
 * context_audit — let the model inspect what is consuming its context window.
 *
 * Surfaces the authoritative per-category breakdown the session already computes
 * (`AgentSession.getContextBreakdown`): system prompt, tool schemas, system
 * context, skills, and conversation messages — each in real tokens, anchored on
 * the provider's last reported prompt-token count when available. Then drills
 * into the provider-visible message list (`session.convertMessagesToLlm`) — the
 * post-transform messages that actually go to the provider — to rank the heaviest
 * individual rows so the model can decide what to compact, drop, or restructure.
 *
 * Read-only and side-effect free. Built on oh-my-pi's real breakdown machinery
 * (real token totals) rather than a chars/4 estimate.
 */
import type {
	AgentMessage,
	AgentTool,
	AgentToolContext,
	AgentToolResult,
	AgentToolUpdateCallback,
} from "@oh-my-pi/pi-agent-core";
import { estimateTokens } from "@oh-my-pi/pi-agent-core/compaction";
import { prompt } from "@oh-my-pi/pi-utils";
import { type } from "arktype";
import contextAuditDescription from "../prompts/tools/context-audit.md" with { type: "text" };
import type { ContextUsageBreakdown } from "../session/agent-session";
import type { ToolSession } from "./index";

// =============================================================================
// Schema
// =============================================================================

const contextAuditSchema = type({
	"min_tokens?": type("number").describe("only list rows estimated at or above this many tokens (default 0 = all)"),
	"max_items?": type("number").describe("cap on rows returned (default 40, max 200)"),
	"query?": type("string").describe("only list rows whose label or content contain this substring"),
	"include_previews?": type("boolean").describe("include a short text preview per row (default true)"),
}).describe("audit what is consuming the model context window");

type ContextAuditParams = typeof contextAuditSchema.infer;

/** Structured snapshot attached to the result for UI/logging. */
export interface ContextAuditDetails {
	contextWindow: number;
	usedTokens: number;
	anchored: boolean;
	categories: {
		systemPrompt: number;
		tools: number;
		systemContext: number;
		skills: number;
		messages: number;
	};
	rowCount: number;
}

// =============================================================================
// Tunables
// =============================================================================

const DEFAULT_MAX_ITEMS = 40;
const MAX_MAX_ITEMS = 200;
const DEFAULT_PREVIEW_CHARS = 180;

// =============================================================================
// Helpers
// =============================================================================

function formatTokens(n: number): string {
	if (n >= 10_000) return `${(n / 1000).toFixed(1)}k`;
	return n.toLocaleString("en-US");
}

function capPreview(text: string, limit = DEFAULT_PREVIEW_CHARS): string {
	const compact = text.replace(/\s+/g, " ").trim();
	if (compact.length <= limit) return compact;
	return `${compact.slice(0, Math.max(0, limit - 1))}…`;
}

/**
 * Short human label for a message, derived only from the role discriminant and
 * the fields TypeScript narrows to after that check — no casts.
 */
function messageLabel(message: AgentMessage): string {
	switch (message.role) {
		case "assistant": {
			const toolCallCount = message.content.filter(block => block.type === "toolCall").length;
			return toolCallCount > 0
				? `assistant (${toolCallCount} tool call${toolCallCount > 1 ? "s" : ""})`
				: "assistant";
		}
		case "user":
			return "user";
		case "toolResult":
			return message.toolName ? `tool result: ${message.toolName}` : "tool result";
		case "developer":
			return "developer";
		case "custom":
			return message.customType ? `custom: ${message.customType}` : "custom";
		case "branchSummary":
			return "branch summary";
		case "compactionSummary":
			return "compaction summary";
		default:
			return message.role;
	}
}

/**
 * Extract a bounded preview of a message's text. Block fields are read only
 * after narrowing on the `type` discriminant — no inline casts.
 */
function messagePreview(message: AgentMessage): string {
	switch (message.role) {
		case "user":
		case "developer":
		case "toolResult":
		case "hookMessage":
		case "custom": {
			const content = message.content;
			if (typeof content === "string") return content;
			return content.flatMap(block => (block.type === "text" ? [block.text] : [])).join(" ");
		}
		case "assistant": {
			return message.content
				.flatMap(block => {
					if (block.type === "text") return [block.text];
					if (block.type === "thinking") return [`[thinking ${block.thinking.length} chars]`];
					if (block.type === "toolCall") return [`[call ${block.name}: ${JSON.stringify(block.arguments)}]`];
					return [];
				})
				.join(" ");
		}
		case "branchSummary":
		case "compactionSummary":
			return message.summary;
		default:
			return "";
	}
}

/**
 * Provider-visible token estimate per message. `estimateTokens` counts image blocks
 * only on `toolResult` (not `user`/`developer`) and has no `developer` case, so:
 *  - user/developer array content is routed through a toolResult-shaped view, which
 *    counts both text and image blocks (pasted screenshots, @file images) — otherwise
 *    image-only rows would read 0 and be filtered out, hiding exactly what to drop;
 *  - developer string content falls back to a user-shaped view (estimateTokens has
 *    no developer case).
 * No casts: the literals are valid Message shapes. Routing through toolResult stays
 * in sync with estimateTokens' image surcharge rather than duplicating the constant.
 */
function estimateVisibleMessageTokens(message: AgentMessage): number {
	if ((message.role === "user" || message.role === "developer") && Array.isArray(message.content)) {
		return estimateTokens({
			role: "toolResult",
			toolCallId: "",
			toolName: "",
			content: message.content,
			isError: false,
			timestamp: message.timestamp,
		});
	}
	if (message.role === "developer") {
		return estimateTokens({ role: "user", content: message.content, timestamp: message.timestamp });
	}
	return estimateTokens(message);
}
interface MessageRow {
	index: number;
	tokens: number;
	label: string;
	searchText: string;
	preview: string;
}

function buildRows(messages: AgentMessage[], includePreviews: boolean): MessageRow[] {
	return messages.map((message, index) => {
		const text = messagePreview(message);
		return {
			index,
			tokens: estimateVisibleMessageTokens(message),
			label: messageLabel(message),
			searchText: text,
			preview: includePreviews ? capPreview(text) : "",
		};
	});
}

function pct(part: number, whole: number): string {
	if (whole <= 0) return "—";
	return `${((part / whole) * 100).toFixed(1)}%`;
}
// =============================================================================
// Report
// =============================================================================

function renderReport(
	breakdown: ContextUsageBreakdown,
	rows: MessageRow[],
	params: ContextAuditParams,
	snapcompactEnabled: boolean,
): string {
	const { contextWindow, usedTokens, anchored } = breakdown;
	const lines: string[] = [];

	lines.push("Context audit");
	lines.push("─".repeat(60));
	lines.push(
		`Window: ${formatTokens(usedTokens)} / ${formatTokens(contextWindow)} tokens ` +
			`(${pct(usedTokens, contextWindow)} of context window)`,
	);
	const free = Math.max(0, contextWindow - usedTokens);
	lines.push(`Free: ${formatTokens(free)} tokens (${pct(free, contextWindow)})`);
	lines.push(
		`Estimate basis: ${anchored ? "anchored on provider usage" : "fully estimated (no provider anchor yet)"}`,
	);
	lines.push("");

	lines.push("Category breakdown (authoritative)");
	lines.push("─".repeat(60));
	const categoryRows: Array<[string, number]> = [
		["System prompt", breakdown.systemPromptTokens],
		["Tool schemas", breakdown.systemToolsTokens],
		["System context (rules/skills injections)", breakdown.systemContextTokens],
		["Skills", breakdown.skillsTokens],
		["Conversation messages", breakdown.messagesTokens],
	];
	for (const [label, tokens] of categoryRows) {
		lines.push(`  ${label.padEnd(46)} ${formatTokens(tokens).padStart(8)}  ${pct(tokens, contextWindow)}`);
	}
	lines.push("");

	const visible = rows.filter(row => row.tokens > 0);
	const totalRowTokens = visible.reduce((sum, row) => sum + row.tokens, 0);
	lines.push(`Heaviest message rows (${visible.length} non-empty, ~${formatTokens(totalRowTokens)} tokens)`);
	lines.push("─".repeat(60));

	const minTokens = typeof params.min_tokens === "number" ? Math.max(0, params.min_tokens) : 0;
	const query = typeof params.query === "string" && params.query.length > 0 ? params.query.toLowerCase() : undefined;
	const maxItemsRaw = typeof params.max_items === "number" ? params.max_items : DEFAULT_MAX_ITEMS;
	const maxItems = Math.max(1, Math.min(MAX_MAX_ITEMS, Math.floor(maxItemsRaw)));

	let ranked = visible;
	if (minTokens > 0) ranked = ranked.filter(row => row.tokens >= minTokens);
	if (query)
		ranked = ranked.filter(
			row => row.label.toLowerCase().includes(query) || row.searchText.toLowerCase().includes(query),
		);
	ranked = [...ranked].sort((a, b) => b.tokens - a.tokens).slice(0, maxItems);

	if (ranked.length === 0) {
		lines.push("  (no rows match the filters)");
	} else {
		for (const row of ranked) {
			const head = `#${row.index} ${row.label} · ${formatTokens(row.tokens)}t · ${pct(row.tokens, contextWindow)}`;
			lines.push(`  ${head}`);
			if (row.preview) lines.push(`      ${row.preview}`);
		}
	}
	lines.push("");

	// Largest groups by label.
	const groups: Record<string, number> = {};
	for (const row of visible) {
		groups[row.label] = (groups[row.label] ?? 0) + row.tokens;
	}
	const rankedGroups = Object.entries(groups)
		.sort((a, b) => b[1] - a[1])
		.slice(0, 6);
	if (rankedGroups.length > 0) {
		lines.push("Largest groups");
		lines.push("─".repeat(60));
		for (const [label, tokens] of rankedGroups) {
			lines.push(
				`  ${label.padEnd(46)} ${formatTokens(tokens).padStart(8)}  ${pct(tokens, totalRowTokens || contextWindow)}`,
			);
		}
	}

	lines.push("");
	lines.push(
		"Per-row token counts are local estimates (real tokenizer where available); the category breakdown above is the authoritative total.",
	);
	if (snapcompactEnabled) {
		lines.push(
			"Note: snapcompact is on — large historical tool results / system-prompt text may already be replaced by image frames on the wire, so row rankings can over-state those rows. The category total remains authoritative (anchored on the provider's real prompt tokens).",
		);
	}
	return lines.join("\n");
}

// =============================================================================
// Tool
// =============================================================================

export class ContextAuditTool implements AgentTool<typeof contextAuditSchema, ContextAuditDetails> {
	readonly name = "context_audit";
	readonly approval = "read" as const;
	readonly label = "Context audit";
	readonly summary = "Audit what is consuming the model context window";
	readonly description: string;
	readonly parameters = contextAuditSchema;
	readonly loadMode = "discoverable" as const;

	constructor(private readonly session: ToolSession) {
		this.description = prompt.render(contextAuditDescription);
	}

	async execute(
		_toolCallId: string,
		params: ContextAuditParams,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<ContextAuditDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<ContextAuditDetails>> {
		const breakdown = this.session.getContextBreakdown?.();
		if (!breakdown || breakdown.contextWindow <= 0) {
			return {
				content: [{ type: "text", text: "Context usage unavailable: no model or context window resolved yet." }],
			};
		}

		const messages = (await this.session.getProviderMessages?.(signal)) ?? [];
		const includePreviews = params.include_previews !== false;
		const rows = buildRows(messages, includePreviews);
		const snapcompactEnabled =
			this.session.settings.get("snapcompact.systemPrompt") !== "none" ||
			this.session.settings.get("snapcompact.toolResults") === true;
		const text = renderReport(breakdown, rows, params, snapcompactEnabled);

		const details: ContextAuditDetails = {
			contextWindow: breakdown.contextWindow,
			usedTokens: breakdown.usedTokens,
			anchored: breakdown.anchored,
			categories: {
				systemPrompt: breakdown.systemPromptTokens,
				tools: breakdown.systemToolsTokens,
				systemContext: breakdown.systemContextTokens,
				skills: breakdown.skillsTokens,
				messages: breakdown.messagesTokens,
			},
			rowCount: rows.filter(row => row.tokens > 0).length,
		};

		return {
			content: [{ type: "text", text }],
			details,
		};
	}
}
