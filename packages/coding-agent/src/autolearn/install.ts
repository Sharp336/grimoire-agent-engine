/**
 * Assembly of the Auto-Learn controller's session-scoped dependencies.
 *
 * Kept out of `sdk.ts` because it is a self-contained wiring concern: resolving
 * the descriptor catalog, deriving MCP tool ownership from the ACTIVE tool set,
 * and slicing the bounded `/learn` window. `sdk.ts` only decides *whether* to
 * install; this module decides *what with*.
 */
import type { AgentMessage, AgentTool } from "@oh-my-pi/pi-agent-core";
import { estimateTokens } from "@oh-my-pi/pi-agent-core/compaction";
import { logger } from "@oh-my-pi/pi-utils";
import type { Settings } from "../config/settings";
import { getActiveSkills } from "../extensibility/skills";
import type { AgentSession } from "../session/agent-session";
import { AgentStorage } from "../session/agent-storage";
import { resolveProjectIdentity } from "../utils/project-identity";
import type { AutoLearnCaptureRequest, AutoLearnCaptureResult } from "./capture-request";
import { MANUAL_CAPTURE_MAX_TOKENS } from "./capture-request";
import { ManagedProcedureCatalog } from "./catalog-store";
import { AutoLearnController } from "./controller";

export interface InstallAutoLearnOptions {
	session: AgentSession;
	settings: Settings;
	/** The isolated capture runner built in `sdk.ts`. */
	runCapture: (request: AutoLearnCaptureRequest, signal?: AbortSignal) => Promise<AutoLearnCaptureResult>;
	/** Tools registered for this session, used for MCP ownership and `read` availability. */
	initialTools: readonly AgentTool[];
	cwd: () => string;
}

/** Tool shape carrying MCP provenance; native tools simply lack the field. */
type MaybeMcpTool = AgentTool & { mcpServerName?: string };

/**
 * One completed user→assistant exchange, newest last.
 *
 * Grouped rather than flat so the token budget can drop WHOLE exchanges: half an
 * exchange teaches a capture agent nothing and risks presenting a failed attempt
 * as the final answer.
 */
interface Exchange {
	messages: AgentMessage[];
	tokens: number;
}

/**
 * Whether a message is a real user prompt rather than host-injected content.
 *
 * Host-authored content (steered reminders, queued deliveries) carries a non-user
 * attribution; including it would make the capture agent treat OMP's own plumbing
 * as something the user said.
 */
function isRealUserMessage(message: AgentMessage): boolean {
	if (message.role !== "user") return false;
	return !("attribution" in message) || message.attribution === undefined || message.attribution === "user";
}

/**
 * Detach one message for the snapshot.
 *
 * Clones so a later primary turn cannot mutate what was selected, and strips
 * provider payloads and response ids: they are transport state for the primary
 * provider session, they can be large, and carrying them would let the private
 * capture agent resume against the primary conversation.
 */
function detachMessage(message: AgentMessage): AgentMessage {
	if (message.role === "assistant") return { ...message, responseId: undefined, providerPayload: undefined };
	if (message.role === "user" || message.role === "developer") return { ...message, providerPayload: undefined };
	return { ...message };
}

/**
 * Group the branch into complete exchanges of detached messages.
 *
 * Grouped rather than flat so the token budget can drop WHOLE exchanges: half an
 * exchange teaches a capture agent nothing and risks presenting an abandoned
 * attempt as the final answer.
 *
 * System and developer prompts and hidden custom messages are dropped outright —
 * they are host content, not the work the user asked to preserve. The consumed
 * slash command itself leaves no message behind.
 */
function groupExchanges(messages: readonly AgentMessage[]): Exchange[] {
	const exchanges: Exchange[] = [];
	let current: Exchange | undefined;
	for (const message of messages) {
		// `developer` carries host/system instructions; hidden custom messages are
		// OMP's own plumbing (recall cards, reminders, async deliveries).
		if (message.role === "developer") continue;
		if (message.role === "custom" && message.display === false) continue;
		const detached = detachMessage(message);
		if (isRealUserMessage(detached)) {
			current = { messages: [detached], tokens: estimateTokens(detached) };
			exchanges.push(current);
			continue;
		}
		if (!current) continue;
		current.messages.push(detached);
		current.tokens += estimateTokens(detached);
	}
	// A trailing exchange with no assistant reply is still in flight; nothing in it
	// has been verified, so it is not something to learn from.
	return exchanges.filter(exchange => exchange.messages.some(message => message.role === "assistant"));
}

/** Sum of the estimator's per-message counts. */
function totalTokens(messages: readonly AgentMessage[]): number {
	let total = 0;
	for (const message of messages) total += estimateTokens(message);
	return total;
}

/**
 * Select the last `turns` complete exchanges under the estimated-token cap.
 *
 * Drops OLDEST complete exchanges first. Only when the newest exchange alone
 * exceeds the cap is its text truncated — otherwise one huge turn would make
 * `/learn` silently select nothing. Returned messages are detached clones.
 */
export function selectManualWindow(messages: readonly AgentMessage[], turns: number): AgentMessage[] {
	const exchanges = groupExchanges(messages).slice(-turns);
	if (exchanges.length === 0) return [];
	let total = exchanges.reduce((sum, exchange) => sum + exchange.tokens, 0);
	while (exchanges.length > 1 && total > MANUAL_CAPTURE_MAX_TOKENS) {
		const dropped = exchanges.shift();
		total -= dropped?.tokens ?? 0;
	}
	let selected = exchanges.flatMap(exchange => exchange.messages);
	if (totalTokens(selected) <= MANUAL_CAPTURE_MAX_TOKENS) return selected;

	// Halve the character budget until the ESTIMATOR agrees, rather than trusting a
	// fixed chars-per-token ratio: `estimateTokens` counts non-text parts too, so a
	// single-pass character slice can still land over the cap.
	let budget = MANUAL_CAPTURE_MAX_TOKENS * 4;
	for (let attempt = 0; attempt < 6; attempt++) {
		const truncated = truncateToCharacterBudget(selected, budget);
		if (totalTokens(truncated) <= MANUAL_CAPTURE_MAX_TOKENS) return truncated;
		selected = truncated;
		budget = Math.floor(budget / 2);
		if (budget <= 0) break;
	}
	// Last resort: keep only the newest message, itself hard-capped. A capture agent
	// with one truncated message may store nothing, which is correct — better than
	// sending an over-budget payload.
	const newest = selected[selected.length - 1];
	return newest ? truncateToCharacterBudget([newest], MANUAL_CAPTURE_MAX_TOKENS * 2) : [];
}

/** Trim text content newest-first until the character budget is spent. */
function truncateToCharacterBudget(messages: readonly AgentMessage[], budget: number): AgentMessage[] {
	let remaining = budget;
	const kept: AgentMessage[] = [];
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (remaining <= 0) break;
		if (!("content" in message)) {
			kept.unshift(message);
			continue;
		}
		const content = message.content;
		if (typeof content === "string") {
			const text = content.slice(0, remaining);
			remaining -= text.length;
			kept.unshift({ ...message, content: text } as AgentMessage);
			continue;
		}
		if (!Array.isArray(content)) {
			kept.unshift(message);
			continue;
		}
		const blocks = content.map(block => {
			if (!block || typeof block !== "object" || !("type" in block) || block.type !== "text") return block;
			if (!("text" in block) || typeof block.text !== "string") return block;
			const text = block.text.slice(0, Math.max(0, remaining));
			remaining -= text.length;
			return { ...block, text };
		});
		kept.unshift({ ...message, content: blocks } as AgentMessage);
	}
	return kept;
}

/**
 * Install the controller for a top-level session.
 *
 * The catalog is best-effort: when `agent.db` cannot be opened, Auto-Learn keeps
 * capture and standing guidance but loses recall, which is strictly better than
 * failing session startup.
 */
export async function installAutoLearnController(options: InstallAutoLearnOptions): Promise<AutoLearnController> {
	let catalog: ManagedProcedureCatalog | undefined;
	try {
		const storage = await AgentStorage.open();
		catalog = new ManagedProcedureCatalog(storage);
		// The filesystem is authoritative: reconcile at startup so rows for deleted
		// procedures disappear and rows lost with a stale database are repaired.
		await catalog.sync(getActiveSkills());
	} catch (error) {
		logger.warn("Auto-Learn procedure catalog unavailable; recall disabled", { error: String(error) });
		catalog = undefined;
	}

	// Re-reconcile after every skill refresh. `manage_skill` and `learn` both call
	// `refreshSkills()` after a create/update/delete, so this hook is what makes a
	// same-session mutation visible to recall instead of waiting for a restart.
	// The sync is idempotent and counter-preserving, so re-running it is safe.
	if (catalog) {
		const reconcile = catalog;
		options.session.registerSkillRefreshHook(() => reconcile.sync(getActiveSkills()));
	}

	const mcpServerByTool: Record<string, string> = {};
	let hasRead = false;
	for (const tool of options.initialTools) {
		if (tool.name === "read") hasRead = true;
		const server = (tool as MaybeMcpTool).mcpServerName;
		// Resolve ownership from the tool OBJECT, never by parsing an `mcp__…` name:
		// that parse is lossy for servers whose names contain the separator, and two
		// different servers with a shared prefix would collapse into one family.
		if (server) mcpServerByTool[tool.name] = server;
	}

	return new AutoLearnController({
		session: options.session,
		settings: options.settings,
		// `runAutolearnCapture` resolves undefined when another capture is already in
		// flight or the session is disposed. That is a refusal, not a success, so it
		// must surface as an error rather than an empty "stored nothing" report.
		capture: async request => {
			const result = await options.session.runAutolearnCapture(signal => options.runCapture(request, signal));
			return result ?? { stored: [], error: "Another Auto-Learn capture is already running." };
		},
		catalog,
		resolveToolFamily: toolName => mcpServerByTool[toolName],
		hasReadTool: () => hasRead,
		projectIdentity: () => resolveProjectIdentity(options.cwd()),
		selectManualWindow: turns => selectManualWindow(options.session.agent.state.messages, turns),
	});
}
