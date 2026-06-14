// ============================================================================
// Raw YAML shape (snake_case, optional fields)
// ============================================================================

interface RawSwarmAgentConfig {
	role: string;
	task: string;
	extra_context?: string;
	reports_to?: string[];
	waits_for?: string[];
	model?: string;
}

interface RawSwarmConfig {
	name: string;
	workspace: string;
	mode?: string;
	target_count?: number;
	model?: string;
	agents: Record<string, RawSwarmAgentConfig>;
}

// ============================================================================
// Normalized types (camelCase, defaults applied)
// ============================================================================

export type SwarmMode = "pipeline" | "parallel" | "sequential" | "vote";

export interface SwarmAgent {
	name: string;
	role: string;
	task: string;
	extraContext?: string;
	reportsTo: string[];
	waitsFor: string[];
	model?: string;
}

export interface SwarmDefinition {
	name: string;
	workspace: string;
	mode: SwarmMode;
	targetCount: number;
	model?: string;
	agents: Map<string, SwarmAgent>;
	/** Preserves YAML declaration order for implicit pipeline sequencing. */
	agentOrder: string[];
}

// ============================================================================
// Parsing
// ============================================================================

const VALID_MODES = new Set<string>(["pipeline", "parallel", "sequential", "vote"]);
const VALID_SWARM_NAME = /^[a-zA-Z0-9._-]+$/;

export function parseSwarmYaml(content: string): SwarmDefinition {
	const raw = Bun.YAML.parse(content) as { swarm?: RawSwarmConfig } | null;
	if (!raw?.swarm) {
		throw new Error("YAML must have a top-level 'swarm' key");
	}
	const swarm = raw.swarm;

	if (!swarm.name || typeof swarm.name !== "string") {
		throw new Error("swarm.name is required and must be a string");
	}
	if (!VALID_SWARM_NAME.test(swarm.name)) {
		throw new Error("swarm.name may only contain letters, numbers, dot, underscore, and dash");
	}
	if (!swarm.workspace || typeof swarm.workspace !== "string") {
		throw new Error("swarm.workspace is required and must be a string");
	}
	if (!swarm.agents || typeof swarm.agents !== "object" || Object.keys(swarm.agents).length === 0) {
		throw new Error("swarm.agents must contain at least one agent");
	}

	const mode = swarm.mode ?? "sequential";
	if (!VALID_MODES.has(mode)) {
		throw new Error(`Invalid mode '${mode}'. Must be one of: ${[...VALID_MODES].join(", ")}`);
	}

	const agentOrder: string[] = [];
	const agents = new Map<string, SwarmAgent>();

	for (const [name, config] of Object.entries(swarm.agents)) {
		if (!config.role || typeof config.role !== "string") {
			throw new Error(`Agent '${name}': 'role' is required`);
		}
		if (!config.task || typeof config.task !== "string") {
			throw new Error(`Agent '${name}': 'task' is required`);
		}

		agentOrder.push(name);
		agents.set(name, {
			name,
			role: config.role,
			task: config.task.trim(),
			extraContext: config.extra_context?.trim(),
			reportsTo: Array.isArray(config.reports_to) ? config.reports_to : [],
			model: typeof config.model === "string" ? config.model.trim() : undefined,
			waitsFor: Array.isArray(config.waits_for) ? config.waits_for : [],
		});
	}

	return {
		name: swarm.name,
		workspace: swarm.workspace,
		mode: mode as SwarmMode,
		targetCount: swarm.target_count ?? 1,
		model: typeof swarm.model === "string" ? swarm.model.trim() : undefined,
		agents,
		agentOrder,
	};
}

// ============================================================================
// Validation (semantic — references, constraints)
// ============================================================================

export function validateSwarmDefinition(def: SwarmDefinition): string[] {
	const errors: string[] = [];
	const agentNames = new Set(def.agents.keys());

	if (def.model !== undefined && def.model.length === 0) {
		errors.push("swarm.model must not be empty when provided");
	}
	for (const [name, agent] of def.agents) {
		for (const dep of agent.waitsFor) {
			if (!agentNames.has(dep)) {
				errors.push(`Agent '${name}' waits_for unknown agent '${dep}'`);
			}
			if (dep === name) {
				errors.push(`Agent '${name}' cannot wait for itself`);
			}
		}
		for (const target of agent.reportsTo) {
			if (!agentNames.has(target)) {
				errors.push(`Agent '${name}' reports_to unknown agent '${target}'`);
			}
			if (target === name) {
				errors.push(`Agent '${name}' cannot report to itself`);
			}
		}
		if (agent.model !== undefined && agent.model.length === 0) {
			errors.push(`Agent '${name}' model must not be empty when provided`);
		}
	}

	if (def.targetCount < 1) {
		errors.push("target_count must be at least 1");
	}
	if (def.mode !== "pipeline" && def.targetCount !== 1) {
		errors.push("target_count is only supported in pipeline mode");
	}

	if (def.mode === "vote") {
		errors.push(...validateVoteMode(def, agentNames));
	}

	return errors;
}

/**
 * Vote mode requires a strict fan-in shape so the judge/aggregator is unambiguous:
 *   - exactly one aggregator (the single agent with a non-empty waits_for),
 *   - at least two voters (the remaining agents, which must have no waits_for),
 *   - the aggregator must wait_for every voter (final wave reduces all of them),
 *   - voters carry no reports_to (any reports_to among voters would inject an extra
 *     dependency edge in buildDependencyGraph and serialize the voters into separate
 *     waves, silently breaking the "voters fan out in parallel, wave 0" contract),
 *   - the aggregator carries no reports_to (reports_to makes its target depend on the
 *     aggregator; pointing it at a voter the aggregator already waits_for would form a
 *     voter<->judge cycle that vote validation must reject up front, not lean on the
 *     downstream detectCycles pass that direct PipelineController callers may skip).
 *
 * The topology itself carries the role (KTD-5: no new DAG primitive, no new schema
 * field) — this validation is the contract that makes the shape unambiguous, so the
 * pipeline reducer can identify the aggregator structurally without heuristics. The
 * reports_to checks keep this validated partition congruent with the dependency graph
 * buildDependencyGraph actually constructs (which consumes both waits_for AND reports_to).
 */
function validateVoteMode(def: SwarmDefinition, agentNames: Set<string>): string[] {
	const errors: string[] = [];

	const aggregators: string[] = [];
	const voters: string[] = [];
	for (const [name, agent] of def.agents) {
		if (agent.waitsFor.length > 0) {
			aggregators.push(name);
		} else {
			voters.push(name);
		}
	}

	if (aggregators.length === 0) {
		errors.push("vote mode requires a judge/aggregator agent (one agent that waits_for the voters)");
		return errors;
	}
	if (aggregators.length > 1) {
		errors.push(
			`vote mode requires exactly one judge/aggregator agent, found ${aggregators.length}: [${aggregators.join(", ")}]`,
		);
		return errors;
	}

	const aggregatorName = aggregators[0];
	if (voters.length < 2) {
		errors.push(`vote mode requires at least 2 voter agents, found ${voters.length}`);
	}

	const aggregatorDeps = new Set(def.agents.get(aggregatorName)!.waitsFor.filter(d => agentNames.has(d)));
	for (const voter of voters) {
		if (!aggregatorDeps.has(voter)) {
			errors.push(`vote mode judge '${aggregatorName}' must wait_for every voter; missing voter '${voter}'`);
		}
		// Voters must fan out in parallel: reports_to adds an extra dependency edge in
		// the graph that would serialize them out of wave 0, so the partition validation
		// enforces here would no longer match the waves that get built.
		if (def.agents.get(voter)!.reportsTo.length > 0) {
			errors.push(
				`vote mode voter '${voter}' must not declare reports_to; voters fan out in parallel with no implicit chain`,
			);
		}
	}

	// The aggregator's only edges come from waits_for. A reports_to on the judge would
	// make its target depend on the judge while the judge waits_for that voter — a cycle.
	if (def.agents.get(aggregatorName)!.reportsTo.length > 0) {
		errors.push(
			`vote mode judge '${aggregatorName}' must not declare reports_to; the judge depends on voters via waits_for only`,
		);
	}

	return errors;
}
