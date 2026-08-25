/**
 * Provider capability resolution and policy surface for the prompt-cache keepalive.
 *
 * A keepalive touch is a real billed request whose only purpose is to prove the
 * cached prefix is still live and to restart the provider's retention clock. The
 * keepalive therefore attempts EVERY provider whose request it can bound, rather
 * than only the ones whose cache telemetry is known in advance. Four independent
 * brakes make that attempt cheap:
 *
 * 1. **Observed cache activity is the arming precondition.** A chain is only armed
 *    after the turn's own response reported `cacheRead + cacheWrite > 0`
 *    (`streamSimpleWithCacheKeepalive`). Most providers cache implicitly and expose
 *    no wire marker to inspect, so this is the evidence that an entry exists — and it
 *    is strictly better than any request-side heuristic, because it is the provider
 *    saying so.
 * 2. **Verified-touch rule.** A touch re-anchors the chain only on
 *    `cacheRead > 0 && cacheWrite === 0`. A provider that answers a touch without
 *    usable cache counters can never produce that, so `CacheKeepaliveState` ends the
 *    chain immediately: an unverifiable provider costs exactly ONE bounded request,
 *    not a loop.
 * 3. **Economic gate.** {@link CacheKeepalivePolicy}-driven `evaluateWarm` refuses a
 *    model with no rate card (`skip-unknown-pricing`), so a provider that cannot be
 *    priced never issues a touch at all.
 * 4. **Fail-closed bounding.** `prepareCacheKeepaliveTouch` returns `undefined`
 *    whenever it cannot bound the captured body to a near-zero output budget *without
 *    otherwise changing it*, and `undefined` arms nothing.
 *
 * Coverage is therefore decided by one question: does this api put a replayable JSON
 * body on the wire with an output-limit field already in it? {@link API_KEEPALIVE}
 * answers it per api and states the reason at every exclusion.
 *
 * Everything except the Anthropic first-party `zero-output` replay is gated on
 * {@link CacheKeepaliveShapeInputs.economicPolicySupplied}: a caller with no policy is
 * asking for the behavior that shipped before the policy existed, and that behavior
 * was Anthropic-official only.
 */

import { resolveTokenCost } from "@oh-my-pi/pi-catalog/models";
import type { Api, KnownApi, Model, ModelCost } from "@oh-my-pi/pi-catalog/types";
import { isRecord, logger } from "@oh-my-pi/pi-utils";
import type { WarmDecision, WarmRates } from "./economics";
import type { CacheOutcome } from "./types";

/**
 * `providerSessionState` key under which the keepalive keeps its per-session chain.
 *
 * The literal stays the historical `"anthropic-cache-refresh"` even though the
 * mechanism is now provider-agnostic: sessions already hold state under this key,
 * and renaming it would orphan their armed timers instead of cancelling them.
 */
export const CACHE_KEEPALIVE_STATE_KEY = "anthropic-cache-refresh";

/**
 * Touch budget when no {@link CacheKeepalivePolicy} is supplied.
 *
 * This is the pre-policy behavior verbatim — 3 touches at ~285s each, i.e. a hard
 * 19-minute ceiling — kept so callers that only set `anthropicCacheRefresh` see no
 * change at all.
 */
export const LEGACY_CACHE_KEEPALIVE_MAX_TOUCHES = 3;

/**
 * Safety cap on touches per armed chain once a policy is supplied.
 *
 * With a policy the *economic* gate is what ends a chain; this only bounds the
 * pathological case where a provider keeps reporting cheap verified hits forever.
 */
export const DEFAULT_CACHE_KEEPALIVE_MAX_TOUCHES = 24;

/** One keepalive decision — fired or skipped — as handed to telemetry. */
export interface CacheKeepaliveRecord {
	/**
	 * Identity of the lease being kept warm: the physical cache fingerprint when the
	 * policy supplies one via {@link CacheKeepalivePolicy.fingerprint}, otherwise the
	 * routing key (prompt-cache key or session id).
	 */
	fingerprint: string;
	/** Why the touch was or was not issued, with every number that produced it. */
	decision: WarmDecision;
	/** Classification of the touch that was issued; absent when it was skipped. */
	outcome?: CacheOutcome;
	/** Seconds since the previous verified touch (or since the turn that armed the chain). */
	idleSeconds: number;
	/** Tokens the touch read from cache; 0 for a skip. */
	cacheRead: number;
	/** Tokens the touch wrote to cache; 0 for a skip. */
	cacheWrite: number;
	/** USD the touch cost; 0 for a skip. */
	costUsd: number;
	/** 1-based position of this decision in the armed chain. */
	touchIndex: number;
	at: number;
}

/**
 * Cost-aware policy layered on top of the `anthropicCacheRefresh` switch.
 *
 * Without a policy the keepalive is a blind watchdog: it fires
 * {@link LEGACY_CACHE_KEEPALIVE_MAX_TOUCHES} touches after every assistant message,
 * including the final one of a turn nobody will resume. With one, each touch must
 * clear an economic gate first, so the chain lives exactly as long as it is worth
 * more than it costs.
 */
export interface CacheKeepalivePolicy {
	/**
	 * P(this session resumes and would have read the cache).
	 *
	 * Consulted immediately before every scheduled touch and never cached:
	 * background work finishing is exactly the event that should end the chain.
	 * `0` stops it; ~0.95 means pending async work will re-wake the loop.
	 */
	resumeProbability(): number;
	/** Size of the cached prefix, used to price the decision. */
	prefixTokens(): number;
	/** Called for every touch and every skip. Must never throw; a throw is swallowed. */
	onDecision?(record: CacheKeepaliveRecord): void;
	/** Safety cap on touches per armed chain. Defaults to {@link DEFAULT_CACHE_KEEPALIVE_MAX_TOUCHES}. */
	maxTouches?: number;
	/**
	 * Retention the provider is believed to honor, in seconds. Omitted uses the
	 * nominal short-cache lifetime; a caller with a learned per-route TTL profile
	 * (`resolveTtl`) supplies its estimate here.
	 */
	ttlSeconds?: number;
	/**
	 * The physical cache entry the armed chain protects, so touches and ordinary
	 * requests file evidence under the same clock. Falls back to the routing key when
	 * the session cannot supply one.
	 */
	fingerprint?(): string | undefined;
}

/**
 * How a keepalive touch must be issued for a given provider.
 *
 * - `zero-output`: a non-streaming request with a zero output budget. Anthropic's
 *   first-party Messages API accepts `max_tokens: 0` and answers with usage only; no
 *   other endpoint in {@link API_KEEPALIVE} is known to.
 * - `bounded-stream`: a streamed request whose *existing* output-limit field is
 *   overwritten with {@link CacheKeepaliveShape.maxTokens} and which is replayed
 *   verbatim otherwise, then drained to completion.
 */
export type CacheKeepaliveShape =
	| { kind: "zero-output" }
	| { kind: "bounded-stream"; maxTokens: number; bound: CacheKeepaliveBound };

/**
 * Where a bounded touch writes its output limit.
 *
 * Carried on the shape so `stream.ts` never re-derives a wire format from the api:
 * exactly one table owns the api → field mapping.
 */
export type CacheKeepaliveBound =
	| {
			kind: "candidates";
			/**
			 * Ordered property paths into the captured body. The first path ALREADY PRESENT
			 * is overwritten; a body carrying none of them arms nothing, because introducing
			 * a limit the original request never sent makes the replay a different request
			 * rather than a bounded one.
			 *
			 * More than one entry means the provider picks between spellings per model:
			 * `openai-completions` sends `max_tokens` or `max_completion_tokens`
			 * (`providers/openai-completions.ts:1734-1740`), and `openrouter` routes to either
			 * the Responses or the Completions wire format depending on
			 * `PI_OPENROUTER_RESPONSES` (`stream.ts:990-991`).
			 */
			paths: readonly (readonly string[])[];
	  }
	| {
			/**
			 * Wire format unknown — a custom api registered through `registerCustomApi`.
			 * Nothing here may guess a path for a format it has never seen, so the field is
			 * discovered from the payload against `stream.ts`'s documented priority list.
			 */
			kind: "discover";
	  };

/**
 * Output budget every bounded touch asks for.
 *
 * 1 rather than 0 because AWS documents `InferenceConfiguration.maxTokens` with a
 * "Minimum value of 1" and Bedrock Converse has no non-streaming route to ask on. The
 * same value is the smallest positive integer every other field in
 * {@link API_KEEPALIVE} accepts: `max_tokens`, `max_completion_tokens`,
 * `max_output_tokens`, `maxOutputTokens` and `num_predict` are all generated-token
 * counts, and each provider's own docs describe them as an upper bound covering
 * everything the model emits.
 *
 * A provider that rejects 1 anyway costs exactly one failed request: the touch
 * resolves unverified and the chain ends. That is the same self-limiting bound the
 * widened coverage rests on, so a wrong guess here degrades to "no keepalive" instead
 * of to repeated spend.
 */
const BOUNDED_TOUCH_MAX_TOKENS = 1;

/** What the caller must tell {@link resolveCacheKeepaliveShape} about its own request. */
export interface CacheKeepaliveShapeInputs {
	/**
	 * Whether the model resolves to Anthropic's first-party endpoint.
	 *
	 * Supplied by the caller rather than recomputed here: deciding that means mirroring
	 * Foundry redirection and the `ANTHROPIC_BASE_URL` gateway fallback, which `stream.ts`
	 * already owns for the leaked-thinking heal. Passing the answer in keeps exactly one
	 * such URL predicate in the codebase. Ignored for every non-Anthropic api.
	 */
	officialAnthropicEndpoint: boolean;
	/**
	 * Whether the caller supplied a {@link CacheKeepalivePolicy}.
	 *
	 * Gates every provider the keepalive learned to cover *after* Anthropic's first-party
	 * endpoint. That zero-output replay predates the policy and stays unconditional, but a
	 * caller with no policy is asking for the behavior that shipped before it — and before
	 * it, every other provider had no keepalive whatsoever. Answering with a shape anyway
	 * would fall back to {@link LEGACY_CACHE_KEEPALIVE_MAX_TOUCHES} and newly bill three
	 * touches per turn on the very configuration that opted out.
	 */
	economicPolicySupplied: boolean;
}

const candidates = (...paths: readonly string[][]): CacheKeepaliveBound => ({ kind: "candidates", paths });

/** One row of {@link API_KEEPALIVE}. */
interface ApiKeepaliveEntry {
	/** Where a bounded touch for this api writes its output limit. */
	readonly bound: CacheKeepaliveBound;
	/**
	 * Extra per-model precondition; absent means the api alone decides. Used where a
	 * model's compat flags determine whether the request creates an entry at all.
	 */
	readonly requires?: (model: Model<Api>) => boolean;
	/**
	 * Anthropic's first-party endpoint gets the `zero-output` replay that predates the
	 * economic policy, unconditionally. Resellers and gateways speaking the same wire
	 * format fall through to the bounded replay: only the first-party endpoint is known
	 * to accept `max_tokens: 0`.
	 */
	readonly anthropicZeroOutput?: true;
}

/**
 * `bedrock-converse-stream` only writes an entry when the catalog asks for explicit
 * `cachePoint` markers. `"automatic"` prefix caching is not something a client can
 * prolong, and `"none"` never creates an entry, so a touch would be pure spend.
 */
function bedrockWritesCachePoints(model: Model<Api>): boolean {
	const compat = model.compat as Model<"bedrock-converse-stream">["compat"];
	return compat.promptCacheMode === "explicit";
}

/**
 * Per-api touch recipe. `null` is a deliberate exclusion, with its reason stated at
 * the entry — the table is the single place a reader can see the whole surface.
 */
const API_KEEPALIVE: Readonly<Record<KnownApi, ApiKeepaliveEntry | null>> = {
	// `max_tokens` is required on every Messages request, so the field is always there
	// to overwrite (`providers/anthropic.ts:2007` hands the hook the final body).
	"anthropic-messages": { bound: candidates(["max_tokens"]), anthropicZeroOutput: true },
	"bedrock-converse-stream": {
		bound: candidates(["inferenceConfig", "maxTokens"]),
		requires: bedrockWritesCachePoints,
	},
	"openai-completions": { bound: candidates(["max_tokens"], ["max_completion_tokens"]) },
	"openai-responses": { bound: candidates(["max_output_tokens"]) },
	"azure-openai-responses": { bound: candidates(["max_output_tokens"]) },
	// Either wire format, decided per process by `PI_OPENROUTER_RESPONSES`; the
	// first-present rule picks whichever one the captured body actually used.
	openrouter: { bound: candidates(["max_output_tokens"], ["max_tokens"], ["max_completion_tokens"]) },
	// EXCLUDED: the Codex backend refuses caller-supplied output caps, and the request
	// transformer deletes both `max_output_tokens` and `max_completion_tokens` before the
	// body is sent (`providers/openai-codex/request-transformer.ts:513-514`,
	// `providers/openai-codex-responses.ts:1554-1556`). There is no field to bound, and an
	// unbounded replay is a whole completion.
	"openai-codex-responses": null,
	// The hook is handed `GenerateContentParameters`, whose `config.maxOutputTokens` is
	// lifted onto the wire body's `generationConfig` by `paramsToWireBody`
	// (`providers/google-shared.ts:1121-1123`).
	"google-generative-ai": { bound: candidates(["config", "maxOutputTokens"]) },
	"google-vertex": { bound: candidates(["config", "maxOutputTokens"]) },
	// Cloud Code Assist nests the whole GenerateContent request one level down
	// (`providers/google-gemini-cli.ts:421-438`).
	"google-gemini-cli": { bound: candidates(["request", "generationConfig", "maxOutputTokens"]) },
	// EXCLUDED: the arming gate in `stream.ts` requires the response to report cache
	// activity (`usage.cacheRead + usage.cacheWrite > 0`), and this provider never reports
	// any — it hardcodes both counters to zero and its `done` path only ever assigns
	// `usage.input` from `prompt_eval_count` (`providers/ollama.ts:390-391,728`). A row
	// here would be a bounded body that nothing can ever arm.
	//
	// Not worth adding the counter to reach it, either: Ollama's prompt cache is KV state
	// inside a local process, so `cost` is zero and the economic gate would price the
	// avoided rebuild at zero and refuse every touch. Reviving this needs a provider that
	// reports cache tokens AND a cost model where keeping them warm is worth something.
	"ollama-chat": null,
	// EXCLUDED: the hook receives a protobuf `StreamUnifiedChatRequest` message
	// (`providers/cursor.ts:5356`), not the wire bytes, and that message carries no
	// output-limit field at all — so a touch could not be bounded.
	"cursor-agent": null,
	// EXCLUDED: the wire body is built by a delegated Anthropic/OpenAI stream chosen per
	// request from GitLab's server-side model mapping (`providers/gitlab-duo.ts:274-320`),
	// so the api does not determine the format and a replay can be routed to a different
	// upstream than the one that cached it.
	"gitlab-duo-agent": null,
	// EXCLUDED: `providers/devin.ts` never invokes the `onPayload` hook, so no body is
	// ever captured and there is nothing to replay.
	"devin-agent": null,
};

/**
 * Fallback row for an api registered through `registerCustomApi`: bound generically,
 * discovering the field from the payload instead of assuming one.
 */
const CUSTOM_API_KEEPALIVE: ApiKeepaliveEntry = { bound: { kind: "discover" } };

/** Resolve how — or whether — {@link model} can be kept warm. */
export function resolveCacheKeepaliveShape(
	model: Model<Api>,
	inputs: CacheKeepaliveShapeInputs,
): CacheKeepaliveShape | undefined {
	// EXCLUDED, for every api: `transport: "pi-native"` is a model-level override that
	// routes through another OMP harness's auth-gateway. The usage it reports describes an
	// entry in *that* process, so a touch issued from here re-anchors nothing this session
	// can observe — and `pi-native-client.ts:44-45` drops the payload hook, so no body is
	// captured either.
	if (model.transport === "pi-native") return undefined;
	// `Object.hasOwn` rather than a bare index: a custom api id must never collide with an
	// inherited `Object.prototype` key.
	const entry = Object.hasOwn(API_KEEPALIVE, model.api) ? API_KEEPALIVE[model.api as KnownApi] : CUSTOM_API_KEEPALIVE;
	if (entry === null) return undefined;
	if (entry.anthropicZeroOutput && model.provider === "anthropic" && inputs.officialAnthropicEndpoint) {
		return { kind: "zero-output" };
	}
	// Everything the keepalive learned after the Anthropic-official replay is opt-in.
	if (!inputs.economicPolicySupplied) return undefined;
	if (entry.requires && !entry.requires(model)) return undefined;
	return { kind: "bounded-stream", maxTokens: BOUNDED_TOUCH_MAX_TOKENS, bound: entry.bound };
}

/**
 * Output-limit fields scanned for `bound.kind === "discover"`, in priority order.
 *
 * Only reached for an api registered through `registerCustomApi`, whose wire format
 * nothing in this repo has seen. Every entry is a field this repo builds for some known
 * api, plus the raw Gemini REST spelling (`generationConfig.maxOutputTokens`) that a
 * custom api speaking Google's HTTP format sends directly rather than through
 * `paramsToWireBody`. The first path actually present in the body is the one bounded; a
 * body carrying none of them arms nothing.
 */
const DISCOVERABLE_OUTPUT_LIMIT_PATHS: readonly (readonly string[])[] = [
	["max_tokens"],
	["max_completion_tokens"],
	["max_output_tokens"],
	["inferenceConfig", "maxTokens"],
	["config", "maxOutputTokens"],
	["generationConfig", "maxOutputTokens"],
	["request", "generationConfig", "maxOutputTokens"],
	// Ollama's spelling. `ollama-chat` itself is excluded above for reporting no cache
	// counters, but a custom api speaking its wire format is a different server that may
	// report them, and it still has to clear the same arming gate to be touched.
	["options", "num_predict"],
];

/** Where the Google wire formats this repo builds nest `thinkingConfig`. */
const GOOGLE_THINKING_CONFIG_PATHS: readonly (readonly string[])[] = [
	["config", "thinkingConfig"],
	["generationConfig", "thinkingConfig"],
	["request", "generationConfig", "thinkingConfig"],
];

function readAtPath(payload: Record<string, unknown>, path: readonly string[]): unknown {
	let cursor: unknown = payload;
	for (const key of path) {
		if (!isRecord(cursor)) return undefined;
		cursor = cursor[key];
	}
	return cursor;
}

/**
 * Shallow-clone `payload` along `path` with a numeric leaf that ALREADY EXISTS
 * overwritten by `value`; `undefined` when the path is absent or its leaf is not a
 * number.
 *
 * Absent is refused rather than created: a replay that adds an output limit the original
 * request never sent is a *different* request, not a bounded one — the provider would be
 * answering a question it was never asked, and whatever it cached was cached for the body
 * without the field. `null` — the wire spelling of "no cap" on the Responses family
 * (`providers/openai-responses-wire.ts:722`) — is refused for the same reason.
 *
 * Only the objects along `path` are cloned; every sibling value is shared with the
 * captured body, so the replay differs from it by exactly one number.
 */
function replaceExistingNumericLeaf(
	payload: Record<string, unknown>,
	path: readonly string[],
	value: number,
): Record<string, unknown> | undefined {
	const parents: Record<string, unknown>[] = [payload];
	for (let depth = 0; depth < path.length - 1; depth++) {
		const next = parents[depth]![path[depth]!];
		if (!isRecord(next)) return undefined;
		parents.push(next);
	}
	const leafKey = path[path.length - 1]!;
	let replacement = parents[parents.length - 1]!;
	if (typeof replacement[leafKey] !== "number") return undefined;
	replacement = { ...replacement, [leafKey]: value };
	for (let depth = parents.length - 2; depth >= 0; depth--) {
		replacement = { ...parents[depth]!, [path[depth]!]: replacement };
	}
	return replacement;
}

/**
 * Why a bounded touch must NOT be issued for this body, or `undefined` when it is safe.
 *
 * Overwriting an output limit is only a *bounding* change when the provider treats that
 * limit as covering everything it generates. Where the body separately declares a
 * reasoning budget the limit must exceed, the bounded replay is either rejected outright
 * or promoted into a full reasoning response — and stripping the declaration would make
 * the replay differ from the cached request by more than its output limit, which is
 * exactly what a keepalive must never do. Declining is the honest outcome: the entry
 * simply expires.
 *
 * Gated on the api rather than sniffed from the body, because the hazard shapes are not
 * structurally distinguishable: an Anthropic `thinking: { type: "enabled" }` and a Z.AI
 * `thinking: { type: "enabled" }` are the same JSON with different meanings. A `discover`
 * bound means the api is custom, so every hazard recognized here applies to it.
 */
function reasonToDeclineBoundedTouch(
	api: Api,
	bound: CacheKeepaliveBound,
	payload: Record<string, unknown>,
): string | undefined {
	const unknownFormat = bound.kind === "discover";

	// Bedrock budget mode puts `thinking.budget_tokens` in `additionalModelRequestFields`
	// (`providers/amazon-bedrock.ts:1116-1121`), and Anthropic requires
	// `max_tokens > budget_tokens`, so a 1-token cap is rejected outright. Adaptive mode
	// carries no explicit budget (`providers/amazon-bedrock.ts:1092-1099`), so honoring it
	// means draining a whole thinking response — and unlike Anthropic native, Bedrock
	// cannot be cut short early because its cache counters only arrive in the trailing
	// `metadata` event.
	if (unknownFormat || api === "bedrock-converse-stream") {
		const thinking = readAtPath(payload, ["additionalModelRequestFields", "thinking"]);
		if (isRecord(thinking) && thinking.type !== "disabled") {
			return `bedrock thinking is active (type: ${String(thinking.type)})`;
		}
	}

	// Anthropic Messages on a reseller or gateway endpoint; the first-party ones take the
	// `zero-output` path and never reach here. `ensureMaxTokensForThinking`
	// (`providers/anthropic.ts:3154-3176`) raises `max_tokens` to
	// `budget_tokens + OUTPUT_FALLBACK_BUFFER` and throws when it cannot, which is this
	// repo's own statement that Anthropic rejects a cap at or below the budget. Adaptive
	// thinking declares no budget at all, so its floor is unknown; both decline.
	if (unknownFormat || api === "anthropic-messages") {
		const thinking = payload.thinking;
		if (isRecord(thinking) && thinking.type !== "disabled") {
			return `anthropic thinking is active (type: ${String(thinking.type)})`;
		}
	}

	// Google: `stream.ts`'s own budget arithmetic keeps `maxOutputTokens` above
	// `thinkingBudget` by `MIN_OUTPUT_TOKENS` and disables thinking when it cannot (the
	// `google-gemini-cli` case in `mapOptionsForApi`), so a 1-token cap underneath a
	// declared budget is not a request this codebase considers valid. A `thinkingLevel`
	// (Gemini 3+) or a dynamic budget (`-1`) declares no number at all, and nothing in this
	// repo establishes what Google does with a 1-token cap underneath one — the same posture
	// as Bedrock adaptive, and the reason this declines rather than guesses. Only an
	// explicit `thinkingBudget: 0`, the suppression shape `resolveGoogleThinkingOff` emits,
	// is known to leave no budget for the cap to fall under.
	if (unknownFormat || api === "google-generative-ai" || api === "google-vertex" || api === "google-gemini-cli") {
		for (const path of GOOGLE_THINKING_CONFIG_PATHS) {
			const thinkingConfig = readAtPath(payload, path);
			if (thinkingConfig === undefined) continue;
			if (!isRecord(thinkingConfig)) return `unrecognized ${path.join(".")}`;
			if (thinkingConfig.thinkingBudget !== 0) {
				return `google thinking budget is not explicitly zero at ${path.join(".")}`;
			}
		}
	}

	// OpenAI-family bodies.
	//
	// NOT declined: `reasoning: { effort | summary | enabled }`. Those are qualitative, with
	// no number for the cap to fall under, and this repo's own wire type documents
	// `max_output_tokens` as "An upper bound for the number of tokens that can be generated
	// for a response, including visible output tokens and reasoning tokens"
	// (`providers/openai-responses-wire.ts:719-722`) — the cap subsumes reasoning, so
	// bounding it cannot force a fuller reasoning pass than the cap allows. Chat-Completions
	// `thinking: { type }` toggles (Z.AI/GLM, `providers/openai-shared.ts:1001`) are likewise
	// a switch, not a budget.
	//
	// Declined: an explicit numeric budget. OpenRouter's unified reasoning surface accepts
	// `reasoning.max_tokens`, and a gateway forwarding an Anthropic thinking block through
	// `extraBody` carries `thinking.budget_tokens`. In both cases the routed upstream is
	// what enforces `cap > budget`, and which upstream that is cannot be known here.
	if (
		unknownFormat ||
		api === "openai-completions" ||
		api === "openai-responses" ||
		api === "azure-openai-responses" ||
		api === "openrouter"
	) {
		const reasoning = payload.reasoning;
		if (isRecord(reasoning) && typeof reasoning.max_tokens === "number") {
			return "a numeric reasoning.max_tokens budget is declared";
		}
		const thinking = payload.thinking;
		if (isRecord(thinking) && typeof thinking.budget_tokens === "number") {
			return "a numeric thinking.budget_tokens budget is declared";
		}
	}

	// `ollama-chat` needs no check: `options.num_predict` is the runner's decode-token limit
	// (`providers/ollama.ts:332-334`) and the chat body carries no separate reasoning budget
	// — `think` is a switch. Thinking tokens are generated tokens, so they fall under the
	// same cap and there is nothing for the cap to be below.
	return undefined;
}

/**
 * Bound `payload`'s existing output limit to `shape.maxTokens`, or `undefined` when this
 * body must not be replayed at all.
 *
 * `undefined` is the fail-closed path, returned for three reasons: the body declares a
 * reasoning budget the bound cannot clear ({@link reasonToDeclineBoundedTouch}); it
 * carries no output-limit field to overwrite, since inventing one would make the replay a
 * different request; or it declares MORE THAN ONE of them.
 *
 * That last case is why this counts every candidate instead of overwriting the first one
 * it finds. The aliases are not mutually exclusive on the wire: a user-configured
 * `extraBody` is merged with `Object.assign` (`providers/openai-shared.ts:731`), so
 * `max_tokens` can land beside the `max_completion_tokens` the provider built, and
 * OpenRouter has three spellings in play. Bounding one while another survives leaves the
 * provider free to honor the untouched cap, so a *verified* hit could replay a whole
 * completion while the economic gate priced it at one token — the exact unfalsifiable
 * spend this design exists to prevent. Which alias wins is the provider's business, not
 * something to guess at, so ambiguity declines and the entry simply expires.
 *
 * "Declared" means a leaf that is not `undefined`, so an explicit `null` — the Responses
 * family's spelling of "no cap" — counts as a declaration and conflicts, rather than
 * being silently overwritten or ignored.
 */
export function boundCacheKeepalivePayload(
	api: Api,
	shape: Extract<CacheKeepaliveShape, { kind: "bounded-stream" }>,
	payload: Record<string, unknown>,
): Record<string, unknown> | undefined {
	const declined = reasonToDeclineBoundedTouch(api, shape.bound, payload);
	if (declined) {
		logger.debug("prompt-cache keepalive declined a bounded touch", { api, reason: declined });
		return undefined;
	}
	const paths = shape.bound.kind === "candidates" ? shape.bound.paths : DISCOVERABLE_OUTPUT_LIMIT_PATHS;
	const declared = paths.filter(path => readAtPath(payload, path) !== undefined);
	if (declared.length !== 1) {
		if (declared.length > 1) {
			logger.debug("prompt-cache keepalive declined a bounded touch", {
				api,
				reason: "more than one output limit declared",
				fields: declared.map(path => path.join(".")),
			});
		}
		return undefined;
	}
	// Still numeric-checked: the single declaration may be `null` or a non-number.
	return replaceExistingNumericLeaf(payload, declared[0]!, shape.maxTokens);
}

/**
 * Rate card for pricing a keepalive decision against a prefix of `promptTokens`.
 *
 * The context-length tier is resolved from the prefix size instead of reading
 * `cost.input` raw: on a long-context model the tier that will bill the resume is
 * the one the prefix reaches, and pricing a 400k-token prefix at the short-context
 * rate understates both the loss avoided and the touch itself.
 */
export function warmRatesForPrefix(cost: ModelCost, promptTokens: number): WarmRates {
	const rates = resolveTokenCost(cost, promptTokens);
	return { input: rates.input, cacheRead: rates.cacheRead, cacheWrite: rates.cacheWrite, output: rates.output };
}
