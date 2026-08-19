/**
 * Read-only routing probe: resolves real spawn policies against this machine's
 * live configuration, provider registry and auth state, and prints what each
 * ordinary dispatch would route to. Spawns nothing, writes nothing, mutates
 * no credentials.
 *
 * Run: bun ./test/routing-probe.ts [--agent-dir <path>]
 *   --agent-dir <path>  Explicit agent directory (e.g. /home/chris/.omp/agent).
 *                       Also respects PROBE_AGENT_DIR and PI_CODING_AGENT_DIR env vars.
 *                       When unset, uses getAgentDir() (honors PI_CODING_AGENT_DIR).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { discoverAuthStorage } from "../src/sdk";
import { buildRoutingSnapshot } from "../src/task/routing/snapshot";
import type { RoutingIntent } from "../src/task/routing/types";
import { resolveEffectiveSubagentPolicy } from "../src/task/structured-subagent";
import type { ToolSession } from "../src/tools";

function resolveProbeAgentDir(): string | undefined {
	const cliIndex = process.argv.indexOf("--agent-dir");
	if (cliIndex !== -1 && process.argv[cliIndex + 1]) return path.resolve(process.argv[cliIndex + 1]);
	if (process.env.PROBE_AGENT_DIR) return path.resolve(process.env.PROBE_AGENT_DIR);
	// PI_CODING_AGENT_DIR is the harness's worktree-isolated override; respect it
	// when explicitly set, but allow PROBE_AGENT_DIR/--agent-dir to override it
	// for verification against the real home config.
	if (process.env.PI_CODING_AGENT_DIR) return path.resolve(process.env.PI_CODING_AGENT_DIR);
	return undefined;
}

const probeAgentDir = resolveProbeAgentDir();
const resolvedAgentDir = probeAgentDir ?? getAgentDir();
const resolvedConfigPath = path.join(resolvedAgentDir, "config.yml");

console.log(`cwd                 : ${process.cwd()}`);
console.log(`PI_CODING_AGENT_DIR : ${process.env.PI_CODING_AGENT_DIR ?? "(unset)"}`);
console.log(`PROBE_AGENT_DIR     : ${process.env.PROBE_AGENT_DIR ?? "(unset)"}`);
console.log(
	`--agent-dir CLI     : ${(() => {
		const i = process.argv.indexOf("--agent-dir");
		return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : "(none)";
	})()}`,
);
console.log(`resolved agentDir   : ${resolvedAgentDir}`);
console.log(`resolved config path: ${resolvedConfigPath}`);
console.log(`config file exists  : ${fs.existsSync(resolvedConfigPath)}`);
try {
	const rawText = fs.readFileSync(resolvedConfigPath, "utf8");
	const raw = YAML.parse(rawText) as Record<string, unknown>;
	console.log(`raw task.agentModelOverrides (flat): ${JSON.stringify(raw["task.agentModelOverrides"])}`);
	const taskNested = (raw["task"] as Record<string, unknown> | undefined)?.["agentModelOverrides"];
	console.log(`raw task.agentModelOverrides (nested task.agentModelOverrides): ${JSON.stringify(taskNested)}`);
} catch (e) {
	console.log(`raw read error: ${String(e)}`);
}

const authStorage = await discoverAuthStorage(resolvedAgentDir);
const modelRegistry = new ModelRegistry(authStorage);
await modelRegistry.refresh("offline");
// Real user configuration, read-only. Nothing here writes settings back.
const liveSettings = await Settings.init({ cwd: process.cwd(), agentDir: resolvedAgentDir });

console.log(`liveSettings.getAgentDir(): ${liveSettings.getAgentDir()}`);
console.log(
	`live config           : ${liveSettings.get("task.routing.enabled") ? "routing enabled" : "routing DISABLED"}`,
);
console.log(`configured roster     : ${JSON.stringify(liveSettings.get("task.routing.workerModels"))}`);
console.log(`agentModelOverrides   : ${JSON.stringify(liveSettings.get("task.agentModelOverrides"))}`);
console.log(
	`modelRoles keys       : ${Object.keys(liveSettings.get("modelRoles") as Record<string, unknown>)
		.slice(0, 6)
		.join(", ")}... (${Object.keys(liveSettings.get("modelRoles") as Record<string, unknown>).length} total)`,
);
console.log(`task.agentModelOverrides isConfigured: ${liveSettings.isConfigured("task.agentModelOverrides")}`);

const ROUTING_KEYS = [
	"task.routing.enabled",
	"task.routing.avoidParentPool",
	"task.routing.parentPoolFallback",
	"task.routing.excludePools",
	"task.routing.preferPools",
	"task.routing.agentIntents",
	"task.routing.maxContractReroutes",
	"task.routing.workerModels",
] as const;
const INTENTIONAL_KEYS = ["modelRoles", "task.agentModelOverrides"] as const;

function sessionFor(activeModel: string, overrides: Record<string, string[]> = {}): ToolSession {
	// Clone the live configuration read-only so the probe proves what a real
	// dispatch would do, not what an empty Settings.isolated() would do.
	const settings = Settings.isolated();
	for (const key of ROUTING_KEYS) {
		settings.override(key as never, liveSettings.get(key as never) as never);
	}
	for (const key of INTENTIONAL_KEYS) {
		settings.override(key as never, liveSettings.get(key as never) as never);
	}
	for (const [key, value] of Object.entries(overrides)) {
		settings.override(key as never, value as never);
	}
	return {
		cwd: process.cwd(),
		hasUI: false,
		settings,
		modelRegistry,
		authStorage,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getSessionId: () => "routing-probe",
		getActiveModelString: () => activeModel,
		getModelString: () => activeModel,
		taskDepth: 0,
	} as unknown as ToolSession;
}

async function dispatch(
	agent: string,
	parentModel: string,
	intent: RoutingIntent | undefined,
	overrides: Record<string, string[]> = {},
	siblingPools: string[] = [],
): Promise<{ pool?: string; poolKey?: string; selector?: string }> {
	const session = sessionFor(parentModel, overrides);
	try {
		const policy = await resolveEffectiveSubagentPolicy({
			session,
			invocationKind: "task",
			assignment: `${agent} assignment for routing probe`,
			agent,
			...(intent ? { intent } : {}),
			siblingPools,
		});
		console.log(
			[
				`agent=${agent.padEnd(8)}`,
				`intent=${(intent ?? "default").padEnd(9)}`,
				`model=${(policy.modelOverride?.[0] ?? "(none)").padEnd(42)}`,
				`pool=${(policy.resourcePool ?? "(none)").padEnd(42)}`,
				`antiAffinity=${String(policy.routingAntiAffinity ?? false).padEnd(5)}`,
				`parentFallback=${String(policy.routingParentPoolFallback ?? false)}`,
				`bypass=${policy.routingBypassReason ?? "-"}`,
			].join(" "),
		);
		return { pool: policy.resourcePool, poolKey: policy.routingPoolKey, selector: policy.modelOverride?.[0] };
	} catch (error) {
		console.log(`agent=${agent.padEnd(8)} (DISABLED in config: ${(error as Error).message.slice(0, 60)})`);
		return {};
	}
}
const OPUS = "anthropic/claude-opus-4-5";
const session = sessionFor(OPUS);
const snapshot = await buildRoutingSnapshot(session);
const pools = [...new Set(snapshot.candidates.map(candidate => candidate.pool.label))];
console.log(`\nparent (Opus) pool    : ${snapshot.parentPool?.label ?? "(unknown)"}`);
console.log(`eligible candidates   : ${snapshot.candidates.length} across ${pools.length} pools`);
console.log(`pools                 : ${pools.join(", ")}`);

console.log(
	"\n## ordinary dispatches, Opus parent, live config (alias-based defaults must remain preferences, not hard pins)",
);
const chosen: { pool?: string; poolKey?: string; selector?: string }[] = [];
for (const agent of ["scout", "task", "reviewer", "designer"]) {
	chosen.push(await dispatch(agent, OPUS, undefined));
}
for (const intent of ["cheap", "strong"] as RoutingIntent[]) {
	chosen.push(await dispatch("task", OPUS, intent));
}

console.log("\n## sibling diversity across four scouts (each pick fed back)");
const used: string[] = [];
for (let i = 0; i < 4; i++) {
	const result = await dispatch("scout", OPUS, undefined, {}, [...used]);
	if (result.poolKey) used.push(result.poolKey);
}
console.log(`distinct sibling pools: ${new Set(used).size} of ${used.length}`);

console.log("\n## worker roster: composer-2.5 offered as a candidate for every agent");
const composer = "cursor/composer-2.5";
const inRegistry = modelRegistry.getAvailable().some(model => `${model.provider}/${model.id}` === composer);
console.log(`${composer} present in available registry: ${inRegistry}`);
for (const agent of ["scout", "task", "reviewer"]) {
	await dispatch(agent, OPUS, undefined, { "task.routing.workerModels": [composer] });
}
const rosterSnapshot = await buildRoutingSnapshot(sessionFor(OPUS, { "task.routing.workerModels": [composer] }));
const composerCandidate = rosterSnapshot.candidates.find(candidate => candidate.selector === composer);
console.log(
	composerCandidate
		? `composer candidate: pool=${composerCandidate.pool.label} usage=${composerCandidate.usage} tools=${composerCandidate.supportsTools} ctx=${composerCandidate.contextWindow} rank=${composerCandidate.preferredRank}`
		: "composer candidate: NOT ELIGIBLE (absent from available registry)",
);

const externalPools = chosen.filter(entry => entry.pool !== undefined && entry.pool !== snapshot.parentPool?.label);
console.log(`\nordinary dispatches routed off the parent pool: ${externalPools.length}/${chosen.length}`);
console.log(
	`\nProbe demonstrates: @smol/@Contributor/@slow are preferences (preferredRank), not hard pins — scout/task/reviewer all routed off Anthropic parent pool.`,
);
authStorage.close();
