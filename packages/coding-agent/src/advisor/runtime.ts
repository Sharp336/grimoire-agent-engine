import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { estimateTokens } from "@oh-my-pi/pi-agent-core/compaction";
import type { AssistantMessage, ImageContent, TextContent } from "@oh-my-pi/pi-ai";
import { logger } from "@oh-my-pi/pi-utils";
import { obfuscateToolArguments, type SecretObfuscator } from "../secrets/obfuscator";
import { formatSessionHistoryMarkdown, PRIMARY_CONTEXT_CUSTOM_TYPES } from "../session/session-history-format";
import type { AdvisorInvestigationUpdateBatch } from "../evidence/types";

/** Minimal slice of `Agent` the runtime drives — satisfied by pi-agent-core `Agent`. */
export interface AdvisorAgent {
	prompt(input: string): Promise<void>;
	abort(reason?: unknown): void;
	reset(): void;
	readonly state: { messages: AgentMessage[] };
}

export interface AdvisorRuntimeHost {
	/** Live primary transcript (use `agent.state.messages`). */
	snapshotMessages(): AgentMessage[];
	/** Surface one advice note to the primary (enqueues into the session YieldQueue). */
	enqueueAdvice(note: string, severity?: "nit" | "concern" | "blocker"): void;
	/** Redact primary transcript bytes before they reach the advisor model. */
	obfuscator?: SecretObfuscator;
	/**
	 * Pre-prompt context maintenance for the advisor's own append-only context.
	 * Promotes the advisor model to a larger sibling when its context nears the
	 * window (mirroring the primary's promote-first policy) and resolves `true`
	 * when the advisor should re-prime — reset and replay the current
	 * primary-bounded transcript — because promotion did not free enough room.
	 * Optional: hosts that omit it get no maintenance (context only shrinks when
	 * the primary's next compaction triggers {@link AdvisorRuntime.reset}).
	 */
	maintainContext?(incomingTokens: number): Promise<boolean>;
	claimInvestigationUpdates?(): Promise<AdvisorInvestigationUpdateBatch | null>;
	releaseInvestigationUpdates?(ids: readonly string[]): Promise<void>;
	markInvestigationUpdatesDelivered?(ids: readonly string[]): Promise<void>;
}

interface PendingDelta {
	text: string;
	turns: number;
	investigationIds: string[];
}

interface CatchupWaiter {
	threshold: number;
	resolve: () => void;
	finish: () => void;
	timer?: NodeJS.Timeout;
}

export class AdvisorRuntime {
	#lastCount = 0;
	/** Last-shown body, keyed by primary-context customType (plan/goal mode rules,
	 *  approved plan). These prompts are re-injected verbatim every primary turn;
	 *  this lets {@link #renderDelta} collapse an unchanged copy to a one-line
	 *  marker so the advisor isn't re-fed the full ~1k-token rules each turn.
	 *  Cleared on every re-prime/seed and when a failed batch is dropped. */
	#seenContext = new Map<string, string>();
	#pending: PendingDelta[] = [];
	#busy = false;
	#drainRequested = false;
	#backlog = 0;
	#consecutiveFailures = 0;
	#latestMessages?: AgentMessage[];
	#waiters: CatchupWaiter[] = [];
	/** Bumped by every external {@link reset}/{@link dispose}. A drain iteration
	 *  captures it before its awaits; a mismatch on resume means a reset aborted
	 *  the in-flight advisor prompt, so the stale batch is dropped instead of
	 *  being retried/requeued into the post-reset conversation. */
	#epoch = 0;
	disposed = false;

	constructor(
		private readonly agent: AdvisorAgent,
		private readonly host: AdvisorRuntimeHost,
		private readonly retryDelayMs = 1000,
	) {}

	get backlog(): number {
		return this.#backlog;
	}

	onTurnEnd(messages?: AgentMessage[]): void {
		if (this.disposed) return;
		const all = messages ?? this.host.snapshotMessages();
		this.#latestMessages = all;
		const render = this.#renderDelta(all);
		if (render) {
			this.#pending.push({ text: render.text, turns: 1, investigationIds: render.investigationIds });
			this.#backlog++;
			this.#notifyWaiters();
		}
		void this.#drain();
	}

	waitForCatchup(maxMs: number, threshold: number, signal?: AbortSignal): Promise<void> {
		if (this.disposed || signal?.aborted || this.#backlog < threshold) return Promise.resolve();
		const { promise, resolve } = Promise.withResolvers<void>();
		let waiter!: CatchupWaiter;
		const finish = (): void => {
			const idx = this.#waiters.indexOf(waiter);
			if (idx >= 0) this.#waiters.splice(idx, 1);
			clearTimeout(waiter.timer);
			signal?.removeEventListener("abort", finish);
			resolve();
		};
		waiter = { threshold, resolve, finish, timer: setTimeout(finish, maxMs) };
		this.#waiters.push(waiter);
		signal?.addEventListener("abort", finish, { once: true });
		if (signal?.aborted) {
			finish();
		}
		return promise;
	}

	dispose(): void {
		this.disposed = true;
		this.#epoch++;
		this.#releaseInvestigationIds(this.#takePendingInvestigationIds());
		this.#pending = [];
		this.#backlog = 0;
		this.#consecutiveFailures = 0;
		this.#wakeAllWaiters();
		try {
			this.agent.abort("advisor disposed");
		} catch {}
	}

	#resetAdvisorContext(clearBacklog: boolean, wakeWaiters: boolean): void {
		this.#lastCount = 0;
		this.#releaseInvestigationIds(this.#takePendingInvestigationIds());
		this.#pending = [];
		this.#consecutiveFailures = 0;
		this.#seenContext.clear();
		if (clearBacklog) {
			this.#backlog = 0;
		}
		if (wakeWaiters) {
			this.#wakeAllWaiters();
		}
		try {
			this.agent.reset();
		} catch {}
		try {
			this.agent.abort("advisor reset");
		} catch {}
	}

	/**
	 * Re-prime the advisor after a history rewrite (compaction, session
	 * switch/resume, branch). Clears the advisor's own (non-persisted) context
	 * and rewinds the cursor to 0 so the NEXT turn replays the full current —
	 * post-compaction — transcript, giving the advisor fresh context instead of
	 * leaving it blind to everything before the rewrite.
	 */
	reset(): void {
		this.#epoch++;
		this.#resetAdvisorContext(true, true);
	}

	/**
	 * Seed the cursor to the current transcript length when the advisor is enabled
	 * mid-session. Prevents the next turn from replaying the entire history to the
	 * advisor (which would be expensive and likely stale).
	 */
	seedTo(count: number): void {
		this.#lastCount = count;
		this.#releaseInvestigationIds(this.#takePendingInvestigationIds());
		this.#pending = [];
		this.#backlog = 0;
		this.#consecutiveFailures = 0;
		this.#seenContext.clear();
		this.#wakeAllWaiters();
	}

	#renderDelta(messages?: AgentMessage[]): { text: string; investigationIds: string[] } | null {
		const all = messages ?? this.#latestMessages ?? this.host.snapshotMessages();
		if (all.length < this.#lastCount) {
			this.#lastCount = all.length;
			this.#seenContext.clear();
			return null;
		}
		const delta = all
			.slice(this.#lastCount)
			.filter(m => !(customMessageType(m) === "advisor"))
			.map(m => this.#dedupContextMessage(m));
		this.#lastCount = all.length;
		if (delta.length === 0) return null;
		const obfuscator = this.host.obfuscator;
		const formattedDelta = obfuscator?.hasSecrets() ? obfuscateAdvisorDelta(obfuscator, delta) : delta;
		const md = formatSessionHistoryMarkdown(formattedDelta, {
			includeThinking: true,
			includeToolIntent: true,
			watchedRoles: true,
			expandPrimaryContext: true,
		});
		if (!md.trim()) return null;
		return { text: `### Session update\n\n${md}`, investigationIds: [] };
	}

	/**
	 * Collapse a re-injected primary-context prompt (plan/goal mode rules, the
	 * approved plan) to a short marker when its body is byte-identical to the
	 * copy already shown to the advisor since the last re-prime. The primary
	 * re-injects these verbatim every turn; without this the advisor re-reads the
	 * full rules (~1k tokens) each turn. Returns a CLONE when collapsing — the
	 * input shares the live primary transcript and must never be mutated.
	 */
	#dedupContextMessage(msg: AgentMessage): AgentMessage {
		const type = customMessageType(msg);
		if (!type || !PRIMARY_CONTEXT_CUSTOM_TYPES.has(type)) return msg;
		const content = customMessageStringContent(msg);
		if (typeof content !== "string") return msg;
		if (this.#seenContext.get(type) === content) {
			return { ...(msg as object), content: "(unchanged — still in effect)" } as AgentMessage;
		}
		this.#seenContext.set(type, content);
		return msg;
	}

	#notifyWaiters(): void {
		for (let i = this.#waiters.length - 1; i >= 0; i--) {
			const w = this.#waiters[i];
			if (this.#backlog < w.threshold) {
				w.finish();
			}
		}
	}

	#wakeAllWaiters(): void {
		for (const w of [...this.#waiters]) {
			w.finish();
		}
	}


	#takePendingInvestigationIds(): string[] {
		const ids: string[] = [];
		for (const delta of this.#pending) {
			ids.push(...delta.investigationIds);
		}
		return [...new Set(ids)];
	}

	#releaseInvestigationIds(ids: readonly string[]): void {
		if (ids.length === 0) return;
		void this.host.releaseInvestigationUpdates?.(ids).catch(err => {
			logger.debug("advisor investigation release failed", { err: String(err) });
		});
	}

	async #markInvestigationIdsDelivered(ids: readonly string[]): Promise<void> {
		if (ids.length === 0) return;
		try {
			await this.host.markInvestigationUpdatesDelivered?.(ids);
		} catch (err) {
			logger.debug("advisor investigation delivery mark failed", { err: String(err) });
			this.#releaseInvestigationIds(ids);
		}
	}

	#combineBatchText(primaryText: string, investigationText: string | null): string | null {
		if (primaryText && investigationText) return `${primaryText}\n\n### Investigation updates\n\n${investigationText}`;
		if (primaryText) return primaryText;
		if (investigationText) return `### Investigation updates\n\n${investigationText}`;
		return null;
	}
	async #drain(): Promise<void> {
		if (this.#busy) {
			this.#drainRequested = true;
			return;
		}
		this.#busy = true;
		try {
			while (!this.disposed) {
				this.#drainRequested = false;
				const popped = this.#pending.splice(0);
				let update: AdvisorInvestigationUpdateBatch | null = null;
				if (this.host.claimInvestigationUpdates) {
					try {
						update = await this.host.claimInvestigationUpdates();
					} catch (err) {
						logger.debug("advisor investigation claim failed", { err: String(err) });
					}
				}
				if (popped.length === 0 && update === null) break;
				const epoch = this.#epoch;
				// Each delta already opens with a `### Session update` heading, so
				// join with a blank line rather than a `---` rule.
				const candidatePrimaryText = popped.map(b => b.text).join("\n\n");
				const investigationText = update?.text ?? null;
				const combinedIds = [...popped.flatMap(b => b.investigationIds), ...(update?.ids ?? [])];
				const turnsCovered = popped.reduce((sum, b) => sum + b.turns, 0);
				const candidateBatch = this.#combineBatchText(candidatePrimaryText, investigationText);
				if (candidateBatch === null) {
					this.#releaseInvestigationIds(combinedIds);
					continue;
				}
				const incomingTokens = estimateTokens({
					role: "user",
					content: candidateBatch,
					timestamp: Date.now(),
				});

				let shouldReprime = false;
				if (this.host.maintainContext) {
					try {
						shouldReprime = await this.host.maintainContext(incomingTokens);
					} catch (err) {
						logger.debug("advisor context maintenance failed", { err: String(err) });
					}
				}
				// A reset/dispose during context maintenance invalidates this batch.
				if (this.#epoch !== epoch) {
					this.#releaseInvestigationIds(combinedIds);
					continue;
				}

				let batch: string | null;
				let finalTurns: number;
				if (shouldReprime) {
					// Promotion could not fit the advisor's context — re-prime.
					const newTurns = this.#pending.reduce((sum, b) => sum + b.turns, 0);
					this.#resetAdvisorContext(false, false);
					const rerendered = this.#renderDelta(this.#latestMessages);
					batch = this.#combineBatchText(rerendered?.text ?? "", investigationText);
					finalTurns = turnsCovered + newTurns;
				} else {
					batch = candidateBatch;
					finalTurns = turnsCovered;
				}

				if (this.disposed || batch === null) {
					this.#releaseInvestigationIds(combinedIds);
					this.#backlog = Math.max(0, this.#backlog - finalTurns);
					this.#notifyWaiters();
					continue;
				}

				let success = false;
				try {
					await this.agent.prompt(batch);
					if (combinedIds.length > 0) await this.#markInvestigationIdsDelivered(combinedIds);
					success = true;
					this.#consecutiveFailures = 0;
				} catch (err) {
					// reset()/dispose() aborts the in-flight prompt; the rejection is the
					// reset itself, not a transient advisor failure. Drop the stale batch
					// (reset already cleared #pending and rewound the cursor) instead of
					// requeuing it into the post-reset conversation.
					if (this.#epoch !== epoch) {
						this.#releaseInvestigationIds(combinedIds);
						continue;
					}
					logger.debug("advisor turn failed", { err: String(err) });
					this.#consecutiveFailures++;
					if (this.#consecutiveFailures >= 3) {
						logger.warn("advisor failed consecutively 3 times; dropping backlog to prevent stall");
						this.#consecutiveFailures = 0;
						this.#releaseInvestigationIds(combinedIds);
						// The dropped batch may carry primary-context we never delivered; drop
						// the seen-state too so the next turn re-expands it instead of marking
						// it "unchanged" against content the advisor never received.
						this.#seenContext.clear();
						success = true;
					} else {
						this.#pending.unshift({ text: batch, turns: finalTurns, investigationIds: combinedIds });
						await Bun.sleep(this.retryDelayMs);
					}
				}

				if (success && this.#epoch === epoch) {
					this.#backlog = Math.max(0, this.#backlog - finalTurns);
					this.#notifyWaiters();
				}
			}
		} finally {
			this.#busy = false;
			if (this.#drainRequested && !this.disposed) {
				void this.#drain();
			}
		}
	}
}

type TextualContent = string | readonly (TextContent | ImageContent)[];

function obfuscateTextualContent(obfuscator: SecretObfuscator, content: TextualContent): TextualContent {
	if (typeof content === "string") return obfuscator.obfuscate(content);
	let changed = false;
	const result = content.map((block): TextContent | ImageContent => {
		if (block.type !== "text") return block;
		const text = obfuscator.obfuscate(block.text);
		if (text === block.text) return block;
		changed = true;
		return { ...block, text };
	});
	return changed ? result : content;
}

function obfuscateAssistantMessage(obfuscator: SecretObfuscator, message: AssistantMessage): AssistantMessage {
	let changed = false;
	const content = message.content.map((block): AssistantMessage["content"][number] => {
		if (block.type === "text") {
			const text = obfuscator.obfuscate(block.text);
			if (text === block.text) return block;
			changed = true;
			return { ...block, text };
		}
		if (block.type === "toolCall") {
			const args = obfuscateToolArguments(obfuscator, block.arguments);
			if (args === block.arguments) return block;
			changed = true;
			return { ...block, arguments: args };
		}
		return block;
	});
	return changed ? { ...message, content } : message;
}

function obfuscateDetails(
	obfuscator: SecretObfuscator,
	details: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
	if (!details) return details;
	// Walk strings at every depth: `customOneLiner` renders nested fields
	// (e.g. `async-result` reads `details.jobs[].label`/`jobId`), so a shallow
	// pass leaks any secret a background job's label happens to contain.
	return obfuscateToolArguments(obfuscator, details);
}

function obfuscateAdvisorMessage(obfuscator: SecretObfuscator, message: AgentMessage): AgentMessage {
	switch (message.role) {
		case "user":
		case "developer":
		case "toolResult": {
			const content = obfuscateTextualContent(obfuscator, message.content as TextualContent);
			return content === message.content ? message : ({ ...(message as object), content } as AgentMessage);
		}
		case "assistant":
			return obfuscateAssistantMessage(obfuscator, message as AssistantMessage) as AgentMessage;
		case "custom":
		case "hookMessage": {
			const msg = message as AgentMessage & {
				content: TextualContent;
				details?: Record<string, unknown>;
			};
			const content = obfuscateTextualContent(obfuscator, msg.content);
			const details = obfuscateDetails(obfuscator, msg.details);
			if (content === msg.content && details === msg.details) return message;
			return { ...(message as object), content, details } as AgentMessage;
		}
		case "bashExecution": {
			const msg = message as AgentMessage & { command: string; output: string };
			const command = obfuscator.obfuscate(msg.command);
			const output = obfuscator.obfuscate(msg.output);
			return command === msg.command && output === msg.output
				? message
				: ({ ...(message as object), command, output } as AgentMessage);
		}
		case "pythonExecution": {
			const msg = message as AgentMessage & { code: string; output: string };
			const code = obfuscator.obfuscate(msg.code);
			const output = obfuscator.obfuscate(msg.output);
			return code === msg.code && output === msg.output
				? message
				: ({ ...(message as object), code, output } as AgentMessage);
		}
		case "branchSummary": {
			const msg = message as AgentMessage & { summary: string };
			const summary = obfuscator.obfuscate(msg.summary);
			return summary === msg.summary ? message : ({ ...(message as object), summary } as AgentMessage);
		}
		case "compactionSummary": {
			const msg = message as AgentMessage & { summary: string };
			const summary = obfuscator.obfuscate(msg.summary);
			return summary === msg.summary ? message : ({ ...(message as object), summary } as AgentMessage);
		}
		case "fileMention": {
			const msg = message as AgentMessage & {
				files: Array<{ path: string; content: string; image?: unknown }>;
			};
			let changed = false;
			const files = msg.files.map(file => {
				const path = obfuscator.obfuscate(file.path);
				const content = obfuscator.obfuscate(file.content);
				if (path === file.path && content === file.content) return file;
				changed = true;
				return { ...file, path, content };
			});
			return changed ? ({ ...(message as object), files } as AgentMessage) : message;
		}
		default:
			return message;
	}
}

function customMessageType(message: AgentMessage): string | undefined {
	if (message.role !== "custom") return undefined;
	if (!("customType" in message) || typeof message.customType !== "string") return undefined;
	return message.customType;
}

function customMessageStringContent(message: AgentMessage): string | undefined {
	if (message.role !== "custom") return undefined;
	if (!("content" in message) || typeof message.content !== "string") return undefined;
	return message.content;
}

function obfuscateAdvisorDelta(obfuscator: SecretObfuscator, messages: AgentMessage[]): AgentMessage[] {
	let changed = false;
	const result = messages.map(message => {
		const next = obfuscateAdvisorMessage(obfuscator, message);
		if (next !== message) changed = true;
		return next;
	});
	return changed ? result : messages;
}
