/**
 * ExecutionStrategy — composable hook bundle for customizing how the agent
 * loop runs without subclassing Agent or forking agent-loop.
 *
 * Agent has always exposed individual hooks (convertToLlm, transformContext,
 * syncContextBeforeModelCall) via its constructor options. Those hooks are
 * fine for single-purpose customization, but they are frozen at construction
 * time and can only be composed by hand. An ExecutionStrategy groups them
 * into a single coherent object that can be swapped atomically at runtime,
 * carries its own state, and is testable in isolation.
 *
 * The strategy's hooks are *composed* with whatever base hooks the Agent was
 * constructed with. A strategy cannot silently shadow convertToLlm — it
 * receives the base converter and returns a wrapped one. The same holds for
 * transformContext, which runs after any base transform.
 *
 * Conceptual shape:
 *   base.transformContext → strategy.transformContext → convertToLlm boundary
 *   strategy.syncBeforeModelCall (runs before base sync)
 *   strategy.wrapConvertToLlm(base) → effective converter
 *   strategy.onTurnEnd (runs after each assistant turn, before event dispatch
 *                      resumes on the caller side)
 *
 * Default: undefined. When no strategy is installed, Agent behaves exactly
 * as it did before this interface existed. This is a strict additive change.
 */

import type { Message } from "@oh-my-pi/pi-ai";
import type { AgentContext, AgentMessage, AgentTool } from "./types";

export type StrategyConvertToLlmFn = (messages: AgentMessage[]) => Message[] | Promise<Message[]>;

export type StrategyTransformContextFn = (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;

export type StrategySyncBeforeModelCallFn = (context: AgentContext) => void | Promise<void>;

export type StrategyTurnEndFn = (info: {
	context: AgentContext;
	message: AgentMessage;
	newMessages: readonly AgentMessage[];
}) => void | Promise<void>;

export type StrategyAgentEndFn = (info: {
	context: AgentContext;
	newMessages: readonly AgentMessage[];
}) => void | Promise<void>;

/**
 * A pluggable execution strategy for the agent loop.
 *
 * Every field is optional. An implementation only needs to fill the hooks it
 * cares about; the rest fall through to the Agent's base behavior.
 */
export interface ExecutionStrategy {
	/** Human-readable identifier. Used only for diagnostics. */
	readonly name: string;

	/**
	 * Wrap the base convertToLlm to filter, reorder, or augment messages
	 * before they reach the LLM. The base converter must be called from
	 * inside the wrapper unless the strategy deliberately shadows it.
	 */
	wrapConvertToLlm?(base: StrategyConvertToLlmFn): StrategyConvertToLlmFn;

	/**
	 * Transform the AgentMessage[] view of the context before convertToLlm
	 * runs. Invoked *after* the Agent's base transformContext (if any), so
	 * strategies see the already-transformed view.
	 */
	transformContext?(messages: AgentMessage[], signal?: AbortSignal): Promise<AgentMessage[]>;

	/**
	 * Called before every model call, *after* the Agent's base
	 * syncContextBeforeModelCall (which refreshes ctx.systemPrompt and
	 * ctx.tools from the live session state). The strategy sees the
	 * already-refreshed context and can override whatever it needs.
	 */
	syncBeforeModelCall?(context: AgentContext): void | Promise<void>;

	/**
	 * Called after each turn (one assistant response plus any tool results)
	 * completes. The `newMessages` array contains every AgentMessage added
	 * during this turn, in order.
	 */
	onTurnEnd?(info: {
		context: AgentContext;
		message: AgentMessage;
		newMessages: readonly AgentMessage[];
	}): void | Promise<void>;

	/**
	 * Called once when the agent loop for a single prompt completes, after
	 * the final turn. Use this for end-of-run bookkeeping: persisting
	 * derived state, emitting summary events, etc.
	 */
	onAgentEnd?(info: { context: AgentContext; newMessages: readonly AgentMessage[] }): void | Promise<void>;
}

/**
 * Apply a strategy's convertToLlm wrapper to a base converter. Returns the
 * base unchanged when the strategy is absent or does not override the hook.
 */
export function applyStrategyConvertToLlm(
	base: StrategyConvertToLlmFn,
	strategy: ExecutionStrategy | undefined,
): StrategyConvertToLlmFn {
	if (!strategy?.wrapConvertToLlm) return base;
	return strategy.wrapConvertToLlm(base);
}

/**
 * Compose a base transformContext with a strategy's transformContext.
 * The base runs first; the strategy sees the output of the base. Either or
 * both may be absent.
 */
export function composeTransformContext(
	base: StrategyTransformContextFn | undefined,
	strategy: ExecutionStrategy | undefined,
): StrategyTransformContextFn | undefined {
	const stratFn = strategy?.transformContext;
	if (!base && !stratFn) return undefined;
	if (!stratFn) return base;
	if (!base) return (msgs, signal) => stratFn.call(strategy, msgs, signal);
	return async (msgs, signal) => {
		const afterBase = await base(msgs, signal);
		return stratFn.call(strategy, afterBase, signal);
	};
}

/**
 * Compose a base syncBeforeModelCall with the strategy's. Base runs first
 * so the loop's live state (system prompt, tools) is installed on the
 * context; the strategy runs after and can override whatever it needs.
 * This lets a strategy replace the system prompt or filter the tool list
 * for a specific run without fighting the agent's refresh pass.
 */
export function composeSyncBeforeModelCall(
	base: StrategySyncBeforeModelCallFn | undefined,
	strategy: ExecutionStrategy | undefined,
): StrategySyncBeforeModelCallFn | undefined {
	const stratFn = strategy?.syncBeforeModelCall;
	if (!base && !stratFn) return undefined;
	if (!stratFn) return base;
	if (!base) return ctx => stratFn.call(strategy, ctx);
	return async ctx => {
		await base(ctx);
		await stratFn.call(strategy, ctx);
	};
}

/**
 * Utility re-export so implementations can type their hooks without pulling
 * a second import line from "./types".
 */
export type { AgentContext, AgentMessage, AgentTool };
