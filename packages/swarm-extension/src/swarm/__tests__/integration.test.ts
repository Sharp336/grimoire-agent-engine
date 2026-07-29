/**
 * Integration test suite: matrix rows A1–K2.
 *
 * Rows already covered by dedicated unit tests are cross-referenced below;
 * no duplicate assertions. New coverage lives in the describe blocks that
 * follow.
 *
 * Cross-reference index (existing coverage):
 *   A1  → discovery.test.ts "resolves a named workflow (no slash, no extension)…"
 *   A2  → discovery.test.ts "substituteVars — ${VAR} substitution"
 *   A3  → discovery.test.ts "discoverSwarmYaml — end-to-end discovery…"
 *   B1  → schema.test.ts "parseSwarmYaml — agent/workspace/gate fields"
 *   C1  → workspace-resolution.test.ts "per-agent workspace resolution in pipeline"
 *   E1  → gate.test.ts "E1 — Declared gate pause (§6.2)"
 *   E2  → gate.test.ts "E2 — Ambient scan (§7.1)"
 *   F1  → gate.test.ts "F1 — Gate resume via session-resume (§6.3)"
 *   F2  → gate.test.ts "F2 — Timeout expiry (§7.2.3)"
 *   H1-H6 → packages/collab-web/test/state-reader.test.ts (25 tests, Repo B)
 *   K1  → state.test.ts "StateTracker — resolvedModel per agent (K1)"
 *   K2  → state.test.ts "StateTracker — gateStatus per agent (K2)"
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import type { AgentDefinition, SingleResult } from "@oh-my-pi/pi-coding-agent";
// G1: not exported from pi-coding-agent's public index; reachable via the ./* export map.
import {
	discoverRelayLinks,
	registerDaemonProjectPresence,
} from "@oh-my-pi/pi-coding-agent/launch/presence";
import * as taskExecutor from "@oh-my-pi/pi-coding-agent";
import { discoverSwarmYaml } from "../discovery";
import { executeSwarmAgent } from "../executor";
import { StateTracker } from "../state";

// ============================================================================
// Shared mock result shape
// ============================================================================

const makeMockResult = (overrides: Partial<SingleResult> = {}): SingleResult =>
	({
		index: 0,
		id: "test-agent-0",
		agent: "test",
		agentSource: "project",
		task: "test task",
		exitCode: 0,
		output: "ok",
		stderr: "",
		truncated: false,
		durationMs: 100,
		tokens: 0,
		requests: 0,
		resolvedModel: "claude-sonnet-4",
		...overrides,
	}) as SingleResult;

// ============================================================================
// D1 — Executor → runSubprocess: AgentDefinition + modelOverride
// ============================================================================

describe("D1 — Executor: AgentDefinition + modelOverride", () => {
	let workspace: string;

	beforeEach(async () => {
		workspace = await fs.mkdtemp(path.join(os.tmpdir(), "swarm-d1-"));
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await fs.rm(workspace, { recursive: true, force: true });
	});

	it("D1: passes raw modelOverride alias and typed AgentDefinition to runSubprocess", async () => {
		// D1: agent: reviewer, model: @plan → spy must see modelOverride === "@plan" (raw, not expanded)
		// and opts.agent must be a typed AgentDefinition with .name matching the declared name.
		const spy = vi.spyOn(taskExecutor, "runSubprocess").mockResolvedValue(
			makeMockResult({ id: "swarm-d1-reviewer-0" }),
		);

		const stateTracker = new StateTracker(workspace, "d1-swarm");
		await stateTracker.init(["reviewer"], 1, "sequential");

		const agent = {
			name: "reviewer",
			role: "code reviewer",
			task: "review the changes",
			reportsTo: [],
			waitsFor: [],
			agent: "reviewer",
			model: "@plan",
		};

		await executeSwarmAgent(agent, 0, {
			workspace,
			swarmName: "d1-swarm",
			iteration: 0,
			modelOverride: "@plan",
			stateTracker,
		});

		expect(spy).toHaveBeenCalledTimes(1);
		const opts = spy.mock.calls[0][0];

		// opts.agent is typed AgentDefinition — .name is a direct string property
		const agentDef: AgentDefinition = opts.agent;
		expect(agentDef.name).toBe("reviewer");
		expect(typeof agentDef.systemPrompt).toBe("string");

		// modelOverride is raw — resolution happens inside runSubprocess, not before
		expect(opts.modelOverride).toBe("@plan");
	});
});

// ============================================================================
// G1 — Process presence → relay-link discovery
// ============================================================================

describe("G1 — Process presence: relay-link discovery", () => {
	it(
		"G1: second process discovers first via relayLink + roomKey in clients/*.json",
		async () => {
			using tempDir = TempDir.createSync("@omp-swarm-g1-");
			const projectDir = path.join(tempDir.path(), "project");
			const runtimeDir = path.join(tempDir.path(), "runtime");
			await fs.mkdir(projectDir, { recursive: true });

			const relayLink1 = "omp://session/swarm-g1-alpha";
			const roomKey1 = "swarm-room-g1";

			const presence1 = await registerDaemonProjectPresence(projectDir, {
				runtimeDir,
				relayLink: relayLink1,
				roomKey: roomKey1,
			});

			try {
				const links = await discoverRelayLinks(runtimeDir, undefined);

				// The second process can see the first entry
				const found = links.find(l => l.relayLink === relayLink1);
				expect(found).toBeTruthy();

				// relayLink and roomKey are both present (not just pid/id/projectDir)
				expect(found?.relayLink).toBe(relayLink1);
				expect(found?.roomKey).toBe(roomKey1);
				expect(found?.pid).toBe(process.pid);
			} finally {
				await presence1.close();
			}
		},
		10_000,
	);
});

// ============================================================================
// G2 — Dashboard → control plane: gate submit (known-open)
// ============================================================================

it.skip(
	"G2: gate-response command socket delivery — broker has no state-dir bridge; delivery is a deferred seam",
	() => { /* deferred */ },
);

// ============================================================================
// G3 — Dashboard → control plane: kill/pause (safety-deferred)
// ============================================================================

it.skip("G3: kill/pause live process via command socket — safety-deferred by orchestrator", () => {
	// Requires a live headless swarm mid-wave.
	// Deferred until G1+G2 are stable end-to-end.
});

// ============================================================================
// I1 — workflows/<name>.yaml symlink → discovered by name
// ============================================================================

describe("I1 — Symlink → discovered by name", () => {
	let origHome: string | undefined;

	afterEach(() => {
		// Restore HOME regardless of test outcome
		process.env.HOME = origHome;
	});

	it("I1: symlink in ~/.omp/agent/swarms/ resolves to the repo source YAML", async () => {
		using tempDir = TempDir.createSync("@omp-swarm-i1-");
		const fakeHome = tempDir.path();
		const swarmDir = path.join(fakeHome, ".omp", "agent", "swarms");
		await fs.mkdir(swarmDir, { recursive: true });

		// "Repo" YAML source (the version-controlled single source of truth)
		const repoDir = path.join(tempDir.path(), "repo", "workflows");
		await fs.mkdir(repoDir, { recursive: true });
		const repoYaml = path.join(repoDir, "my-workflow.yaml");
		await Bun.write(
			repoYaml,
			`swarm:
  name: "\${WORKFLOW_NAME}"
  workspace: "\${PROJECT_DIR}"
  mode: sequential
  agents:
    plan:
      role: planner
      agent: task
      gate:
        prompt: "Approve plan?"
        actions: [approve, reject]
      task: write a plan
`,
		);

		// Install via symlink (the one-time install step)
		const symlinkPath = path.join(swarmDir, "my-workflow.yaml");
		await fs.symlink(repoYaml, symlinkPath);

		// Override HOME so resolveSwarmYamlPath resolves into the temp dir
		origHome = process.env.HOME;
		process.env.HOME = fakeHome;

		const def = await discoverSwarmYaml("my-workflow", {
			projectDir: "/tmp/i1-proj",
			workflowName: "my-run",
		});

		// Discovery succeeded — YAML was read through the symlink
		expect(def).toBeDefined();
		expect(def.agents.has("plan")).toBe(true);

		// Vars were substituted (single source of truth, editing repo copy is immediately visible)
		expect(def.name).toBe("my-run");
		expect(def.workspace).toBe("/tmp/i1-proj");

		// Gate was parsed
		const planAgent = def.agents.get("plan");
		expect(planAgent?.gate).toBeDefined();
		expect(planAgent?.gate?.actions).toEqual(["approve", "reject"]);
	});
});

// ============================================================================
// J1 — Full DAG headless: dev-workflow.yaml discovery + gate schema
// ============================================================================

describe("J1 — dev-workflow.yaml: discovery → parse → gate config reached", () => {
	it(
		"J1: discoverSwarmYaml('dev-workflow') resolves symlink, parses YAML, plan+reviewer have gates",
		async () => {
			// J1 contract: verify the full discovery→parse→gate chain WITHOUT spawning real agents.
			// The symlink ~/.omp/agent/swarms/dev-workflow.yaml → repo file is pre-installed.
			const def = await discoverSwarmYaml("dev-workflow", {
				projectDir: "/tmp/j1-test",
				workflowName: "j1-test",
			});

			// Discovery resolved and parsed without error
			expect(def).toBeDefined();
			expect(def.agents.size).toBeGreaterThan(0);

			// plan agent has a gate (first human checkpoint)
			const plan = def.agents.get("plan");
			expect(plan).toBeDefined();
			expect(plan?.gate).toBeDefined();
			expect(Array.isArray(plan?.gate?.actions)).toBe(true);
			expect((plan?.gate?.actions ?? []).length).toBeGreaterThan(0);

			// reviewer agent has a gate (second human checkpoint)
			const reviewer = def.agents.get("reviewer");
			expect(reviewer).toBeDefined();
			expect(reviewer?.gate).toBeDefined();
			expect(Array.isArray(reviewer?.gate?.actions)).toBe(true);
			expect((reviewer?.gate?.actions ?? []).length).toBeGreaterThan(0);

			// Vars were substituted
			expect(def.workspace).toBe("/tmp/j1-test");
			expect(def.name).toBe("j1-test");
		},
		10_000,
	);
});
