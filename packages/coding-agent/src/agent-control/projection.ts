import type { AgentLifecycleManager } from "../registry/agent-lifecycle";
import type { AgentRegistry, RegistryEvent } from "../registry/agent-registry";
import { readCompleteEntryPage } from "../session/complete-entry-page";
import type { FileEntry } from "../session/session-manager";
import {
	type SubagentEventPayload,
	type SubagentLifecyclePayload,
	type SubagentProgressPayload,
	TASK_SUBAGENT_EVENT_CHANNEL,
	TASK_SUBAGENT_LIFECYCLE_CHANNEL,
	TASK_SUBAGENT_PROGRESS_CHANNEL,
} from "../task";
import type { EventBus } from "../utils/event-bus";
import { type ChildControlTarget, DirectChildControl, type DirectChildControlAdmission } from "./control";
import {
	AGENT_CONTROL_PROTOCOL_VERSION,
	type ChildInvalidationDTO,
	type ChildSnapshotDTO,
	type TranscriptEntryDTO,
	type TranscriptPageDTO,
} from "./protocol";

interface ProjectedChild {
	target: ChildControlTarget;
	label: string;
	lastOutcome?: "completed" | "failed" | "aborted";
	updatedAt: number;
}

function safeLabel(value: string): string {
	return value.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 256);
}

function textContent(value: unknown): string {
	if (typeof value === "string") return value;
	if (!Array.isArray(value)) return "";
	const parts: string[] = [];
	for (const item of value) {
		if (!item || typeof item !== "object") continue;
		const record = item as Record<string, unknown>;
		if (record.type === "text" && typeof record.text === "string") parts.push(record.text);
	}
	return parts.join("\n");
}

function projectEntry(entry: FileEntry): TranscriptEntryDTO | undefined {
	if (!("id" in entry)) return undefined;
	if (entry.type === "message") {
		const message = entry.message as unknown as Record<string, unknown>;
		const role = message.role;
		if (role !== "user" && role !== "assistant" && role !== "toolResult") return undefined;
		return {
			id: entry.id,
			type: "message",
			role,
			text: textContent(message.content),
			toolName: typeof message.toolName === "string" ? message.toolName : undefined,
			isError: typeof message.isError === "boolean" ? message.isError : undefined,
		};
	}
	if (entry.type === "custom_message") {
		if (!entry.display) return undefined;
		return { id: entry.id, type: "custom_message", role: "custom", text: textContent(entry.content) };
	}
	if (entry.type === "branch_summary") {
		return { id: entry.id, type: "branch_summary", text: entry.summary };
	}
	if (entry.type === "compaction") {
		return { id: entry.id, type: "compaction_summary", text: entry.summary };
	}
	return undefined;
}

export type ProjectionListener = (invalidation: ChildInvalidationDTO) => void;

/** Current-generation, direct-child-only projection over task events and registry state. */
export class DirectChildProjection {
	readonly control: DirectChildControl;
	readonly #registry: AgentRegistry;
	readonly #lifecycle: AgentLifecycleManager;
	readonly #children = new Map<string, ProjectedChild>();
	readonly #listeners = new Set<ProjectionListener>();
	#unsubscribers: Array<() => void> = [];
	#closed = false;

	constructor(generation: string, eventBus: EventBus, registry: AgentRegistry, lifecycle: AgentLifecycleManager) {
		this.control = new DirectChildControl(generation, registry, lifecycle);
		this.#registry = registry;
		this.#lifecycle = lifecycle;
		this.#unsubscribers.push(
			eventBus.on(TASK_SUBAGENT_LIFECYCLE_CHANNEL, data => this.#handleLifecycle(data as SubagentLifecyclePayload)),
			eventBus.on(TASK_SUBAGENT_PROGRESS_CHANNEL, data => this.#handleProgress(data as SubagentProgressPayload)),
			eventBus.on(TASK_SUBAGENT_EVENT_CHANNEL, data => this.#handleEvent(data as SubagentEventPayload)),
			registry.onChange(event => this.#handleRegistry(event)),
		);
	}

	get generation(): string {
		return this.control.controlGeneration;
	}

	capture(): DirectChildControlAdmission | undefined {
		return this.#closed ? undefined : this.control;
	}

	list(): ChildSnapshotDTO[] {
		return [...this.#children.values()]
			.map(child => this.#snapshot(child))
			.sort((a, b) => a.updatedAt - b.updatedAt || a.id.localeCompare(b.id));
	}

	snapshot(childId: string): ChildSnapshotDTO | undefined {
		const child = this.#children.get(childId);
		return child ? this.#snapshot(child) : undefined;
	}

	hasChild(childId: string): boolean {
		return this.#children.has(childId);
	}

	onInvalidation(listener: ProjectionListener): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	async transcript(childId: string, fromByte = 0): Promise<TranscriptPageDTO | undefined> {
		const child = this.#children.get(childId);
		if (!child || this.#closed) return undefined;
		const page = await readCompleteEntryPage(child.target.sessionFile, {
			fromByte,
			maxBytes: 256 * 1024,
			maxEntries: 256,
		});
		return {
			version: AGENT_CONTROL_PROTOCOL_VERSION,
			generation: this.generation,
			childId,
			fromByte: page.fromByte,
			nextByte: page.nextByte,
			reset: page.reset,
			entries: page.entries.map(projectEntry).filter((entry): entry is TranscriptEntryDTO => entry !== undefined),
		};
	}

	async send(childId: string, prompt: string) {
		const child = this.#children.get(childId);
		if (!child || this.#closed) {
			return { ok: false as const, code: "unknown_target" as const, message: `Unknown child "${childId}".` };
		}
		return this.control.send(child.target, prompt);
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		for (const child of this.#children.values()) this.#emit(child.target.id, "generation_closed");
		this.control.close();
		for (const unsubscribe of this.#unsubscribers) unsubscribe();
		this.#unsubscribers = [];
		this.#children.clear();
		this.#listeners.clear();
	}

	#snapshot(child: ProjectedChild): ChildSnapshotDTO {
		const ref = this.#registry.get(child.target.id);
		const matches = ref?.kind === "sub" && ref.sessionFile === child.target.sessionFile;
		const availability = matches ? ref.status : child.lastOutcome === "aborted" ? "aborted" : "unavailable";
		const capability =
			availability === "aborted" ||
			availability === "unavailable" ||
			(availability === "parked" && !this.#lifecycle.canRevive(child.target.id))
				? "transcript_only"
				: "send";
		return {
			version: AGENT_CONTROL_PROTOCOL_VERSION,
			generation: this.generation,
			id: child.target.id,
			label: child.label,
			availability,
			capability,
			lastOutcome: child.lastOutcome,
			updatedAt: child.updatedAt,
		};
	}

	#handleLifecycle(payload: SubagentLifecyclePayload): void {
		if (this.#closed || payload.controlGeneration !== this.generation || !payload.sessionFile) return;
		let child = this.#children.get(payload.id);
		if (payload.status === "started") {
			if (
				!this.control.admit({
					controlGeneration: this.generation,
					id: payload.id,
					sessionFile: payload.sessionFile,
				})
			)
				return;
			child = {
				target: { controlGeneration: this.generation, id: payload.id, sessionFile: payload.sessionFile },
				label: safeLabel(payload.description ?? payload.agent),
				updatedAt: Date.now(),
			};
			this.#children.set(payload.id, child);
		} else if (!child || child.target.sessionFile !== payload.sessionFile) {
			return;
		} else {
			child.lastOutcome = payload.status;
			child.updatedAt = Date.now();
			if (payload.status === "aborted") this.control.markTerminal(child.target);
		}
		this.#emit(payload.id, "state");
	}

	#handleProgress(payload: SubagentProgressPayload): void {
		if (this.#closed || payload.controlGeneration !== this.generation || !payload.sessionFile) return;
		const child = this.#children.get(payload.progress.id);
		if (!child || child.target.sessionFile !== payload.sessionFile) return;
		child.updatedAt = Date.now();
		this.#emit(child.target.id, "state");
	}

	#handleEvent(payload: SubagentEventPayload): void {
		if (this.#closed || payload.controlGeneration !== this.generation || !payload.sessionFile) return;
		const child = this.#children.get(payload.id);
		if (!child || child.target.sessionFile !== payload.sessionFile) return;
		this.#emit(payload.id, "transcript");
	}

	#handleRegistry(event: RegistryEvent): void {
		const child = this.#children.get(event.ref.id);
		if (!child || event.ref.sessionFile !== child.target.sessionFile) return;
		child.updatedAt = Date.now();
		this.#emit(child.target.id, "state");
	}

	#emit(childId: string, kind: ChildInvalidationDTO["kind"]): void {
		const invalidation: ChildInvalidationDTO = {
			version: AGENT_CONTROL_PROTOCOL_VERSION,
			generation: this.generation,
			childId,
			kind,
		};
		for (const listener of this.#listeners) {
			try {
				listener(invalidation);
			} catch {}
		}
	}
}
