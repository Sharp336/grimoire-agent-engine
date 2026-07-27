#!/usr/bin/env bun
/**
 * Direct pipeline runner — executes a swarm pipeline outside of the TUI.
 *
 * Usage:
 *   omp-swarm <path-to-yaml>
 *   omp-swarm <workflow-name> --project <dir> --name <swarm-name>
 *
 * Options:
 *   --project <dir>   Project directory for ${PROJECT_DIR} substitution
 *   --name <name>     Workflow name for ${WORKFLOW_NAME} substitution
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { discoverAuthStorage } from "@oh-my-pi/pi-coding-agent";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { buildDependencyGraph, buildExecutionWaves, detectCycles } from "./swarm/dag";
import { PipelineController } from "./swarm/pipeline";
import { renderSwarmProgress } from "./swarm/render";
import { parseSwarmYaml, validateSwarmDefinition, type SwarmDefinition } from "./swarm/schema";
import { StateTracker } from "./swarm/state";
import { discoverSwarmYaml, resolveSwarmYamlPath, substituteVars } from "./swarm/discovery";

// ============================================================================
// Parse CLI flags
// ============================================================================

const rawArgs = process.argv.slice(2);
const positionalArgs: string[] = [];
const flags: Record<string, string | undefined> = {};

for (let i = 0; i < rawArgs.length; i++) {
	const arg = rawArgs[i];
	if (arg.startsWith("--")) {
		const key = arg.slice(2);
		const next = rawArgs[i + 1];
		if (next && !next.startsWith("--")) {
			flags[key] = next;
			i++;
		} else {
			flags[key] = "";
		}
	} else {
		positionalArgs.push(arg);
	}
}

const nameOrPath = positionalArgs[0];
if (!nameOrPath) {
	console.error(
		[
			"Usage: omp-swarm <path-to-yaml> [--project <dir>] [--name <swarm-name>]",
			"       omp-swarm <workflow-name> [--project <dir>] [--name <swarm-name>]",
			"",
			"Options:",
			"  --project <dir>   Project directory for ${PROJECT_DIR} substitution",
			"  --name <name>     Workflow name for ${WORKFLOW_NAME} substitution",
		].join("\n"),
	);
	process.exit(1);
}

// ============================================================================
// Resolve YAML path (Option A: named workflow → ~/.omp/agent/swarms/<name>.yaml)
// ============================================================================

const resolvedPath = resolveSwarmYamlPath(nameOrPath);
const absolutePath = path.isAbsolute(resolvedPath)
	? resolvedPath
	: path.resolve(process.cwd(), resolvedPath);

console.log(`Reading: ${absolutePath}`);

// ============================================================================
// Read, substitute, parse
// ============================================================================

let content: string;
try {
	content = await Bun.file(absolutePath).text();
} catch {
	console.error(`Cannot read file: ${absolutePath}`);
	process.exit(1);
}

// Build substitution map
const projectDir = flags.project ?? process.cwd();
const workflowName = flags.name;


const vars: Record<string, string> = {
	PROJECT_DIR: projectDir,
};
if (workflowName) {
	vars.WORKFLOW_NAME = workflowName;
}

const substituted = substituteVars(content, vars);

let def: SwarmDefinition;
try {
	def = parseSwarmYaml(substituted);
} catch (err) {
	console.error(`YAML error: ${err instanceof Error ? err.message : String(err)}`);
	process.exit(1);
}

console.log(`Swarm: ${def.name}`);
console.log(`Mode: ${def.mode}`);
console.log(`Target count: ${def.targetCount}`);
console.log(`Agents: ${[...def.agents.keys()].join(", ")}`);

// Validate
const errors = validateSwarmDefinition(def);
if (errors.length > 0) {
	console.error("Validation errors:", errors);
	process.exit(1);
}

// Build DAG
const deps = buildDependencyGraph(def);
const cycles = detectCycles(deps);
if (cycles) {
	console.error("Cycle detected:", cycles);
	process.exit(1);
}
const waves = buildExecutionWaves(deps);
console.log(`Waves: ${waves.map((w, i) => `W${i + 1}:[${w.join(",")}]`).join(" -> ")}`);

// Resolve workspace (relative to projectDir, NOT YAML location)
const workspace = path.isAbsolute(def.workspace)
	? def.workspace
	: path.resolve(projectDir, def.workspace);

await fs.mkdir(workspace, { recursive: true });
console.log(`Workspace: ${workspace}`);

// Initialize
const stateTracker = new StateTracker(workspace, def.name);
await stateTracker.init([...def.agents.keys()], def.targetCount, def.mode);

// Auth + settings
const authStorage = await discoverAuthStorage();
const modelRegistry = new ModelRegistry(authStorage);
const settings = Settings.isolated();

// Progress display
let lastProgressDump = 0;
const PROGRESS_INTERVAL_MS = 5000;

// Run
console.log("\n--- Pipeline starting ---\n");

const controller = new PipelineController(def, waves, stateTracker);
const result = await controller.run({
	workspace,
	onProgress: () => {
		const now = Date.now();
		if (now - lastProgressDump > PROGRESS_INTERVAL_MS) {
			lastProgressDump = now;
			const lines = renderSwarmProgress(stateTracker.state);
			console.log(lines.join("\n"));
			console.log();
		}
	},
	modelRegistry,
	settings,
});

console.log("\n--- Pipeline finished ---\n");
console.log(`Status: ${result.status}`);
console.log(`Iterations completed: ${result.iterations}/${def.targetCount}`);
if (result.errors.length > 0) {
	console.log(`Errors (${result.errors.length}):`);
	for (const err of result.errors) {
		console.log(`  - ${err}`);
	}
}
console.log(`\nState saved to: ${stateTracker.swarmDir}`);

// Final state dump
const lines = renderSwarmProgress(stateTracker.state);
console.log(lines.join("\n"));
