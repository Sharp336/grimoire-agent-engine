/**
 * The `omp-swarm` blend executor.
 *
 * A synthetic blended model (`api: "omp-swarm"`) is virtual: it carries a
 * {@link SwarmSpec} on `model.swarm` and, at dispatch time, fans out across its
 * members and reduces their streams into ONE coherent
 * {@link AssistantMessageEventStream}. This module is the
 * {@link CustomStreamSimpleFn} the `omp` provider registers — it is the bridge
 * between the catalog spec and the pure blend primitives (U5).
 *
 * Division of labor:
 *   - the PURE combinators in `./primitives` express each strategy over a
 *     {@link DriveNode} without performing I/O;
 *   - this executor wires the single effect edge (`modelLeafDriveNode`), maps the
 *     spec's `strategy` onto the right combinator, surfaces exactly one member's
 *     content, and reports the summed usage across every member run.
 *
 * Streaming contract (KTD-7): the blend emits one outer stream — `start` → the
 * surfaced member's content events → `done` — whose `message.usage` is the sum
 * across all members. Parallel/`moa` blends push an early `start` placeholder so
 * the agent-loop first-event watchdog never misfires on pre-aggregation latency.
 *
 * Cache-prefix stability (KTD-8): every member call is constructed from the
 * SAME base context — the shared system prompt + conversation prefix stays
 * byte-identical and only the variable tail (a prior stage's output / the
 * aggregator prompt) is appended as a fresh user turn. The model-leaf node
 * passes the base context through unchanged, so native prompt caching stays
 * effective. The combinators never rewrite the prefix.
 *
 * Registration: `model-registry.ts` wires this via {@link registerSwarmApi},
 * which installs ONE instance-free global dispatcher under the `"omp-swarm"`
 * custom-API slot. Deps are first-writer-wins: the first registry to register
 * owns the slot until `clearCustomApis()`; later (possibly transient) registries
 * neither rebind it (no hijack of a live blend's resolver/auth) nor break it (no
 * poison-latch). The single global slot can serve one active owner; U9 adds
 * per-`Model` deps binding for robust attribution when several registries are
 * live. The executor never imports the registry; it receives a `resolveModel`
 * closure, keeping it a pure function of its dependencies.
 */

import type {
	AssistantMessage,
	Context,
	Model,
	SimpleStreamOptions,
	SwarmMember,
	SwarmSpec,
	Usage,
} from "@oh-my-pi/pi-ai";
import { getCustomApi, registerCustomApi } from "@oh-my-pi/pi-ai/api-registry";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import {
	capMembers,
	type DriveNode,
	type DriveResult,
	emitSurface,
	modelLeafDriveNode,
	pickSurface,
	runParallelAggregate,
	runRouter,
	runSequence,
	type SubagentLeafDeps,
	subagentLeafDriveNode,
	sumUsage,
} from "./primitives";

/** Resolve a member's `model` id (or `provider/id`) to a built {@link Model}. */
export type SwarmModelResolver = (modelId: string) => Model;

/** The `ai` streaming entry point, injected so the executor stays testable. */
export type StreamSimpleFn = (
	model: Model,
	context: Context,
	options?: SimpleStreamOptions,
) => AssistantMessageEventStream;

/**
 * Everything the subagent-leaf needs EXCEPT the per-call `context` (which the
 * executor injects from each blend invocation). Carried on
 * {@link SwarmExecutorDeps.subagent}; absent when the host registered no subagent
 * runner, in which case a `kind: "subagent"` member fails with a clear error.
 */
export type SwarmSubagentDeps = Omit<SubagentLeafDeps, "context">;

/** Dependencies the blend executor closes over (injected by the registry). */
export interface SwarmExecutorDeps {
	/** Resolve a member model id to a built model (registry-backed in prod). */
	resolveModel: SwarmModelResolver;
	/** The transport edge for `kind: "model"` members. Defaults to ai `streamSimple`. */
	streamSimple: StreamSimpleFn;
	/**
	 * The subagent-leaf edge for `kind: "subagent"` members (KTD-2: direct
	 * `runSubprocess`). Optional — when unset, a subagent member fails fast rather
	 * than silently downgrading to a model call.
	 */
	subagent?: SwarmSubagentDeps;
}

/** The API string the `omp` provider serves. */
export const OMP_SWARM_API = "omp-swarm" as const;

/** Source id used when registering the built-in `omp` provider. */
export const OMP_PROVIDER_SOURCE_ID = "omp-builtin";

/** Provider name for synthetic blended models. */
export const OMP_PROVIDER_NAME = "omp";

/** Base URL for the (network-less) synthetic `omp` provider. */
export const OMP_BASE_URL = "omp://";

/**
 * Extract the user's most recent prompt text from the base context. Used to feed
 * the router selector and the moa aggregator-prompt builder. Returns the empty
 * string when the trailing message is not a textual user turn.
 */
function lastUserPrompt(context: Context): string {
	for (let i = context.messages.length - 1; i >= 0; i--) {
		const message = context.messages[i];
		if (message.role !== "user") continue;
		if (typeof message.content === "string") return message.content;
		let text = "";
		for (const block of message.content) {
			if (block.type === "text") text += block.text;
		}
		return text;
	}
	return "";
}

/**
 * True when a member's run did not terminate successfully. A terminal provider
 * `error` event RESOLVES `result()` with an error message (`stopReason: "error"`,
 * empty content, zero usage) rather than rejecting — see `event-stream.ts`. So a
 * failed member arrives as a fulfilled {@link DriveResult} and must be detected
 * here by its `stopReason`, not by a rejected promise.
 */
function isFailedResult(result: DriveResult): boolean {
	const reason = result.message.stopReason;
	return reason === "error" || reason === "aborted";
}

/**
 * Compose the aggregator's prompt for a `moa` blend from the user's question and
 * the surviving proposals. Failed proposers (terminal `error`/`aborted`, which
 * resolve rather than reject — see {@link isFailedResult}) are DROPPED here so
 * the aggregator never sees an empty `### Proposal` section; their (zero) usage
 * is still summed into the blend total elsewhere. The surviving proposals are
 * appended as the variable tail (a fresh user turn); the stable system/
 * conversation prefix is untouched (KTD-8).
 *
 * When EVERY proposal failed there is nothing to synthesize, so this throws
 * (caught by {@link runBlend} → `outer.fail`) rather than handing the aggregator
 * a content-free prompt — the `runParallelAggregate` "all proposers failed"
 * guard cannot catch this case because terminal error events resolve, leaving
 * the proposals fulfilled-but-empty.
 */
function buildAggregatorInput(userPrompt: string, proposals: DriveResult[]): string {
	const surviving = proposals.filter(proposal => !isFailedResult(proposal));
	if (surviving.length === 0) {
		throw new Error(`all ${proposals.length} proposer(s) failed in moa blend; nothing to synthesize.`);
	}
	const sections = surviving.map((proposal, index) => `### Proposal ${index + 1}\n${proposal.output}`);
	return [
		"You are the aggregator in a mixture-of-agents blend.",
		"Synthesize the single best answer to the user's request from the proposals below.",
		"Do not mention the proposals or the synthesis process in your reply.",
		"",
		`## User request\n${userPrompt}`,
		"",
		`## Proposals\n${sections.join("\n\n")}`,
	].join("\n");
}

/**
 * Build a classifier-only context that asks for a routing verdict — NOT an
 * answer to the user. The base conversation is discarded for the selector call
 * (routing is a meta-decision, not part of the surfaced thread); a single
 * developer instruction enumerates the candidate roles and a user turn carries
 * the request to classify. Kept separate from the member contexts so it never
 * perturbs the cache-stable prefix the members share.
 */
function buildSelectorContext(context: Context, members: readonly SwarmMember[], userPrompt: string): Context {
	const roles = members.map(member => member.role).join(", ");
	return {
		systemPrompt: context.systemPrompt,
		tools: [],
		messages: [
			{
				role: "developer",
				content: [
					"You are a request router. Read the user request below and reply with EXACTLY ONE",
					`of these role names and nothing else: ${roles}.`,
					"Pick the role best suited to handle the request.",
				].join(" "),
				timestamp: Date.now(),
			},
			{ role: "user", content: userPrompt, timestamp: Date.now() },
		],
	};
}

/**
 * The router selector seam. `kind: "rule"` (or no selector) picks the first
 * member deterministically. `kind: "classifier"` drives the classifier model
 * against a routing-only context (see {@link buildSelectorContext}) and matches
 * its text verdict to a member role (falling back to the first member when no
 * role matches). Selection is the ONLY place a classifier call lives; the pure
 * `runRouter` combinator never sees it.
 */
function makeRouterSelect(
	spec: SwarmSpec,
	deps: SwarmExecutorDeps,
	context: Context,
	baseOptions: SimpleStreamOptions | undefined,
	selectorUsages: Usage[],
): (members: readonly SwarmMember[], userPrompt: string, signal?: AbortSignal) => Promise<string | number> {
	return async (members, userPrompt, signal) => {
		const selector = spec.selector;
		if (selector === undefined || selector.kind === "rule" || selector.model === undefined) {
			return 0;
		}
		signal?.throwIfAborted();
		const classifier = deps.resolveModel(selector.model);
		const options: SimpleStreamOptions | undefined = signal !== undefined ? { ...baseOptions, signal } : baseOptions;
		const selectorContext = buildSelectorContext(context, members, userPrompt);
		const stream = deps.streamSimple(classifier, selectorContext, options);
		const message = await stream.result();
		// The classifier ran, so its tokens are part of the blend's cost. Sum its
		// usage into the blend total (KTD-7) — the caller threads `selectorUsages`
		// into `sumUsage` alongside the chosen member's usage.
		selectorUsages.push(message.usage);
		const verdict = messageText(message).trim().toLowerCase();
		return matchVerdictToMember(verdict, members);
	};
}

/**
 * Map a classifier verdict to a member index. Matching is tiered so overlapping
 * role names (e.g. `code` vs `coder`) never mis-route:
 *   1. exact normalized equality (the classifier was told to emit ONE role name);
 *   2. whole-word containment (the role appears as a standalone token in the
 *      verdict — anchored on word boundaries, so `code` does NOT match `coder`);
 *   3. loose substring containment (last resort for chatty verdicts).
 * Falls back to the first member (index 0) when nothing matches. The earlier,
 * stricter tiers win across ALL members before any looser tier is consulted, so
 * an exact/word-boundary match on a later member beats a substring hit on an
 * earlier one.
 */
function matchVerdictToMember(verdict: string, members: readonly SwarmMember[]): number {
	const roles = members.map(member => member.role.toLowerCase());
	const exact = roles.indexOf(verdict);
	if (exact >= 0) return exact;
	const word = roles.findIndex(role => role.length > 0 && wordBoundaryMatch(verdict, role));
	if (word >= 0) return word;
	const loose = roles.findIndex(role => role.length > 0 && verdict.includes(role));
	return loose >= 0 ? loose : 0;
}

/**
 * True when `role` occurs in `verdict` as a whole word (delimited by start/end of
 * string or a non-word character), so a prefix/substring role can't steal a
 * verdict naming a longer role (`code` must not match the verdict `coder`).
 */
function wordBoundaryMatch(verdict: string, role: string): boolean {
	let from = 0;
	for (;;) {
		const at = verdict.indexOf(role, from);
		if (at < 0) return false;
		const before = at === 0 ? "" : verdict[at - 1];
		const after = at + role.length >= verdict.length ? "" : verdict[at + role.length];
		if (!isWordChar(before) && !isWordChar(after)) return true;
		from = at + 1;
	}
}

/** Word character for verdict tokenization: ASCII alphanumerics plus `_`. */
function isWordChar(ch: string): boolean {
	return ch.length > 0 && /[a-z0-9_]/.test(ch);
}

/** Concatenate the text content blocks of an assistant message. */
function messageText(message: AssistantMessage): string {
	let text = "";
	for (const block of message.content) {
		if (block.type === "text") text += block.text;
	}
	return text;
}

/**
 * Forward the surfaced member's content events + `done` onto an outer stream that
 * ALREADY emitted its `start` (the moa early-start path). Mirrors the body of
 * {@link emitSurface} but omits the leading `start`, so the watchdog placeholder
 * isn't duplicated. The surfaced `message.usage` is the summed blend total.
 */
function forwardSurfaceBody(outer: AssistantMessageEventStream, surface: AssistantMessage, totalUsage: Usage): void {
	const message: AssistantMessage = { ...surface, usage: totalUsage };
	const partial = message;
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
	}
	if (message.stopReason === "stop" || message.stopReason === "length" || message.stopReason === "toolUse") {
		outer.push({ type: "done", reason: message.stopReason, message });
		return;
	}
	outer.push({
		type: "error",
		reason: message.stopReason === "aborted" ? "aborted" : "error",
		error: { ...message, errorMessage: message.errorMessage ?? "swarm surface error" },
	});
}

/**
 * A placeholder `start` partial for the moa early-start: an empty assistant
 * message attributed to the synthetic blend. Pushing it immediately resets the
 * agent-loop first-event watchdog before the proposers/aggregator run (KTD-7).
 */
function synthesizingPartial(model: Model): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: sumUsage([]),
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

/**
 * Run a `router` / `sequence` / `draft-refine` blend (single coherent surface,
 * no pre-aggregation latency), surfacing one member and reporting summed usage.
 */
async function runBlendSurfaced(
	outer: AssistantMessageEventStream,
	spec: SwarmSpec,
	members: SwarmMember[],
	drive: DriveNode,
	context: Context,
	deps: SwarmExecutorDeps,
	baseOptions: SimpleStreamOptions | undefined,
	signal: AbortSignal | undefined,
): Promise<void> {
	const ordered: { member: SwarmMember; result: DriveResult }[] = [];
	// A classifier selector runs a model whose tokens must be billed; the select
	// seam pushes its usage here so it joins the summed total (KTD-7).
	const selectorUsages: Usage[] = [];
	if (spec.strategy === "router") {
		const select = makeRouterSelect(spec, deps, context, baseOptions, selectorUsages);
		const { chosen, result } = await runRouter(members, lastUserPrompt(context), select, drive, signal);
		ordered.push({ member: chosen, result });
	} else {
		// "sequence" and "draft-refine" both pipe output → input.
		const results = await runSequence(members, drive, signal);
		for (let i = 0; i < members.length; i++) ordered.push({ member: members[i], result: results[i] });
	}
	const surface = pickSurface(spec, ordered);
	const totalUsage = sumUsage([...selectorUsages, ...ordered.map(o => o.result.usage)]);
	emitSurface(outer, surface.message, totalUsage);
}

/**
 * Run a `moa` blend: emit the early `start` placeholder, fan out the proposers,
 * synthesize with the aggregator, then forward the aggregator's content + `done`
 * with summed usage. The aggregator is the last member; proposers are all the
 * rest. A `surface` role/flag may override which member is surfaced.
 */
async function runBlendMoa(
	outer: AssistantMessageEventStream,
	model: Model,
	spec: SwarmSpec,
	members: SwarmMember[],
	drive: DriveNode,
	context: Context,
	signal: AbortSignal | undefined,
): Promise<void> {
	if (members.length < 2) {
		throw new Error(`moa blend "${model.id}" needs at least one proposer and an aggregator (got ${members.length})`);
	}
	// Early start so the first-event watchdog doesn't misfire while proposers run.
	outer.push({ type: "start", partial: synthesizingPartial(model) });
	const proposers = members.slice(0, -1);
	const aggregator = members[members.length - 1];
	const { proposals, aggregate } = await runParallelAggregate(
		proposers,
		aggregator,
		lastUserPrompt(context),
		buildAggregatorInput,
		drive,
		signal,
	);
	// Each proposal already carries its proposer (rejected proposers are omitted
	// from `proposals`), so no index zip against `proposers` can misattribute a
	// survivor's result to the wrong member.
	const ordered: { member: SwarmMember; result: DriveResult }[] = [
		...proposals,
		{ member: aggregator, result: aggregate },
	];
	const surface = pickSurface(spec, ordered);
	const totalUsage = sumUsage([...proposals.map(p => p.result.usage), aggregate.usage]);
	forwardSurfaceBody(outer, surface.message, totalUsage);
}

/**
 * Build the per-member {@link DriveNode}: `kind: "subagent"` members go to the
 * subagent-leaf (direct `runSubprocess`, KTD-2), everything else to the
 * model-leaf (`streamSimple`). Both leaves close over the SAME base `context`, so
 * every member call shares the byte-identical stable prefix and appends only the
 * variable tail (KTD-8). A subagent member with no configured runner
 * ({@link SwarmExecutorDeps.subagent} unset) fails fast rather than silently
 * routing to the model edge.
 */
function makeDrive(deps: SwarmExecutorDeps, context: Context, options: SimpleStreamOptions | undefined): DriveNode {
	const model = modelLeafDriveNode(deps.streamSimple, deps.resolveModel, context, options);
	const subagentConfig = deps.subagent;
	const subagent: DriveNode | undefined =
		subagentConfig === undefined ? undefined : subagentLeafDriveNode({ ...subagentConfig, context });
	return (member, input, signal) => {
		if (member.kind === "subagent") {
			if (subagent === undefined) {
				return Promise.reject(
					new Error(
						`swarm member "${member.role}" is kind:"subagent" but no subagent runner is configured for this blend.`,
					),
				);
			}
			return subagent(member, input, signal);
		}
		return model(member, input, signal);
	};
}

/**
 * Build the `omp-swarm` {@link CustomStreamSimpleFn} from explicit deps. The
 * returned function reads `model.swarm`, maps the strategy onto the matching
 * pure primitive (driven by {@link modelLeafDriveNode}), and reduces the members
 * into one outer stream. This is the test-facing seam: a test injects mock deps
 * and registers the result directly, exercising the executor without the global
 * registry. An absent `model.swarm` is a programming error; an `options.signal`
 * abort is fatal.
 */
export function createSwarmStreamSimple(
	deps: SwarmExecutorDeps,
): (model: Model, context: Context, options?: SimpleStreamOptions) => AssistantMessageEventStream {
	return (model, context, options) => runBlend(model, context, options, deps);
}

/**
 * Drive one blend to completion against an explicit {@link SwarmExecutorDeps}.
 * Shared by {@link createSwarmStreamSimple} and the stable global dispatcher, so
 * both paths run identical logic. Returns the single outer stream synchronously;
 * the fan-out runs async and settles `result()` via `start`/`done` (or `fail`).
 */
function runBlend(
	model: Model,
	context: Context,
	options: SimpleStreamOptions | undefined,
	deps: SwarmExecutorDeps,
): AssistantMessageEventStream {
	const outer = new AssistantMessageEventStream();
	const spec = model.swarm;
	if (spec === undefined) {
		queueMicrotask(() => outer.fail(new Error(`omp-swarm model "${model.id}" has no swarm spec; cannot blend.`)));
		return outer;
	}
	const signal = options?.signal;
	if (signal?.aborted) {
		queueMicrotask(() => outer.fail(signal.reason ?? new Error("swarm aborted before start")));
		return outer;
	}
	const members = capMembers(spec.members, spec.maxMembers);
	if (members.length === 0) {
		queueMicrotask(() => outer.fail(new Error(`omp-swarm model "${model.id}" has no members.`)));
		return outer;
	}
	const drive = makeDrive(deps, context, options);
	void (async () => {
		try {
			if (spec.strategy === "moa") {
				await runBlendMoa(outer, model, spec, members, drive, context, signal);
			} else {
				await runBlendSurfaced(outer, spec, members, drive, context, deps, options, signal);
			}
		} catch (err) {
			outer.fail(err);
		}
	})();
	return outer;
}

// =============================================================================
// Stable global dispatch (lifecycle-safe registration)
// =============================================================================

/**
 * Deps of the registry that owns the process-global `omp-swarm` slot. The
 * custom-API registry keys on the literal API string (`"omp-swarm"`), so there
 * is exactly ONE slot and the instance-free dispatcher resolves deps from here.
 * First-writer-wins: the first registry to register owns the slot until
 * `clearCustomApis()` empties it; later registrations do NOT rebind (see
 * {@link registerSwarmApi}). This deliberately rejects two worse designs — a
 * poison-latch that permanently broke dispatch once any transient second
 * `ModelRegistry` (sdk.ts, task/executor.ts, the CLIs) was built, and
 * last-writer-wins, which would let a transient newer registry silently resolve
 * an already-live blend's members and auth (a hijack). Single-active-owner fits
 * the normal one-registry process; U9 adds per-`Model` deps binding for robust
 * attribution when several registries are live at once.
 */
let activeSwarmDeps: SwarmExecutorDeps | undefined;

/**
 * The stable global `omp-swarm` dispatcher. Registered ONCE (see
 * {@link registerSwarmApi}); it never closes over a registry instance, resolving
 * deps from {@link activeSwarmDeps} at dispatch time.
 */
function dispatchSwarm(model: Model, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream {
	if (activeSwarmDeps === undefined) {
		const outer = new AssistantMessageEventStream();
		queueMicrotask(() => outer.fail(new Error(`omp-swarm model "${model.id}" has no registered blend deps.`)));
		return outer;
	}
	return runBlend(model, context, options, activeSwarmDeps);
}

/**
 * Register the stable `omp-swarm` dispatcher with the custom-API registry. The
 * registered function is instance-free. First-writer-wins: deps are bound only on
 * the install-from-empty path, so the owning registry keeps the slot and a later
 * (possibly transient) registry cannot rebind it — no hijack of an already-live
 * blend's resolver/auth, and no poison-latch. The once-guard keys on live
 * registry state ({@link getCustomApi}) so it self-heals after `clearCustomApis()`.
 * Returns whether this call performed the install — `false` means an owner already
 * holds the slot and deps were left untouched.
 */
export function registerSwarmApi(deps: SwarmExecutorDeps, sourceId: string = OMP_PROVIDER_SOURCE_ID): boolean {
	if (getCustomApi(OMP_SWARM_API) === undefined) {
		activeSwarmDeps = deps;
		registerCustomApi(OMP_SWARM_API, dispatchSwarm, sourceId, (model, context, options) =>
			dispatchSwarm(model, context, options as SimpleStreamOptions),
		);
		return true;
	}
	return false;
}
