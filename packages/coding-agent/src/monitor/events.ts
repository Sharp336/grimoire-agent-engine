import { escapeXmlAttribute, escapeXmlText, logger, prompt } from "@oh-my-pi/pi-utils";
import type { AsyncJobEvent } from "../async/job-manager";
import monitorEventTemplate from "../prompts/tools/monitor-event.md" with { type: "text" };
import type { CustomMessage } from "../session/messages";
import { replaceTabs, shortenPath } from "../tools/render-utils";

export const MONITOR_COALESCE_WINDOW_MS = 200;
export const MONITOR_SOURCE_ENTRY_MAX_CHARS = 500;
export const MONITOR_EVENT_MAX_CHARS = 3_000;
export const MONITOR_PENDING_ENTRY_CAPACITY = MONITOR_EVENT_MAX_CHARS + 1;
export const MONITOR_TOKEN_BUCKET_CAPACITY = 10;
export const MONITOR_TOKEN_REFILL_MS = 2_000;
export const MONITOR_FLOOD_DURATION_MS = 30_000;
export const MONITOR_INPUT_MAX_BYTES = 1024 * 1024;
export const MONITOR_MESSAGE_MAX_CHARS = 12_000;

const CONTROL_NOISE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;
const MONITOR_FLOOD_QUIET_MS = MONITOR_TOKEN_REFILL_MS;

export interface MonitorEventChannelOptions {
	emit: (text: string) => void | Promise<void>;
	onFlood: () => void;
	onOversizedInput: () => void;
}

export interface MonitorEventEntry extends AsyncJobEvent {
	jobId: string;
	description: string;
}

export interface MonitorEventMessageDetails {
	events: Array<{
		jobId: string;
		description: string;
		sequence: number;
		timestamp: number;
	}>;
	omitted: number;
}

function utf8ByteLength(text: string): number {
	return Buffer.byteLength(text, "utf8");
}

function truncateCharacters(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	let count = 0;
	let end = 0;
	for (const character of text) {
		if (count >= maxChars) break;
		count += 1;
		end += character.length;
	}
	return text.slice(0, end);
}

function sanitizeSourceText(text: string, maxChars = MONITOR_SOURCE_ENTRY_MAX_CHARS): string {
	const sanitized = replaceTabs(Bun.stripANSI(text)).replace(CONTROL_NOISE, "");
	return truncateCharacters(shortenPath(sanitized), maxChars);
}

function buildBoundedEntries(entries: readonly string[], maxChars: number, previouslyOmitted = 0): string {
	let suffixLength = 0;
	let keptCount = 0;
	for (let candidateCount = 0; candidateCount <= entries.length; candidateCount++) {
		if (candidateCount > 0) {
			const entry = entries[entries.length - candidateCount] ?? "";
			suffixLength += entry.length + (candidateCount > 1 ? 1 : 0);
		}
		const omitted = previouslyOmitted + entries.length - candidateCount;
		const summary = omitted > 0 ? `[${omitted} older monitor ${omitted === 1 ? "entry" : "entries"} omitted]` : "";
		const candidateLength = suffixLength + (summary && candidateCount > 0 ? summary.length + 1 : summary.length);
		if (candidateLength <= maxChars) keptCount = candidateCount;
	}

	const omitted = previouslyOmitted + entries.length - keptCount;
	const kept = entries.slice(entries.length - keptCount);
	if (omitted === 0) return kept.join("\n");
	const summary = `[${omitted} older monitor ${omitted === 1 ? "entry" : "entries"} omitted]`;
	return kept.length > 0 ? `${summary}\n${kept.join("\n")}` : truncateCharacters(summary, maxChars);
}

export class MonitorEventChannel {
	readonly #emit: MonitorEventChannelOptions["emit"];
	readonly #onFlood: MonitorEventChannelOptions["onFlood"];
	readonly #onOversizedInput: MonitorEventChannelOptions["onOversizedInput"];
	#carry = "";
	#carryBytes = 0;
	#pendingEntries: string[] = [];
	#pendingStart = 0;
	#pendingOmitted = 0;
	#coalesceTimer: NodeJS.Timeout | undefined;
	#quietTimer: NodeJS.Timeout | undefined;
	#floodTimer: NodeJS.Timeout | undefined;
	#tokens = MONITOR_TOKEN_BUCKET_CAPACITY;
	#lastRefillAt = Date.now();
	#suppressedNotifications = 0;
	#floodStartedAt: number | undefined;
	#lastSuppressionAt: number | undefined;
	#emitChain = Promise.resolve();
	#closed = false;
	#inputFailed = false;
	#flooded = false;

	constructor(options: MonitorEventChannelOptions) {
		this.#emit = options.emit;
		this.#onFlood = options.onFlood;
		this.#onOversizedInput = options.onOversizedInput;
	}

	pushChunk(chunk: string): void {
		if (this.#closed || this.#inputFailed || this.#flooded || chunk.length === 0) return;
		let start = 0;
		for (let index = chunk.indexOf("\n", start); index !== -1; index = chunk.indexOf("\n", start)) {
			if (!this.#appendCarry(chunk.slice(start, index))) return;
			const line = this.#carry.endsWith("\r") ? this.#carry.slice(0, -1) : this.#carry;
			this.#carry = "";
			this.#carryBytes = 0;
			this.#acceptEntry(line);
			start = index + 1;
		}
		if (start < chunk.length) this.#appendCarry(chunk.slice(start));
	}

	pushFrame(frame: string): void {
		if (this.#closed || this.#inputFailed || this.#flooded) return;
		if (utf8ByteLength(frame) > MONITOR_INPUT_MAX_BYTES) {
			this.#failOversizedInput();
			return;
		}
		this.#acceptEntry(frame);
	}

	async close(options: { flush: boolean }): Promise<void> {
		if (this.#closed) {
			await this.#emitChain;
			return;
		}
		this.#closed = true;
		this.#clearTimers();
		if (options.flush && !this.#inputFailed && !this.#flooded) {
			if (this.#carry.length > 0) {
				const line = this.#carry.endsWith("\r") ? this.#carry.slice(0, -1) : this.#carry;
				this.#appendPendingEntry(sanitizeSourceText(line));
			}
			this.#carry = "";
			this.#carryBytes = 0;
			this.#flushPending(true);
		} else {
			this.#carry = "";
			this.#carryBytes = 0;
			this.#dropPendingEntries();
		}
		await this.#emitChain;
	}

	#appendCarry(text: string): boolean {
		const nextBytes = this.#carryBytes + utf8ByteLength(text);
		if (nextBytes > MONITOR_INPUT_MAX_BYTES) {
			this.#failOversizedInput();
			return false;
		}
		this.#carry += text;
		this.#carryBytes = nextBytes;
		return true;
	}

	#failOversizedInput(): void {
		if (this.#inputFailed) return;
		this.#inputFailed = true;
		this.#dropPendingEntries();
		this.#carry = "";
		this.#carryBytes = 0;
		if (this.#coalesceTimer) {
			clearTimeout(this.#coalesceTimer);
			this.#coalesceTimer = undefined;
		}
		try {
			this.#onOversizedInput();
		} catch (error) {
			logger.warn("Monitor oversized-input callback failed", {
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	#acceptEntry(text: string): void {
		this.#appendPendingEntry(sanitizeSourceText(text));
		if (this.#coalesceTimer) return;
		this.#coalesceTimer = setTimeout(() => {
			this.#coalesceTimer = undefined;
			this.#flushPending(false);
		}, MONITOR_COALESCE_WINDOW_MS);
		this.#coalesceTimer.unref?.();
	}

	#flushPending(force: boolean): void {
		if (this.#pendingEntries.length === this.#pendingStart) return;
		const entries = this.#pendingEntries.slice(this.#pendingStart);
		const previouslyOmitted = this.#pendingOmitted;
		this.#dropPendingEntries();
		const now = Date.now();
		this.#refillTokens(now);
		if (!force && this.#tokens < 1) {
			this.#suppressedNotifications += 1;
			this.#recordSuppression(now);
			return;
		}
		if (!force) this.#tokens -= 1;

		let prefix = "";
		let eventBudget = MONITOR_EVENT_MAX_CHARS;
		if (this.#suppressedNotifications > 0) {
			const count = this.#suppressedNotifications;
			prefix = `[${count} monitor ${count === 1 ? "notification" : "notifications"} suppressed by rate limit]`;
			eventBudget -= prefix.length + 1;
			this.#suppressedNotifications = 0;
		}
		const body = buildBoundedEntries(entries, eventBudget, previouslyOmitted);
		this.#queueEmit(prefix ? `${prefix}\n${body}` : body);
	}

	#refillTokens(now: number): void {
		if (this.#tokens >= MONITOR_TOKEN_BUCKET_CAPACITY) {
			this.#lastRefillAt = now;
			return;
		}
		const elapsed = Math.max(0, now - this.#lastRefillAt);
		const refill = Math.floor(elapsed / MONITOR_TOKEN_REFILL_MS);
		if (refill <= 0) return;
		this.#tokens = Math.min(MONITOR_TOKEN_BUCKET_CAPACITY, this.#tokens + refill);
		this.#lastRefillAt += refill * MONITOR_TOKEN_REFILL_MS;
	}

	#recordSuppression(now: number): void {
		this.#lastSuppressionAt = now;
		if (this.#floodStartedAt === undefined) {
			this.#floodStartedAt = now;
			this.#floodTimer = setTimeout(() => this.#checkFlood(), MONITOR_FLOOD_DURATION_MS);
			this.#floodTimer.unref?.();
		}
		clearTimeout(this.#quietTimer);
		this.#quietTimer = setTimeout(() => this.#resetFloodWindow(), MONITOR_FLOOD_QUIET_MS);
		this.#quietTimer.unref?.();
	}

	#checkFlood(): void {
		this.#floodTimer = undefined;
		if (
			this.#closed ||
			this.#flooded ||
			this.#floodStartedAt === undefined ||
			this.#lastSuppressionAt === undefined ||
			Date.now() - this.#floodStartedAt < MONITOR_FLOOD_DURATION_MS ||
			Date.now() - this.#lastSuppressionAt >= MONITOR_FLOOD_QUIET_MS
		) {
			return;
		}
		this.#flooded = true;
		this.#dropPendingEntries();
		try {
			this.#onFlood();
		} catch (error) {
			logger.warn("Monitor flood callback failed", {
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	#resetFloodWindow(): void {
		this.#quietTimer = undefined;
		this.#floodStartedAt = undefined;
		this.#lastSuppressionAt = undefined;
		clearTimeout(this.#floodTimer);
		this.#floodTimer = undefined;
	}

	#appendPendingEntry(text: string): void {
		this.#pendingEntries.push(text);
		if (this.#pendingEntries.length - this.#pendingStart > MONITOR_PENDING_ENTRY_CAPACITY) {
			this.#pendingStart += 1;
			this.#pendingOmitted += 1;
		}
		if (
			this.#pendingStart >= MONITOR_PENDING_ENTRY_CAPACITY &&
			this.#pendingStart * 2 >= this.#pendingEntries.length
		) {
			this.#pendingEntries = this.#pendingEntries.slice(this.#pendingStart);
			this.#pendingStart = 0;
		}
	}

	#dropPendingEntries(): void {
		this.#pendingEntries = [];
		this.#pendingStart = 0;
		this.#pendingOmitted = 0;
	}

	#queueEmit(text: string): void {
		this.#emitChain = this.#emitChain
			.then(() => this.#emit(text))
			.catch(error => {
				logger.warn("Monitor event emission failed", {
					error: error instanceof Error ? error.message : String(error),
				});
			});
	}

	#clearTimers(): void {
		clearTimeout(this.#coalesceTimer);
		clearTimeout(this.#quietTimer);
		clearTimeout(this.#floodTimer);
		this.#coalesceTimer = undefined;
		this.#quietTimer = undefined;
		this.#floodTimer = undefined;
	}
}

interface EscapedMonitorEventEntry {
	jobId: string;
	description: string;
	sequence: number;
	text: string;
}

export function buildMonitorEventBatchMessage(
	entries: MonitorEventEntry[],
): CustomMessage<MonitorEventMessageDetails> | null {
	if (entries.length === 0) return null;
	const escaped: EscapedMonitorEventEntry[] = entries.map(entry => ({
		jobId: escapeXmlAttribute(sanitizeSourceText(entry.jobId, MONITOR_SOURCE_ENTRY_MAX_CHARS)),
		description: escapeXmlAttribute(sanitizeSourceText(entry.description, MONITOR_SOURCE_ENTRY_MAX_CHARS)),
		sequence: entry.sequence,
		text: escapeXmlText(sanitizeSourceText(entry.text, MONITOR_EVENT_MAX_CHARS)),
	}));
	let kept: EscapedMonitorEventEntry[] = [];
	let content = "";
	for (let index = escaped.length - 1; index >= 0; index--) {
		const candidate = [escaped[index]!, ...kept];
		const candidateContent = prompt.render(monitorEventTemplate, {
			entries: candidate,
			omitted: escaped.length - candidate.length,
		});
		if (candidateContent.length > MONITOR_MESSAGE_MAX_CHARS) break;
		kept = candidate;
		content = candidateContent;
	}
	if (kept.length === 0) {
		const latest = entries.at(-1)!;
		const jobId = escapeXmlAttribute(sanitizeSourceText(latest.jobId, MONITOR_SOURCE_ENTRY_MAX_CHARS));
		const description = escapeXmlAttribute(sanitizeSourceText(latest.description, MONITOR_SOURCE_ENTRY_MAX_CHARS));
		const sourceText = sanitizeSourceText(latest.text, MONITOR_EVENT_MAX_CHARS);
		let low = 0;
		let high = MONITOR_EVENT_MAX_CHARS;
		while (low <= high) {
			const midpoint = Math.floor((low + high) / 2);
			const candidate = {
				jobId,
				description,
				sequence: latest.sequence,
				text: escapeXmlText(truncateCharacters(sourceText, midpoint)),
			};
			const candidateContent = prompt.render(monitorEventTemplate, {
				entries: [candidate],
				omitted: escaped.length - 1,
			});
			if (candidateContent.length <= MONITOR_MESSAGE_MAX_CHARS) {
				kept = [candidate];
				content = candidateContent;
				low = midpoint + 1;
			} else {
				high = midpoint - 1;
			}
		}
	}
	const omitted = escaped.length - kept.length;
	const keptOriginal = entries.slice(entries.length - kept.length);
	return {
		role: "custom",
		customType: "monitor-event",
		content,
		display: true,
		attribution: "agent",
		details: {
			events: keptOriginal.map(entry => ({
				jobId: entry.jobId,
				description: entry.description,
				sequence: entry.sequence,
				timestamp: entry.timestamp,
			})),
			omitted,
		},
		timestamp: Date.now(),
	};
}
