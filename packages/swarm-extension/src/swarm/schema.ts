// ============================================================================
// Raw YAML shape (snake_case, optional fields)
// ============================================================================

interface RawGateConfig {
	prompt: string;
	actions: string[];
	timeout?: number;
	on_timeout?: "fail" | "default_action";
	default_action?: string;
}

interface RawSwarmAgentConfig {
	role: string;
	task: string;
	extra_context?: string;
	reports_to?: string[];
	waits_for?: string[];
	model?: string;
	agent?: string;
	workspace?: string;
	gate?: RawGateConfig;
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

export type SwarmMode = "pipeline" | "parallel" | "sequential";

export interface GateConfig {
	prompt: string;
	actions: string[];
	timeout?: number;
	onTimeout?: "fail" | "default_action";
	defaultAction?: string;
}

export interface SwarmAgent {
	name: string;
	role: string;
	task: string;
	extraContext?: string;
	reportsTo: string[];
	waitsFor: string[];
	model?: string;
	/** Specific agent type to use (e.g. "reviewer", "librarian"). Shape-validated only. */
	agent?: string;
	/** Workspace sub-path for this agent. */
	workspace?: string;
	/** Human-in-the-loop gate configuration. */
	gate?: GateConfig;
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

const VALID_MODES = new Set<string>(["pipeline", "parallel", "sequential"]);
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

		// Validate agent field (shape only — non-empty string)
		if (config.agent !== undefined && typeof config.agent !== "string") {
			throw new Error(`Agent '${name}': 'agent' must be a string`);
		}
		const agentTrimmed = typeof config.agent === "string" ? config.agent.trim() : undefined;
		if (agentTrimmed === "") {
			throw new Error(`Agent '${name}': 'agent' must not be empty when provided`);
		}

		// Validate workspace field
		if (config.workspace !== undefined && typeof config.workspace !== "string") {
			throw new Error(`Agent '${name}': 'workspace' must be a string`);
		}
		const workspaceTrimmed = typeof config.workspace === "string" ? config.workspace.trim() : undefined;

		// Parse gate config
		let gate: GateConfig | undefined;
		if (config.gate) {
			if (typeof config.gate !== "object" || config.gate === null) {
				throw new Error(`Agent '${name}': 'gate' must be an object`);
			}
			if (!config.gate.prompt || typeof config.gate.prompt !== "string") {
				throw new Error(`Agent '${name}': gate.prompt is required`);
			}
			if (!Array.isArray(config.gate.actions) || config.gate.actions.length === 0) {
				throw new Error(`Agent '${name}': gate.actions is required and must be non-empty`);
			}
			// Validate on_timeout enum if provided
			if (config.gate.on_timeout !== undefined && !["fail", "default_action"].includes(config.gate.on_timeout)) {
				throw new Error(`Agent '${name}': gate.on_timeout must be 'fail' or 'default_action'`);
			}
			// timeout must be a number if provided
			if (config.gate.timeout !== undefined && typeof config.gate.timeout !== "number") {
				throw new Error(`Agent '${name}': gate.timeout must be a number`);
			}
			gate = {
				prompt: config.gate.prompt,
				actions: config.gate.actions,
				timeout: config.gate.timeout,
				onTimeout: config.gate.on_timeout,
				defaultAction: config.gate.default_action,
			};
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
			agent: agentTrimmed || undefined,
			workspace: workspaceTrimmed || undefined,
			gate,
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

	return errors;
}
