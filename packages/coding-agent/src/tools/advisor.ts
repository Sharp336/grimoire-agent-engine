import {
	type AgentTool,
	type AgentToolResult,
	instrumentedCompleteSimple,
	resolveTelemetry,
} from "@oh-my-pi/pi-agent-core";
import type { Message } from "@oh-my-pi/pi-ai";
import { z } from "zod/v4";
import { extractTextContent } from "../commit/utils";
import { formatModelString } from "../config/model-resolver";
import advisorDescription from "../prompts/tools/advisor.md" with { type: "text" };
import advisorCompactorPrompt from "../prompts/tools/advisor-compactor.md" with { type: "text" };
import advisorSystemPrompt from "../prompts/tools/advisor-system.md" with { type: "text" };
import type { AgentSession } from "../session/agent-session";
import { toReasoningEffort } from "../thinking";
import type { ToolSession } from ".";

const advisorSchema = z.object({
	focus: z
		.string()
		.describe("optional specific question for the advisor; omit for general guidance on the current task")
		.optional(),
});

export type AdvisorParams = z.infer<typeof advisorSchema>;

const DEFAULT_ASK =
	"Advise on the current task: the key decision, the approach you would take, and the failure mode to avoid.";

function advisorError(text: string): AgentToolResult {
	return { content: [{ type: "text", text }], isError: true, details: { advisor: null } };
}

/**
 * Model-invoked "advisor" tool: consults a separately-paired advisor model that
 * returns a concise plan / course-correction. The advisor model is resolved from
 * the `advisor` model role, so any provider can be paired with any executor
 * (unlike a vendor-native advisor that fixes the executor/advisor pair). Opt-in
 * via `advisor.enabled` (default off).
 *
 * Generic two-model strategy: when a `compactor` model role is also paired, a
 * cheap, fast, long-context model first digests the full transcript into a dense
 * brief, and the advisor reviews the brief — so a high-IQ but expensive or
 * shorter-context advisor stays affordable and in-budget. With no compactor the
 * advisor reads the transcript directly.
 *
 * Cache discipline mirrors {@link AgentSession.runEphemeralTurn} for BOTH side
 * calls: a stable `promptCacheKey` (the session id) lets repeated consults reuse
 * the growing-transcript prefix, while a unique per-call `sessionId` keeps each
 * side request's provider lineage separate so the executor's own prompt cache is
 * never disturbed.
 */
export class AdvisorTool implements AgentTool<typeof advisorSchema> {
	readonly name = "advisor";
	readonly approval = "read" as const;
	readonly label = "Advisor";
	readonly description = advisorDescription;
	readonly parameters = advisorSchema;
	readonly strict = true;
	readonly loadMode = "essential" as const;
	readonly summary = "Consult a paired advisor model for a second opinion on the current task";

	constructor(private readonly session: ToolSession) {}

	static createIf(session: ToolSession): AdvisorTool | null {
		return session.settings.get("advisor.enabled") ? new AdvisorTool(session) : null;
	}

	async execute(_id: string, params: AdvisorParams, signal?: AbortSignal): Promise<AgentToolResult> {
		const agentSession = this.session.getAgentSession?.();
		if (!agentSession) {
			return advisorError("Advisor is unavailable in this context.");
		}

		const { model, thinkingLevel } = agentSession.resolveRoleModelWithThinking("advisor");
		if (!model) {
			// No silent fallback to the executor model — that would defeat the pairing.
			return advisorError(
				'No advisor model configured. Pair one via the "Advisor" model role (run /model and assign the Advisor role).',
			);
		}

		const apiKey = await agentSession.modelRegistry.getApiKey(model, agentSession.sessionId);
		if (!apiKey) {
			return advisorError(
				`No API key for ${model.provider}/${model.id}; configure credentials or choose another advisor model.`,
			);
		}

		const ask = params.focus?.trim() || DEFAULT_ASK;
		const cacheSessionId = agentSession.sessionId;

		try {
			const transcript = await agentSession.convertMessagesToLlm(agentSession.messages, signal);
			// First stage (optional): compact the transcript with the paired `compactor` model.
			const brief = await this.#compact(agentSession, transcript, cacheSessionId, _id, signal);
			const advisorMessages: Message[] = brief
				? [
						{
							role: "user",
							content: [
								{ type: "text", text: `<conversation_brief>\n${brief}\n</conversation_brief>\n\n${ask}` },
							],
							timestamp: Date.now(),
						},
					]
				: [...transcript, { role: "user", content: [{ type: "text", text: ask }], timestamp: Date.now() }];

			const response = await instrumentedCompleteSimple(
				model,
				{ systemPrompt: [advisorSystemPrompt], messages: advisorMessages, tools: [] },
				agentSession.prepareSimpleStreamOptions(
					{
						apiKey: agentSession.modelRegistry.resolver(model, cacheSessionId),
						signal,
						reasoning: toReasoningEffort(thinkingLevel),
						promptCacheKey: cacheSessionId,
						sessionId: `${cacheSessionId}:advisor:${_id}`,
					},
					model.provider,
				),
				{ telemetry: resolveTelemetry(agentSession.agent.telemetry, cacheSessionId), oneshotKind: "advisor" },
			);

			if (response.stopReason === "error") {
				return advisorError(`Advisor request failed: ${response.errorMessage ?? "unknown error"}.`);
			}
			if (response.stopReason === "aborted") {
				return advisorError("Advisor request was aborted.");
			}

			const advice = extractTextContent(response).trim();
			if (!advice) {
				return advisorError("Advisor returned no guidance.");
			}

			return {
				content: [{ type: "text", text: advice }],
				details: { advisor: formatModelString(model), compacted: brief !== null },
			};
		} catch (err) {
			// Transport / resolver failures (advisor OR compactor) reject rather than resolving with a
			// stopReason. Keep the same graceful contract regardless of caller — the eval JS tool bridge
			// invokes execute() directly, without the agent loop's tool try/catch.
			return advisorError(`Advisor request failed: ${err instanceof Error ? err.message : String(err)}.`);
		}
	}

	/**
	 * Optional first stage of the generic advisor strategy. When a `compactor`
	 * model role is paired, a cheap, fast, long-context model digests the full
	 * transcript into a dense brief for the advisor. Returns `null` when no
	 * compactor is configured (the advisor then reads the transcript directly);
	 * throws when a configured compactor fails, so the caller surfaces a graceful
	 * advisorError rather than dumping the full transcript into a possibly
	 * shorter-context advisor.
	 *
	 * Cache discipline matches the advisor call: a stable `promptCacheKey` lets
	 * repeated consults reuse the compactor's growing-transcript prefix, while a
	 * unique per-call `sessionId` keeps its provider lineage separate.
	 */
	async #compact(
		agentSession: AgentSession,
		transcript: Message[],
		cacheSessionId: string,
		callId: string,
		signal: AbortSignal | undefined,
	): Promise<string | null> {
		const { model, thinkingLevel } = agentSession.resolveRoleModelWithThinking("compactor");
		if (!model) {
			// Discriminate "no compactor configured" (direct mode) from "configured but
			// unresolvable". A paired-but-unavailable compactor must NOT silently dump the
			// full transcript into a possibly short-context advisor — surface it instead.
			if (this.session.settings.getModelRole("compactor")) {
				throw new Error(
					"Paired compactor model is unavailable; configure credentials or reassign the compactor model role.",
				);
			}
			return null;
		}

		const apiKey = await agentSession.modelRegistry.getApiKey(model, cacheSessionId);
		if (!apiKey) {
			throw new Error(`No API key for the paired compactor ${model.provider}/${model.id}.`);
		}

		const response = await instrumentedCompleteSimple(
			model,
			{
				systemPrompt: [advisorCompactorPrompt],
				messages: [
					...transcript,
					{
						role: "user",
						content: [
							{ type: "text", text: "Compact the conversation above into a dense brief for an advisor." },
						],
						timestamp: Date.now(),
					},
				],
				tools: [],
			},
			agentSession.prepareSimpleStreamOptions(
				{
					apiKey: agentSession.modelRegistry.resolver(model, cacheSessionId),
					signal,
					reasoning: toReasoningEffort(thinkingLevel),
					promptCacheKey: cacheSessionId,
					sessionId: `${cacheSessionId}:advisor-compact:${callId}`,
				},
				model.provider,
			),
			{ telemetry: resolveTelemetry(agentSession.agent.telemetry, cacheSessionId), oneshotKind: "advisor_compact" },
		);

		if (response.stopReason === "error" || response.stopReason === "aborted") {
			throw new Error(response.errorMessage ?? "compactor request failed");
		}
		const brief = extractTextContent(response).trim();
		if (!brief) {
			throw new Error("compactor returned an empty brief");
		}
		return brief;
	}
}
