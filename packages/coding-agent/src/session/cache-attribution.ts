import { stringifyJson } from "@oh-my-pi/pi-utils";

/**
 * Prompt-cache attribution instrumentation.
 *
 * A provider prompt-cache prefix breaks when the message array sent on the wire
 * stops being a byte-stable extension of the previous request. Several distinct
 * mutators can cause that (compaction, secret obfuscation, image stripping,
 * steering wrapping, thinking demotion, retry-recovery history edits, tool
 * signature changes). Until now a break was *detected* (`detectCacheInvalidation`)
 * but never *attributed*: nothing recorded which mutator fired on the turn that
 * lost the prefix.
 *
 * This module is instrumentation only. It records short stable tags at each
 * mutator and offers the cumulative hit-ratio formula shared with the status
 * line, so an invalidation can be attributed to its cause. It changes no
 * mutator behavior and no detection threshold.
 */

/**
 * One literal tag per message-array mutator that can break a prompt-cache
 * prefix, so log output stays greppable. The set is closed: a new cause gets a
 * new member here, never a free-form string at a callsite.
 */
export type CacheMutationTag =
	| "compaction"
	| "obfuscate"
	| "image-strip"
	| "steering-wrap"
	| "thinking-demote"
	| "thinking-level"
	| "retry-recovery"
	| "rewind"
	| "tool-signature"
	| "context-hook"
	| "snapcompact"
	| "shake";

/** The fingerprint state of a mutator on the current provider request. */
type WireMutationState = { state: "absent" } | { state: "present"; digest: bigint };

const ABSENT_WIRE_MUTATION: WireMutationState = { state: "absent" };

/**
 * Extract only wire bytes that form a provider prompt-cache prefix. This is
 * intentionally a projection, not a recursive JSON walk: request contents can
 * hold arbitrary user data and must never participate in this fingerprint.
 *
 * Google and Vertex invoke `onPayload` before their SDK config is flattened to
 * the REST body, while Gemini CLI sends its Cloud Code Assist body with a nested
 * `request`. All other built-in provider payloads put these fields at the top
 * level (apart from system/developer entries in `messages`).
 */
export function projectSystemAndToolsWireBytes(payload: unknown): string {
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) return "";
	const record = payload as Record<string, unknown>;
	const projection: Record<string, unknown> = {};
	projectWireFields(projection, record);

	const config = record.config;
	if (isRecord(config)) {
		const projectedConfig: Record<string, unknown> = {};
		projectWireFields(projectedConfig, config);
		if (Object.keys(projectedConfig).length > 0) projection.config = projectedConfig;
	}

	const request = record.request;
	if (isRecord(request)) {
		const projectedRequest: Record<string, unknown> = {};
		projectWireFields(projectedRequest, request);
		if (Object.keys(projectedRequest).length > 0) projection.request = projectedRequest;
	}

	if (Array.isArray(record.messages)) {
		const systemMessages = record.messages.filter(
			(message): message is Record<string, unknown> =>
				isRecord(message) && (message.role === "system" || message.role === "developer"),
		);
		if (systemMessages.length > 0) projection.messages = systemMessages;
	}
	return JSON.stringify(projection);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function projectWireFields(target: Record<string, unknown>, source: Record<string, unknown>): void {
	for (const key of [
		"system",
		"instructions",
		"systemInstruction",
		"customSystemPrompt",
		"tools",
		"functions",
		"tool_choice",
		"toolChoice",
		"toolConfig",
	]) {
		if (key in source) target[key] = source[key];
	}
}

/**
 * Project only the request-control fields that select a thinking/reasoning
 * configuration, since a mid-session effort change on the same model and
 * session rewrites the explicit prompt-cache prefix without altering system or
 * tool bytes. Like {@link projectSystemAndToolsWireBytes} this is a projection,
 * not a recursive walk: request contents are never fingerprinted.
 *
 * Covers the controls each built-in provider emits at the top level: Anthropic
 * `thinking` / `output_config.effort`, Bedrock `additionalModelRequestFields`,
 * and OpenAI-style `reasoning_effort` / `reasoning`.
 */
export function projectThinkingControlsWireBytes(payload: unknown): string {
	if (!isRecord(payload)) return "";
	const projection: Record<string, unknown> = {};
	for (const key of ["thinking", "output_config", "additionalModelRequestFields", "reasoning_effort", "reasoning"]) {
		if (key in payload) projection[key] = payload[key];
	}
	return stringifyJson(projection) ?? "";
}

/**
 * Session-scoped ledger of which message-array mutators fired since the last
 * cache-invalidation report. Producers call {@link CacheMutationLedger.record};
 * the detection point calls {@link CacheMutationLedger.consume} once per turn,
 * so an invalidation is attributed to exactly the mutators active on the turn
 * that lost the prefix and tags never leak across turns.
 *
 * Intentionally minimal: a deduped, insertion-ordered tag set. It carries no
 * message content.
 */
export class CacheMutationLedger {
	#tags = new Set<CacheMutationTag>();
	#order: CacheMutationTag[] = [];
	#thinkingReplayState: WireMutationState = ABSENT_WIRE_MUTATION;
	#steeringWrapState: WireMutationState = ABSENT_WIRE_MUTATION;
	#obfuscationState: WireMutationState = ABSENT_WIRE_MUTATION;
	#imageStripState: WireMutationState = ABSENT_WIRE_MUTATION;
	#providerImageStripState: WireMutationState = ABSENT_WIRE_MUTATION;
	#contextHookState: WireMutationState = ABSENT_WIRE_MUTATION;
	#snapcompactState: WireMutationState = ABSENT_WIRE_MUTATION;
	#nextProviderRequestTags = new Set<CacheMutationTag>();
	#lastEmittedToolSignatureByCacheIdentity = new Map<string, bigint>();
	#lastEmittedThinkingConfigByCacheIdentity = new Map<string, bigint>();

	/** Record that mutator `tag` rewrote the message array for the wire this turn. */
	record(tag: CacheMutationTag): void {
		if (this.#tags.has(tag)) return;
		this.#tags.add(tag);
		this.#order.push(tag);
	}

	/** Tags recorded so far this turn, without clearing. */
	get tags(): readonly CacheMutationTag[] {
		return this.#order;
	}

	#advancePresentMutation(
		tag: CacheMutationTag,
		previous: WireMutationState,
		next: WireMutationState,
	): WireMutationState {
		if (next.state === "absent") {
			if (previous.state === "present") this.record(tag);
			return next;
		}
		if (previous.state === "present" && previous.digest === next.digest) return next;
		this.record(tag);
		return next;
	}

	#recordChangedMessagesAtWire(
		tag: CacheMutationTag,
		previous: WireMutationState,
		before: readonly object[],
		emitted: readonly object[],
	): WireMutationState {
		const changed = emitted.flatMap((message, index) => (message === before[index] ? [] : [[index, message]]));
		const next: WireMutationState =
			changed.length === 0
				? ABSENT_WIRE_MUTATION
				: { state: "present", digest: Bun.hash.wyhash(stringifyJson(changed) ?? "") };
		return this.#advancePresentMutation(tag, previous, next);
	}

	/** Record an obfuscation only when the emitted secret-bearing message subset changes. */
	recordObfuscationAtWire(before: readonly object[], emitted: readonly object[]): void {
		this.#obfuscationState = this.#recordChangedMessagesAtWire("obfuscate", this.#obfuscationState, before, emitted);
	}

	/** Record image stripping only when the emitted placeholder-bearing message subset changes. */
	recordImageStripAtWire(before: readonly object[], emitted: readonly object[]): void {
		this.#imageStripState = this.#recordChangedMessagesAtWire("image-strip", this.#imageStripState, before, emitted);
	}

	/** Record image stripping needed to fit the active provider's image budget. */
	recordProviderImageStripAtWire(before: readonly object[], emitted: readonly object[]): void {
		this.#providerImageStripState = this.#recordChangedMessagesAtWire(
			"image-strip",
			this.#providerImageStripState,
			before,
			emitted,
		);
	}

	/** Record rewrites made by extension context handlers. */
	recordContextHookAtWire(before: readonly object[], emitted: readonly object[]): void {
		this.#contextHookState = this.#recordChangedMessagesAtWire(
			"context-hook",
			this.#contextHookState,
			before,
			emitted,
		);
	}

	/** Record rewrites made by snapcompact after provider conversion. */
	recordSnapcompactAtWire(before: readonly object[], emitted: readonly object[]): void {
		this.#snapcompactState = this.#recordChangedMessagesAtWire(
			"snapcompact",
			this.#snapcompactState,
			before,
			emitted,
		);
	}

	/** Queue a mutation that must be attributed to the next real provider request, not an in-flight one. */
	queueForNextProviderRequest(tag: CacheMutationTag): void {
		this.#nextProviderRequestTags.add(tag);
	}

	/**
	 * Compare system/tool bytes at the main provider boundary. The baseline is
	 * partitioned by the actual provider and its prompt-cache/session identity,
	 * rather than by calls that happen to share this SDK instance.
	 */
	recordMainProviderToolSignature(cacheIdentity: string, wireBytes: string): void {
		const digest = Bun.hash.wyhash(wireBytes);
		const previous = this.#lastEmittedToolSignatureByCacheIdentity.get(cacheIdentity);
		if (previous !== undefined && previous !== digest) this.record("tool-signature");
		this.#lastEmittedToolSignatureByCacheIdentity.set(cacheIdentity, digest);
	}

	/**
	 * Compare the thinking/reasoning controls emitted at the main provider
	 * boundary, partitioned by cache identity. A mid-session effort change keeps
	 * the same provider/model/session identity yet rewrites the explicit cache
	 * prefix on Anthropic and Bedrock, so the resulting warm-to-cold transition
	 * is attributed to the effort change rather than an empty cause list.
	 */
	recordThinkingLevelAtWire(cacheIdentity: string, wireBytes: string): void {
		const digest = Bun.hash.wyhash(wireBytes);
		const previous = this.#lastEmittedThinkingConfigByCacheIdentity.get(cacheIdentity);
		if (previous !== undefined && previous !== digest) this.record("thinking-level");
		this.#lastEmittedThinkingConfigByCacheIdentity.set(cacheIdentity, digest);
	}

	/** Move queued mutations onto the main request being emitted. Each queued tag is consumed exactly once. */
	recordQueuedMutationsAtMainProviderBoundary(): void {
		for (const tag of this.#nextProviderRequestTags) this.record(tag);
		this.#nextProviderRequestTags.clear();
	}

	/**
	 * Record a thinking demotion only when the ordered interrupted-thinking replay
	 * set differs from the preceding provider request. The fingerprint includes
	 * both each persisted continuity message and its paired assistant turn, so a
	 * structured clone remains stable while either wire-relevant member changes.
	 */
	recordThinkingDemotionsAtWire(pairs: readonly { continuity: object; assistant: object }[]): void {
		const next: WireMutationState =
			pairs.length === 0
				? ABSENT_WIRE_MUTATION
				: {
						state: "present",
						digest: Bun.hash.wyhash(
							stringifyJson(pairs.map(({ continuity, assistant }) => [continuity, assistant])) ?? "",
						),
					};
		this.#thinkingReplayState = this.#advancePresentMutation("thinking-demote", this.#thinkingReplayState, next);
	}

	/** Record a steering wrap only when its emitted digest is newly present or changes. */
	recordSteeringWrapAtWire(digest: bigint | undefined): void {
		const next: WireMutationState = digest === undefined ? ABSENT_WIRE_MUTATION : { state: "present", digest };
		this.#steeringWrapState = this.#advancePresentMutation("steering-wrap", this.#steeringWrapState, next);
	}

	/** Return the tags recorded since the last report, then clear the ledger. */
	consume(): readonly CacheMutationTag[] {
		const out = this.#order;
		this.#order = [];
		this.#tags.clear();
		return out;
	}

	/** Drop every recorded tag without reading them. */
	clear(): void {
		this.#order = [];
		this.#tags.clear();
		this.#nextProviderRequestTags.clear();
	}
}

/** Structural prompt-traffic shape shared by per-turn `Usage` and cumulative usage stats. */
interface PromptTraffic {
	cacheRead: number;
	cacheWrite: number;
	input: number;
}

/** Add the current message's pending prompt traffic to persisted session usage. */
export function addPromptTraffic(persisted: PromptTraffic, current: PromptTraffic): PromptTraffic {
	return {
		cacheRead: persisted.cacheRead + current.cacheRead,
		cacheWrite: persisted.cacheWrite + current.cacheWrite,
		input: persisted.input + current.input,
	};
}

/**
 * Prompt-cache hit ratio over a usage accumulator, using the same denominator
 * as the per-turn status-line `cache_hit` segment — `cacheRead + cacheWrite +
 * input` — so the two numbers are directly comparable. Returns `null` when
 * there is no prompt traffic (denominator zero).
 *
 * Mirrors `cacheHitSegment` in `status-line/segments.ts`: hit rate is the cache
 * share of all prompt tokens, with uncached `input` kept in the denominator so
 * DeepSeek-style "miss reported as input" still yields hit / (hit + miss).
 */
export function computeCacheHitRatio(usage: PromptTraffic): number | null {
	const total = usage.cacheRead + usage.cacheWrite + usage.input;
	if (total <= 0) return null;
	return (usage.cacheRead / total) * 100;
}
