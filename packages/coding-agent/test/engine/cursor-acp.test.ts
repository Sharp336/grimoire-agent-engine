import { describe, expect, it } from "bun:test";
import { type Agent, AgentSideConnection, ndJsonStream, type SessionNotification } from "@oh-my-pi/pi-utils/acp";
import { type CursorAcpOptions, CursorAcpSession } from "../../src/engine/cursor-acp";

function fixture(overrides: Partial<Agent> = {}, options: Partial<CursorAcpOptions> = {}) {
	const outbound = new TransformStream<Uint8Array, Uint8Array>();
	const inbound = new TransformStream<Uint8Array, Uint8Array>();
	const updates: { notification: SessionNotification; replay: boolean }[] = [];
	const bindings: string[] = [];
	let killed = 0;
	let prompts = 0;
	let creates = 0;
	const server = new AgentSideConnection(
		() => ({
			initialize: () => ({ protocolVersion: 1, agentCapabilities: { loadSession: true } }),
			newSession: () => {
				creates++;
				return { sessionId: "cursor-1" };
			},
			prompt: async () => {
				prompts++;
				return { stopReason: "end_turn" };
			},
			cancel: () => {},
			...overrides,
		}),
		ndJsonStream(inbound.writable, outbound.readable),
	);
	const session = new CursorAcpSession(ndJsonStream(outbound.writable, inbound.readable), () => killed++, {
		cwd: process.cwd(),
		onSession: async id => {
			bindings.push(id);
		},
		onUpdate: (notification, replay) => {
			updates.push({ notification, replay });
		},
		onPermission: async () => ({ outcome: { outcome: "cancelled" } }),
		requestTimeoutMs: 1000,
		cancelTimeoutMs: 10,
		...options,
	});
	return { session, server, updates, bindings, counts: () => ({ killed, prompts, creates }) };
}

describe("official Cursor ACP lifecycle", () => {
	it("persists the binding before dispatch and never resubmits a failed prompt", async () => {
		const failedPersistence = fixture(
			{},
			{
				onSession: async () => {
					throw new Error("disk full");
				},
			},
		);
		await expect(failedPersistence.session.initialize()).rejects.toThrow("disk full");
		await expect(failedPersistence.session.prompt([])).rejects.toThrow("not ready");
		expect(failedPersistence.counts()).toEqual({ killed: 1, prompts: 0, creates: 1 });
		const run = fixture();
		await run.session.initialize();
		expect(run.bindings).toEqual(["cursor-1"]);
		await expect(run.session.prompt([{ type: "text", text: "hi" }])).resolves.toEqual({ stopReason: "end_turn" });
		expect(run.counts().prompts).toBe(1);
		run.session.dispose();
	});

	it("loads exact identity and marks retained updates instead of creating a new chat", async () => {
		const run = fixture(
			{
				loadSession: async request => {
					expect(request.sessionId).toBe("retained");
					await run.server.sessionUpdate({
						sessionId: request.sessionId,
						update: {
							sessionUpdate: "agent_message_chunk",
							content: { type: "text", text: "earlier" },
						},
					});
					return {};
				},
			},
			{ sessionId: "retained" },
		);
		await run.session.initialize();
		expect(run.counts().creates).toBe(0);
		expect(run.updates).toHaveLength(1);
		expect(run.updates[0].replay).toBe(true);
		expect(run.bindings).toEqual(["retained"]);
		run.session.dispose();
		const unsupported = fixture({ initialize: () => ({ protocolVersion: 1 }) }, { sessionId: "retained" });
		await expect(unsupported.session.initialize()).rejects.toThrow("refusing to create");
		expect(unsupported.counts().creates).toBe(0);
	});

	it("rejects unavailable models and unsupported blocking extensions explicitly", async () => {
		const run = fixture({}, { model: "invented" });
		await expect(run.session.initialize()).rejects.toThrow("not selectable");
		const extensions = fixture();
		await extensions.session.initialize();
		await expect(extensions.server.request("cursor/ask_question", {})).rejects.toMatchObject({ code: -32601 });
		extensions.session.dispose();
	});

	it("cancels once, rejects concurrent prompt, and bounds an unresponsive peer", async () => {
		const pending = Promise.withResolvers<{ stopReason: "cancelled" }>();
		const started = Promise.withResolvers<void>();
		let cancels = 0;
		const run = fixture({
			prompt: () => {
				started.resolve();
				return pending.promise;
			},
			cancel: () => {
				cancels++;
			},
		});
		await run.session.initialize();
		const result = run.session.prompt([]);
		void result.catch(() => {});
		await started.promise;
		await expect(run.session.prompt([])).rejects.toThrow("queue this message");
		await run.session.cancel();
		await run.session.cancel();
		await expect(result).rejects.toThrow("closed");
		expect(cancels).toBe(1);
		expect(run.counts().killed).toBe(1);
		pending.resolve({ stopReason: "cancelled" });
	});

	it("denies permissions by default and rejects foreign-session updates", async () => {
		const run = fixture({
			prompt: async () => {
				const permission = await run.server.requestPermission({
					sessionId: "cursor-1",
					toolCall: { toolCallId: "t1" },
					options: [{ optionId: "allow", kind: "allow_once", name: "Allow" }],
				});
				expect(permission.outcome.outcome).toBe("cancelled");
				await run.server.sessionUpdate({
					sessionId: "someone-else",
					update: { sessionUpdate: "plan", entries: [] },
				});
				return { stopReason: "end_turn" };
			},
		});
		await run.session.initialize();
		await expect(run.session.prompt([])).rejects.toThrow("different session");
		expect(run.updates).toHaveLength(0);
	});
});
