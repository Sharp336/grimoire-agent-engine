/**
 * Pipeline controller for swarm execution.
 *
 * Orchestrates execution waves within each iteration:
 * - Agents in the same wave execute in parallel
 * - Waves execute sequentially (wave N+1 starts after wave N completes)
 * - For pipeline mode, iterations repeat the full DAG execution
 */
import type { AgentSource, ModelRegistry, Settings, SingleResult } from "@oh-my-pi/pi-coding-agent";
import { executeSwarmAgent } from "./executor";
import type { SwarmAgent, SwarmDefinition } from "./schema";
import type { StateTracker } from "./state";

// ============================================================================
// Types
// ============================================================================

export interface PipelineOptions {
	workspace: string;
	signal?: AbortSignal;
	onProgress?: (state: PipelineProgress) => void;
	modelRegistry?: ModelRegistry;
	settings?: Settings;
}

export interface PipelineProgress {
	iteration: number;
	targetCount: number;
	currentWave: number;
	totalWaves: number;
	agents: Record<string, { status: string; iteration: number }>;
}

export interface PipelineResult {
	status: "completed" | "failed" | "aborted";
	iterations: number;
	agentResults: Map<string, SingleResult[]>;
	errors: string[];
}

// ============================================================================
// Controller
// ============================================================================

export class PipelineController {
	#def: SwarmDefinition;
	#waves: string[][];
	#stateTracker: StateTracker;

	constructor(def: SwarmDefinition, waves: string[][], stateTracker: StateTracker) {
		this.#def = def;
		this.#waves = waves;
		this.#stateTracker = stateTracker;
	}

	async run(options: PipelineOptions): Promise<PipelineResult> {
		const { workspace, signal, onProgress, modelRegistry, settings } = options;
		const allResults = new Map<string, SingleResult[]>();
		const errors: string[] = [];

		for (const name of this.#def.agents.keys()) {
			allResults.set(name, []);
		}

		const targetCount = this.#def.targetCount;

		await this.#stateTracker.appendOrchestratorLog(
			`Pipeline '${this.#def.name}' starting: mode=${this.#def.mode} iterations=${targetCount} waves=${this.#waves.length} agents=${this.#def.agents.size}`,
		);

		try {
			for (let iteration = 0; iteration < targetCount; iteration++) {
				if (signal?.aborted) {
					await this.#stateTracker.updatePipeline({ status: "aborted" });
					return { status: "aborted", iterations: iteration, agentResults: allResults, errors };
				}

				await this.#stateTracker.updatePipeline({ iteration });
				await this.#stateTracker.appendOrchestratorLog(`--- Iteration ${iteration + 1}/${targetCount} ---`);

				const emitProgress = (currentWave: number) => {
					onProgress?.({
						iteration,
						targetCount,
						currentWave,
						totalWaves: this.#waves.length,
						agents: this.#buildProgressSnapshot(),
					});
				};

				const iterationResults = await this.#runIteration(iteration, {
					workspace,
					signal,
					emitProgress,
					modelRegistry,
					settings,
				});

				for (const [agentName, result] of iterationResults) {
					allResults.get(agentName)!.push(result);
					if (result.exitCode !== 0) {
						errors.push(
							`${agentName} (iteration ${iteration + 1}): ${result.error || `exit code ${result.exitCode}`}`,
						);
					}
				}
			}

			const status = errors.length > 0 ? ("failed" as const) : ("completed" as const);
			await this.#stateTracker.updatePipeline({ status, completedAt: Date.now() });
			await this.#stateTracker.appendOrchestratorLog(`Pipeline ${status} (${errors.length} errors)`);
			return { status, iterations: targetCount, agentResults: allResults, errors };
		} catch (err) {
			const error = err instanceof Error ? err.message : String(err);
			await this.#stateTracker.updatePipeline({ status: "failed", completedAt: Date.now() });
			await this.#stateTracker.appendOrchestratorLog(`Pipeline fatal error: ${error}`);
			errors.push(error);
			return { status: "failed", iterations: 0, agentResults: allResults, errors };
		}
	}

	async #runIteration(
		iteration: number,
		options: {
			workspace: string;
			signal?: AbortSignal;
			emitProgress: (currentWave: number) => void;
			modelRegistry?: ModelRegistry;
			settings?: Settings;
		},
	): Promise<Map<string, SingleResult>> {
		const results = new Map<string, SingleResult>();
		let agentIndex = 0;

		// In vote and mixture modes the aggregator is the final-wave agent that
		// waits_for the fan-out members; it must REDUCE their outputs. Both share the
		// same DAG shape (KTD-5) and the same proposer->aggregator injection seam — they
		// differ only in the reduce instruction (vote JUDGES the consensus; mixture
		// SYNTHESIZES a unified answer). We identify the aggregator structurally (validated
		// shape) once per iteration so the wave loop can inject the member outputs.
		const reduceAggregator =
			this.#def.mode === "vote" || this.#def.mode === "mixture" ? this.#findReduceAggregator() : null;

		for (let waveIdx = 0; waveIdx < this.#waves.length; waveIdx++) {
			const wave = this.#waves[waveIdx];

			if (options.signal?.aborted) break;

			await this.#stateTracker.appendOrchestratorLog(
				`Wave ${waveIdx + 1}/${this.#waves.length}: [${wave.join(", ")}]`,
			);

			// Mark agents in this wave as waiting
			for (const agentName of wave) {
				await this.#stateTracker.updateAgent(agentName, {
					status: "waiting",
					iteration,
					wave: waveIdx,
				});
			}
			options.emitProgress(waveIdx);

			// Execute all agents in wave in parallel, catching per-agent errors
			const waveResults = await Promise.all(
				wave.map(async agentName => {
					const baseAgent = this.#def.agents.get(agentName)!;
					// Feedback seam: when this agent is the vote/mixture aggregator, inject every
					// fan-out member's output into its context and prompt it to reduce. Reuses
					// executeSwarmAgent unchanged by deriving an agent whose extraContext carries
					// the member outputs. The reduce instruction is mode-specific: vote JUDGES the
					// consensus, mixture SYNTHESIZES a unified answer (both NON-deterministic,
					// advisory — the aggregator decides).
					const agent = agentName === reduceAggregator ? this.#buildReduceAgent(baseAgent, results) : baseAgent;
					const currentIndex = agentIndex++;
					try {
						const result = await executeSwarmAgent(agent, currentIndex, {
							workspace: options.workspace,
							swarmName: this.#def.name,
							iteration,
							modelOverride: agent.model ?? this.#def.model,
							signal: options.signal,
							onProgress: (_name, _progress) => {
								options.emitProgress(waveIdx);
							},
							modelRegistry: options.modelRegistry,
							settings: options.settings,
							stateTracker: this.#stateTracker,
						});
						return { agentName, result };
					} catch (err) {
						const error = err instanceof Error ? err.message : String(err);
						const failResult: SingleResult = {
							index: currentIndex,
							id: `swarm-${this.#def.name}-${agentName}-${iteration}`,
							agent: agentName,
							agentSource: "project" as AgentSource,
							task: agent.task,
							exitCode: 1,
							output: "",
							stderr: error,
							truncated: false,
							durationMs: 0,
							tokens: 0,
							requests: 0,
							error,
						};
						return { agentName, result: failResult };
					}
				}),
			);

			for (const { agentName, result } of waveResults) {
				results.set(agentName, result);
			}

			options.emitProgress(waveIdx);
		}

		return results;
	}

	/**
	 * Identify the vote/mixture aggregator structurally: the single agent that
	 * waits_for the fan-out members. Both modes share this shape (KTD-5) and it is
	 * enforced by validateSwarmDefinition, so the lone agent with a non-empty
	 * waits_for is unambiguously the reducer. Returns null if the shape does not hold
	 * (zero or multiple candidates), matching dag.ts findVoteAggregator but without
	 * the vote-only mode gate so mixture can reuse it.
	 */
	#findReduceAggregator(): string | null {
		const aggregators: string[] = [];
		for (const [name, agent] of this.#def.agents) {
			if (agent.waitsFor.length > 0) aggregators.push(name);
		}
		return aggregators.length === 1 ? aggregators[0] : null;
	}

	/**
	 * Dispatch the reduce-agent derivation by mode: vote JUDGES the consensus,
	 * mixture SYNTHESIZES a unified answer. Both inject the member outputs into the
	 * aggregator's extraContext via the same seam; only the prompt instruction differs.
	 */
	#buildReduceAgent(agent: SwarmAgent, completed: Map<string, SingleResult>): SwarmAgent {
		return this.#def.mode === "mixture"
			? this.#buildSynthesizerAgent(agent, completed)
			: this.#buildJudgeAgent(agent, completed);
	}

	/**
	 * Derive the vote judge agent by appending the voter outputs to its extraContext
	 * plus an instruction to pick/synthesize the consensus answer. Returns the base
	 * agent unchanged if no voter output is available yet (defensive — under the
	 * validated vote shape voters always complete in an earlier wave).
	 *
	 * The judge is an LLM reduce: explicitly NON-deterministic and advisory. There is
	 * no deterministic exact-match-majority contract in this slice (no vote_key field).
	 */
	#buildJudgeAgent(agent: SwarmAgent, completed: Map<string, SingleResult>): SwarmAgent {
		const voters = agent.waitsFor.filter(name => this.#def.agents.has(name));
		const sections: string[] = [];
		let succeededVoters = 0;
		for (const voter of voters) {
			const result = completed.get(voter);
			if (!result) continue;
			const succeeded = result.exitCode === 0;
			if (succeeded) succeededVoters++;
			const body = succeeded ? result.output : `(voter failed: ${result.error ?? "unknown error"})`;
			sections.push(`### Voter: ${voter}\n${body}`);
		}

		if (sections.length === 0) return agent;

		// When every voter failed there is nothing to reach consensus over; prompting the
		// judge to "produce a consensus" over zero real answers would invent one. Downgrade
		// the instruction to report the failures instead. (The pipeline already marks the
		// overall run failed because each failed voter contributes a non-zero exit.)
		const instruction =
			succeededVoters === 0
				? "You are acting as the JUDGE in a majority-vote swarm, but EVERY voter failed to " +
					"produce an answer (see the failure markers below). Do NOT fabricate a consensus. " +
					"Report that all voters failed and summarize the failures."
				: "You are acting as the JUDGE in a majority-vote swarm. Below are the independent " +
					"answers from each voter to the same task. Compare them, identify the majority/consensus " +
					"position, and produce a single consolidated answer. If voters disagree, pick the most " +
					"strongly supported answer and briefly note the disagreement. Do not simply concatenate.";

		const judgeContext = [agent.extraContext, instruction, "## Voter outputs", sections.join("\n\n")]
			.filter((part): part is string => Boolean(part))
			.join("\n\n");

		return { ...agent, extraContext: judgeContext };
	}

	/**
	 * Derive the mixture-of-agents aggregator by appending every proposer's output to
	 * its extraContext plus an instruction to SYNTHESIZE a single best answer (the
	 * mixture reduce — distinct from vote's JUDGE/consensus reduce). Returns the base
	 * agent unchanged if no proposer output is available yet (defensive — under the
	 * validated mixture shape proposers always complete in an earlier wave).
	 *
	 * The synthesis is an LLM reduce: NON-deterministic and advisory. Unlike vote,
	 * which picks/consolidates the consensus, the aggregator here is told to combine
	 * the complementary strengths of the proposals into one improved answer (the
	 * mixture-of-agents pattern, arxiv 2406.04692).
	 */
	#buildSynthesizerAgent(agent: SwarmAgent, completed: Map<string, SingleResult>): SwarmAgent {
		const proposers = agent.waitsFor.filter(name => this.#def.agents.has(name));
		const sections: string[] = [];
		let succeededProposers = 0;
		for (const proposer of proposers) {
			const result = completed.get(proposer);
			if (!result) continue;
			const succeeded = result.exitCode === 0;
			if (succeeded) succeededProposers++;
			const body = succeeded ? result.output : `(proposer failed: ${result.error ?? "unknown error"})`;
			sections.push(`### Proposer: ${proposer}\n${body}`);
		}

		if (sections.length === 0) return agent;

		// When every proposer failed there is nothing to synthesize; prompting the
		// aggregator to "synthesize" over zero real answers would invent one. Downgrade
		// the instruction to report the failures instead. (The pipeline already marks the
		// overall run failed because each failed proposer contributes a non-zero exit.)
		const instruction =
			succeededProposers === 0
				? "You are acting as the AGGREGATOR in a mixture-of-agents swarm, but EVERY proposer " +
					"failed to produce an answer (see the failure markers below). Do NOT fabricate a " +
					"synthesis. Report that all proposers failed and summarize the failures."
				: "You are acting as the AGGREGATOR in a mixture-of-agents swarm. Below are the " +
					"independent proposed answers from each proposer to the same task. Do NOT simply " +
					"pick one and do NOT concatenate them. SYNTHESIZE a single, improved answer that " +
					"combines the complementary strengths of the proposals, corrects their individual " +
					"errors, and resolves any contradictions into one coherent response.";

		const synthContext = [agent.extraContext, instruction, "## Proposer outputs", sections.join("\n\n")]
			.filter((part): part is string => Boolean(part))
			.join("\n\n");

		return { ...agent, extraContext: synthContext };
	}

	#buildProgressSnapshot(): Record<string, { status: string; iteration: number }> {
		const snapshot: Record<string, { status: string; iteration: number }> = {};
		for (const [name, agent] of Object.entries(this.#stateTracker.state.agents)) {
			snapshot[name] = { status: agent.status, iteration: agent.iteration };
		}
		return snapshot;
	}
}
