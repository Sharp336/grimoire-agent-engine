/**
 * "Approve for me" auto-reviewer: a separate LLM evaluates each
 * approval-pending tool call and auto-approves or denies it, so the user is
 * not prompted for every exec-tier action.
 *
 * Fail-closed: timeout, parse failure, or model error → deny.
 * Circuit breaker: 3 consecutive denials or 10 in the last 50 → interrupt turn.
 *
 * The reviewer's `outcome` is **never trusted** — it is derived from the
 * validated `risk_level` + `user_authorization` pair per the policy rules.
 * A model that returns `{ risk: "critical", outcome: "allow" }` is denied.
 */
import type { AgentTool, AgentToolContext } from "@oh-my-pi/pi-agent-core";
import { type Api, completeSimple, type Message, type Model, type Tool, type ToolCall } from "@oh-my-pi/pi-ai";
import { prompt } from "@oh-my-pi/pi-utils";
import type { ModelRegistry } from "../config/model-registry";
import { resolveRoleSelection } from "../config/model-resolver";
import type { Settings } from "../config/settings";
import { truncateForPrompt } from "./approval";
import policy from "./approve-for-me-policy.md" with { type: "text" };
import systemPromptText from "./approve-for-me-system.md" with { type: "text" };

export interface ReviewDecision {
	risk_level: "low" | "medium" | "high" | "critical";
	user_authorization: "high" | "medium" | "low" | "unknown";
	outcome: "allow" | "deny";
	rationale: string;
}

export const REVIEW_TIMEOUT_MS = 30_000;
export const MAX_CONSECUTIVE_DENIALS = 3;
export const MAX_RECENT_DENIALS = 10;
export const DENIAL_WINDOW = 50;

const ARGS_TRUNCATE_CHARS = 4000;
const STRUCTURED_TOOL_NAME = "respond";

const reviewTool: Tool = {
	name: STRUCTURED_TOOL_NAME,
	description: "Return your review decision by calling this tool.",
	parameters: {
		type: "object",
		properties: {
			risk_level: { type: "string", enum: ["low", "medium", "high", "critical"] },
			user_authorization: { type: "string", enum: ["high", "medium", "low", "unknown"] },
			rationale: { type: "string" },
		},
		required: ["risk_level", "user_authorization", "rationale"],
	} as Record<string, unknown>,
	strict: false,
};

/** Per-session state: cache + circuit breaker counters. */
interface SessionState {
	consecutiveDenials: number;
	recentDenials: boolean[];
	cache: Map<string, ReviewDecision>;
}

/**
 * Derive the outcome from the validated risk level and user authorization,
 * per the policy rules. The model's `outcome` field is **never used** —
 * only `risk_level` and `user_authorization` are trusted.
 *
 * - low/medium risk → allow
 * - high risk → allow only with medium+ authorization; otherwise deny
 * - critical risk → always deny
 */
function deriveOutcome(
	risk: ReviewDecision["risk_level"],
	auth: ReviewDecision["user_authorization"],
): "allow" | "deny" {
	if (risk === "critical") return "deny";
	if (risk === "high" && (auth === "low" || auth === "unknown")) return "deny";
	return "allow";
}

/** Reviewer with per-session cache and circuit breaker state. */
export class ApproveForMeReviewer {
	#sessions = new Map<string, SessionState>();

	#getSession(id: string): SessionState {
		let s = this.#sessions.get(id);
		if (!s) {
			s = { consecutiveDenials: 0, recentDenials: [], cache: new Map() };
			this.#sessions.set(id, s);
		}
		return s;
	}

	/**
	 * Review a tool call. Returns the decision, or a fail-closed deny on any
	 * error (timeout, parse failure, model unavailable, truncated args).
	 */
	async review(
		tool: AgentTool,
		args: unknown,
		reason: string | undefined,
		context: AgentToolContext | undefined,
	): Promise<ReviewDecision> {
		const sessionId = context?.sessionManager?.getSessionId() ?? "";
		const session = this.#getSession(sessionId);

		const cacheKey = this.#cacheKey(tool.name, args);
		const cached = session.cache.get(cacheKey);
		if (cached) return cached;

		// Fail closed when args are truncated — a security decision must cover
		// the complete action, not a prefix of it.
		let argsStr: string;
		try {
			argsStr = JSON.stringify(args, null, 2);
		} catch {
			argsStr = String(args);
		}
		const truncated = truncateForPrompt(argsStr, ARGS_TRUNCATE_CHARS);
		if (truncated !== argsStr) {
			session.consecutiveDenials = session.consecutiveDenials + 1;
			session.recentDenials.push(true);
			if (session.recentDenials.length > DENIAL_WINDOW) session.recentDenials.shift();
			return {
				risk_level: "high",
				user_authorization: "unknown",
				outcome: "deny",
				rationale:
					"Auto-review denied: tool arguments exceed the review context window. A security decision cannot be made on a truncated action.",
			};
		}

		try {
			const recentUserMessages = this.#extractRecentUserMessages(context);
			const promptText = this.#buildPrompt(tool, argsStr, reason, recentUserMessages);
			const result = await this.#callModel(promptText, context);
			const decision = this.#parseDecision(result);
			const outcome = deriveOutcome(decision.risk_level, decision.user_authorization);
			const finalDecision: ReviewDecision = { ...decision, outcome };
			if (outcome === "allow") {
				session.cache.set(cacheKey, finalDecision);
			}
			this.#recordReview(session, outcome === "deny");
			return finalDecision;
		} catch (err) {
			this.#recordReview(session, true);
			return {
				risk_level: "high",
				user_authorization: "unknown",
				outcome: "deny",
				rationale: `Auto-review failed: ${err instanceof Error ? err.message : "unknown error"}. Falling back to deny for safety.`,
			};
		}
	}

	/** Circuit breaker: after N consecutive denials or M in last K, interrupt. */
	shouldInterruptTurn(sessionId: string): boolean {
		const s = this.#sessions.get(sessionId);
		if (!s) return false;
		return (
			s.consecutiveDenials >= MAX_CONSECUTIVE_DENIALS || s.recentDenials.filter(Boolean).length >= MAX_RECENT_DENIALS
		);
	}

	/** Clear the circuit breaker for a session (e.g. on a new turn). */
	resetCircuitBreaker(sessionId: string): void {
		const s = this.#sessions.get(sessionId);
		if (!s) return;
		s.consecutiveDenials = 0;
		s.recentDenials = [];
	}

	#recordReview(session: SessionState, denied: boolean): void {
		session.consecutiveDenials = denied ? session.consecutiveDenials + 1 : 0;
		session.recentDenials.push(denied);
		if (session.recentDenials.length > DENIAL_WINDOW) {
			session.recentDenials.shift();
		}
	}

	#cacheKey(toolName: string, args: unknown): string {
		try {
			return `${toolName}:${JSON.stringify(args)}`;
		} catch {
			return `${toolName}:${String(args)}`;
		}
	}

	/**
	 * Extract up to 5 recent user messages from the session transcript so the
	 * reviewer can assess whether the user authorized the proposed action.
	 * Returns a string summary, or "(no recent user messages)" when the
	 * session is unavailable or has no user messages.
	 */
	#extractRecentUserMessages(context: AgentToolContext | undefined): string {
		try {
			const entries = context?.sessionManager?.getEntries?.();
			if (!entries) return "(no recent user messages)";
			const userTexts: string[] = [];
			for (const entry of entries) {
				if (entry.type !== "message") continue;
				const msg = entry.message as { role?: string; content?: unknown };
				if (msg.role !== "user") continue;
				const content = msg.content;
				if (typeof content === "string") {
					userTexts.push(content);
				} else if (Array.isArray(content)) {
					for (const part of content) {
						if (
							typeof part === "object" &&
							part !== null &&
							part.type === "text" &&
							typeof part.text === "string"
						) {
							userTexts.push(part.text);
						}
					}
				}
				if (userTexts.length >= 5) break;
			}
			if (userTexts.length === 0) return "(no recent user messages)";
			return userTexts.map((t, i) => `[${i + 1}] ${truncateForPrompt(t, 500)}`).join("\n");
		} catch {
			return "(no recent user messages)";
		}
	}

	#buildPrompt(tool: AgentTool, argsStr: string, reason: string | undefined, recentUserMessages: string): string {
		return prompt.render(policy, {
			tool_name: tool.name,
			approval_reason: reason ?? "",
			arguments: argsStr,
			recent_user_messages: recentUserMessages,
		});
	}

	async #callModel(promptText: string, context: AgentToolContext | undefined): Promise<unknown> {
		const settings = context?.settings as Settings | undefined;
		const registry = context?.modelRegistry as ModelRegistry | undefined;
		if (!settings || !registry) {
			throw new Error("no settings or model registry available for auto-review");
		}

		const resolved = resolveRoleSelection(["tiny", "smol"], settings, registry.getAvailable());
		const model = resolved?.model as Model<Api> | undefined;
		if (!model) {
			throw new Error("no tiny/smol model available for auto-review");
		}

		const sessionId = context?.sessionManager?.getSessionId();
		const apiKey = await registry.getApiKey(model, sessionId);
		if (!apiKey) {
			throw new Error(`no API key for auto-review model ${model.provider}/${model.id}`);
		}

		const messages: Message[] = [{ role: "user", content: promptText, timestamp: Date.now() }];

		const response = await completeSimple(
			model,
			{
				systemPrompt: [systemPromptText],
				messages,
				tools: [reviewTool],
			},
			{
				apiKey: registry.resolver(model, sessionId),
				disableReasoning: true,
				toolChoice: { type: "tool", name: STRUCTURED_TOOL_NAME },
				signal: AbortSignal.timeout(REVIEW_TIMEOUT_MS),
				maxTokens: 1024,
			},
		);

		if (response.stopReason === "error") {
			throw new Error(response.errorMessage ?? "auto-review request failed");
		}

		const toolCall = response.content.find(
			(c): c is ToolCall => c.type === "toolCall" && c.name === STRUCTURED_TOOL_NAME,
		);
		if (toolCall) return toolCall.arguments;

		// Fallback: try to parse text as JSON
		const text = response.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map(c => c.text)
			.join("");
		if (text) {
			try {
				return JSON.parse(text);
			} catch {
				// fall through
			}
		}

		throw new Error("auto-review returned no structured response");
	}

	#parseDecision(raw: unknown): Omit<ReviewDecision, "outcome"> {
		if (typeof raw !== "object" || raw === null) {
			throw new Error("auto-review response is not an object");
		}
		const obj = raw as Record<string, unknown>;
		const {
			risk_level: risk,
			user_authorization: auth,
			rationale,
		} = obj as {
			risk_level: unknown;
			user_authorization: unknown;
			rationale: unknown;
		};

		if (
			(risk === "low" || risk === "medium" || risk === "high" || risk === "critical") &&
			(auth === "high" || auth === "medium" || auth === "low" || auth === "unknown") &&
			typeof rationale === "string"
		) {
			return { risk_level: risk, user_authorization: auth, rationale };
		}

		throw new Error("auto-review response does not match expected schema");
	}
}

/** Singleton reviewer per process — per-session state is keyed by session ID. */
let reviewerInstance: ApproveForMeReviewer | undefined;

export function getApproveForMeReviewer(): ApproveForMeReviewer {
	if (!reviewerInstance) reviewerInstance = new ApproveForMeReviewer();
	return reviewerInstance;
}

/**
 * Run auto-review on a tool call. Returns the decision, or a fail-closed
 * deny when auto-review cannot run (no model/registry/timeout).
 */
export async function runApproveForMeReview(
	tool: AgentTool,
	args: unknown,
	reason: string | undefined,
	context: AgentToolContext | undefined,
): Promise<ReviewDecision> {
	return getApproveForMeReviewer().review(tool, args, reason, context);
}
