/**
 * Discovery layer — Option A: user-level only.
 *
 * - Named workflow resolution: `my-workflow` → `~/.omp/agent/swarms/my-workflow.yaml`
 * - `${VAR}` substitution: `PROJECT_DIR`, `WORKFLOW_NAME`
 * - CLI flags: `--project`, `--name`
 *
 * NO project-level override, NO `.omp/swarms/` shadow search.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parseSwarmYaml, type SwarmDefinition } from "./schema";

// ============================================================================
// Named-workflow → YAML path resolution
// ============================================================================

/**
 * Resolve a workflow identifier to an absolute YAML path.
 *
 * - Named workflow (no slash, no `.yaml`): `~/.omp/agent/swarms/<name>.yaml`
 * - Absolute path: returned as-is
 * - Relative path with `.yaml` extension: returned as-is (caller resolves)
 */
export function resolveSwarmYamlPath(input: string): string {
	// Already absolute — pass through
	if (path.isAbsolute(input)) {
		return input;
	}

	// Has .yaml extension — treat as explicit path, pass through
	if (input.endsWith(".yaml") || input.endsWith(".yml")) {
		return input;
	}

	// Contains path separator — treat as explicit relative path
	if (input.includes("/") || input.includes("\\")) {
		return input;
	}

	// Named workflow — Option A: user-level only
	const home = process.env.HOME ?? "";
	return path.join(home, ".omp", "agent", "swarms", `${input}.yaml`);
}

// ============================================================================
// ${VAR} substitution
// ============================================================================

/**
 * Substitute ${VAR} placeholders in raw YAML text.
 *
 * Unmatched ${VAR} patterns are left literal.
 */
export function substituteVars(text: string, vars: Record<string, string>): string {
	return text.replace(/\$\{(\w+)\}/g, (_match, name) => {
		return vars[name] ?? _match; // leave unmatched literal
	});
}

// ============================================================================
// Full discovery: resolve → read → substitute → parse
// ============================================================================

export interface DiscoveryOptions {
	/** Project directory for PROJECT_DIR substitution. Defaults to cwd. */
	projectDir?: string;
	/** Workflow name for WORKFLOW_NAME substitution. */
	workflowName?: string;
	/** Current working directory (used for relative path resolution). */
	cwd?: string;
}

/**
 * Discover a swarm YAML by name, substitute variables, and parse.
 *
 * Option A: searches ONLY `~/.omp/agent/swarms/<name>.yaml`.
 * No project-level override, no `.omp/swarms/` shadow search.
 */
export async function discoverSwarmYaml(
	nameOrPath: string,
	opts: DiscoveryOptions = {},
): Promise<SwarmDefinition> {
	const { projectDir, workflowName, cwd } = opts;
	const resolvedPath = resolveSwarmYamlPath(nameOrPath);

	// Resolve relative paths against cwd
	const absolutePath = path.isAbsolute(resolvedPath)
		? resolvedPath
		: path.resolve(cwd ?? process.cwd(), resolvedPath);

	// Read raw YAML text
	let content: string;
	try {
		content = await fs.readFile(absolutePath, "utf-8");
	} catch (err) {
		throw new Error(
			`Cannot read swarm YAML: ${absolutePath}\n${err instanceof Error ? err.message : String(err)}`,
		);
	}

	// Build substitution map
	const vars: Record<string, string> = {
		PROJECT_DIR: projectDir ?? cwd ?? process.cwd(),
	};
	if (workflowName) {
		vars.WORKFLOW_NAME = workflowName;
	}

	// Substitute variables
	const substituted = substituteVars(content, vars);

	// Parse into typed SwarmDefinition
	return parseSwarmYaml(substituted);
}
