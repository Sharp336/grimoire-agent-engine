import type { ExecutorOptions } from "./executor";
import type { AgentDefinition, SingleResult } from "./types";

const EXECUTOR_ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;

/** Execute one normalized subagent request. */
export type SubagentExecute = (options: ExecutorOptions) => Promise<SingleResult>;

/**
 * Extension-supplied subagent backend.
 *
 * OMP retains role discovery, policy, isolation, rendering, and result validation.
 * The selected backend owns only the child execution described by ExecutorOptions.
 */
export interface SubagentExecutor {
	/** Stable backend identifier used in diagnostics. */
	readonly id: string;
	/** Return true only for agent definitions this backend owns. */
	claim(agent: Readonly<AgentDefinition>): boolean;
	/** Execute the normalized request and return OMP's canonical result shape. */
	execute: SubagentExecute;
}

/** Session-scoped executor selection. Absence of a claim means OMP's native executor. */
export class SubagentExecutorRegistry {
	readonly #executors: readonly SubagentExecutor[];

	constructor(executors: readonly SubagentExecutor[] = []) {
		const ids = new Set<string>();
		for (const executor of executors) {
			if (!EXECUTOR_ID_PATTERN.test(executor.id)) {
				throw new Error(
					`Invalid subagent executor id ${JSON.stringify(executor.id)}; expected ${EXECUTOR_ID_PATTERN.source}`,
				);
			}
			if (ids.has(executor.id)) {
				throw new Error(`Duplicate subagent executor id ${JSON.stringify(executor.id)}`);
			}
			ids.add(executor.id);
		}
		this.#executors = executors;
	}

	/** Resolve exactly one external backend, or undefined for OMP-native execution. */
	resolve(agent: Readonly<AgentDefinition>): SubagentExecutor | undefined {
		let selected: SubagentExecutor | undefined;
		for (const executor of this.#executors) {
			if (!executor.claim(agent)) continue;
			if (selected) {
				throw new Error(
					`Agent ${JSON.stringify(agent.name)} is claimed by multiple subagent executors: ${JSON.stringify(selected.id)}, ${JSON.stringify(executor.id)}`,
				);
			}
			selected = executor;
		}
		return selected;
	}
}
