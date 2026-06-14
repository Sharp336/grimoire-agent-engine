import { describe, expect, it } from "bun:test";
import type {
	AssistantMessage,
	AssistantMessageEvent,
	Context,
	Model,
	SimpleStreamOptions,
	SwarmMember,
	SwarmSpec,
	Usage,
} from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import {
	appendUserInputContext,
	capMembers,
	DEFAULT_MAX_MEMBERS,
	type DriveInput,
	type DriveNode,
	type DriveResult,
	emitSurface,
	modelLeafDriveNode,
	ORIGINAL_INPUT,
	pickSurface,
	runParallelAggregate,
	runRouter,
	runSequence,
	sumUsage,
} from "@oh-my-pi/pi-coding-agent/swarm/primitives";

// ── helpers ────────────────────────────────────────────────────────────────

function usage(over: Partial<Omit<Usage, "cost">> & { cost?: Partial<Usage["cost"]> } = {}): Usage {
	const base: Usage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	const merged: Usage = { ...base, ...over, cost: { ...base.cost, ...over.cost } };
	merged.totalTokens = merged.input + merged.output + merged.cacheRead + merged.cacheWrite;
	merged.cost.total = merged.cost.input + merged.cost.output + merged.cost.cacheRead + merged.cost.cacheWrite;
	return merged;
}

function assistantMessage(text: string, u: Usage = usage()): AssistantMessage {
	return {
		role: "assistant",
		content: text === "" ? [] : [{ type: "text", text }],
		api: "mock",
		provider: "mock",
		model: "mock",
		usage: u,
		stopReason: "stop",
		timestamp: 0,
	};
}

function result(output: string, u: Usage = usage()): DriveResult {
	return { message: assistantMessage(output, u), usage: u, output };
}

function member(role: string, model = `model-${role}`, extra: Partial<SwarmMember> = {}): SwarmMember {
	return { role, model, ...extra };
}

function emptyContext(): Context {
	return { messages: [] };
}

// ── sumUsage ─────────────────────────────────────────────────────────────────

describe("sumUsage", () => {
	it("sums components and recomputes derived totals", () => {
		const a = usage({ input: 10, output: 5, cost: { input: 0.1, output: 0.2 } });
		const b = usage({ input: 3, output: 7, cacheRead: 2, cost: { input: 0.05, cacheRead: 0.01 } });
		const total = sumUsage([a, b]);
		expect(total.input).toBe(13);
		expect(total.output).toBe(12);
		expect(total.cacheRead).toBe(2);
		// totalTokens recomputed from components, not trusted from inputs.
		expect(total.totalTokens).toBe(13 + 12 + 2 + 0);
		expect(total.cost.input).toBeCloseTo(0.15, 10);
		expect(total.cost.output).toBeCloseTo(0.2, 10);
		expect(total.cost.cacheRead).toBeCloseTo(0.01, 10);
		// cost.total recomputed from cost components.
		expect(total.cost.total).toBeCloseTo(0.15 + 0.2 + 0.01, 10);
	});

	it("returns a zeroed usage for an empty list", () => {
		const total = sumUsage([]);
		expect(total.totalTokens).toBe(0);
		expect(total.cost.total).toBe(0);
	});

	it("sums optional reasoningTokens only when present", () => {
		const withReasoning = sumUsage([usage({ reasoningTokens: 4 }), usage({ reasoningTokens: 6 })]);
		expect(withReasoning.reasoningTokens).toBe(10);
		const without = sumUsage([usage(), usage()]);
		expect(without.reasoningTokens).toBeUndefined();
	});
});

// ── capMembers ───────────────────────────────────────────────────────────────

describe("capMembers", () => {
	const five = [member("a"), member("b"), member("c"), member("d"), member("e"), member("f")];

	it("defaults the cap to DEFAULT_MAX_MEMBERS", () => {
		expect(DEFAULT_MAX_MEMBERS).toBe(5);
		expect(capMembers(five).map(m => m.role)).toEqual(["a", "b", "c", "d", "e"]);
	});

	it("honors an explicit positive cap and preserves order", () => {
		expect(capMembers(five, 2).map(m => m.role)).toEqual(["a", "b"]);
	});

	it("falls back to the default for a non-positive cap", () => {
		expect(capMembers(five, 0)).toHaveLength(5);
		expect(capMembers(five, -3)).toHaveLength(5);
	});
});

// ── runSequence ──────────────────────────────────────────────────────────────

describe("runSequence", () => {
	it("pipes each member's output into the next member's input (i -> i+1)", async () => {
		const seen: Array<{ role: string; input: DriveInput }> = [];
		// Render the sentinel symbol as a readable token so outputs stay strings.
		const render = (input: DriveInput): string => (input === ORIGINAL_INPUT ? "<orig>" : input);
		const drive: DriveNode = async (m, input) => {
			seen.push({ role: m.role, input });
			return result(`${m.role}:${render(input)}`);
		};
		const results = await runSequence([member("draft"), member("refine")], drive);
		// First member sees the original-prompt sentinel; second sees member 1's output.
		expect(seen).toEqual([
			{ role: "draft", input: ORIGINAL_INPUT },
			{ role: "refine", input: "draft:<orig>" },
		]);
		expect(results).toHaveLength(2);
		expect(results[1].output).toBe("refine:draft:<orig>");
	});

	it("returns every member result in run order", async () => {
		const drive: DriveNode = async m => result(m.role);
		const results = await runSequence([member("a"), member("b"), member("c")], drive);
		expect(results.map(r => r.output)).toEqual(["a", "b", "c"]);
	});

	it("throws when aborted before driving the next member", async () => {
		const controller = new AbortController();
		const drive: DriveNode = async m => {
			if (m.role === "first") controller.abort();
			return result(m.role);
		};
		await expect(runSequence([member("first"), member("second")], drive, controller.signal)).rejects.toThrow();
	});

	it("drives a downstream stage with the empty piped output, not the original context", async () => {
		// A first stage that produces NO text yields output: "". The next stage
		// must receive that empty string as a piped DriveInput — NOT the
		// ORIGINAL_INPUT sentinel — so it can never silently fall back to the
		// original context. (Regression guard for the sentinel collision.)
		const seen: Array<{ role: string; input: DriveInput; isOriginal: boolean }> = [];
		const drive: DriveNode = async (m, input) => {
			seen.push({ role: m.role, input, isOriginal: input === ORIGINAL_INPUT });
			// First stage returns empty output; downstream returns its role.
			return m.role === "draft" ? result("") : result(m.role);
		};
		await runSequence([member("draft"), member("refine")], drive);
		expect(seen[0]).toMatchObject({ role: "draft", isOriginal: true });
		// The second stage's input is the empty piped output, distinct from the sentinel.
		expect(seen[1]).toMatchObject({ role: "refine", isOriginal: false });
		expect(seen[1].input).toBe("");
	});
});

// ── runRouter ────────────────────────────────────────────────────────────────

describe("runRouter", () => {
	const members = [member("weak"), member("strong")];

	it("picks exactly one member by role and drives only it", async () => {
		const driven: string[] = [];
		const drive: DriveNode = async m => {
			driven.push(m.role);
			return result(m.role);
		};
		const { chosen, result: r } = await runRouter(members, "hard task", async () => "strong", drive);
		expect(chosen.role).toBe("strong");
		expect(r.output).toBe("strong");
		// Only one member ran.
		expect(driven).toEqual(["strong"]);
	});

	it("resolves a numeric selector choice to the member at that index", async () => {
		const drive: DriveNode = async m => result(m.role);
		const { chosen } = await runRouter(members, "easy", async () => 0, drive);
		expect(chosen.role).toBe("weak");
	});

	it("drives the chosen member with the original-prompt sentinel", async () => {
		let receivedInput: DriveInput | undefined;
		const drive: DriveNode = async (m, input) => {
			receivedInput = input;
			return result(m.role);
		};
		await runRouter(members, "the user prompt", async () => "weak", drive);
		expect(receivedInput).toBe(ORIGINAL_INPUT);
	});

	it("throws when the selector returns no matching member", async () => {
		const drive: DriveNode = async m => result(m.role);
		await expect(runRouter(members, "x", async () => "nope", drive)).rejects.toThrow(/no matching member/);
	});
});

// ── runParallelAggregate ─────────────────────────────────────────────────────

describe("runParallelAggregate", () => {
	const proposers = [member("p1"), member("p2"), member("p3")];
	const aggregator = member("aggregator");

	it("runs all proposers then the aggregator with the synthesized input", async () => {
		const order: string[] = [];
		// Proposers are driven against the sentinel; render it as "" so outputs stay strings.
		const render = (input: DriveInput): string => (input === ORIGINAL_INPUT ? "" : input);
		const drive: DriveNode = async (m, input) => {
			order.push(m.role);
			return result(`${m.role}<${render(input)}>`);
		};
		const buildAgg = (prompt: string, proposals: DriveResult[]) =>
			`SYNTH(${prompt})[${proposals.map(p => p.output).join(",")}]`;
		const { proposals, aggregate } = await runParallelAggregate(proposers, aggregator, "question", buildAgg, drive);
		expect(proposals).toHaveLength(3);
		// Aggregator runs after every proposer.
		expect(order.slice(0, 3).sort()).toEqual(["p1", "p2", "p3"]);
		expect(order[3]).toBe("aggregator");
		// Aggregator received the synthesized prompt built from proposals.
		expect(aggregate.output).toContain("SYNTH(question)");
		expect(aggregate.output).toContain("p1<>");
	});

	it("tolerates a failing proposer as long as one survives (remaining outputs reduce)", async () => {
		const drive: DriveNode = async m => {
			if (m.role === "p2") throw new Error("p2 boom");
			return result(m.role);
		};
		const seenProposals: string[] = [];
		const buildAgg = (_prompt: string, proposals: DriveResult[]) => {
			seenProposals.push(...proposals.map(p => p.output));
			return "agg";
		};
		const { proposals, aggregate } = await runParallelAggregate(proposers, aggregator, "q", buildAgg, drive);
		// Failed proposer dropped; survivors still reduce.
		expect(proposals.map(p => p.output).sort()).toEqual(["p1", "p3"]);
		expect(seenProposals.sort()).toEqual(["p1", "p3"]);
		// `aggregate` is the aggregator member's DriveResult; the stub returns
		// result(m.role), so its output is its role ("aggregator"). buildAgg's "agg"
		// is the aggregator's INPUT prompt (its consumption of survivors is asserted
		// via seenProposals above), not its output.
		expect(aggregate.output).toBe("aggregator");
	});

	it("throws when every proposer fails", async () => {
		const drive: DriveNode = async () => {
			throw new Error("all dead");
		};
		await expect(runParallelAggregate(proposers, aggregator, "q", () => "agg", drive)).rejects.toThrow(
			/proposer\(s\) failed/,
		);
	});

	it("aborts fatally instead of degrading to a partial reduce", async () => {
		const controller = new AbortController();
		const drive: DriveNode = async m => {
			controller.abort();
			return result(m.role);
		};
		await expect(
			runParallelAggregate(proposers, aggregator, "q", () => "agg", drive, controller.signal),
		).rejects.toThrow();
	});

	it("degenerates to passthrough with a single proposer", async () => {
		const drive: DriveNode = async m => result(m.role);
		const { proposals } = await runParallelAggregate(
			[member("solo")],
			aggregator,
			"q",
			(_p, ps) => ps[0].output,
			drive,
		);
		expect(proposals).toHaveLength(1);
		expect(proposals[0].output).toBe("solo");
	});
});

// ── pickSurface ──────────────────────────────────────────────────────────────

describe("pickSurface", () => {
	const a = { member: member("draft"), result: result("draft-out") };
	const b = { member: member("refine"), result: result("refine-out") };

	it("prefers the spec.surface role", () => {
		const spec: SwarmSpec = { strategy: "sequence", members: [], surface: "draft" };
		expect(pickSurface(spec, [a, b]).output).toBe("draft-out");
	});

	it("falls back to a member flagged surface: true", () => {
		const flagged = { member: member("refine", "m", { surface: true }), result: result("flagged-out") };
		const spec: SwarmSpec = { strategy: "sequence", members: [] };
		expect(pickSurface(spec, [a, flagged]).output).toBe("flagged-out");
	});

	it("falls back to the terminal member when nothing is flagged", () => {
		const spec: SwarmSpec = { strategy: "sequence", members: [] };
		expect(pickSurface(spec, [a, b]).output).toBe("refine-out");
	});

	it("throws when no members were run", () => {
		const spec: SwarmSpec = { strategy: "sequence", members: [] };
		expect(() => pickSurface(spec, [])).toThrow();
	});
});

// ── emitSurface ──────────────────────────────────────────────────────────────

describe("emitSurface", () => {
	it("settles result() with the surface message and the total usage", async () => {
		const outer = new AssistantMessageEventStream();
		const surface = assistantMessage("final answer", usage({ output: 1 }));
		const total = usage({ input: 100, output: 50 });
		emitSurface(outer, surface, total);
		const message = await outer.result();
		// Surface content is preserved...
		expect(message.content).toEqual([{ type: "text", text: "final answer" }]);
		// ...but usage is overwritten with the blend total.
		expect(message.usage.input).toBe(100);
		expect(message.usage.output).toBe(50);
		expect(message.usage.totalTokens).toBe(150);
	});

	it("emits start -> text events -> done in order", async () => {
		const outer = new AssistantMessageEventStream();
		const events: AssistantMessageEvent[] = [];
		const collect = (async () => {
			for await (const e of outer) events.push(e);
		})();
		emitSurface(outer, assistantMessage("hi", usage()), usage());
		await outer.result();
		await collect;
		const types = events.map(e => e.type);
		expect(types[0]).toBe("start");
		expect(types).toContain("text_start");
		expect(types).toContain("text_delta");
		expect(types).toContain("text_end");
		expect(types.at(-1)).toBe("done");
	});

	it("does not surface non-surface members' content (only the surface message is emitted)", async () => {
		// The surface is one member's message; a proposer's tool-call content is
		// never part of the surfaced message, so it cannot leak into the stream.
		const outer = new AssistantMessageEventStream();
		const surfaceMsg: AssistantMessage = {
			...assistantMessage("clean surface text"),
		};
		emitSurface(outer, surfaceMsg, usage());
		const message = await outer.result();
		expect(message.content.some(b => b.type === "toolCall")).toBe(false);
		expect(message.content).toEqual([{ type: "text", text: "clean surface text" }]);
	});

	it("emits a terminal error event when the surface stopped with an error", async () => {
		const outer = new AssistantMessageEventStream();
		const events: AssistantMessageEvent[] = [];
		const collect = (async () => {
			for await (const e of outer) events.push(e);
		})();
		const errored: AssistantMessage = { ...assistantMessage("partial"), stopReason: "error" };
		emitSurface(outer, errored, usage());
		// Per the AssistantMessageEventStream contract, an `error` event is a
		// terminal event whose extractResult RETURNS event.error — so result()
		// RESOLVES with the error-marked message; it does NOT reject. (This is
		// exactly how the mock provider template settles an errored stream.)
		const message = await outer.result();
		await collect;
		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toBeDefined();
		// The terminal event is an `error` event carrying the error message.
		const last = events.at(-1);
		expect(last?.type).toBe("error");
		if (last?.type === "error") {
			expect(last.reason).toBe("error");
			expect(last.error.errorMessage).toBeDefined();
		}
	});
});

// ── appendUserInputContext ───────────────────────────────────────────────────

describe("appendUserInputContext", () => {
	it("passes the original context through unchanged for ORIGINAL_INPUT", () => {
		const ctx = emptyContext();
		expect(appendUserInputContext(ctx, ORIGINAL_INPUT)).toBe(ctx);
	});

	it("always appends a non-empty input as a fresh user turn", () => {
		const ctx: Context = { messages: [{ role: "user", content: "same", timestamp: 0 }] };
		// Even when the input equals existing user text, it is appended (no
		// text-equality guessing that could silently drop a piped output).
		const next = appendUserInputContext(ctx, "same");
		expect(next.messages).toHaveLength(2);
		expect(next.messages[1]).toMatchObject({ role: "user", content: "same" });
	});

	it("appends an EMPTY piped output as a user turn rather than reverting to the original context", () => {
		// The empty string is a piped output from a stage that produced no text;
		// because ORIGINAL_INPUT is a symbol (not ""), the empty string does NOT
		// match the passthrough sentinel and must still be appended as a turn.
		const ctx: Context = { messages: [{ role: "user", content: "orig", timestamp: 0 }] };
		const next = appendUserInputContext(ctx, "");
		expect(next).not.toBe(ctx);
		expect(next.messages).toHaveLength(2);
		expect(next.messages[1]).toMatchObject({ role: "user", content: "" });
	});

	it("does not mutate the original context", () => {
		const ctx: Context = { messages: [] };
		appendUserInputContext(ctx, "piped");
		expect(ctx.messages).toHaveLength(0);
	});
});

// ── modelLeafDriveNode (the effect edge) ─────────────────────────────────────

describe("modelLeafDriveNode", () => {
	function fakeStream(text: string, u: Usage): AssistantMessageEventStream {
		const stream = new AssistantMessageEventStream();
		const msg = assistantMessage(text, u);
		stream.push({ type: "start", partial: msg });
		stream.push({ type: "done", reason: "stop", message: msg });
		return stream;
	}

	it("resolves the member's model, runs streamSimple, and maps to a DriveResult", async () => {
		const resolved: string[] = [];
		const u = usage({ input: 7, output: 3 });
		const streamSimple = (model: Model, _ctx: Context, _opts?: SimpleStreamOptions) => {
			resolved.push(model.id);
			return fakeStream("leaf output", u);
		};
		const resolveModel = (id: string): Model => ({ id }) as unknown as Model;
		const drive = modelLeafDriveNode(streamSimple, resolveModel, emptyContext());
		const r = await drive(member("worker", "provider/worker"), ORIGINAL_INPUT);
		expect(resolved).toEqual(["provider/worker"]);
		expect(r.output).toBe("leaf output");
		expect(r.usage.input).toBe(7);
		expect(r.message.content).toEqual([{ type: "text", text: "leaf output" }]);
	});

	it("builds the per-member context with the injected MemberContextBuilder", async () => {
		let receivedCtx: Context | undefined;
		const streamSimple = (_model: Model, ctx: Context) => {
			receivedCtx = ctx;
			return fakeStream("out", usage());
		};
		const resolveModel = (id: string): Model => ({ id }) as unknown as Model;
		// Default builder appends a non-empty input as a user turn.
		const drive = modelLeafDriveNode(streamSimple, resolveModel, emptyContext());
		await drive(member("refine"), "piped draft");
		expect(receivedCtx?.messages.at(-1)).toMatchObject({ role: "user", content: "piped draft" });
	});

	it("forwards the abort signal into the stream options", async () => {
		let sawSignal: AbortSignal | undefined;
		const streamSimple = (_model: Model, _ctx: Context, opts?: SimpleStreamOptions) => {
			sawSignal = opts?.signal;
			return fakeStream("out", usage());
		};
		const resolveModel = (id: string): Model => ({ id }) as unknown as Model;
		const controller = new AbortController();
		const drive = modelLeafDriveNode(streamSimple, resolveModel, emptyContext());
		await drive(member("worker"), ORIGINAL_INPUT, controller.signal);
		expect(sawSignal).toBe(controller.signal);
	});

	it("throws immediately when the signal is already aborted", async () => {
		const streamSimple = () => fakeStream("out", usage());
		const resolveModel = (id: string): Model => ({ id }) as unknown as Model;
		const controller = new AbortController();
		controller.abort();
		const drive = modelLeafDriveNode(streamSimple, resolveModel, emptyContext());
		await expect(drive(member("worker"), ORIGINAL_INPUT, controller.signal)).rejects.toThrow();
	});
});
