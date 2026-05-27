/**
 * Langfuse telemetry adapter that plugs into the agent-level `AgentTelemetryConfig`
 * hooks (`onRunEnd`, `onChatUsage`, `onSpanStart`, `onSpanEnd`).
 *
 * This is **provider-agnostic** — it sits at the agent loop level, so every LLM
 * provider (Kimi, Anthropic, Gemini, OpenRouter, …) gets Langfuse traces
 * without needing per-provider wrapping.
 *
 * All Langfuse calls are wrapped in `try/catch` and errors are reported via
 * `onTelemetryWarning`. The adapter never throws.
 */

import { postmortem } from "@oh-my-pi/pi-utils";
import type { Langfuse, LangfuseSpanClient, LangfuseTraceClient } from "langfuse";
import { detectDomain } from "./utils";

function randomId(): string {
	return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function safeJson(value: unknown): string | undefined {
	try {
		return JSON.stringify(value);
	} catch {
		return undefined;
	}
}

/* ── Minimal structural types compatible with AgentTelemetryConfig callbacks ── */

interface TelemetryWarning {
	readonly code: string;
	readonly message: string;
	readonly error?: unknown;
}

interface SpanLike {
	spanContext(): { traceId: string; spanId: string };
}

interface ChatUsageEventLike {
	readonly span: SpanLike;
	readonly model: string;
	readonly provider: string | undefined;
	readonly stepNumber: number | undefined;
	readonly usage: {
		readonly inputTokens: number;
		readonly outputTokens: number;
		readonly totalTokens: number;
		readonly cachedInputTokens: number | undefined;
		readonly cacheWriteTokens: number | undefined;
		readonly reasoningOutputTokens: number | undefined;
	};
	readonly cost:
		| { readonly usd: number; readonly inputUsd?: number; readonly outputUsd?: number }
		| { readonly unavailable: string }
		| undefined;
	readonly conversationId: string | undefined;
	readonly headers: Readonly<Record<string, string>> | undefined;
}

interface RunSummaryLike {
	readonly stepCount: number;
	readonly chats: { readonly total: number; readonly totalLatencyMs: number };
	readonly tools: {
		readonly total: number;
		readonly ok: number;
		readonly error: number;
		readonly skipped: number;
		readonly blocked: number;
		readonly timeout: number;
		readonly aborted: number;
	};
	readonly usage: {
		readonly inputTokens: number;
		readonly outputTokens: number;
		readonly totalTokens: number;
	};
	readonly cost: { readonly estimatedUsd: number };
	readonly errors: { readonly total: number };
}

interface RunCoverageLike {
	readonly modelsUsed: readonly string[];
	readonly providersUsed: readonly string[];
}

interface HookContextLike {
	readonly kind: string;
	readonly span: SpanLike;
	readonly agent: { readonly name?: string; readonly id?: string } | undefined;
	readonly conversationId: string | undefined;
	readonly stepNumber?: number;
	readonly toolCallId?: string;
	readonly toolName?: string;
}

/** Shape returned by {@link buildLangfuseTelemetryConfig}. Structurally compatible
 * with `AgentTelemetryConfig` so it can be spread directly into telemetry options. */
export interface LangfuseTelemetryAdapter {
	readonly onRunEnd?: (summary: RunSummaryLike, coverage: RunCoverageLike) => void;
	readonly onChatUsage?: (event: ChatUsageEventLike) => void | Promise<void>;
	readonly onSpanStart?: (ctx: HookContextLike) => void;
	readonly onSpanEnd?: (ctx: HookContextLike) => void;
	readonly onTelemetryWarning?: (warning: TelemetryWarning) => void;
}

interface TraceState {
	trace: LangfuseTraceClient;
	langfuseTraceId?: string;
}

/**
 * Build a Langfuse telemetry adapter that consumes the agent loop's OTEL hooks.
 *
 * @param client   Langfuse SDK instance (from {@link getLangfuseClient}).
 * @param options  Optional conversationId for session correlation, plus extra tags/metadata.
 * @returns Partial telemetry config ready to be spread into `AgentOptions.telemetry`.
 */
export function buildLangfuseTelemetryConfig(
	client: Langfuse,
	options?: {
		readonly conversationId?: string;
		readonly tags?: string[];
		readonly metadata?: Record<string, unknown>;
	},
): LangfuseTelemetryAdapter {
	const sessionId = options?.conversationId || randomId();
	const baseTags = options?.tags ?? [];
	const baseMetadata = options?.metadata ?? {};

	// Keyed by OTEL traceId (same across a single agent run)
	const tracesByTraceId = new Map<string, TraceState>();
	// Keyed by sessionId so onRunEnd can find the trace without a span reference
	const tracesBySessionId = new Map<string, TraceState>();
	// Keyed by OTEL spanId for active execute_tool spans
	const toolSpansBySpanId = new Map<string, LangfuseSpanClient>();
	// Flush pending traces before the process exits so partial / crashed runs
	// still appear in Langfuse. Normal runs also flush in onRunEnd; this is
	// a safety net.
	postmortem.register("langfuse-telemetry-flush", async () => {
		try {
			await client.shutdownAsync();
		} catch {
			// ignore — best-effort flush on exit
		}
	});

	function reportWarning(code: string, message: string, error?: unknown) {
		try {
			const hook = adapter.onTelemetryWarning;
			if (hook) {
				hook({ code, message, error });
			}
		} catch {
			// swallow — telemetry warnings must never propagate
		}
	}

	const adapter: LangfuseTelemetryAdapter = {
		onSpanStart(ctx) {
			try {
				if (ctx.kind === "invoke_agent") {
					const rawTraceId = ctx.span.spanContext().traceId;
					// If OTEL is in no-op mode the traceId is all zeros; let Langfuse
					// auto-generate a real id so the trace is queryable.
					const traceId = /^0+$/.test(rawTraceId) ? undefined : rawTraceId;
					if (tracesByTraceId.has(traceId || rawTraceId)) {
						// Already started (possible with nested / resumed spans)
						return;
					}

					const domain = detectDomain();
					const provider = ctx.agent?.name || "unknown";

					const trace = client.trace({
						id: traceId,
						name: "omp",
						sessionId,
						tags: [...baseTags, "omp", provider, domain].filter(Boolean),
						metadata: {
							...baseMetadata,
							agentName: ctx.agent?.name,
							agentId: ctx.agent?.id,
							conversationId: ctx.conversationId,
							cwd: process.cwd(),
							platform: process.platform,
						},
					});

					const state: TraceState = {
						trace,
						langfuseTraceId: trace.traceId,
					};
					tracesByTraceId.set(traceId || trace.traceId || rawTraceId, state);
					// Also store by raw OTEL traceId so zero-id lookups find the trace.
					tracesByTraceId.set(rawTraceId, state);
					tracesBySessionId.set(sessionId, state);
				} else if (ctx.kind === "execute_tool") {
					const traceId = ctx.span.spanContext().traceId;
					const state = tracesByTraceId.get(traceId);
					if (!state) return;

					const span = state.trace.span({
						name: ctx.toolName || "tool",
						input: safeJson({ toolCallId: ctx.toolCallId }),
						metadata: { toolCallId: ctx.toolCallId, isError: false },
					});

					toolSpansBySpanId.set(ctx.span.spanContext().spanId, span);
				}
				// "chat" and "handoff" spans are intentionally ignored here;
				// generations are created via onChatUsage instead.
			} catch (err) {
				reportWarning("on_span_start_failed", "Langfuse onSpanStart failed", err);
			}
		},

		onSpanEnd(ctx) {
			try {
				if (ctx.kind === "execute_tool") {
					const spanId = ctx.span.spanContext().spanId;
					const span = toolSpansBySpanId.get(spanId);
					if (span) {
						span.end();
						toolSpansBySpanId.delete(spanId);
					}
				}
				// invoke_agent onSpanEnd: we intentionally do NOT end the trace here,
				// because onRunEnd (which fires immediately after) still needs to attach
				// scores and update metadata.
			} catch (err) {
				reportWarning("on_span_end_failed", "Langfuse onSpanEnd failed", err);
			}
		},

		onChatUsage(event) {
			try {
				const traceId = event.span.spanContext().traceId;
				const state = tracesByTraceId.get(traceId);
				if (!state) return;

				const usage = event.usage;
				const cost = event.cost && "usd" in event.cost ? event.cost : undefined;
				state.trace.generation({
					name: "llm-generation",
					model: event.model,
					metadata: {
						provider: event.provider,
						stepNumber: event.stepNumber,
						requestId: event.headers?.["x-request-id"],
					},
					usageDetails: {
						input: usage.inputTokens,
						output: usage.outputTokens,
						total: usage.totalTokens,
						cacheRead: usage.cachedInputTokens ?? 0,
						cacheWrite: usage.cacheWriteTokens ?? 0,
						reasoning: usage.reasoningOutputTokens ?? 0,
					},
					costDetails: cost
						? {
								input: cost.inputUsd ?? cost.usd,
								output: cost.outputUsd ?? cost.usd,
								total: cost.usd,
							}
						: undefined,
				});
			} catch (err) {
				reportWarning("on_chat_usage_failed", "Langfuse onChatUsage failed", err);
			}
		},

		onRunEnd(summary, coverage) {
			try {
				const state = tracesBySessionId.get(sessionId);
				if (!state) return;

				const trace = state.trace;
				// Update trace with aggregate run metadata
				trace.update({
					metadata: {
						...baseMetadata,
						totalTokens: summary.usage.totalTokens,
						totalCostUsd: summary.cost.estimatedUsd,
						totalErrors: summary.errors.total,
						modelsUsed: coverage.modelsUsed,
						providersUsed: coverage.providersUsed,
					},
				});

				// Scores
				const toolSuccessRate = summary.tools.total > 0 ? summary.tools.ok / summary.tools.total : 0;
				const totalToolErrors = summary.tools.error;

				try {
					client.score({
						traceId: trace.traceId,
						name: "tool_success_rate",
						value: toolSuccessRate,
					});
				} catch {
					// fail-open
				}

				try {
					client.score({
						traceId: trace.traceId,
						name: "total_tool_errors",
						value: totalToolErrors,
					});
				} catch {
					// fail-open
				}

				try {
					client.score({
						traceId: trace.traceId,
						name: "turn_count",
						value: summary.stepCount,
					});
				} catch {
					// fail-open
				}

				// Flush so traces are sent before process exit
				client.flushAsync().catch(() => {
					// fail-open
				});
			} catch (err) {
				reportWarning("on_run_end_failed", "Langfuse onRunEnd failed", err);
			} finally {
				// Clean up to avoid leaking across runs
				const stateToClean = tracesBySessionId.get(sessionId);
				if (stateToClean) {
					tracesBySessionId.delete(sessionId);
					// Also remove from traceId map
					for (const [traceId, s] of tracesByTraceId) {
						if (s === stateToClean) {
							tracesByTraceId.delete(traceId);
							break;
						}
					}
				}
			}
		},

		onTelemetryWarning(_warning) {
			// The agent telemetry system already surfaces warnings via console.warn.
			// We do not forward them to Langfuse to avoid feedback loops.
		},
	};

	return adapter;
}
