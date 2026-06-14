/**
 * U6 — `omp-swarm` blend executor.
 *
 * Exercises the executor against mock member models (no network). Two seams are
 * covered:
 *   1. {@link createSwarmStreamSimple} with injected mock deps — the direct,
 *      registry-free contract (the real U6 deliverable);
 *   2. dispatch through the global custom-API registry via {@link registerSwarmApi}
 *      + {@link getCustomApi}, proving `api: "omp-swarm"` routes to the executor.
 *
 * Assertions track the plan's scenarios: surfaced message + SUMMED usage; router
 * surfaces exactly one member; draft-refine pipes draft→refiner and surfaces the
 * refiner; moa surfaces the aggregator and sums every proposer's usage; an abort
 * signal is fatal; and every member call shares a byte-identical cache prefix
 * (KTD-8).
 */

import { afterEach, describe, expect, it } from "bun:test";
import {
	type AssistantMessage,
	type Context,
	clearCustomApis,
	getCustomApi,
	type Model,
	type Usage,
} from "@oh-my-pi/pi-ai";
import { createMockModel, type MockModel, streamMock } from "@oh-my-pi/pi-ai/providers/mock";
import type { SwarmSpec } from "@oh-my-pi/pi-catalog/types";
import {
	createSwarmStreamSimple,
	OMP_BASE_URL,
	OMP_PROVIDER_NAME,
	OMP_SWARM_API,
	registerSwarmApi,
	type SwarmExecutorDeps,
} from "@oh-my-pi/pi-coding-agent/swarm/executor";

afterEach(() => {
	clearCustomApis();
});

/** A blend `Model` carrying the given spec. The executor only reads `swarm` + identity. */
function blendModel(swarm: SwarmSpec, id = "omp/test-blend"): Model {
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

/** A base conversation context with a single user turn — the stable cache prefix. */
function baseContext(prompt = "refactor the parser"): Context {
	return {
		systemPrompt: ["You are a coding agent."],
		tools: [],
		messages: [{ role: "user", content: prompt, timestamp: 1 }],
	};
}

/**
 * Build executor deps from a role→MockModel map. `resolveModel` indexes the map;
 * `streamSimple` forwards to the mock transport. The returned `models` handle
 * exposes every mock for call inspection.
 */
function mockDeps(models: Record<string, MockModel>): { deps: SwarmExecutorDeps; models: Record<string, MockModel> } {
	const deps: SwarmExecutorDeps = {
		resolveModel: id => {
			const model = models[id];
			if (!model) throw new Error(`test resolveModel: no mock for "${id}"`);
			return model as unknown as Model;
		},
		streamSimple: (model, context, options) => streamMock(model, context, options),
	};
	return { deps, models };
}

/** Usage with explicit input/output token counts (cost recomputed by the executor's sum). */
function usage(input: number, output: number): Partial<Usage> {
	return {
		input,
		output,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: input + output,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

/** Collect the text of an assistant message. */
function text(message: AssistantMessage): string {
	let out = "";
	for (const block of message.content) {
		if (block.type === "text") out += block.text;
	}
	return out;
}

describe("omp-swarm blend executor", () => {
	it("dispatches through getCustomApi('omp-swarm') and surfaces the member message with summed usage", async () => {
		const drafter = createMockModel({ id: "weak", responses: [{ content: ["draft answer"], usage: usage(10, 5) }] });
		const refiner = createMockModel({
			id: "strong",
			responses: [{ content: ["refined answer"], usage: usage(20, 8) }],
		});
		const { deps } = mockDeps({ weak: drafter, strong: refiner });
		// Register the global dispatcher (deps as fallback) and route via the registry.
		registerSwarmApi(deps);
		const api = getCustomApi(OMP_SWARM_API);
		expect(api).toBeDefined();

		const swarm: SwarmSpec = {
			strategy: "draft-refine",
			members: [
				{ role: "draft", model: "weak" },
				{ role: "refine", model: "strong" },
			],
		};
		const message = await api!.streamSimple(blendModel(swarm), baseContext(), undefined).result();

		// Surface is the terminal (refiner) member.
		expect(text(message)).toBe("refined answer");
		// Usage is summed across BOTH members, with derived totals recomputed.
		expect(message.usage.input).toBe(30);
		expect(message.usage.output).toBe(13);
		expect(message.usage.totalTokens).toBe(43);
	});

	it("router surfaces exactly one member and leaves the others uncalled", async () => {
		const fast = createMockModel({ id: "fast", responses: [{ content: ["fast reply"], usage: usage(5, 5) }] });
		const slow = createMockModel({ id: "slow", responses: [{ content: ["slow reply"], usage: usage(50, 50) }] });
		const { deps } = mockDeps({ fast, slow });

		const swarm: SwarmSpec = {
			strategy: "router",
			// No selector → rule default picks the first member ("fast").
			members: [
				{ role: "fast", model: "fast" },
				{ role: "slow", model: "slow" },
			],
		};
		const message = await createSwarmStreamSimple(deps)(blendModel(swarm), baseContext(), undefined).result();

		expect(text(message)).toBe("fast reply");
		// Exactly one member ran; the unrouted member was never invoked.
		expect(fast.calls).toHaveLength(1);
		expect(slow.calls).toHaveLength(0);
		// Surfaced usage is the single chosen member's.
		expect(message.usage.totalTokens).toBe(10);
	});

	it("router classifier verdict selects the matching member", async () => {
		const codeModel = createMockModel({ id: "code", responses: [{ content: ["code answer"], usage: usage(7, 7) }] });
		const proseModel = createMockModel({
			id: "prose",
			responses: [{ content: ["prose answer"], usage: usage(9, 9) }],
		});
		// Classifier emits the winning role verbatim.
		const classifier = createMockModel({ id: "judge", responses: [{ content: ["prose"], usage: usage(2, 1) }] });
		const { deps } = mockDeps({ code: codeModel, prose: proseModel, judge: classifier });

		const swarm: SwarmSpec = {
			strategy: "router",
			selector: { kind: "classifier", model: "judge" },
			members: [
				{ role: "code", model: "code" },
				{ role: "prose", model: "prose" },
			],
		};
		const message = await createSwarmStreamSimple(deps)(blendModel(swarm), baseContext(), undefined).result();

		expect(text(message)).toBe("prose answer");
		expect(codeModel.calls).toHaveLength(0);
		expect(proseModel.calls).toHaveLength(1);
		expect(classifier.calls).toHaveLength(1);
		// Summed usage = classifier + chosen member (the classifier spends tokens too).
		expect(message.usage.input).toBe(11);
		expect(message.usage.output).toBe(10);
	});

	it("draft-refine pipes the draft output into the refiner as a fresh user turn", async () => {
		const drafter = createMockModel({ id: "weak", responses: [{ content: ["DRAFT"], usage: usage(1, 1) }] });
		const refiner = createMockModel({ id: "strong", responses: [{ content: ["FINAL"], usage: usage(1, 1) }] });
		const { deps } = mockDeps({ weak: drafter, strong: refiner });

		const swarm: SwarmSpec = {
			strategy: "draft-refine",
			members: [
				{ role: "draft", model: "weak" },
				{ role: "refine", model: "strong" },
			],
		};
		await createSwarmStreamSimple(deps)(blendModel(swarm), baseContext(), undefined).result();

		// The drafter saw the original context (one user turn).
		expect(drafter.calls[0].context.messages).toHaveLength(1);
		// The refiner saw the original prefix PLUS the drafter's output appended.
		const refinerMessages = refiner.calls[0].context.messages;
		expect(refinerMessages).toHaveLength(2);
		const appended = refinerMessages[1];
		expect(appended.role).toBe("user");
		expect(appended.content).toBe("DRAFT");
	});

	it("moa surfaces the aggregator and sums all proposer usage", async () => {
		const p1 = createMockModel({ id: "p1", responses: [{ content: ["proposal one"], usage: usage(10, 10) }] });
		const p2 = createMockModel({ id: "p2", responses: [{ content: ["proposal two"], usage: usage(10, 10) }] });
		const agg = createMockModel({ id: "agg", responses: [{ content: ["synthesis"], usage: usage(30, 15) }] });
		const { deps } = mockDeps({ p1, p2, agg });

		const swarm: SwarmSpec = {
			strategy: "moa",
			members: [
				{ role: "proposer", model: "p1" },
				{ role: "proposer", model: "p2" },
				{ role: "aggregator", model: "agg" },
			],
		};
		const stream = createSwarmStreamSimple(deps)(blendModel(swarm), baseContext(), undefined);

		// moa emits an early `start` placeholder before the aggregate completes (KTD-7).
		// Collect the full event sequence and AWAIT it so the assertions never race
		// the stream draining (and any late stream error surfaces inside the test).
		const events: string[] = [];
		const collector = (async () => {
			for await (const event of stream) events.push(event.type);
		})();
		const message = await stream.result();
		await collector;

		expect(text(message)).toBe("synthesis");
		// Summed usage = both proposers + aggregator.
		expect(message.usage.input).toBe(50);
		expect(message.usage.output).toBe(35);
		expect(message.usage.totalTokens).toBe(85);
		// The aggregator received a prompt that embeds BOTH proposals.
		const aggInput = agg.calls[0].context.messages.at(-1);
		expect(aggInput?.role).toBe("user");
		expect(String(aggInput?.content)).toContain("proposal one");
		expect(String(aggInput?.content)).toContain("proposal two");
		// First emitted event is a `start` (the synthesizing placeholder).
		expect(events[0]).toBe("start");
	});

	it("moa drops a failed proposer from the aggregator prompt and still reduces", async () => {
		const ok = createMockModel({ id: "ok", responses: [{ content: ["good proposal"], usage: usage(10, 10) }] });
		// A `{ throw }` mock emits a TERMINAL error event, which RESOLVES result()
		// with an error message (stopReason "error", empty content, zero usage) —
		// it does NOT reject. So the failed proposer arrives as a fulfilled, empty
		// DriveResult; the executor drops it by `stopReason`, not by a rejection.
		const bad = createMockModel({ id: "bad", responses: [{ throw: "proposer exploded" }] });
		const agg = createMockModel({ id: "agg", responses: [{ content: ["reduced"], usage: usage(5, 5) }] });
		const { deps } = mockDeps({ ok, bad, agg });

		const swarm: SwarmSpec = {
			strategy: "moa",
			members: [
				{ role: "proposer", model: "ok" },
				{ role: "proposer", model: "bad" },
				{ role: "aggregator", model: "agg" },
			],
		};
		const message = await createSwarmStreamSimple(deps)(blendModel(swarm), baseContext(), undefined).result();

		expect(text(message)).toBe("reduced");
		// Usage sums every member's usage; the failed proposer contributes zero, so
		// the total is the surviving proposer (10) + aggregator (5).
		expect(message.usage.input).toBe(15);
		const aggPrompt = String(agg.calls[0].context.messages.at(-1)?.content);
		// The surviving proposal is embedded.
		expect(aggPrompt).toContain("good proposal");
		// The failed proposer is DROPPED: exactly one numbered Proposal section is
		// present, so the aggregator never sees an empty "### Proposal 2".
		expect(aggPrompt).toContain("### Proposal 1");
		expect(aggPrompt).not.toContain("### Proposal 2");
	});

	it("moa fails loudly when every proposer fails (nothing to synthesize)", async () => {
		// Both proposers emit terminal error events (resolve-not-reject), so the
		// primitive's allSettled drop branch never fires; the executor detects the
		// all-failed case by stopReason and fails loud rather than feeding the
		// aggregator a content-free prompt.
		const bad1 = createMockModel({ id: "bad1", responses: [{ throw: "boom one" }] });
		const bad2 = createMockModel({ id: "bad2", responses: [{ throw: "boom two" }] });
		const agg = createMockModel({ id: "agg", responses: [{ content: ["unreachable"], usage: usage(5, 5) }] });
		const { deps } = mockDeps({ bad1, bad2, agg });

		const swarm: SwarmSpec = {
			strategy: "moa",
			members: [
				{ role: "proposer", model: "bad1" },
				{ role: "proposer", model: "bad2" },
				{ role: "aggregator", model: "agg" },
			],
		};
		const stream = createSwarmStreamSimple(deps)(blendModel(swarm), baseContext(), undefined);
		await expect(stream.result()).rejects.toThrow(/all 2 proposer\(s\) failed/);
		// The aggregator never ran: there was nothing to synthesize.
		expect(agg.calls).toHaveLength(0);
	});

	it("router classifier prefers an exact role over a prefix role on overlapping names", async () => {
		// Roles `code` and `coder` overlap: `code` is a prefix of `coder`. A naive
		// first-substring match would route the verdict "coder" to `code` (checked
		// first). Exact/word-boundary matching must select `coder`.
		const code = createMockModel({ id: "code", responses: [{ content: ["from code"], usage: usage(3, 3) }] });
		const coder = createMockModel({ id: "coder", responses: [{ content: ["from coder"], usage: usage(4, 4) }] });
		const classifier = createMockModel({ id: "judge", responses: [{ content: ["coder"], usage: usage(1, 1) }] });
		const { deps } = mockDeps({ code, coder, judge: classifier });

		const swarm: SwarmSpec = {
			strategy: "router",
			selector: { kind: "classifier", model: "judge" },
			members: [
				// `code` is declared FIRST so a substring-first matcher would wrongly win.
				{ role: "code", model: "code" },
				{ role: "coder", model: "coder" },
			],
		};
		const message = await createSwarmStreamSimple(deps)(blendModel(swarm), baseContext(), undefined).result();

		expect(text(message)).toBe("from coder");
		expect(coder.calls).toHaveLength(1);
		expect(code.calls).toHaveLength(0);
	});

	it("each member call shares a byte-identical cache prefix (KTD-8)", async () => {
		const drafter = createMockModel({ id: "weak", responses: [{ content: ["d"], usage: usage(1, 1) }] });
		const refiner = createMockModel({ id: "strong", responses: [{ content: ["f"], usage: usage(1, 1) }] });
		const { deps } = mockDeps({ weak: drafter, strong: refiner });

		const context = baseContext("stable prompt");
		const swarm: SwarmSpec = {
			strategy: "draft-refine",
			members: [
				{ role: "draft", model: "weak" },
				{ role: "refine", model: "strong" },
			],
		};
		await createSwarmStreamSimple(deps)(blendModel(swarm), context, undefined).result();

		const draftCtx = drafter.calls[0].context;
		const refineCtx = refiner.calls[0].context;
		// Same system prompt object content across every member call.
		expect(refineCtx.systemPrompt).toEqual(draftCtx.systemPrompt);
		expect(draftCtx.systemPrompt).toEqual(context.systemPrompt);
		// The shared conversation prefix (everything before the variable tail) is
		// byte-identical: the refiner's first message equals the drafter's only
		// message; only a fresh tail turn is appended, never a rewritten prefix.
		expect(refineCtx.messages[0]).toEqual(draftCtx.messages[0]);
		expect(refineCtx.messages[0]).toEqual(context.messages[0]);
		expect(refineCtx.messages).toHaveLength(2);
	});

	it("treats an abort signal as fatal", async () => {
		const member = createMockModel({ id: "m", responses: [{ content: ["never"], usage: usage(1, 1) }] });
		const { deps } = mockDeps({ m: member });
		const controller = new AbortController();
		controller.abort();

		const swarm: SwarmSpec = { strategy: "sequence", members: [{ role: "only", model: "m" }] };
		const stream = createSwarmStreamSimple(deps)(blendModel(swarm), baseContext(), { signal: controller.signal });

		await expect(stream.result()).rejects.toThrow();
		// No member ran: the abort short-circuited before dispatch.
		expect(member.calls).toHaveLength(0);
	});

	it("fails fast when the model carries no swarm spec", async () => {
		const { deps } = mockDeps({});
		const notBlend = { ...blendModel({ strategy: "sequence", members: [] }) } as Model;
		// Strip the spec to simulate a misrouted non-blend model.
		(notBlend as { swarm?: SwarmSpec }).swarm = undefined;

		const stream = createSwarmStreamSimple(deps)(notBlend, baseContext(), undefined);
		await expect(stream.result()).rejects.toThrow(/no swarm spec/);
	});

	it("registerSwarmApi installs the dispatcher once; re-registering the SAME deps is an idempotent refresh", async () => {
		const only = createMockModel({ id: "only", responses: [{ content: ["from owner"], usage: usage(1, 1) }] });
		const { deps } = mockDeps({ only });
		const firstInstall = registerSwarmApi(deps);
		// Re-registering the IDENTICAL deps object (e.g. a cached single-owner
		// reference) is a no-op refresh: the slot stays unambiguous.
		const secondInstall = registerSwarmApi(deps);
		expect(firstInstall).toBe(true);
		// The global slot is registered exactly once.
		expect(secondInstall).toBe(false);

		const swarm: SwarmSpec = { strategy: "sequence", members: [{ role: "only", model: "only" }] };
		const message = await getCustomApi(OMP_SWARM_API)!
			.streamSimple(blendModel(swarm), baseContext(), undefined)
			.result();
		// Dispatch resolves through the single active owner.
		expect(text(message)).toBe("from owner");
		expect(only.calls).toHaveLength(1);
	});

	it("first-writer-wins: a SECOND distinct registry does not rebind or break the slot", async () => {
		// The custom-API slot keys on the literal "omp-swarm" string, so it is
		// process-global. First-writer-wins: the first registry owns the slot; a
		// second DISTINCT registry must NOT rebind it (rebinding would hijack the
		// live owner's member resolution + auth) and must NOT poison it (a latch
		// would permanently break every blend after any transient second registry —
		// sdk.ts / task/executor.ts / the CLIs all build one). Dispatch keeps
		// resolving through the FIRST owner.
		const first = createMockModel({ id: "first", responses: [{ content: ["from first"], usage: usage(1, 1) }] });
		const second = createMockModel({ id: "second", responses: [{ content: ["from second"], usage: usage(1, 1) }] });
		const firstInstall = registerSwarmApi(mockDeps({ only: first }).deps);
		// A distinct deps object models a second live ModelRegistry in the process.
		const secondInstall = registerSwarmApi(mockDeps({ only: second }).deps);
		expect(firstInstall).toBe(true);
		expect(secondInstall).toBe(false);

		const swarm: SwarmSpec = { strategy: "sequence", members: [{ role: "only", model: "only" }] };
		const message = await getCustomApi(OMP_SWARM_API)!
			.streamSimple(blendModel(swarm), baseContext(), undefined)
			.result();
		// Resolves through the FIRST owner; the second registry's model never ran.
		expect(text(message)).toBe("from first");
		expect(first.calls).toHaveLength(1);
		expect(second.calls).toHaveLength(0);
	});
});
