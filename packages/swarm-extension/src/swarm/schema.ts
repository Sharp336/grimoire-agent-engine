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

export type SwarmMode = "pipeline" | "parallel" | "sequential" | "vote" | "mixture";

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

const VALID_MODES = new Set<string>(["pipeline", "parallel", "sequential", "vote", "mixture"]);
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

	if (def.mode === "mixture") {
		errors.push(...validateMixtureMode(def, agentNames));
	}

	return errors;
}

/**
 * Non-fatal advisory warnings for a swarm definition. Kept separate from
 * validateSwarmDefinition (whose every entry aborts the run) so a quality
 * caveat never blocks an otherwise-valid topology. Callers surface these at
 * "warning" severity without halting; an empty array means no caveats.
 *
 * WIRING CONTRACT (KTD-6 deliverable — must reach the operator before mixture
 * ships): every real run path MUST invoke this AFTER validateSwarmDefinition
 * passes and surface each returned string non-fatally —
 *   - extension.ts /swarm run → ctx.ui.notify(msg, "warning") (non-halting),
 *   - cli.ts → process.stderr / console.warn.
 * Without that wiring the Self-MoA heterogeneous-proposer caveat is dead code
 * and the −6.6pp quality regression it guards against ships silently. The
 * wiring lands in a dedicated follow-up commit (kept out of U2's three-file
 * atomic scope by design); do NOT leave it unwired across the milestone.
 */
export function collectSwarmWarnings(def: SwarmDefinition): string[] {
	const warnings: string[] = [];
	if (def.mode === "mixture") {
		warnings.push(...mixtureModelWarnings(def));
	}
	return warnings;
}

/**
 * KTD-6 (Self-MoA, arxiv 2502.00674): a mixture-of-agents aggregator gains the
 * most when its proposers share ONE model (heterogeneous mixing nets −6.6pp).
 * The aggregator should get the best available model; the proposers should be
 * homogeneous. Mixing distinct proposer models is allowed but earns a one-line
 * caveat so the operator knows the configuration trades quality for diversity.
 *
 * "Homogeneous" is judged over the EFFECTIVE proposer model — a proposer's own
 * `model` if set, otherwise the swarm-level default `def.model`. The aggregator
 * is excluded: it is expected to differ (best model) and is not a proposer.
 */
function mixtureModelWarnings(def: SwarmDefinition): string[] {
	const aggregatorName = findFanInAggregator(def);
	if (aggregatorName === null) return [];

	const proposerModels = new Set<string>();
	for (const [name, agent] of def.agents) {
		if (name === aggregatorName) continue;
		// undefined → inherits def.model; collapse to a sentinel so two proposers
		// that both inherit the same default count as homogeneous.
		proposerModels.add(agent.model ?? def.model ?? "<default>");
	}

	if (proposerModels.size > 1) {
		return [
			`mixture mode proposers use heterogeneous models [${[...proposerModels].sort().join(", ")}]; ` +
				"Self-MoA (KTD-6) favors homogeneous proposers (same model) with the aggregator on the best model — " +
				"heterogeneous mixing can lower quality (arxiv 2502.00674).",
		];
	}
	return [];
}

/**
 * Mixture mode shares the strict fan-in shape with vote mode: the proposers fan
 * out in parallel (wave 0, no waits_for, no reports_to) and exactly one
 * aggregator waits_for every proposer (final wave). The only difference is the
 * reduce semantics at the aggregator — vote JUDGES the consensus, mixture
 * SYNTHESIZES a unified answer — which lives in the pipeline reducer, not here.
 * The topology validation is therefore identical, so it is delegated.
 */
function validateMixtureMode(def: SwarmDefinition, agentNames: Set<string>): string[] {
	return validateFanInShape(def, agentNames, MIXTURE_VOCAB);
}

/**
 * Vote mode requires the same strict fan-in shape, judged with vote vocabulary.
 */
function validateVoteMode(def: SwarmDefinition, agentNames: Set<string>): string[] {
	return validateFanInShape(def, agentNames, VOTE_VOCAB);
}

/**
 * Per-mode message vocabulary for the shared fan-in validator. Each closure
 * renders the exact operator-facing error string for that violation so the two
 * modes keep their own wording (vote speaks of a "judge"/"voters", mixture of an
 * "aggregator"/"proposers") while sharing one structural check.
 */
interface FanInVocab {
	mode: SwarmMode;
	/** No agent has a non-empty waits_for → no aggregator to reduce. */
	missingAggregator(): string;
	/** More than one agent has waits_for → the reducer would be ambiguous. */
	multipleAggregators(names: string[]): string;
	/** Fewer than the 2-member fan-in minimum. */
	tooFewMembers(count: number): string;
	/** The aggregator fails to wait_for one of the members. */
	missingMemberEdge(aggregator: string, member: string): string;
	/** A member declares reports_to, which would serialize it out of wave 0. */
	memberReportsTo(member: string): string;
	/** The aggregator declares reports_to, forming an aggregator<->member cycle. */
	aggregatorReportsTo(aggregator: string): string;
}

const VOTE_VOCAB: FanInVocab = {
	mode: "vote",
	missingAggregator: () => "vote mode requires a judge/aggregator agent (one agent that waits_for the voters)",
	multipleAggregators: names =>
		`vote mode requires exactly one judge/aggregator agent, found ${names.length}: [${names.join(", ")}]`,
	tooFewMembers: count => `vote mode requires at least 2 voter agents, found ${count}`,
	missingMemberEdge: (aggregator, member) =>
		`vote mode judge '${aggregator}' must wait_for every voter; missing voter '${member}'`,
	memberReportsTo: member =>
		`vote mode voter '${member}' must not declare reports_to; voters fan out in parallel with no implicit chain`,
	aggregatorReportsTo: aggregator =>
		`vote mode judge '${aggregator}' must not declare reports_to; the judge depends on voters via waits_for only`,
};

const MIXTURE_VOCAB: FanInVocab = {
	mode: "mixture",
	missingAggregator: () =>
		"mixture mode requires an aggregator agent (one agent that waits_for the proposers and synthesizes their answers)",
	multipleAggregators: names =>
		`mixture mode requires exactly one aggregator agent, found ${names.length}: [${names.join(", ")}]`,
	tooFewMembers: count => `mixture mode requires at least 2 proposer agents, found ${count}`,
	missingMemberEdge: (aggregator, member) =>
		`mixture mode aggregator '${aggregator}' must wait_for every proposer; missing proposer '${member}'`,
	memberReportsTo: member =>
		`mixture mode proposer '${member}' must not declare reports_to; proposers fan out in parallel with no implicit chain`,
	aggregatorReportsTo: aggregator =>
		`mixture mode aggregator '${aggregator}' must not declare reports_to; the aggregator depends on proposers via waits_for only`,
};

/**
 * The strict fan-in shape shared by vote and mixture (KTD-5 — no new DAG
 * primitive, the topology itself carries the role):
 *   - exactly one aggregator (the single agent with a non-empty waits_for),
 *   - at least two members (the rest, which must have no waits_for),
 *   - the aggregator must wait_for every member (final wave reduces all of them),
 *   - members carry no reports_to (any reports_to among members would inject an
 *     extra dependency edge in buildDependencyGraph and serialize them into
 *     separate waves, silently breaking the "members fan out, wave 0" contract),
 *   - the aggregator carries no reports_to (reports_to makes its target depend on
 *     the aggregator; pointing it at a member the aggregator already waits_for
 *     forms a cycle this validation must reject up front, not lean on the
 *     downstream detectCycles pass that direct PipelineController callers may skip).
 *
 * This validation is the contract that makes the shape unambiguous so the pipeline
 * reducer can identify the aggregator structurally without heuristics. The
 * reports_to checks keep the validated partition congruent with the dependency
 * graph buildDependencyGraph constructs (which consumes waits_for AND reports_to).
 */
function validateFanInShape(def: SwarmDefinition, agentNames: Set<string>, vocab: FanInVocab): string[] {
	const errors: string[] = [];

	const aggregators: string[] = [];
	const members: string[] = [];
	for (const [name, agent] of def.agents) {
		if (agent.waitsFor.length > 0) {
			aggregators.push(name);
		} else {
			members.push(name);
		}
	}

	if (aggregators.length === 0) {
		errors.push(vocab.missingAggregator());
		return errors;
	}
	if (aggregators.length > 1) {
		errors.push(vocab.multipleAggregators(aggregators));
		return errors;
	}

	const aggregatorName = aggregators[0];
	if (members.length < 2) {
		errors.push(vocab.tooFewMembers(members.length));
	}

	const aggregatorDeps = new Set(def.agents.get(aggregatorName)!.waitsFor.filter(d => agentNames.has(d)));
	for (const member of members) {
		if (!aggregatorDeps.has(member)) {
			errors.push(vocab.missingMemberEdge(aggregatorName, member));
		}
		if (def.agents.get(member)!.reportsTo.length > 0) {
			errors.push(vocab.memberReportsTo(member));
		}
	}

	if (def.agents.get(aggregatorName)!.reportsTo.length > 0) {
		errors.push(vocab.aggregatorReportsTo(aggregatorName));
	}

	return errors;
}

/**
 * Identify the single fan-in aggregator (the lone agent with a non-empty
 * waits_for) for vote/mixture definitions. Relies on the strict shape enforced by
 * validateSwarmDefinition; returns null when the shape does not hold (e.g. an
 * invalid definition that skipped validation, or zero/multiple candidates).
 */
function findFanInAggregator(def: SwarmDefinition): string | null {
	const aggregators: string[] = [];
	for (const [name, agent] of def.agents) {
		if (agent.waitsFor.length > 0) aggregators.push(name);
	}
	return aggregators.length === 1 ? aggregators[0] : null;
}
