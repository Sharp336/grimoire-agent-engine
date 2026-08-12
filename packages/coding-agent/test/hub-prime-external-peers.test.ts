import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { AgentRegistry, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { HubTool } from "@oh-my-pi/pi-coding-agent/tools/hub";
import type { BridgeMessage, BridgeReceipt, ExternalPeer } from "@oh-my-pi/prime-bridge-protocol";
import type { ExternalPeerProvider, ExternalPeerWaitClaim } from "../src/integrations/prime-bridge";
import { normalizeExternalPeerId } from "../src/tools/hub/rendering";

const settings = {
	get: (key: string) => (key === "irc.timeoutMs" ? 100 : undefined),
} as never;

function bridgeMessage(overrides: Partial<BridgeMessage> = {}): BridgeMessage {
	return {
		meshMessageId: "mesh-1",
		idempotencyKey: "idem-1",
		originHarness: "prime",
		originSessionId: "prime-session",
		targetHarness: "omp",
		targetId: "omp-session",
		body: "hello",
		projectRoot: "/repo",
		createdAt: new Date().toISOString(),
		...overrides,
	};
}

function waitClaim(message: BridgeMessage, claimToken = "claim-1"): ExternalPeerWaitClaim {
	return { message, claimToken, claimedUntilMs: Date.now() + 30_000 };
}

function session(provider?: ExternalPeerProvider, overrides: Partial<ToolSession> = {}): ToolSession {
	const registry = AgentRegistry.global();
	registry.register({ id: MAIN_AGENT_ID, displayName: MAIN_AGENT_ID, kind: "main", session: null, status: "running" });
	return {
		cwd: "/repo",
		hasUI: false,
		settings,
		agentRegistry: registry,
		getAgentId: () => MAIN_AGENT_ID,
		externalPeerProvider: provider,
		...overrides,
	} as ToolSession;
}

function peerProvider(overrides: Partial<ExternalPeerProvider> = {}): ExternalPeerProvider {
	return {
		list: async () => [],
		send: async () => ({ meshMessageId: "receipt-1", status: "queued", extra: { keep: true } }),
		inbox: async () => [],
		wait: async () => null,
		ack: async () => true,
		release: async () => true,
		...overrides,
	};
}

beforeEach(() => {
	AgentRegistry.resetGlobalForTests();
	IrcBus.resetGlobalForTests();
});

afterEach(() => {
	AgentRegistry.resetGlobalForTests();
	IrcBus.resetGlobalForTests();
});

describe("hub Prime external peers", () => {
	it("lists normalized external rows in a separate section", async () => {
		const raw: ExternalPeer = {
			id: "prime:session-1",
			displayName: "Prime\tworker",
			status: "ready",
			activeSessionId: "session-1",
			extra: { keep: true },
		};
		const result = await new HubTool(
			session(peerProvider({ list: async () => [raw, { ...raw, id: "session-1" }] })),
		).execute("call", { op: "list" });
		if (!result.details) throw new Error("Expected details");
		expect(result.details.externalPeers).toEqual([{ ...raw, id: "prime://session-1" }]);
		const text = result.content[0];
		if (text?.type !== "text") throw new Error("Expected text");
		expect(text.text).toContain("External Prime peers:");
		expect(text.text).toContain("prime://session-1");
		expect(text.text).not.toContain("\t");
	});

	it("keeps local and external peer IDs distinct and dedupes external session IDs", async () => {
		const localSession = session(
			peerProvider({
				list: async () => [
					{ id: "session-1", activeSessionId: "session-1", displayName: "Prime one", status: "ready" },
					{ id: "prime:session-1", activeSessionId: "session-1", displayName: "Duplicate", status: "ready" },
					{ id: "session-2", activeSessionId: "session-2", displayName: "External", status: "ready" },
				],
			}),
		);
		localSession.agentRegistry?.register({
			id: "prime:session-2",
			displayName: "Local",
			kind: "sub",
			session: null,
			status: "running",
		});
		const result = await new HubTool(localSession).execute("call", { op: "list" });
		expect(result.details?.externalPeers).toEqual([
			{
				id: "prime://session-1",
				activeSessionId: "session-1",
				displayName: "Prime one",
				status: "ready",
			},
			{
				id: "prime://session-2",
				activeSessionId: "session-2",
				displayName: "External",
				status: "ready",
			},
		]);
		expect(result.details?.peers?.some(peer => peer.id === "prime:session-2")).toBe(true);
	});

	it("rejects malformed Unicode external IDs without collapsing them", () => {
		expect(() => normalizeExternalPeerId("\uD800")).toThrow("well-formed Unicode");
		expect(normalizeExternalPeerId("\uFFFD")).toBe("prime://%EF%BF%BD");
	});

	it("routes namespaced sends and preserves queued receipt fields verbatim", async () => {
		const receipt: BridgeReceipt = { meshMessageId: "receipt-1", status: "queued", extra: { keep: true } };
		let target = "";
		const provider = peerProvider({
			send: async value => {
				target = value;
				return receipt;
			},
		});
		const result = await new HubTool(session(provider)).execute("call", {
			op: "send",
			to: "prime://session%2F1",
			message: "hello",
		});
		expect(target).toBe("session/1");
		expect(result.details?.externalReceipts).toEqual([receipt]);
		expect(result.isError).not.toBe(true);
	});

	it("round-trips a legacy Prime peer row from list to send", async () => {
		let target = "";
		const provider = peerProvider({
			list: async () => [{ id: "prime:session/1", displayName: "Prime", status: "ready" }],
			send: async value => {
				target = value;
				return { meshMessageId: "receipt", status: "queued" };
			},
		});
		const tool = new HubTool(session(provider));
		const listed = await tool.execute("list", { op: "list" });
		const listedId = listed.details?.externalPeers?.[0]?.id;
		expect(listedId).toBe("prime://prime%3Asession%2F1");
		if (listedId === undefined) throw new Error("Expected external peer ID");
		await tool.execute("send", { op: "send", to: listedId, message: "hello" });
		expect(target).toBe("prime:session/1");
	});

	it("keeps a valid local list when the external provider is offline", async () => {
		const result = await new HubTool(
			session(
				peerProvider({
					list: async () => {
						throw new Error("bridge offline");
					},
				}),
			),
		).execute("call", { op: "list" });
		expect(result.isError).not.toBe(true);
		expect(result.content[0]).toEqual({ type: "text", text: "No other agents." });
	});

	it("surfaces provider failures when no local list leg exists", async () => {
		const result = await new HubTool(
			session(
				peerProvider({
					list: async () => {
						throw new Error("bridge offline");
					},
				}),
				{ agentRegistry: undefined },
			),
		).execute("call", { op: "list" });
		expect(result.isError).toBe(true);
		expect(result.content[0]).toEqual({
			type: "text",
			text: "Prime external peer provider failed during list: bridge offline",
		});
	});

	it("leaves local sends on IrcBus when an external provider exists", async () => {
		let called = false;
		const provider = peerProvider({
			send: async () => {
				called = true;
				return { meshMessageId: "x", status: "queued" };
			},
		});
		const result = await new HubTool(session(provider)).execute("call", {
			op: "send",
			to: "Worker",
			message: "hello",
		});
		expect(called).toBe(false);
		expect(result.details?.receipts?.[0]).toMatchObject({ to: "Worker", outcome: "failed" });
	});

	it("routes an exact visible prime-prefixed local ID locally", async () => {
		let externalCalled = false;
		const localSession = session(
			peerProvider({
				send: async () => {
					externalCalled = true;
					return { meshMessageId: "external", status: "queued" };
				},
			}),
		);
		localSession.agentRegistry?.register({
			id: "prime:local",
			displayName: "Local",
			kind: "sub",
			parentId: MAIN_AGENT_ID,
			session: { deliverIrcMessage: async () => "injected" } as never,
			status: "running",
		});
		const result = await new HubTool(localSession).execute("call", {
			op: "send",
			to: "prime:local",
			message: "local",
		});

		expect(externalCalled).toBe(false);
		expect(result.details?.receipts?.[0]).toMatchObject({ to: "prime:local", outcome: "injected" });
	});

	it("keeps the local inbox when the external provider is offline", async () => {
		const localSession = session(
			peerProvider({
				inbox: async () => {
					throw new Error("bridge offline");
				},
			}),
		);
		const result = await new HubTool(localSession).execute("call", { op: "inbox" });
		expect(result.isError).not.toBe(true);
		expect(result.content[0]).toEqual({ type: "text", text: "Inbox empty." });
	});

	it("sanitizes ANSI, OSC, and C0 bytes from external display fields", async () => {
		const external = bridgeMessage({
			meshMessageId: "\u001b[31mmesh\u001b[0m",
			originSessionId: "session\u001b]0;title\u0007",
			body: "body\u0000\u001b[2K",
			replyTo: "reply\u001b[32m",
		});
		const result = await new HubTool(session(peerProvider({ wait: async () => waitClaim(external) }))).execute(
			"call",
			{
				op: "wait",
				timeoutMs: 100,
			},
		);
		const text = result.content[0];
		if (text?.type !== "text") throw new Error("Expected text");
		expect(text.text).toBe("[mesh] prime://session%1B%5D0%3Btitle%07 (reply to reply): body");
		expect(text.text).not.toMatch(/\u001b|\u0000|\u0007/);
	});

	it("merges local and external inboxes", async () => {
		const external = bridgeMessage({ body: "prime\tbody" });
		const provider = peerProvider({ inbox: async () => [external] });
		const result = await new HubTool(session(provider)).execute("call", { op: "inbox" });
		expect(result.details?.externalInbox).toEqual([external]);
		const text = result.content[0];
		if (text?.type !== "text") throw new Error("Expected text");
		expect(text.text).toContain("body");
		expect(text.text).not.toContain("\t");
	});

	it("uses the filtered external wait without pre-draining unmatched Prime messages", async () => {
		const external = { ...bridgeMessage(), extra: { keep: true } };
		let inboxCalls = 0;
		const provider = peerProvider({
			inbox: async () => {
				inboxCalls++;
				return [external];
			},
			wait: async () => null,
		});
		const localSession = session(provider, { agentRegistry: undefined });
		const waited = await new HubTool(localSession).execute("call", {
			op: "wait",
			from: "prime://other",
			timeoutMs: 100,
		});
		expect(waited.details?.externalWaited).toBeNull();
		const inbox = await new HubTool(localSession).execute("call", { op: "inbox" });
		expect(inboxCalls).toBe(1);
		expect(inbox.details?.externalInbox).toEqual([external]);
	});

	it("does not let a local reserved ID satisfy an external wait", async () => {
		const external = bridgeMessage({ originSessionId: "victim", body: "external" });
		const provider = peerProvider({ wait: async () => waitClaim(external) });
		const localSession = session(provider, { asyncJobManager: undefined });
		localSession.agentRegistry?.register({
			id: "prime://victim",
			displayName: "Local collision",
			parentId: MAIN_AGENT_ID,
			kind: "sub",
			session: null,
			status: "running",
		});
		await IrcBus.global().send({ from: "prime://victim", to: MAIN_AGENT_ID, body: "local" });

		const result = await new HubTool(localSession).execute("call", {
			op: "wait",
			from: "prime://victim",
			timeoutMs: 100,
		});
		expect(result.details?.externalWaited).toEqual(external);
		expect(result.details?.waited).toBeUndefined();
	});

	it("does not let a local reserved ID satisfy an external wait beside a job", async () => {
		const external = bridgeMessage({ originSessionId: "victim", body: "external" });
		const provider = peerProvider({ wait: async () => waitClaim(external) });
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const gate = Promise.withResolvers<string>();
		manager.register("task", "held job", () => gate.promise, { id: "held-job", ownerId: MAIN_AGENT_ID });
		const localSession = session(provider, { asyncJobManager: manager });
		localSession.agentRegistry?.register({
			id: "prime://victim",
			displayName: "Local collision",
			parentId: MAIN_AGENT_ID,
			kind: "sub",
			session: null,
			status: "running",
		});
		await IrcBus.global().send({ from: "prime://victim", to: MAIN_AGENT_ID, body: "local" });

		const result = await new HubTool(localSession).execute("call", {
			op: "wait",
			from: "prime://victim",
			timeoutMs: 100,
		});
		gate.resolve("done");
		await manager.dispose({ timeoutMs: 100 });
		expect(result.details?.externalWaited).toEqual(external);
		expect(result.details?.waited).toBeUndefined();
	});

	it("rejects a malformed reserved wait target", async () => {
		let waitCalls = 0;
		const provider = peerProvider({
			wait: async () => {
				waitCalls++;
				return null;
			},
		});
		const result = await new HubTool(session(provider, { asyncJobManager: undefined })).execute("call", {
			op: "wait",
			from: "prime://%",
			timeoutMs: 100,
		});
		expect(result.isError).toBe(true);
		expect(waitCalls).toBe(0);
	});

	it("releases a claim when acknowledgement returns false", async () => {
		let releases = 0;
		const provider = peerProvider({
			wait: async () => waitClaim(bridgeMessage()),
			ack: async () => false,
			release: async () => {
				releases++;
				return true;
			},
		});
		const result = await new HubTool(session(provider, { asyncJobManager: undefined })).execute("call", {
			op: "wait",
			timeoutMs: 100,
		});
		expect(result.isError).toBe(true);
		expect(releases).toBeGreaterThan(0);
	});

	it("releases a claim when acknowledgement throws", async () => {
		let releases = 0;
		const provider = peerProvider({
			wait: async () => waitClaim(bridgeMessage()),
			ack: async () => {
				throw new Error("ack unavailable");
			},
			release: async () => {
				releases++;
				return true;
			},
		});
		const result = await new HubTool(session(provider, { asyncJobManager: undefined })).execute("call", {
			op: "wait",
			timeoutMs: 100,
		});
		expect(result.isError).toBe(true);
		expect(releases).toBeGreaterThan(0);
	});

	it("releases an unrenderable claim before acknowledgement", async () => {
		let acknowledgements = 0;
		let releases = 0;
		const provider = peerProvider({
			wait: async () => waitClaim(bridgeMessage({ originSessionId: "\uD800" })),
			ack: async () => {
				acknowledgements++;
				return true;
			},
			release: async () => {
				releases++;
				return true;
			},
		});
		const result = await new HubTool(session(provider, { asyncJobManager: undefined })).execute("call", {
			op: "wait",
			timeoutMs: 100,
		});
		expect(result.isError).toBe(true);
		expect(acknowledgements).toBe(0);
		expect(releases).toBeGreaterThan(0);
	});

	it("aborts the external wait when the local hub wait wins", async () => {
		const aborts: AbortSignal[] = [];
		const provider = peerProvider({
			wait: async (_from, _timeout, signal) => {
				if (signal) aborts.push(signal);
				return await new Promise<null>(() => {});
			},
		});
		const localSession = session(provider, { asyncJobManager: undefined });
		localSession.agentRegistry?.register({
			id: "Worker",
			displayName: "Worker",
			parentId: MAIN_AGENT_ID,
			kind: "sub",
			session: null,
			status: "running",
		});
		const pending = new HubTool(localSession).execute("call", {
			op: "wait",
			timeoutMs: 100,
		});
		await Bun.sleep(0);
		await IrcBus.global().send({ from: "Worker", to: MAIN_AGENT_ID, body: "local" });
		const result = await pending;
		expect(result.details?.waited).toMatchObject({ from: "Worker", body: "local" });
		expect(aborts[0]?.aborted).toBe(true);
	});

	it("releases an external claim when the caller aborts before ownership", async () => {
		const controller = new AbortController();
		let acknowledgements = 0;
		let releases = 0;
		const provider = peerProvider({
			wait: async () => {
				controller.abort(new Error("cancelled"));
				return waitClaim(bridgeMessage());
			},
			ack: async () => {
				acknowledgements++;
				return true;
			},
			release: async () => {
				releases++;
				return true;
			},
		});
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const gate = Promise.withResolvers<string>();
		manager.register("task", "held job", () => gate.promise, { id: "held-job", ownerId: MAIN_AGENT_ID });
		const pending = new HubTool(session(provider, { asyncJobManager: manager })).execute(
			"call",
			{ op: "wait", timeoutMs: 100 },
			controller.signal,
		);
		await expect(pending).rejects.toThrow("cancelled");
		await Bun.sleep(0);
		expect(acknowledgements).toBe(0);
		expect(releases).toBe(1);
		gate.resolve("done");
		await manager.dispose({ timeoutMs: 100 });
	});

	it("returns an external message when the external wait wins and cancels local waiting", async () => {
		const external = bridgeMessage({ body: "external winner" });
		const provider = peerProvider({ wait: async () => waitClaim(external) });
		const localSession = session(provider, { asyncJobManager: undefined });
		localSession.agentRegistry?.register({
			id: "Worker",
			displayName: "Worker",
			kind: "sub",
			parentId: MAIN_AGENT_ID,
			session: null,
			status: "running",
		});
		const result = await new HubTool(localSession).execute("call", {
			op: "wait",
			timeoutMs: 100,
		});
		expect(result.details?.externalWaited).toEqual(external);
		expect(result.details?.waited).toBeUndefined();
	});

	it("keeps a local message leg alive when the external wait fails beside a job", async () => {
		const provider = peerProvider({
			wait: async () => {
				throw new Error("wait unavailable");
			},
		});
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const gate = Promise.withResolvers<string>();
		manager.register("task", "held job", () => gate.promise, { id: "held-job", ownerId: MAIN_AGENT_ID });
		const localSession = session(provider, { asyncJobManager: manager });
		localSession.agentRegistry?.register({
			id: "Worker",
			displayName: "Worker",
			parentId: MAIN_AGENT_ID,
			kind: "sub",
			session: null,
			status: "running",
		});
		const pending = new HubTool(localSession).execute("call", { op: "wait", timeoutMs: 100 });
		await Promise.resolve();
		await IrcBus.global().send({ from: "Worker", to: MAIN_AGENT_ID, body: "local survives" });
		const result = await pending;
		gate.resolve("done");
		await manager.dispose({ timeoutMs: 100 });
		expect(result.details?.waited).toMatchObject({ from: "Worker", body: "local survives" });
		expect(result.isError).not.toBe(true);
	});

	it("surfaces external wait failures", async () => {
		const provider = peerProvider({
			wait: async () => {
				throw new Error("wait unavailable");
			},
		});
		const result = await new HubTool(session(provider, { asyncJobManager: undefined })).execute("call", {
			op: "wait",
			timeoutMs: 100,
		});
		expect(result.isError).toBe(true);
		expect(result.content[0]).toEqual({
			type: "text",
			text: "Prime external peer provider failed during wait: wait unavailable",
		});
	});

	it("keeps the exact local behavior when external peers are disabled", async () => {
		const result = await new HubTool(session()).execute("call", { op: "list" });
		expect(result.details?.externalPeers).toBeUndefined();
		expect(result.content[0]).toEqual({ type: "text", text: "No other agents." });
	});

	it("retains prior unavailable behavior without a provider", async () => {
		const result = await new HubTool(session(undefined, { agentRegistry: undefined })).execute("call", {
			op: "list",
		});
		expect(result.isError).toBe(true);
		expect(result.content[0]).toEqual({ type: "text", text: "Peer messaging is unavailable in this session." });
	});
});
