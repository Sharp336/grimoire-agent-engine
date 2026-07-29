import type { AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import { $env } from "@oh-my-pi/pi-utils";
import type { ToolSession } from "../tools";
import { isIrcEnabled } from "../tools/hub";
import { spawnParamsFor, validateSpawnParams } from "./dispatch-contract";
import { resolveSpawnPolicy } from "./spawn-policy";
import {
	type EffectiveSubagentPolicy,
	resolveEffectiveSubagentPolicy,
	StructuredSubagentError,
} from "./structured-subagent";
import type { TaskItem, TaskParams, TaskToolDetails } from "./types";

export interface SettledTaskSpawn {
	context: string;
	item: TaskItem;
}

export interface TaskDispatchFailure {
	index: number;
	error: string;
}

export type TaskDispatchPreflight =
	| {
			ok: true;
			defaultAgent: string;
			normalizedSpawnParams: TaskParams[];
			resolvedAgents: string[];
			policies: EffectiveSubagentPolicy[];
	  }
	| {
			ok: false;
			defaultAgent: string;
			normalizedSpawnParams: TaskParams[];
			resolvedAgents: string[];
			failures: TaskDispatchFailure[];
	  };

export type SettledTaskRunner = (
	toolCallId: string,
	params: TaskParams,
	item: TaskItem,
	defaultAgent: string,
	signal?: AbortSignal,
	onUpdate?: AgentToolUpdateCallback<TaskToolDetails>,
) => Promise<AgentToolResult<TaskToolDetails>>;

function createTaskDispatchError(text: string): AgentToolResult<TaskToolDetails> {
	return {
		content: [{ type: "text", text }],
		details: { projectAgentsDir: null, results: [], totalDurationMs: 0 },
	};
}

export class TaskDispatchService {
	readonly #session: ToolSession;
	readonly #runSettled: SettledTaskRunner;
	readonly #blockedAgent: string | undefined;

	constructor(session: ToolSession, runSettled: SettledTaskRunner) {
		this.#session = session;
		this.#runSettled = runSettled;
		this.#blockedAgent = $env.PI_BLOCKED_AGENT;
	}

	async preflight(params: TaskParams, spawnItems: TaskItem[]): Promise<TaskDispatchPreflight> {
		const defaultAgent = resolveSpawnPolicy(this.#session.getSessionSpawns()).defaultAgent;
		const normalizedSpawnParams = spawnItems.map(item => spawnParamsFor(params, item, defaultAgent));
		const resolvedAgents = normalizedSpawnParams.map(spawn => spawn.agent ?? defaultAgent);
		const resolved = await Promise.all(
			normalizedSpawnParams.map(async spawn => {
				try {
					return { policy: await this.#resolveSpawnPreflight(spawn) };
				} catch (error) {
					return { error: error instanceof StructuredSubagentError ? error.message : String(error) };
				}
			}),
		);
		const failures = resolved
			.map((item, index) => ("error" in item ? { index, error: item.error } : undefined))
			.filter((failure): failure is TaskDispatchFailure => failure !== undefined);
		if (failures.length > 0) {
			return { ok: false, defaultAgent, normalizedSpawnParams, resolvedAgents, failures };
		}
		return {
			ok: true,
			defaultAgent,
			normalizedSpawnParams,
			resolvedAgents,
			policies: resolved.map(item => item.policy!),
		};
	}

	async assertSettledSpawns(spawns: readonly SettledTaskSpawn[]): Promise<void> {
		const failures = (
			await Promise.all(
				spawns.map(async (spawn, index) => {
					const params: TaskParams = { context: spawn.context, tasks: [spawn.item] };
					const validationError = validateSpawnParams(params, true);
					if (validationError) return { index, error: validationError };
					const preflight = await this.preflight(params, [spawn.item]);
					return preflight.ok ? undefined : { index, error: preflight.failures[0]!.error };
				}),
			)
		).filter((failure): failure is TaskDispatchFailure => failure !== undefined);
		if (failures.length === 0) return;
		throw new Error(
			failures
				.map(({ index, error }) => {
					const item = spawns[index]!.item;
					return `Task ${item.name?.trim() || `#${index + 1}`} failed preflight: ${error}`;
				})
				.join("\n"),
		);
	}

	async executeSettledSpawn(
		toolCallId: string,
		spawn: SettledTaskSpawn,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<TaskToolDetails>,
	): Promise<AgentToolResult<TaskToolDetails>> {
		const params: TaskParams = { context: spawn.context, tasks: [spawn.item] };
		const validationError = validateSpawnParams(params, true);
		if (validationError) return createTaskDispatchError(validationError);
		const preflight = await this.preflight(params, [spawn.item]);
		if (!preflight.ok) {
			return createTaskDispatchError(`Task execution failed: ${preflight.failures[0]!.error}`);
		}
		return this.#runSettled(toolCallId, params, spawn.item, preflight.defaultAgent, signal, onUpdate);
	}

	#resolveSpawnPreflight(params: TaskParams): Promise<EffectiveSubagentPolicy> {
		return resolveEffectiveSubagentPolicy({
			session: this.#session,
			invocationKind: "task",
			assignment: (params.task ?? "").trim(),
			context: params.context?.trim() || undefined,
			agent: params.agent,
			...(Object.hasOwn(params, "outputSchema") ? { outputSchema: params.outputSchema } : {}),
			...(Object.hasOwn(params, "schemaMode") ? { schemaMode: params.schemaMode } : {}),
			...(params.effort !== undefined ? { effort: params.effort } : {}),
			...("isolated" in params ? { isolation: { requested: params.isolated } } : {}),
			blockedAgent: this.#blockedAgent,
			enableLsp: (this.#session.enableLsp ?? true) && this.#session.settings.get("task.enableLsp"),
			enableIrc: isIrcEnabled(this.#session.settings, this.#session.taskDepth ?? 0),
			maxRuntimeMs: this.#session.settings.get("task.maxRuntimeMs"),
		});
	}
}
