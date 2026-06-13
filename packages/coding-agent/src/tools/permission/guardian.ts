/**
 * Guardian: an ephemeral LLM safety judge for tool calls.
 *
 * Mirrors the one-shot pattern used by the session-title generator — a single
 * `completeSimple` call with a forced `verdict` tool, never touching the live
 * conversation. Used by the `guardian` and `hybrid` approval modes.
 */
import { type Api, type AssistantMessage, completeSimple, type Model, type Tool } from "@oh-my-pi/pi-ai";
import { logger, prompt } from "@oh-my-pi/pi-utils";
import type { ModelRegistry } from "../../config/model-registry";
import { parseModelString, resolveRoleSelection } from "../../config/model-resolver";
import type { Settings } from "../../config/settings";
import guardianSystemPrompt from "../../prompts/system/guardian-system.md" with { type: "text" };

const GUARDIAN_SYSTEM_PROMPT = prompt.render(guardianSystemPrompt);
const VERDICT_TOOL_NAME = "verdict";
// The Guardian is the sole authorization gate in `guardian` mode, so it must see the whole
// security-relevant argument. Bound the prompt generously and elide only the MIDDLE on overflow
// (head + tail) — head-only truncation could drop a trailing `; rm -rf /` and let the judge
// authorize a destructive call it never saw.
const MAX_ARGS_CHARS = 8000;
const GUARDIAN_MAX_TOKENS = 200;
const REASONING_SAFE_MAX_TOKENS = 1024;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BASE_BACKOFF_MS = 500;

const verdictTool: Tool = {
	name: VERDICT_TOOL_NAME,
	description: "Record the safety verdict for the proposed tool call.",
	parameters: {
		type: "object",
		properties: {
			decision: {
				type: "string",
				enum: ["allow", "deny"],
				description: "Whether the proposed tool call is safe to run.",
			},
			reason: {
				type: "string",
				description: "Short justification for the decision; required when denying.",
			},
		},
		required: ["decision"],
		additionalProperties: false,
	},
};

/** Outcome of a Guardian review. `error` means retries were exhausted. */
export type GuardianVerdict =
	| { decision: "allow"; reason?: string }
	| { decision: "deny"; reason: string }
	| { decision: "error" };

export interface GuardianRequest {
	toolName: string;
	args: unknown;
	/** Reason a prior heuristic flagged the call (hybrid mode). */
	reason?: string;
	cwd?: string;
}

export interface GuardianOptions {
	/** Override the attempt count (otherwise read from settings, default 3). */
	maxAttempts?: number;
	/** Base backoff in ms; doubles each retry. Lowered in tests for speed. */
	baseBackoffMs?: number;
}

function safeStringify(value: unknown): string {
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value, null, 2) ?? String(value);
	} catch {
		return String(value);
	}
}

/**
 * Bound an argument string for the Guardian prompt while preserving BOTH ends. On overflow only
 * the middle is elided, so a command's trailing payload (e.g. `…; rm -rf /`) always reaches the
 * judge. The explicit elision marker also signals to the judge that content was withheld.
 */
function truncateArgsForJudgment(value: string, maxChars: number): string {
	if (value.length <= maxChars) return value;
	const half = Math.max(1, Math.floor((maxChars - 1) / 2));
	const omitted = value.length - half * 2;
	return `${value.slice(0, half)}\n… (${omitted} chars elided) …\n${value.slice(value.length - half)}`;
}

function buildUserMessage(req: GuardianRequest): string {
	const lines = [`Tool: ${req.toolName}`];
	if (req.cwd) lines.push(`Working directory: ${req.cwd}`);
	if (req.reason) lines.push(`A safety heuristic flagged this call: ${req.reason}`);
	lines.push("Arguments:", truncateArgsForJudgment(safeStringify(req.args), MAX_ARGS_CHARS));
	return lines.join("\n");
}

function parseVerdict(content: AssistantMessage["content"]): GuardianVerdict | null {
	for (const block of content) {
		if (block.type === "toolCall" && block.name === VERDICT_TOOL_NAME) {
			const args = block.arguments as Record<string, unknown>;
			const reason = typeof args.reason === "string" && args.reason.length > 0 ? args.reason : undefined;
			if (args.decision === "allow") return reason ? { decision: "allow", reason } : { decision: "allow" };
			if (args.decision === "deny") {
				return { decision: "deny", reason: reason ?? "Guardian denied the tool call." };
			}
		}
	}
	return null;
}

async function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
	if (ms <= 0 || signal?.aborted) return;
	await new Promise<void>(resolve => {
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			resolve();
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

export class GuardianJudge {
	readonly #registry: ModelRegistry;
	readonly #settings: Settings;
	readonly #getCurrentModel: () => Model<Api> | undefined;
	readonly #sessionId?: string;
	readonly #options: GuardianOptions;

	constructor(
		registry: ModelRegistry,
		settings: Settings,
		getCurrentModel: () => Model<Api> | undefined,
		sessionId?: string,
		options: GuardianOptions = {},
	) {
		this.#registry = registry;
		this.#settings = settings;
		this.#getCurrentModel = getCurrentModel;
		this.#sessionId = sessionId;
		this.#options = options;
	}

	#resolveModel(): Model<Api> | undefined {
		const available = this.#registry.getAvailable();
		if (available.length === 0) return undefined;

		const configured = this.#settings.get("tools.guardian.model");
		if (typeof configured === "string" && configured.trim()) {
			const parsed = parseModelString(configured.trim());
			if (parsed) {
				const found = this.#registry.find(parsed.provider, parsed.id);
				if (found && available.some(m => m.provider === found.provider && m.id === found.id)) {
					return found;
				}
			}
		}

		const role = resolveRoleSelection(["smol", "commit"], this.#settings, available, this.#registry)?.model;
		return role ?? this.#getCurrentModel();
	}

	#maxAttempts(): number {
		if (typeof this.#options.maxAttempts === "number") return Math.max(1, this.#options.maxAttempts);
		const configured = this.#settings.get("tools.guardian.maxRetries");
		return typeof configured === "number" && configured >= 1 ? configured : DEFAULT_MAX_ATTEMPTS;
	}

	/**
	 * Review a proposed tool call. Retries transient failures with exponential
	 * backoff, then returns `{ decision: "error" }` so the caller can fail safe.
	 */
	async evaluate(req: GuardianRequest, signal?: AbortSignal): Promise<GuardianVerdict> {
		const model = this.#resolveModel();
		if (!model) {
			logger.debug("guardian: no model available");
			return { decision: "error" };
		}
		const apiKey = await this.#registry.getApiKey(model, this.#sessionId);
		if (!apiKey) {
			logger.debug("guardian: no API key", { provider: model.provider, id: model.id });
			return { decision: "error" };
		}

		const userMessage = buildUserMessage(req);
		const maxTokens = model.reasoning
			? Math.max(GUARDIAN_MAX_TOKENS, REASONING_SAFE_MAX_TOKENS)
			: GUARDIAN_MAX_TOKENS;
		const maxAttempts = this.#maxAttempts();
		const baseBackoff = this.#options.baseBackoffMs ?? DEFAULT_BASE_BACKOFF_MS;

		for (let attempt = 0; attempt < maxAttempts; attempt++) {
			if (signal?.aborted) return { decision: "error" };
			try {
				const response = await completeSimple(
					model,
					{
						systemPrompt: [GUARDIAN_SYSTEM_PROMPT],
						messages: [{ role: "user", content: userMessage, timestamp: Date.now() }],
						tools: [verdictTool],
					},
					{
						apiKey,
						maxTokens,
						disableReasoning: true,
						toolChoice: { type: "tool", name: VERDICT_TOOL_NAME },
						signal,
					},
				);
				if (response.stopReason === "error") {
					throw new Error(response.errorMessage ?? "guardian completion error");
				}
				const verdict = parseVerdict(response.content);
				if (verdict) return verdict;
				throw new Error("guardian returned no parseable verdict");
			} catch (err) {
				if (signal?.aborted) return { decision: "error" };
				logger.debug("guardian: attempt failed", {
					attempt,
					error: err instanceof Error ? err.message : String(err),
				});
				if (attempt < maxAttempts - 1) await abortableDelay(baseBackoff * 2 ** attempt, signal);
			}
		}
		return { decision: "error" };
	}
}
