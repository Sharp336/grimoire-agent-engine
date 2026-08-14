import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { AgentSource, SubagentLifecyclePayload, SubagentRunKind } from "./types";

export const TASK_SUBAGENT_LIFECYCLE_CUSTOM_TYPE = "task_subagent_lifecycle";

export interface CreateSubagentLifecycleEmitterOptions {
	emitEvent?: (payload: SubagentLifecyclePayload) => void;
	appendEntry?: (customType: string, data: SubagentLifecyclePayload) => void;
}

/** Fan one versioned payload into the live event channel and durable session JSONL. */
export function createSubagentLifecycleEmitter(
	options: CreateSubagentLifecycleEmitterOptions,
): (payload: SubagentLifecyclePayload) => void {
	return payload => {
		options.emitEvent?.(payload);
		options.appendEntry?.(TASK_SUBAGENT_LIFECYCLE_CUSTOM_TYPE, payload);
	};
}

export interface ParentSubagentLifecycleHost {
	getSessionManager(): { appendCustomEntry(customType: string, data?: unknown): unknown } | undefined;
	isDisposed?(): boolean;
}

/**
 * Persist lifecycle boundaries into the live parent journal only. Resolving the
 * manager per payload follows parent session switches and avoids retaining a
 * disposed manager for later IRC wake turns.
 */
export function createParentSubagentLifecycleRecorder(
	host: ParentSubagentLifecycleHost,
): ((payload: SubagentLifecyclePayload) => void) | undefined {
	if (!host.getSessionManager()) return undefined;
	return payload => {
		if (host.isDisposed?.()) return;
		host.getSessionManager()?.appendCustomEntry(TASK_SUBAGENT_LIFECYCLE_CUSTOM_TYPE, payload);
	};
}

export interface CreateSubagentLifecycleRunOptions {
	id: string;
	agent: string;
	agentSource: AgentSource;
	index: number;
	runKind: SubagentRunKind;
	description?: string;
	sessionFile?: string;
	parentToolCallId?: string;
	detached?: boolean;
	startedAt?: number;
	startedMonotonicAt?: number;
	emit: (payload: SubagentLifecyclePayload) => void;
}

export interface SubagentLifecycleRun {
	readonly started: SubagentLifecyclePayload;
	complete(
		status: Exclude<SubagentLifecyclePayload["status"], "started">,
		completedAt?: number,
		completedMonotonicAt?: number,
	): SubagentLifecyclePayload;
}

/**
 * Emit exactly one start and terminal boundary for a logical subagent run.
 * Epochs make the boundary reconstructible from JSONL; duration uses a
 * monotonic clock so wall-clock adjustments cannot create negative work.
 */
export function createSubagentLifecycleRun(options: CreateSubagentLifecycleRunOptions): SubagentLifecycleRun {
	const startedAt = options.startedAt ?? Date.now();
	const startedMonotonicAt = options.startedMonotonicAt ?? performance.now();
	const common = {
		version: 1 as const,
		runId: randomUUID(),
		runKind: options.runKind,
		id: options.id,
		agent: options.agent,
		agentSource: options.agentSource,
		description: options.description,
		sessionFile: options.sessionFile,
		parentToolCallId: options.parentToolCallId,
		index: options.index,
		detached: options.detached,
		startedAt,
	};
	const started: SubagentLifecyclePayload = { ...common, status: "started" };
	options.emit(started);
	let terminal = false;
	return {
		started,
		complete(status, completedAt = Date.now(), completedMonotonicAt = performance.now()) {
			if (terminal) throw new Error(`Subagent lifecycle run ${common.runId} already completed`);
			terminal = true;
			const payload: SubagentLifecyclePayload = {
				...common,
				status,
				completedAt,
				durationMs: Math.max(0, completedMonotonicAt - startedMonotonicAt),
			};
			options.emit(payload);
			return payload;
		},
	};
}
