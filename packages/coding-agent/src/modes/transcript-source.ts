import * as fs from "node:fs";
import type { AgentEvent } from "@oh-my-pi/pi-agent-core";
import type { ToolResultMessage } from "@oh-my-pi/pi-ai";
import type { SessionMessageEntry } from "../session/session-manager";
import { parseSessionEntries } from "../session/session-manager";
import { type SubagentEventPayload, TASK_SUBAGENT_EVENT_CHANNEL } from "../task";
import type { EventBus } from "../utils/event-bus";

export interface TranscriptSourceMeta {
	status: "active" | "completed" | "failed" | "aborted";
	tokens?: number;
	cost?: number;
	model?: string;
	durationMs?: number;
}

export interface TranscriptSource {
	backlog(): AgentEvent[]; // events to seed() the renderer
	subscribe(cb: (e: AgentEvent) => void): () => void; // live tail; no-op + returns noop for completed
	meta(): TranscriptSourceMeta;
	dispose(): void;
}

function readFileIncremental(filePath: string, fromByte: number): { text: string; newSize: number } | null {
	try {
		const stat = fs.statSync(filePath);
		if (stat.size <= fromByte) return { text: "", newSize: stat.size };
		const buf = Buffer.alloc(stat.size - fromByte);
		const fd = fs.openSync(filePath, "r");
		try {
			fs.readSync(fd, buf, 0, buf.length, fromByte);
		} finally {
			fs.closeSync(fd);
		}
		return { text: buf.toString("utf-8"), newSize: stat.size };
	} catch {
		return null;
	}
}

export class ReplaySource implements TranscriptSource {
	#sessionFile: string;
	#meta?: Partial<TranscriptSourceMeta>;
	#bytesRead = 0;
	#entries: SessionMessageEntry[] = [];
	#model?: string;
	#status: TranscriptSourceMeta["status"] = "active";

	constructor(sessionFile: string, meta?: Partial<TranscriptSourceMeta>) {
		this.#sessionFile = sessionFile;
		this.#meta = meta;
		if (meta?.status) {
			this.#status = meta.status;
		}
	}

	#readIncremental(): void {
		const result = readFileIncremental(this.#sessionFile, this.#bytesRead);
		if (!result) return;
		if (result.newSize < this.#bytesRead) {
			this.#bytesRead = 0;
			this.#entries = [];
			this.#model = undefined;
			return this.#readIncremental();
		}
		if (result.text.length > 0) {
			const lastNewline = result.text.lastIndexOf("\n");
			if (lastNewline >= 0) {
				const completeChunk = result.text.slice(0, lastNewline + 1);
				const parsed = parseSessionEntries(completeChunk);
				for (const entry of parsed) {
					if (entry.type === "message") {
						this.#entries.push(entry);
						const msg = entry.message;
						if (!this.#model && msg.role === "assistant") {
							this.#model = msg.model;
						}
					} else if (entry.type === "model_change") {
						this.#model = entry.model;
					}
				}
				this.#bytesRead += Buffer.byteLength(completeChunk, "utf-8");
			}
		}
	}

	backlog(): AgentEvent[] {
		this.#readIncremental();

		// Build a tool call ID -> tool result map
		const toolResults = new Map<string, ToolResultMessage>();
		for (const entry of this.#entries) {
			if (entry.message.role === "toolResult") {
				toolResults.set(entry.message.toolCallId, entry.message);
			}
		}

		const events: AgentEvent[] = [];
		for (const entry of this.#entries) {
			const msg = entry.message;
			if (msg.role === "assistant") {
				events.push({ type: "message_start", message: msg } as AgentEvent);
				events.push({ type: "message_update", message: msg } as AgentEvent);
				events.push({ type: "message_end", message: msg } as AgentEvent);

				for (const block of msg.content) {
					if (block.type === "toolCall") {
						const tr = toolResults.get(block.id);
						events.push({
							type: "tool_execution_end",
							toolCallId: block.id,
							toolName: block.name,
							isError: tr ? (tr.isError ?? false) : false,
							result: {
								content: tr
									? tr.content.map(item => {
											if (item.type === "text") {
												return { type: "text", text: item.text };
											} else if (item.type === "image") {
												return { type: "image", data: item.data, mimeType: item.mimeType };
											}
											return item;
										})
									: [],
								details: tr?.details,
							},
						} as AgentEvent);
					}
				}
			}
		}

		return events;
	}

	subscribe(_cb: (e: AgentEvent) => void): () => void {
		// Replay source is completed or static file, so live tail is a no-op
		return () => {};
	}

	meta(): TranscriptSourceMeta {
		return {
			status: this.#meta?.status ?? this.#status,
			model: this.#model ?? this.#meta?.model,
			tokens: this.#meta?.tokens,
			cost: this.#meta?.cost,
			durationMs: this.#meta?.durationMs,
		};
	}

	dispose(): void {}
}

export class LiveSource implements TranscriptSource {
	#eventBus: EventBus;
	#agentId: string;
	#meta?: Partial<TranscriptSourceMeta>;

	constructor(eventBus: EventBus, agentId: string, meta?: Partial<TranscriptSourceMeta>) {
		this.#eventBus = eventBus;
		this.#agentId = agentId;
		this.#meta = meta;
	}

	backlog(): AgentEvent[] {
		return [];
	}

	subscribe(cb: (e: AgentEvent) => void): () => void {
		return this.#eventBus.on(TASK_SUBAGENT_EVENT_CHANNEL, data => {
			const p = data as SubagentEventPayload;
			if (p.id === this.#agentId) {
				cb(p.event);
			}
		});
	}

	meta(): TranscriptSourceMeta {
		return {
			status: this.#meta?.status ?? "active",
			model: this.#meta?.model,
			tokens: this.#meta?.tokens,
			cost: this.#meta?.cost,
			durationMs: this.#meta?.durationMs,
		};
	}

	dispose(): void {}
}

export class HybridSource implements TranscriptSource {
	#meta?: Partial<TranscriptSourceMeta>;
	#replaySource: ReplaySource;
	#liveSource: LiveSource;
	#seenAssistantIds = new Set<string>();

	constructor(sessionFile: string, eventBus: EventBus, agentId: string, meta?: Partial<TranscriptSourceMeta>) {
		this.#meta = meta;
		this.#replaySource = new ReplaySource(sessionFile, meta);
		this.#liveSource = new LiveSource(eventBus, agentId, meta);
	}

	backlog(): AgentEvent[] {
		const events = this.#replaySource.backlog();
		// Record ids of assistant messages already seeded so the live stream can drop a
		// concrete duplicate (the narrow window where a message both flushed to disk and
		// re-emitted live). Messages without a stable id are not deduped: the live stream
		// only carries future events, so a completed backlog message is never re-sent.
		for (const e of events) {
			if (e.type === "message_start" && e.message.role === "assistant") {
				const id = (e.message as { id?: string }).id;
				if (id) this.#seenAssistantIds.add(id);
			}
		}
		return events;
	}

	subscribe(cb: (e: AgentEvent) => void): () => void {
		return this.#liveSource.subscribe(e => {
			// Drop a live assistant event only when it is a concrete id-duplicate of a
			// message already seeded from the backlog. Never drop based on position: an
			// in-flight message (whose message_start we attached after) is not yet on
			// disk, so its updates/end MUST reach the renderer.
			if (
				(e.type === "message_start" || e.type === "message_update" || e.type === "message_end") &&
				e.message?.role === "assistant"
			) {
				const id = (e.message as { id?: string }).id;
				if (id && this.#seenAssistantIds.has(id)) return;
			}
			cb(e);
		});
	}

	meta(): TranscriptSourceMeta {
		const replayMeta = this.#replaySource.meta();
		return {
			status: this.#meta?.status ?? replayMeta.status,
			model: replayMeta.model ?? this.#meta?.model,
			tokens: this.#meta?.tokens ?? replayMeta.tokens,
			cost: this.#meta?.cost ?? replayMeta.cost,
			durationMs: this.#meta?.durationMs ?? replayMeta.durationMs,
		};
	}

	dispose(): void {
		this.#replaySource.dispose();
		this.#liveSource.dispose();
	}
}
