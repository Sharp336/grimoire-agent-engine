import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { logger } from "@oh-my-pi/pi-utils";
import { z } from "zod";

// ═══════════════════════════════════════════════════════════════════════════
// Schema
// ═══════════════════════════════════════════════════════════════════════════

const hermesSchema = z.object({
	message: z.string().min(1).describe("The message to send to Hermes"),
	personality: z
		.string()
		.optional()
		.describe("Hermes personality to use (e.g. 'concise', 'technical', 'creative'). Omit for default."),
	continue_session: z.string().optional().describe("Previous session ID to continue a conversation with Hermes"),
});

export type HermesToolInput = z.infer<typeof hermesSchema>;

// ═══════════════════════════════════════════════════════════════════════════
// Config
// ═══════════════════════════════════════════════════════════════════════════

const HERMES_API_URL = process.env.HERMES_API_URL || "http://127.0.0.1:8642";
const HERMES_API_KEY = process.env.HERMES_API_KEY || "";
const REQUEST_TIMEOUT_MS = 120_000; // 2 min — Hermes may do tool calling

// ═══════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════

export interface HermesToolDetails {
	session_id?: string;
	turns_used?: number;
	model?: string;
	duration_ms?: number;
}

interface HermesChoice {
	message?: {
		role: string;
		content: string;
	};
	finish_reason?: string;
}

interface HermesResponse {
	choices?: HermesChoice[];
	model?: string;
	usage?: { total_tokens?: number };
	hermes_meta?: {
		session_id?: string;
		turns_used?: number;
	};
}

// ═══════════════════════════════════════════════════════════════════════════
// Tool
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Send a message to Hermes (the coordinator agent) and return its response.
 *
 * Hermes runs an OpenAI-compatible API server on localhost:8642. This tool
 * forwards a user message to Hermes and surfaces the final text response.
 *
 * Use this to:
 *   - Ask Hermes to look up tasks, check system state, or coordinate work
 *   - Continue a prior Hermes conversation by passing continue_session
 *   - Route context-heavy questions to Hermes when OMP lacks the context
 *
 * Requires Hermes API server to be running (`hermes gateway` or
 * `API_SERVER_ENABLED=true`).
 */
export class HermesTool implements AgentTool<typeof hermesSchema, HermesToolDetails> {
	readonly name = "hermes";
	readonly label = "Hermes";
	readonly summary = "Send a message to the Hermes coordinator agent";
	readonly loadMode = "discoverable" as const;
	readonly description = `Send a message to Hermes (the coordinator agent) and return its response.

Hermes operates at a higher orchestration layer than OMP — it manages
work-tracking, knowledge graph queries, and cross-session coordination.
Use this tool when you need information or actions that live outside
your current coding context (e.g. "what tasks am I blocked on?" or
"summarize what I shipped this week").

Parameters:
  message          – Required. The message to send.
  personality      – Optional. Personality preset (concise, technical, creative, …).
  continue_session – Optional. Previous session ID to keep context.`;

	readonly parameters = hermesSchema;

	// Omit _i field since intent is obvious
	readonly intent = "omit" as const;

	async execute(
		_toolCallId: string,
		params: HermesToolInput,
		signal?: AbortSignal,
	): Promise<AgentToolResult<HermesToolDetails>> {
		const startedAt = Date.now();
		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort("timeout"), REQUEST_TIMEOUT_MS);

		// Link external abort to internal controller
		const onExternalAbort = () => controller.abort(signal?.reason);
		signal?.addEventListener("abort", onExternalAbort);

		try {
			const url = `${HERMES_API_URL.replace(/\/$/, "")}/v1/chat/completions`;

			const systemParts: string[] = [];
			if (params.personality) {
				systemParts.push(`Personality: ${params.personality}`);
			}
			// Tell Hermes who is calling so it can contextualize
			systemParts.push(
				"You are being called by OMP (the coding agent). The user is working in a coding session. Be concise and actionable.",
			);

			const messages: Array<{ role: string; content: string }> = [];
			if (systemParts.length > 0) {
				messages.push({ role: "system", content: systemParts.join("\n") });
			}
			messages.push({ role: "user", content: params.message });

			const body: Record<string, unknown> = {
				model: "hermes-agent",
				messages,
				stream: false,
			};

			const headers: Record<string, string> = {
				"Content-Type": "application/json",
			};
			if (HERMES_API_KEY) {
				headers.Authorization = `Bearer ${HERMES_API_KEY}`;
			}
			if (params.continue_session) {
				headers["X-Hermes-Session-Id"] = params.continue_session;
			}

			logger.debug("hermes tool: posting to API server", { url });

			const response = await fetch(url, {
				method: "POST",
				headers,
				body: JSON.stringify(body),
				signal: controller.signal,
			});

			clearTimeout(timeoutId);

			if (!response.ok) {
				const text = await response.text().catch(() => "");
				let detail = text;
				try {
					const parsed = JSON.parse(text);
					detail = parsed.error?.message || text;
				} catch {
					/* ignore */
				}
				const errorText =
					`Hermes API error (${response.status}): ${detail || response.statusText}\n\n` +
					"Is Hermes running? Start it with: hermes gateway";
				return {
					content: [{ type: "text", text: errorText }],
					details: { duration_ms: Date.now() - startedAt },
					isError: true,
				};
			}

			const data = (await response.json()) as HermesResponse;
			const content = data.choices?.[0]?.message?.content ?? "";
			if (!content) {
				return {
					content: [{ type: "text", text: "Hermes returned an empty response." }],
					details: { duration_ms: Date.now() - startedAt },
					isError: true,
				};
			}

			const details: HermesToolDetails = {
				session_id: data.hermes_meta?.session_id,
				turns_used: data.hermes_meta?.turns_used,
				model: data.model,
				duration_ms: Date.now() - startedAt,
			};

			return {
				content: [{ type: "text", text: content }],
				details,
			};
		} catch (err: unknown) {
			clearTimeout(timeoutId);
			if (err instanceof Error && err.name === "AbortError") {
				return {
					content: [
						{
							type: "text",
							text: "Hermes request timed out after 2 minutes. Hermes may be stuck in a long tool loop or the server is not responding.",
						},
					],
					details: { duration_ms: Date.now() - startedAt },
					isError: true,
				};
			}
			const message = err instanceof Error ? err.message : String(err);
			logger.error("Hermes tool failed", { error: message });
			const errorText = `Failed to reach Hermes: ${message}\n\nIs Hermes running? Start it with: hermes gateway`;
			return {
				content: [{ type: "text", text: errorText }],
				details: { duration_ms: Date.now() - startedAt },
				isError: true,
			};
		} finally {
			signal?.removeEventListener("abort", onExternalAbort);
		}
	}
}

/**
 * Factory for the Hermes tool.
 */
export function createHermesTool(_session?: import("./index").ToolSession) {
	return new HermesTool();
}
