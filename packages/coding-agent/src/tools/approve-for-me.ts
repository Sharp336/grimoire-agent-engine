/**
 * "Approve for me" auto-reviewer: a separate LLM evaluates each
 * approval-pending tool call and auto-approves or denies it, so the user is
 * not prompted for every exec-tier action.
 *
 * Fail-closed: timeout, parse failure, or model error → deny.
 * Circuit breaker: 3 consecutive denials or 10 in the last 50 → interrupt turn.
 */
import type { AgentTool, AgentToolContext } from "@oh-my-pi/pi-agent-core";
import { type Api, completeSimple, type Message, type Model, type Tool, type ToolCall } from "@oh-my-pi/pi-ai";
import type { ModelRegistry } from "../config/model-registry";
import { resolveRoleSelection } from "../config/model-resolver";
import type { Settings } from "../config/settings";
import { truncateForPrompt } from "./approval";
import policy from "./approve-for-me-policy.md" with { type: "text" };

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
			outcome: { type: "string", enum: ["allow", "deny"] },
			rationale: { type: "string" },
		},
		required: ["risk_level", "user_authorization", "outcome", "rationale"],
	} as Record<string, unknown>,
	strict: false,
};

/** Session-scoped reviewer with per-session cache + circuit breaker. */
export class ApproveForMeReviewer {
	#consecutiveDenials = 0;
	#recentDenials: boolean[] = [];
	#cache = new Map<string, ReviewDecision>();

	/**
	 * Review a tool call. Returns the decision, or a fail-closed deny on any
	 * error (timeout, parse failure, model unavailable).
	 */
	async review(
		tool: AgentTool,
		args: unknown,
		reason: string | undefined,
		context: AgentToolContext | undefined,
	): Promise<ReviewDecision> {
		const cacheKey = this.#cacheKey(tool.name, args);
		const cached = this.#cache.get(cacheKey);
		if (cached) return cached;

		try {
			const prompt = this.#buildPrompt(tool, args, reason);
			const result = await this.#callModel(prompt, context);
			const decision = this.#parseDecision(result);
			if (decision.outcome === "allow") {
				this.#cache.set(cacheKey, decision);
			}
			this.#recordReview(decision.outcome === "deny");
			return decision;
		} catch (err) {
			this.#recordReview(true);
			return {
				risk_level: "high",
				user_authorization: "unknown",
				outcome: "deny",
				rationale: `Auto-review failed: ${err instanceof Error ? err.message : "unknown error"}. Falling back to deny for safety.`,
			};
		}
	}

	/** Circuit breaker: after N consecutive denials or M in last K, interrupt. */
	shouldInterruptTurn(): boolean {
		return (
			this.#consecutiveDenials >= MAX_CONSECUTIVE_DENIALS ||
			this.#recentDenials.filter(Boolean).length >= MAX_RECENT_DENIALS
		);
	}

	/** Clear the circuit breaker (e.g. on a new turn). */
	resetCircuitBreaker(): void {
		this.#consecutiveDenials = 0;
		this.#recentDenials = [];
	}

	#recordReview(denied: boolean): void {
		this.#consecutiveDenials = denied ? this.#consecutiveDenials + 1 : 0;
		this.#recentDenials.push(denied);
		if (this.#recentDenials.length > DENIAL_WINDOW) {
			this.#recentDenials.shift();
		}
	}

	#cacheKey(toolName: string, args: unknown): string {
		try {
			return `${toolName}:${JSON.stringify(args)}`;
		} catch {
			return `${toolName}:${String(args)}`;
		}
	}

	#buildPrompt(tool: AgentTool, args: unknown, reason: string | undefined): string {
		const lines: string[] = [policy, "", "## Planned Action", `Tool: ${tool.name}`];
		if (reason) lines.push(`Approval reason: ${reason}`);

		let argsStr: string;
		try {
			argsStr = JSON.stringify(args, null, 2);
		} catch {
			argsStr = String(args);
		}
		lines.push(`Arguments:\n${truncateForPrompt(argsStr, ARGS_TRUNCATE_CHARS)}`);
		lines.push("", 'Return your decision by calling the "respond" tool with the JSON fields.');
		return lines.join("\n");
	}

	async #callModel(prompt: string, context: AgentToolContext | undefined): Promise<unknown> {
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

		const messages: Message[] = [{ role: "user", content: prompt, timestamp: Date.now() }];

		const response = await completeSimple(
			model,
			{
				systemPrompt: [
					"You are a safety reviewer for an AI coding agent. Evaluate the proposed tool call and return a decision.",
				],
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

	#parseDecision(raw: unknown): ReviewDecision {
		if (typeof raw !== "object" || raw === null) {
			throw new Error("auto-review response is not an object");
		}
		const obj = raw as Record<string, unknown>;
		const {
			risk_level: risk,
			user_authorization: auth,
			outcome,
			rationale,
		} = obj as {
			risk_level: unknown;
			user_authorization: unknown;
			outcome: unknown;
			rationale: unknown;
		};

		if (
			(risk === "low" || risk === "medium" || risk === "high" || risk === "critical") &&
			(auth === "high" || auth === "medium" || auth === "low" || auth === "unknown") &&
			(outcome === "allow" || outcome === "deny") &&
			typeof rationale === "string"
		) {
			return { risk_level: risk, user_authorization: auth, outcome, rationale };
		}

		throw new Error("auto-review response does not match expected schema");
	}
}

/** Singleton reviewer per process — session cache is instance-scoped. */
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
