/**
 * Pure blend primitives for synthetic `omp-swarm` models.
 *
 * These combinators express the three blend strategies (router / sequence /
 * draft-refine / moa) over swarm members **without performing any I/O**. Each
 * primitive is parameterized by a {@link DriveNode} callback — the single effect
 * edge. The combinators never call `streamSimple` or `runSubprocess`; they only
 * invoke the injected `DriveNode`, so they are deterministic and fully testable
 * with a stub node.
 *
 * The model-leaf effect edge ({@link modelLeafDriveNode}) lives here too: it is
 * the one place that touches the network (via the injected `streamSimple`). The
 * subagent-leaf edge is added in a sibling unit and calls `runSubprocess`
 * directly — never importing `@oh-my-pi/swarm-extension` (no cross-package cycle).
 *
 * Placement: `coding-agent`, NOT `ai`. Nothing in `ai` consumes these; the sole
 * consumer is the blend executor (sibling unit) in this same package. The module
 * depends only on `ai` event-stream + catalog types, so a later lift to `ai` is
 * mechanical if a second consumer ever appears.
 */

import type {
	AssistantMessage,
	AssistantMessageEvent,
	Context,
	Model,
	SimpleStreamOptions,
	SwarmMember,
	SwarmSpec,
	Usage,
} from "@oh-my-pi/pi-ai";
import type { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";

/** Default hard cap on members actually run when `swarm.maxMembers` is unset. */
export const DEFAULT_MAX_MEMBERS = 5;

/**
 * The sentinel meaning "drive this member against the original context verbatim,
 * with no extra user turn". It is a unique symbol (NOT the empty string) so it
 * can never collide with a piped member output: a stage that produces empty text
 * yields `output: ""`, which is a distinct {@link DriveInput} from this sentinel
 * and is therefore still appended as a (possibly empty) user turn rather than
 * silently reverting the downstream stage to the original context.
 */
export const ORIGINAL_INPUT: unique symbol = Symbol("swarm.ORIGINAL_INPUT");

/**
 * The input handed to a {@link DriveNode}: either the {@link ORIGINAL_INPUT}
 * sentinel (drive against the base context) or a concrete prompt string (a
 * piped member output, appended as a fresh user turn — even when empty).
 */
export type DriveInput = typeof ORIGINAL_INPUT | string;

/**
 * The result of driving a single swarm member to completion. `output` is the
 * textual content threaded into the next member (sequence) or collected for the
 * aggregator (moa); `message` is the full assistant message; `usage` is the
 * member's token spend. `stream` is the live stream when the caller wants to
 * forward content events (the surfaced member); it is omitted for buffered runs.
 */
export interface DriveResult {
	/** The full assistant message produced by this member. */
	message: AssistantMessage;
	/** This member's token usage (summed into the blend total). */
	usage: Usage;
	/** The member's text output, used to feed downstream members. */
	output: string;
	/** Live event stream, present only when content should be forwarded. */
	stream?: AssistantMessageEventStream;
}

/**
 * The single effect edge: runs one member with an input prompt and resolves to
 * its {@link DriveResult}. `kind: "model"` members get {@link modelLeafDriveNode};
 * `kind: "subagent"` members get the subagent leaf (sibling unit). The pure
 * combinators only ever call this callback — never the underlying transport.
 */
export type DriveNode = (member: SwarmMember, input: DriveInput, signal?: AbortSignal) => Promise<DriveResult>;

/**
 * Apply the `maxMembers` guardrail. Returns at most `maxMembers` members
 * (default {@link DEFAULT_MAX_MEMBERS}), preserving order. A non-positive or
 * absent cap falls back to the default.
 */
export function capMembers(members: readonly SwarmMember[], maxMembers?: number): SwarmMember[] {
	const cap = maxMembers !== undefined && maxMembers > 0 ? maxMembers : DEFAULT_MAX_MEMBERS;
	return members.slice(0, cap);
}

/**
 * Sum a list of {@link Usage} records into one, recomputing the derived totals
 * (`totalTokens` = input+output+cacheRead+cacheWrite; `cost.total` = the sum of
 * its components) so the blend reports a single coherent usage. Mirrors the
 * canonical formula in `packages/catalog/src/types.ts`.
 */
export function sumUsage(usages: readonly Usage[]): Usage {
	const acc: Usage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	let reasoningTokens: number | undefined;
	let premiumRequests: number | undefined;
	for (const u of usages) {
		acc.input += u.input;
		acc.output += u.output;
		acc.cacheRead += u.cacheRead;
		acc.cacheWrite += u.cacheWrite;
		acc.cost.input += u.cost.input;
		acc.cost.output += u.cost.output;
		acc.cost.cacheRead += u.cost.cacheRead;
		acc.cost.cacheWrite += u.cost.cacheWrite;
		if (u.reasoningTokens !== undefined) reasoningTokens = (reasoningTokens ?? 0) + u.reasoningTokens;
		if (u.premiumRequests !== undefined) premiumRequests = (premiumRequests ?? 0) + u.premiumRequests;
	}
	// Recompute derived totals from components (never trust per-member totals).
	acc.totalTokens = acc.input + acc.output + acc.cacheRead + acc.cacheWrite;
	acc.cost.total = acc.cost.input + acc.cost.output + acc.cost.cacheRead + acc.cost.cacheWrite;
	if (reasoningTokens !== undefined) acc.reasoningTokens = reasoningTokens;
	if (premiumRequests !== undefined) acc.premiumRequests = premiumRequests;
	return acc;
}

/** Concatenate the text content blocks of an assistant message into one string. */
function messageText(message: AssistantMessage): string {
	let text = "";
	for (const block of message.content) {
		if (block.type === "text") text += block.text;
	}
	return text;
}

/**
 * Run members in order, piping each member's `output` into the next member's
 * input (`sequence` / `draft-refine`). The FIRST member is driven against
 * {@link ORIGINAL_INPUT} (it sees the user's prompt via the base context); every
 * subsequent member receives the previous member's `output`, which the leaf
 * appends as a fresh user turn. This passthrough is explicit here, not inferred
 * downstream. Returns every member's {@link DriveResult} in run order; the caller
 * surfaces the terminal member and sums usage. The combinator is pure: all
 * effects flow through `drive`.
 *
 * @param members ordered stages (already resolved; cap applied by the caller).
 * @param drive the effect edge.
 * @param signal cooperative abort, forwarded to each `drive` call.
 */
export async function runSequence(
	members: readonly SwarmMember[],
	drive: DriveNode,
	signal?: AbortSignal,
): Promise<DriveResult[]> {
	const results: DriveResult[] = [];
	// First member sees the original prompt (ORIGINAL_INPUT); thereafter pipe.
	// `input` is a DriveInput, so an empty piped `output` ("") stays distinct
	// from the sentinel and is appended as a (possibly empty) user turn rather
	// than reverting the next stage to the original context.
	let input: DriveInput = ORIGINAL_INPUT;
	for (const member of members) {
		signal?.throwIfAborted();
		const result = await drive(member, input, signal);
		results.push(result);
		input = result.output;
	}
	return results;
}

/**
 * Pick exactly one member and run it (`router`). The `select` callback inspects
 * the user prompt and returns the role (or index) of the winning member; the
 * combinator resolves it against `members` and drives only that one against
 * {@link ORIGINAL_INPUT} (the chosen member answers the user's original prompt
 * via the base context). `select` is the selector seam — a classifier-model or
 * static-rule call lives in the executor, not here, so this combinator stays
 * pure.
 *
 * @param userPrompt the user's prompt text, passed to `select` for routing.
 * @returns the single chosen member's {@link DriveResult} plus the resolved member.
 * @throws if `select` returns a role/index that matches no member.
 */
export async function runRouter(
	members: readonly SwarmMember[],
	userPrompt: string,
	select: (members: readonly SwarmMember[], userPrompt: string, signal?: AbortSignal) => Promise<string | number>,
	drive: DriveNode,
	signal?: AbortSignal,
): Promise<{ chosen: SwarmMember; result: DriveResult }> {
	signal?.throwIfAborted();
	const choice = await select(members, userPrompt, signal);
	const chosen = typeof choice === "number" ? members[choice] : members.find(m => m.role === choice);
	if (chosen === undefined) {
		throw new Error(`router selector returned no matching member for ${JSON.stringify(choice)}`);
	}
	const result = await drive(chosen, ORIGINAL_INPUT, signal);
	return { chosen, result };
}

/** A {@link runParallelAggregate} run: every proposer result plus the aggregator's. */
export interface ParallelAggregateResult {
	/** One entry per proposer, in declaration order (failed proposers omitted). */
	proposals: DriveResult[];
	/** The aggregator's synthesized/voted result. */
	aggregate: DriveResult;
}

/**
 * Run proposer members in parallel, then synthesize/vote with the aggregator
 * (`moa`). Every proposer is driven against {@link ORIGINAL_INPUT} (each answers
 * the user's original prompt) concurrently; a proposer failure is tolerated (its
 * result is dropped) as long as at least one proposal survives — matching "one
 * voter fails → remaining outputs still reduce". The surviving proposals are
 * handed to `buildAggregatorInput`, whose (non-empty) output drives the
 * aggregator as a fresh user turn. An abort `signal` is fatal (propagated, not
 * swallowed).
 *
 * @param proposers the fan-out members (cap applied by the caller).
 * @param aggregator the reduce member.
 * @param userPrompt the user's prompt, passed to `buildAggregatorInput`.
 * @param buildAggregatorInput maps the surviving proposals → the aggregator prompt.
 * @param drive the effect edge.
 * @throws if every proposer fails, or on abort.
 */
export async function runParallelAggregate(
	proposers: readonly SwarmMember[],
	aggregator: SwarmMember,
	userPrompt: string,
	buildAggregatorInput: (userPrompt: string, proposals: DriveResult[]) => string,
	drive: DriveNode,
	signal?: AbortSignal,
): Promise<ParallelAggregateResult> {
	signal?.throwIfAborted();
	const settled = await Promise.allSettled(proposers.map(member => drive(member, ORIGINAL_INPUT, signal)));
	// An abort is fatal: surface it instead of degrading to a partial reduce.
	if (signal?.aborted) signal.throwIfAborted();
	const proposals: DriveResult[] = [];
	let lastError: unknown;
	for (const outcome of settled) {
		if (outcome.status === "fulfilled") proposals.push(outcome.value);
		else lastError = outcome.reason;
	}
	if (proposals.length === 0) {
		throw new Error(
			`all ${proposers.length} proposer(s) failed in moa blend: ${
				lastError instanceof Error ? lastError.message : String(lastError)
			}`,
		);
	}
	const aggregatorInput = buildAggregatorInput(userPrompt, proposals);
	const aggregate = await drive(aggregator, aggregatorInput, signal);
	return { proposals, aggregate };
}

/**
 * Emit the surfaced member's message as the blend's single outer stream, with
 * `usage` overwritten to the summed total across all members run (KTD-7). The
 * outer stream pushes `start` → the surface's content events → `done`, so
 * `result()` settles with one coherent message. Only the surface member's
 * content reaches the user; non-surfaced members (e.g. proposers, classifier)
 * contribute usage but not content.
 *
 * @param outer the blend's single output stream (pushed into and closed here).
 * @param surface the surfaced member's full message (its content is forwarded).
 * @param totalUsage the summed usage across every member run.
 */
export function emitSurface(outer: AssistantMessageEventStream, surface: AssistantMessage, totalUsage: Usage): void {
	// Clone so we can rewrite usage without mutating the member's own message.
	const message: AssistantMessage = { ...surface, usage: totalUsage };
	const partial = message;
	outer.push({ type: "start", partial });
	for (let i = 0; i < message.content.length; i++) {
		const block = message.content[i];
		if (block.type === "text") {
			outer.push({ type: "text_start", contentIndex: i, partial });
			outer.push({ type: "text_delta", contentIndex: i, delta: block.text, partial });
			outer.push({ type: "text_end", contentIndex: i, content: block.text, partial });
		} else if (block.type === "thinking") {
			outer.push({ type: "thinking_start", contentIndex: i, partial });
			outer.push({ type: "thinking_delta", contentIndex: i, delta: block.thinking, partial });
			outer.push({ type: "thinking_end", contentIndex: i, content: block.thinking, partial });
		} else if (block.type === "toolCall") {
			const serialized = typeof block.arguments === "string" ? block.arguments : JSON.stringify(block.arguments);
			outer.push({ type: "toolcall_start", contentIndex: i, partial });
			outer.push({ type: "toolcall_delta", contentIndex: i, delta: serialized, partial });
			outer.push({ type: "toolcall_end", contentIndex: i, toolCall: block, partial });
		}
		// RedactedThinkingContent has no event-stream representation; skip it.
	}
	const reason = surfaceDoneReason(message.stopReason);
	if (reason === undefined) {
		outer.push({
			type: "error",
			reason: message.stopReason === "aborted" ? "aborted" : "error",
			error: { ...message, errorMessage: message.errorMessage ?? "swarm surface error" },
		});
		return;
	}
	outer.push({ type: "done", reason, message });
}

/** Narrow a surface message's stopReason to the terminal-success `done` reasons. */
function surfaceDoneReason(stopReason: AssistantMessage["stopReason"]): "stop" | "length" | "toolUse" | undefined {
	if (stopReason === "stop" || stopReason === "length" || stopReason === "toolUse") return stopReason;
	return undefined;
}

/**
 * Builds the per-member {@link Context} from the base context and the member's
 * {@link DriveInput}. Injected into {@link modelLeafDriveNode} so transport
 * execution and context-threading policy stay separable. The default
 * ({@link appendUserInputContext}) appends a string input as a user turn and
 * passes {@link ORIGINAL_INPUT} through unchanged.
 */
export type MemberContextBuilder = (context: Context, input: DriveInput) => Context;

/**
 * Default {@link MemberContextBuilder}: pipe the previous member's `output` into
 * the next member as a fresh user turn. {@link ORIGINAL_INPUT} (the unique
 * symbol sentinel) is the only explicit passthrough — the member sees the
 * original context unchanged. Any string input — INCLUDING the empty string
 * from a stage that produced no text — is appended as a user turn. Because the
 * sentinel is a symbol, an empty piped output can never collide with it, so a
 * downstream stage can never silently fall back to the original prompt.
 */
export function appendUserInputContext(context: Context, input: DriveInput): Context {
	if (input === ORIGINAL_INPUT) return context;
	return {
		...context,
		messages: [...context.messages, { role: "user", content: input, timestamp: Date.now() }],
	};
}

/**
 * The model-leaf effect edge: drive a `kind: "model"` member via `streamSimple`.
 * This is the ONLY place in the blend that performs network I/O. It resolves the
 * member's model id against the registry, builds the per-member context via the
 * injected {@link MemberContextBuilder}, runs `streamSimple`, awaits the result,
 * and maps it to a {@link DriveResult}. The combinators above invoke the returned
 * `DriveNode`; they never see `streamSimple` directly.
 *
 * @param streamSimple the `ai` streaming entry point (injected for testability).
 * @param resolveModel maps a member's `model` string to a built `Model`.
 * @param context the base conversation context fed to each member call.
 * @param baseOptions shared stream options (signal merged per-call).
 * @param buildMemberContext context-threading strategy (defaults to
 *   {@link appendUserInputContext}).
 */
export function modelLeafDriveNode(
	streamSimple: (model: Model, context: Context, options?: SimpleStreamOptions) => AssistantMessageEventStream,
	resolveModel: (modelId: string) => Model,
	context: Context,
	baseOptions?: SimpleStreamOptions,
	buildMemberContext: MemberContextBuilder = appendUserInputContext,
): DriveNode {
	return async (member, input, signal) => {
		signal?.throwIfAborted();
		const model = resolveModel(member.model);
		const memberContext = buildMemberContext(context, input);
		const options: SimpleStreamOptions | undefined = signal !== undefined ? { ...baseOptions, signal } : baseOptions;
		const stream = streamSimple(model, memberContext, options);
		const message = await stream.result();
		return { message, usage: message.usage, output: messageText(message), stream };
	};
}

/**
 * Resolve the surfaced member's message from a set of completed results. Surface
 * resolution order (KTD-7): the `swarm.surface` role, else any member flagged
 * `surface: true`, else the strategy's terminal member (the last result).
 *
 * @param spec the blend spec (for `surface` role + member flags).
 * @param ordered the members actually run, paired with their results.
 * @returns the {@link DriveResult} to surface.
 * @throws if `ordered` is empty.
 */
export function pickSurface(
	spec: SwarmSpec,
	ordered: readonly { member: SwarmMember; result: DriveResult }[],
): DriveResult {
	if (ordered.length === 0) throw new Error("pickSurface: no members were run");
	if (spec.surface !== undefined) {
		const byRole = ordered.find(o => o.member.role === spec.surface);
		if (byRole !== undefined) return byRole.result;
	}
	const flagged = ordered.find(o => o.member.surface === true);
	if (flagged !== undefined) return flagged.result;
	return ordered[ordered.length - 1].result;
}

export type { AssistantMessageEvent };
