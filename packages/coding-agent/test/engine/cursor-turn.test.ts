import { describe, expect, it } from "bun:test";
import { Agent, type AgentEvent, type AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { type Agent as AcpAgent, AgentSideConnection, ndJsonStream } from "@oh-my-pi/pi-utils/acp";
import { CursorAcpSession } from "../../src/engine/cursor-acp";
import { type CursorTurnOptions, cursorTurn } from "../../src/engine/cursor-turn";
import { SessionManager } from "../../src/session/session-manager";

const model: Model = {
	id: "auto",
	name: "Cursor Auto",
	provider: "cursor",
	api: "openai-completions",
	baseUrl: "",
	compat: undefined,
	reasoning: true,
	input: ["text"],
	contextWindow: 128000,
	maxTokens: 4096,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

function fixture(
	overrides: (server: () => AgentSideConnection) => Partial<AcpAgent>,
	extra: Partial<CursorTurnOptions> = {},
) {
	const manager = extra.sessionManager ?? SessionManager.inMemory();
	const observed: AgentEvent[] = [];
	const persisted: AgentMessage[] = [];
	let opened = 0;
	let killed = 0;
	const loop = cursorTurn({
		model,
		sessionManager: manager,
		beforePrompt: async () => {},
		toolExecutionHook: { before: async () => ({ invocationId: "effect-1" }), after: async () => {} },
		open: options => {
			opened++;
			const outbound = new TransformStream<Uint8Array, Uint8Array>();
			const inbound = new TransformStream<Uint8Array, Uint8Array>();
			const server = new AgentSideConnection(
				() => ({
					initialize: () => ({ protocolVersion: 1, agentCapabilities: { loadSession: true } }),
					newSession: () => ({ sessionId: "cursor-1" }),
					loadSession: () => ({}),
					prompt: () => ({ stopReason: "end_turn" }),
					cancel: () => {},
					...overrides(() => server),
				}),
				ndJsonStream(inbound.writable, outbound.readable),
			);
			return new CursorAcpSession(ndJsonStream(outbound.writable, inbound.readable), () => killed++, options);
		},
		...extra,
	});
	const agent = new Agent({ initialState: { model }, externalLoop: loop });
	agent.subscribe(event => {
		observed.push(structuredClone(event));
		if (event.type === "message_end") {
			persisted.push(event.message);
			if (event.message.role === "user" || event.message.role === "assistant" || event.message.role === "toolResult")
				manager.appendMessage(event.message);
		}
	});
	return { agent, loop, manager, observed, persisted, counts: () => ({ opened, killed }) };
}

describe("Cursor native Engine turn", () => {
	it("persists native tool origin before admitting permission and retains thought/output order", async () => {
		const order: string[] = [];
		const run = fixture(
			server => ({
				prompt: async () => {
					await server().sessionUpdate({
						sessionId: "cursor-1",
						update: {
							sessionUpdate: "agent_thought_chunk",
							content: { type: "text", text: "checking" },
						},
					});
					const result = await server().requestPermission({
						sessionId: "cursor-1",
						toolCall: { toolCallId: "t1", kind: "execute", rawInput: { command: "pwd" } },
						options: [{ optionId: "once", name: "Allow once", kind: "allow_once" }],
					});
					expect(result.outcome).toEqual({ outcome: "selected", optionId: "once" });
					order.push("executed");
					await server().sessionUpdate({
						sessionId: "cursor-1",
						update: {
							sessionUpdate: "tool_call_update",
							toolCallId: "t1",
							status: "completed",
							rawOutput: "test cwd",
						},
					});
					await server().sessionUpdate({
						sessionId: "cursor-1",
						update: {
							sessionUpdate: "agent_message_chunk",
							content: { type: "text", text: "done" },
						},
					});
					return { stopReason: "end_turn" };
				},
			}),
			{
				toolExecutionHook: {
					before: async call => {
						const last = run.persisted.at(-1);
						expect(last?.role).toBe("assistant");
						if (last?.role === "assistant")
							expect(last.content.at(-1)).toMatchObject({ type: "toolCall", id: call.toolCallId });
						order.push("admitted");
						return { invocationId: "effect-1" };
					},
					after: async () => {
						order.push("settled");
					},
				},
			},
		);
		await run.agent.prompt("test");
		expect(order).toEqual(["admitted", "executed", "settled"]);
		expect(run.persisted.map(message => message.role)).toEqual(["user", "assistant", "toolResult", "assistant"]);
		expect(run.agent.state.isStreaming).toBe(false);
		expect(run.counts()).toEqual({ opened: 1, killed: 1 });
	});

	it("reopens exact session without duplicating retained updates", async () => {
		let creates = 0;
		let loads = 0;
		const run = fixture(server => ({
			newSession: () => {
				creates++;
				return { sessionId: "cursor-1" };
			},
			loadSession: async request => {
				loads++;
				expect(request.sessionId).toBe("cursor-1");
				await server().sessionUpdate({
					sessionId: "cursor-1",
					update: {
						sessionUpdate: "agent_message_chunk",
						content: { type: "text", text: "replay" },
					},
				});
				return {};
			},
			prompt: async () => {
				await server().sessionUpdate({
					sessionId: "cursor-1",
					update: {
						sessionUpdate: "agent_message_chunk",
						content: { type: "text", text: "fresh" },
					},
				});
				return { stopReason: "refusal" };
			},
		}));
		await run.agent.prompt("one");
		await run.agent.prompt("two");
		expect({ creates, loads }).toEqual({ creates: 1, loads: 1 });
		expect(run.persisted.filter(message => message.role === "assistant")).toHaveLength(2);
		expect(JSON.stringify(run.persisted)).not.toContain("replay");
		expect(run.persisted.at(-1)).toMatchObject({ stopReason: "stop", usage: { unavailable: true } });
	});

	it("quota denial dispatches nothing and yields an honest native error", async () => {
		const run = fixture(() => ({}), {
			beforePrompt: async () => {
				throw new Error("quota unavailable");
			},
		});
		await run.agent.prompt("test");
		expect(run.counts().opened).toBe(0);
		expect(run.agent.state.error).toContain("quota unavailable");
	});

	it("closing the history consumer cannot strand the session", async () => {
		const run = fixture(() => ({}));
		const stream = run.loop(
			[{ role: "user", content: "test", timestamp: 1 }],
			{ systemPrompt: [], messages: [], tools: [] },
			new AbortController().signal,
		);
		for await (const event of stream) if (event.type === "message_end") break;
		expect(run.counts().opened).toBe(0);
	});
});
