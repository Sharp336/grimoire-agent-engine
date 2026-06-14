/**
 * U7 — subagent-leaf `DriveNode` via direct `runSubprocess`.
 *
 * Exercises {@link subagentLeafDriveNode} and its wire-in to the blend executor
 * with a MOCKED `runSubprocess` (injected) — so the suite runs serially with no
 * real subprocess spawn and no `ModelRegistry` (which would hang the loader). The
 * mock records every {@link ExecutorOptions} it receives, so the tests can assert
 * the member → options mapping (task threading, depth, role, modelOverride) and
 * the {@link SingleResult} → {@link DriveResult} mapping (output/usage/message).
 *
 * Plan scenarios: a `kind:"subagent"` member is driven and mapped to a
 * `DriveResult`; the depth guard refuses beyond the cap; a `signal` abort
 * propagates (fatal); the executor routes `kind:"subagent"` to the subagent leaf
 * and `kind:"model"` to the model leaf; and a STATIC guard asserts no
 * `coding-agent`/`ai` source imports `@oh-my-pi/swarm-extension` (KTD-2).
 */

import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { AssistantMessage, Context, Model, SimpleStreamOptions, SwarmMember, Usage } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import type { SwarmSpec } from "@oh-my-pi/pi-catalog/types";
import {
	createSwarmStreamSimple,
	OMP_BASE_URL,
	OMP_PROVIDER_NAME,
	OMP_SWARM_API,
	type SwarmExecutorDeps,
} from "@oh-my-pi/pi-coding-agent/swarm/executor";
import {
	ORIGINAL_INPUT,
	type SubagentLeafDeps,
	subagentLeafDriveNode,
} from "@oh-my-pi/pi-coding-agent/swarm/primitives";
import type { ExecutorOptions } from "@oh-my-pi/pi-coding-agent/task/executor";
import type { AgentDefinition, SingleResult } from "@oh-my-pi/pi-coding-agent/task/types";

// ── helpers ────────────────────────────────────────────────────────────────

function usage(input = 0, output = 0): Usage {
	const u: Usage = {
		input,
		output,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: input + output,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	return u;
}

const agent: AgentDefinition = {
	name: "explorer",
	description: "test agent",
	systemPrompt: "be helpful",
	source: "bundled",
};

function context(prompt = "do the thing"): Context {
	return {
		systemPrompt: ["You are a coding agent."],
		tools: [],
		messages: [{ role: "user", content: prompt, timestamp: 1 }],
	};
}

/** A `SingleResult` with the fields the leaf reads; the rest are filler. */
function singleResult(over: Partial<SingleResult>): SingleResult {
	return {
		index: 0,
		id: "id",
		agent: "explorer",
		agentSource: "bundled",
		task: "t",
		exitCode: 0,
		output: "",
		stderr: "",
		truncated: false,
		durationMs: 0,
		tokens: 0,
		requests: 0,
		...over,
	};
}

/**
 * A mock runner that records each call's {@link ExecutorOptions} and returns a
 * queued {@link SingleResult} (or a default success). No real spawn, no registry.
 */
function mockRunner(results: SingleResult[] = []) {
	const calls: ExecutorOptions[] = [];
	let i = 0;
	const runSubprocess = async (options: ExecutorOptions): Promise<SingleResult> => {
		calls.push(options);
		const result = results[i] ?? singleResult({ output: "subagent output" });
		i += 1;
		return result;
	};
	return { runSubprocess, calls };
}

function leafDeps(over: Partial<SubagentLeafDeps> = {}): SubagentLeafDeps {
	const { runSubprocess } = mockRunner();
	return { runSubprocess, agent, cwd: "/repo", context: context(), ...over };
}

// ── subagentLeafDriveNode ────────────────────────────────────────────────────

describe("subagentLeafDriveNode", () => {
	it("drives a subagent member and maps SingleResult → DriveResult", async () => {
		const runner = mockRunner([singleResult({ output: "explored result", usage: usage(40, 12) })]);
		const node = subagentLeafDriveNode(leafDeps({ runSubprocess: runner.runSubprocess }));
		const member: SwarmMember = { role: "explore", model: "anthropic/claude", kind: "subagent" };

		const result = await node(member, ORIGINAL_INPUT);

		// SingleResult.output threads into the next member and the synthesized message.
		expect(result.output).toBe("explored result");
		expect(result.usage.input).toBe(40);
		expect(result.usage.output).toBe(12);
		expect(result.message.role).toBe("assistant");
		expect(result.message.stopReason).toBe("stop");
		expect(result.message.content).toEqual([{ type: "text", text: "explored result" }]);
	});

	it("maps ORIGINAL_INPUT to the last user prompt and a string input to the task verbatim", async () => {
		const runner = mockRunner();
		const node = subagentLeafDriveNode(
			leafDeps({ runSubprocess: runner.runSubprocess, context: context("ORIG PROMPT") }),
		);
		const member: SwarmMember = { role: "explore", model: "m", kind: "subagent" };

		await node(member, ORIGINAL_INPUT);
		await node(member, "PIPED TAIL");

		expect(runner.calls[0].task).toBe("ORIG PROMPT");
		expect(runner.calls[1].task).toBe("PIPED TAIL");
		// Identity + recursion are threaded into the options.
		expect(runner.calls[0].agent).toBe(agent);
		expect(runner.calls[0].role).toBe("explore");
		expect(runner.calls[0].modelOverride).toBe("m");
		expect(runner.calls[0].cwd).toBe("/repo");
	});

	it("forwards the parent taskDepth so the child runs one level deeper", async () => {
		const runner = mockRunner();
		const node = subagentLeafDriveNode(leafDeps({ runSubprocess: runner.runSubprocess, taskDepth: 1 }));
		const member: SwarmMember = { role: "explore", model: "m", kind: "subagent" };

		await node(member, ORIGINAL_INPUT);

		// runSubprocess receives the PARENT depth (it computes childDepth itself).
		expect(runner.calls[0].taskDepth).toBe(1);
	});

	it("refuses to run when the child's depth would exceed the cap", async () => {
		const runner = mockRunner();
		// parent depth 2, cap 2 → childDepth 3 > 2 → refuse.
		const node = subagentLeafDriveNode(
			leafDeps({ runSubprocess: runner.runSubprocess, taskDepth: 2, maxRecursionDepth: 2 }),
		);
		const member: SwarmMember = { role: "explore", model: "m", kind: "subagent" };

		await expect(node(member, ORIGINAL_INPUT)).rejects.toThrow(/recursion depth/);
		// The guard short-circuits BEFORE the runner is touched.
		expect(runner.calls).toHaveLength(0);
	});

	it("allows the child to run at exactly the cap", async () => {
		const runner = mockRunner();
		// parent depth 1, cap 2 → childDepth 2, not > 2 → allowed.
		const node = subagentLeafDriveNode(
			leafDeps({ runSubprocess: runner.runSubprocess, taskDepth: 1, maxRecursionDepth: 2 }),
		);
		const member: SwarmMember = { role: "explore", model: "m", kind: "subagent" };

		await node(member, ORIGINAL_INPUT);
		expect(runner.calls).toHaveLength(1);
	});

	it("treats an aborted run as a fatal abort (signal checked before the runner)", async () => {
		const runner = mockRunner();
		const controller = new AbortController();
		controller.abort();
		const node = subagentLeafDriveNode(leafDeps({ runSubprocess: runner.runSubprocess }));
		const member: SwarmMember = { role: "explore", model: "m", kind: "subagent" };

		await expect(node(member, ORIGINAL_INPUT, controller.signal)).rejects.toThrow();
		expect(runner.calls).toHaveLength(0);
	});

	it("forwards the abort signal into the runner's ExecutorOptions", async () => {
		const runner = mockRunner();
		const controller = new AbortController();
		const node = subagentLeafDriveNode(leafDeps({ runSubprocess: runner.runSubprocess }));
		const member: SwarmMember = { role: "explore", model: "m", kind: "subagent" };

		await node(member, ORIGINAL_INPUT, controller.signal);
		expect(runner.calls[0].signal).toBe(controller.signal);
	});

	it("maps a failed run to a resolved DriveResult with stopReason 'error' (not a rejection)", async () => {
		const runner = mockRunner([singleResult({ exitCode: 1, error: "boom", output: "" })]);
		const node = subagentLeafDriveNode(leafDeps({ runSubprocess: runner.runSubprocess }));
		const member: SwarmMember = { role: "explore", model: "m", kind: "subagent" };

		const result = await node(member, ORIGINAL_INPUT);
		expect(result.message.stopReason).toBe("error");
		expect(result.message.errorMessage).toBe("boom");
	});

	it("maps an aborted run to stopReason 'aborted'", async () => {
		const runner = mockRunner([singleResult({ exitCode: 1, aborted: true, output: "" })]);
		const node = subagentLeafDriveNode(leafDeps({ runSubprocess: runner.runSubprocess }));
		const member: SwarmMember = { role: "explore", model: "m", kind: "subagent" };

		const result = await node(member, ORIGINAL_INPUT);
		expect(result.message.stopReason).toBe("aborted");
	});

	it("defaults usage to a zero record when the runner reports none", async () => {
		const runner = mockRunner([singleResult({ output: "x", usage: undefined })]);
		const node = subagentLeafDriveNode(leafDeps({ runSubprocess: runner.runSubprocess }));
		const member: SwarmMember = { role: "explore", model: "m", kind: "subagent" };

		const result = await node(member, ORIGINAL_INPUT);
		expect(result.usage.totalTokens).toBe(0);
		expect(result.usage.cost.total).toBe(0);
	});

	it("allocates a registry-unique id (and distinct index) per spawn for two SAME-ROLE members in one blend", async () => {
		// moa proposers commonly share a role; SwarmMember does not forbid duplicates.
		// A constant `${agent}-${role}-${index}` id would collide in the process-global
		// AgentRegistry (overwrite, setStatus cross-talk, lost teardown). Each spawn must
		// get a distinct id AND a distinct index.
		const runner = mockRunner();
		const node = subagentLeafDriveNode(leafDeps({ runSubprocess: runner.runSubprocess }));
		const a: SwarmMember = { role: "propose", model: "m1", kind: "subagent" };
		const b: SwarmMember = { role: "propose", model: "m2", kind: "subagent" };

		await Promise.all([node(a, ORIGINAL_INPUT), node(b, ORIGINAL_INPUT)]);

		expect(runner.calls).toHaveLength(2);
		expect(runner.calls[0].id).not.toBe(runner.calls[1].id);
		expect(runner.calls[0].index).not.toBe(runner.calls[1].index);
	});

	it("allocates distinct ids across repeated turns of the same blend (same role, stable index base)", async () => {
		// A repeated blend re-drives the same role every turn; a deterministic id keyed on
		// role/index would clobber the prior turn's registry ref. The per-leaf counter +
		// allocator keep each turn unique.
		const runner = mockRunner();
		const node = subagentLeafDriveNode(leafDeps({ runSubprocess: runner.runSubprocess }));
		const member: SwarmMember = { role: "explore", model: "m", kind: "subagent" };

		await node(member, ORIGINAL_INPUT);
		await node(member, ORIGINAL_INPUT);

		expect(runner.calls[0].id).not.toBe(runner.calls[1].id);
		expect(runner.calls[0].index).not.toBe(runner.calls[1].index);
	});

	it("uses an injected idAllocator verbatim for ExecutorOptions.id", async () => {
		const ids = ["alloc-0", "alloc-1"];
		let n = 0;
		const runner = mockRunner();
		const node = subagentLeafDriveNode(
			leafDeps({ runSubprocess: runner.runSubprocess, idAllocator: () => ids[n++] }),
		);
		const member: SwarmMember = { role: "explore", model: "m", kind: "subagent" };

		await node(member, ORIGINAL_INPUT);
		await node(member, ORIGINAL_INPUT);

		expect(runner.calls[0].id).toBe("alloc-0");
		expect(runner.calls[1].id).toBe("alloc-1");
	});

	it("offsets each spawn's index from the configured base index", async () => {
		const runner = mockRunner();
		const node = subagentLeafDriveNode(leafDeps({ runSubprocess: runner.runSubprocess, index: 10 }));
		const member: SwarmMember = { role: "explore", model: "m", kind: "subagent" };

		await node(member, ORIGINAL_INPUT);
		await node(member, ORIGINAL_INPUT);

		expect(runner.calls[0].index).toBe(10);
		expect(runner.calls[1].index).toBe(11);
	});

	it("does NOT refuse at exactly the cap (the task-tool strip is delegated to runSubprocess)", async () => {
		// Real guard: runSubprocess marks atMaxDepth at childDepth >= cap and strips the
		// task tool while STILL running the child. The leaf must not pre-empt that — it
		// only refuses when the depth is already PAST the cap (childDepth > cap).
		const runner = mockRunner();
		// parent depth 2, cap 2 → childDepth 3 > 2 → defensive refuse.
		const past = subagentLeafDriveNode(
			leafDeps({ runSubprocess: runner.runSubprocess, taskDepth: 2, maxRecursionDepth: 2 }),
		);
		const member: SwarmMember = { role: "explore", model: "m", kind: "subagent" };
		await expect(past(member, ORIGINAL_INPUT)).rejects.toThrow(/recursion depth/);
		expect(runner.calls).toHaveLength(0);

		// parent depth 1, cap 2 → childDepth 2 == cap → leaf allows; runSubprocess strips.
		const atCap = subagentLeafDriveNode(
			leafDeps({ runSubprocess: runner.runSubprocess, taskDepth: 1, maxRecursionDepth: 2 }),
		);
		await atCap(member, ORIGINAL_INPUT);
		expect(runner.calls).toHaveLength(1);
	});
});

// ── executor wire-in (kind dispatch) ─────────────────────────────────────────

/** A blend `Model` carrying the given spec; the executor reads only `swarm` + identity. */
function blendModel(swarm: SwarmSpec, id = "omp/subagent-blend"): Model {
	return {
		id,
		name: id,
		api: OMP_SWARM_API,
		provider: OMP_PROVIDER_NAME,
		baseUrl: OMP_BASE_URL,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 32_768,
		compat: undefined,
		swarm,
	} as unknown as Model;
}

/** A model-leaf `streamSimple` that emits a fixed text message — no network, no registry. */
function fixedModelStream(text: string, u: Usage): SwarmExecutorDeps["streamSimple"] {
	return (model: Model, _context: Context, _options?: SimpleStreamOptions) => {
		const stream = new AssistantMessageEventStream();
		const message: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: u,
			stopReason: "stop",
			timestamp: 0,
		};
		queueMicrotask(() => {
			stream.push({ type: "start", partial: message });
			stream.push({ type: "done", reason: "stop", message });
		});
		return stream;
	};
}

function collectText(message: AssistantMessage): string {
	let out = "";
	for (const block of message.content) {
		if (block.type === "text") out += block.text;
	}
	return out;
}

describe("executor kind dispatch", () => {
	it("routes kind:'subagent' members to the subagent leaf and surfaces its output", async () => {
		const runner = mockRunner([singleResult({ output: "from subagent", usage: usage(7, 3) })]);
		const deps: SwarmExecutorDeps = {
			resolveModel: id => ({ id }) as unknown as Model,
			streamSimple: fixedModelStream("from model", usage(99, 99)),
			subagent: { runSubprocess: runner.runSubprocess, agent, cwd: "/repo" },
		};
		const swarm: SwarmSpec = {
			strategy: "sequence",
			members: [{ role: "explore", model: "m", kind: "subagent" }],
		};

		const message = await createSwarmStreamSimple(deps)(blendModel(swarm), context(), undefined).result();

		// Surfaced content is the subagent's output, not the model leaf's.
		expect(collectText(message)).toBe("from subagent");
		expect(message.usage.input).toBe(7);
		expect(message.usage.output).toBe(3);
		expect(runner.calls).toHaveLength(1);
	});

	for (const { label, member } of [
		{ label: "unset kind", member: { role: "answer", model: "m" } as SwarmMember },
		{ label: "explicit kind:'model'", member: { role: "answer", model: "m", kind: "model" } as SwarmMember },
	]) {
		it(`routes ${label} members to the model leaf`, async () => {
			const runner = mockRunner();
			const deps: SwarmExecutorDeps = {
				resolveModel: id => ({ id }) as unknown as Model,
				streamSimple: fixedModelStream("from model", usage(5, 5)),
				subagent: { runSubprocess: runner.runSubprocess, agent, cwd: "/repo" },
			};
			const swarm: SwarmSpec = { strategy: "sequence", members: [member] };

			const message = await createSwarmStreamSimple(deps)(blendModel(swarm), context(), undefined).result();

			expect(collectText(message)).toBe("from model");
			// The subagent runner was never touched for a model member.
			expect(runner.calls).toHaveLength(0);
		});
	}

	it("pipes a model draft into a subagent refiner (mixed-kind sequence)", async () => {
		const runner = mockRunner([singleResult({ output: "refined", usage: usage(1, 1) })]);
		const deps: SwarmExecutorDeps = {
			resolveModel: id => ({ id }) as unknown as Model,
			streamSimple: fixedModelStream("draft", usage(2, 2)),
			subagent: { runSubprocess: runner.runSubprocess, agent, cwd: "/repo" },
		};
		const swarm: SwarmSpec = {
			strategy: "draft-refine",
			members: [
				{ role: "draft", model: "m" },
				{ role: "refine", model: "m2", kind: "subagent" },
			],
		};

		const message = await createSwarmStreamSimple(deps)(blendModel(swarm), context(), undefined).result();

		// Terminal (subagent) member is surfaced; usage is summed across both.
		expect(collectText(message)).toBe("refined");
		expect(message.usage.input).toBe(3);
		expect(message.usage.output).toBe(3);
		// The subagent's task is the model draft's output (the piped variable tail).
		expect(runner.calls[0].task).toBe("draft");
	});

	it("fails fast when a subagent member has no configured runner", async () => {
		const deps: SwarmExecutorDeps = {
			resolveModel: id => ({ id }) as unknown as Model,
			streamSimple: fixedModelStream("from model", usage(1, 1)),
			// no `subagent` configured
		};
		const swarm: SwarmSpec = {
			strategy: "sequence",
			members: [{ role: "explore", model: "m", kind: "subagent" }],
		};

		await expect(createSwarmStreamSimple(deps)(blendModel(swarm), context(), undefined).result()).rejects.toThrow(
			/no subagent runner is configured/,
		);
	});
});

// ── static import-direction guard (KTD-2) ────────────────────────────────────

describe("import direction (KTD-2)", () => {
	it("no coding-agent or ai source imports @oh-my-pi/swarm-extension", () => {
		const roots = [path.resolve(import.meta.dir, "../src"), path.resolve(import.meta.dir, "../../ai/src")];
		// Match a REAL module specifier (static `from "..."` / dynamic `import("...")` /
		// `require("...")`), NOT a prose mention of the package name in a doc comment —
		// the package name appears legitimately in KTD-2 comments documenting the ban.
		const importSpecifier = /(?:\bfrom|\bimport|\brequire)\s*\(?\s*["']@oh-my-pi\/swarm-extension(?:\/[^"']*)?["']/;
		const offenders: string[] = [];
		const walk = (dir: string) => {
			for (const entry of readdirSync(dir)) {
				const full = path.join(dir, entry);
				const st = statSync(full);
				if (st.isDirectory()) {
					walk(full);
					continue;
				}
				if (!/\.(ts|tsx|mts|cts)$/.test(entry)) continue;
				const text = readFileSync(full, "utf8");
				if (importSpecifier.test(text)) offenders.push(full);
			}
		};
		for (const root of roots) walk(root);
		expect(offenders).toEqual([]);
	});
});
