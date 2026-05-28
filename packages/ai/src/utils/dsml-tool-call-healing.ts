/**
 * Streaming-safe filter for the DeepSeek "DSML" chat-template tool-call
 * envelope.
 *
 * DeepSeek's V4 family is occasionally served by hosts (Ollama Cloud, NVIDIA
 * NIM, the native DeepSeek API, …) that don't strip the chat-template envelope
 * before forwarding `delta.content` / `message.content`. The leak looks like:
 *
 *     <｜DSML｜tool_calls>
 *       <｜DSML｜invoke name="bash">
 *         <｜DSML｜parameter name="_i" string="true">Check Fedora packages</｜DSML｜parameter>
 *         <｜DSML｜parameter name="timeout" string="false">15</｜DSML｜parameter>
 *       </｜DSML｜invoke>
 *     </｜DSML｜tool_calls>
 *
 * Without healing, users see the raw XML and the agent loop never gets a
 * structured tool call — the turn ends right after the envelope. This module
 * reconstructs the embedded calls and strips the envelope from visible text.
 * It is stream-aware: any partial tag at the end of a chunk is held back
 * until the next chunk arrives.
 *
 * The healer is grammar-specific (DSML envelope only) and is independent of
 * the single-token stripper in {@link openai-completions.ts}, which handles
 * solitary `<｜DSML｜tool_calls｜>` style markers leaked without an envelope.
 */

import { parseJsonWithRepair } from "./json-parse";

/** Both fullwidth (U+FF5C) and ASCII pipes are observed in the wild. */
const PIPE = "[｜|]";

const TC_OPEN_RE = new RegExp(String.raw`<${PIPE}DSML${PIPE}tool_calls>`, "y");
const TC_CLOSE_RE = new RegExp(String.raw`</${PIPE}DSML${PIPE}tool_calls>`, "y");
const INVOKE_OPEN_RE = new RegExp(String.raw`<${PIPE}DSML${PIPE}invoke\s+name="([^"]*)"\s*>`, "y");
const INVOKE_CLOSE_RE = new RegExp(String.raw`</${PIPE}DSML${PIPE}invoke>`, "y");
const PARAM_OPEN_RE = new RegExp(
	String.raw`<${PIPE}DSML${PIPE}parameter\s+name="([^"]*)"(?:\s+string="(true|false)")?\s*>`,
	"y",
);
const PARAM_CLOSE_RE = new RegExp(String.raw`</${PIPE}DSML${PIPE}parameter>`, "y");

/** Cap held-back buffer length so a stray `<` in normal prose can't grow it unboundedly. */
const MAX_PARTIAL_HOLD = 256;

/** Maximum bytes of parameter value we'll accumulate before bailing on the call. */
const MAX_PARAM_VALUE_LENGTH = 1_000_000;

export interface HealedDsmlToolCall {
	readonly id: string;
	readonly name: string;
	readonly arguments: string;
}

type State =
	| { kind: "idle" }
	| { kind: "section" }
	| { kind: "invoke"; name: string; args: Record<string, unknown> }
	| {
			kind: "parameter";
			invokeName: string;
			args: Record<string, unknown>;
			paramName: string;
			isString: boolean;
			value: string;
	  };

/**
 * State machine that consumes streamed text, emits visible text with the
 * DSML envelope stripped, and accumulates the embedded tool calls for the
 * caller to drain after each {@link feed} call.
 *
 * One instance per stream. Feed only the visible-text channel (e.g.
 * `delta.content` / `message.content`); reasoning text never carries the
 * envelope and mixing channels corrupts the held-back buffer.
 */
export class DsmlToolCallHealer {
	#buffer = "";
	#offset = 0;
	#state: State = { kind: "idle" };
	#sectionTerminated = false;
	readonly #completed: HealedDsmlToolCall[] = [];

	/**
	 * Feed a chunk of streamed text. Returns the portion safe to emit
	 * downstream (envelope stripped). Any partial tag suffix is held back
	 * until the next {@link feed} call or {@link flushPending}.
	 */
	feed(text: string): string {
		if (text.length === 0) return "";
		this.#compact();
		this.#buffer += text;
		return this.#consume();
	}

	/**
	 * Like {@link feed}, but discards any tool calls that the chunk completes.
	 * Used when the upstream provider also emits structured `tool_calls` for
	 * the same chunk: the healer still strips envelope markup from visible
	 * output, but the structured payload remains the single source of truth.
	 */
	consumeWithoutCalls(text: string): string {
		const clean = this.feed(text);
		if (this.#completed.length > 0) this.#completed.length = 0;
		return clean;
	}

	/**
	 * Drain accumulated tool calls. Internal list is cleared so a subsequent
	 * envelope in the same stream (rare) yields fresh calls.
	 */
	drainCompleted(): HealedDsmlToolCall[] {
		if (this.#completed.length === 0) return [];
		return this.#completed.splice(0, this.#completed.length);
	}

	/**
	 * Flush any held-back fragment when the stream ends. If we were mid-call
	 * the partial is dropped (surfacing half-tags would re-leak markers);
	 * otherwise the fragment is returned verbatim so a literal `<｜DSML` in
	 * unrelated prose is not silently lost.
	 */
	flushPending(): string {
		const tail = this.#remaining();
		this.#buffer = "";
		this.#offset = 0;
		const state = this.#state;
		this.#state = { kind: "idle" };
		if (state.kind === "idle") return tail;
		return "";
	}

	/** True once any DSML envelope in this stream has fully closed. */
	get sectionClosed(): boolean {
		return this.#sectionTerminated;
	}

	#remaining(): string {
		return this.#offset === 0 ? this.#buffer : this.#buffer.slice(this.#offset);
	}

	#compact(): void {
		if (this.#offset === 0) return;
		this.#buffer = this.#buffer.slice(this.#offset);
		this.#offset = 0;
	}

	#consume(): string {
		let clean = "";
		while (this.#offset < this.#buffer.length) {
			const state = this.#state;

			// Try state-specific complete tag matches first.
			if (state.kind === "idle") {
				if (this.#tryMatch(TC_OPEN_RE)) {
					this.#state = { kind: "section" };
					continue;
				}
			} else if (state.kind === "section") {
				if (this.#tryMatch(TC_CLOSE_RE)) {
					this.#state = { kind: "idle" };
					this.#sectionTerminated = true;
					continue;
				}
				const invokeMatch = this.#tryMatchCapture(INVOKE_OPEN_RE);
				if (invokeMatch) {
					this.#state = {
						kind: "invoke",
						name: invokeMatch[1] ?? "",
						args: {},
					};
					continue;
				}
			} else if (state.kind === "invoke") {
				if (this.#tryMatch(INVOKE_CLOSE_RE)) {
					this.#finalizeCall(state.name, state.args);
					this.#state = { kind: "section" };
					continue;
				}
				const paramMatch = this.#tryMatchCapture(PARAM_OPEN_RE);
				if (paramMatch) {
					const isString = paramMatch[2] !== "false";
					this.#state = {
						kind: "parameter",
						invokeName: state.name,
						args: state.args,
						paramName: paramMatch[1] ?? "",
						isString,
						value: "",
					};
					continue;
				}
			} else {
				// parameter
				if (this.#tryMatch(PARAM_CLOSE_RE)) {
					state.args[state.paramName] = coerceParamValue(state.value, state.isString);
					this.#state = {
						kind: "invoke",
						name: state.invokeName,
						args: state.args,
					};
					continue;
				}
			}

			// No complete tag matched at the current offset.
			// If the unconsumed tail might still complete into a tag once more
			// bytes arrive, hold back until the next chunk.
			if (this.#startsWithPartialTag()) break;

			// Consume one char as state-appropriate output.
			const ch = this.#buffer[this.#offset]!;
			this.#offset += 1;
			if (state.kind === "idle") {
				clean += ch;
				continue;
			}
			if (state.kind === "parameter") {
				if (state.value.length >= MAX_PARAM_VALUE_LENGTH) {
					// Pathological output — abandon the call rather than blow up memory.
					this.#state = { kind: "idle" };
					continue;
				}
				state.value += ch;
				continue;
			}
			// section / invoke: swallow inter-tag whitespace and stray text.
		}
		return clean;
	}

	#tryMatch(pattern: RegExp): boolean {
		pattern.lastIndex = this.#offset;
		const match = pattern.exec(this.#buffer);
		if (!match) return false;
		this.#offset += match[0].length;
		return true;
	}

	#tryMatchCapture(pattern: RegExp): RegExpExecArray | undefined {
		pattern.lastIndex = this.#offset;
		const match = pattern.exec(this.#buffer);
		if (!match) return undefined;
		this.#offset += match[0].length;
		return match;
	}

	/**
	 * True if the buffer at the current offset starts with `<` but does not
	 * yet contain `>`. The consume loop has already attempted every
	 * state-specific regex match; reaching this point means either the tag
	 * is still incomplete (hold back) or the `<` is literal prose / value
	 * content (consume it). The `>` lookahead disambiguates.
	 *
	 * Capped so a stray `<` followed by many bytes without `>` (e.g. shell
	 * comparison `a < b`, never closed) doesn't grow the holdback
	 * unboundedly.
	 */
	#startsWithPartialTag(): boolean {
		if (this.#buffer[this.#offset] !== "<") return false;
		const tailLength = this.#buffer.length - this.#offset;
		if (tailLength > MAX_PARTIAL_HOLD) return false;
		for (let i = this.#offset + 1; i < this.#buffer.length; i++) {
			if (this.#buffer[i] === ">") return false;
		}
		return true;
	}

	#finalizeCall(name: string, args: Record<string, unknown>): void {
		const id = generateHealedDsmlCallId();
		this.#completed.push({
			id,
			name: name.trim(),
			arguments: JSON.stringify(args),
		});
	}
}



function coerceParamValue(raw: string, isString: boolean): unknown {
	if (isString) return raw;
	const trimmed = raw.trim();
	if (trimmed.length === 0) return raw;
	try {
		return parseJsonWithRepair<unknown>(trimmed);
	} catch {
		return raw;
	}
}

function generateHealedDsmlCallId(): string {
	return `call_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

/**
 * Cheap test for whether a model is known to leak DSML chat-template envelopes
 * into visible text. Gated to DeepSeek family on hosts observed in the wild;
 * other providers do not pay for the per-chunk scan.
 */
export function modelMayLeakDsmlToolCalls(provider: string, modelId: string): boolean {
	const isDeepseekId = /deepseek/i.test(modelId);
	if (!isDeepseekId) return false;
	return (
		provider === "ollama" ||
		provider === "ollama-cloud" ||
		provider === "nvidia" ||
		provider === "deepseek" ||
		provider === "fireworks" ||
		provider === "opencode-go" ||
		provider === "openrouter"
	);
}
