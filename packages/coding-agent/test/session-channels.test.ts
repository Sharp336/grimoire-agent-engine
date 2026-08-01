import { afterEach, describe, expect, it, vi } from "bun:test";
import * as net from "node:net";
import {
	type ExtensionUISelectItem,
	getExtensionUISelectOptionLabel,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import type { DaemonBrokerClient } from "@oh-my-pi/pi-coding-agent/launch/client";
import * as launchClient from "@oh-my-pi/pi-coding-agent/launch/client";
import type { DaemonOperation } from "@oh-my-pi/pi-coding-agent/launch/protocol";
import type { InteractiveSelectorDialogOptions } from "@oh-my-pi/pi-coding-agent/modes/types";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { SessionChannelBroker } from "@oh-my-pi/pi-coding-agent/session-channels/broker";
import { handleSessionChannelTuiCommand } from "@oh-my-pi/pi-coding-agent/session-channels/command";
import { SessionChannelManager } from "@oh-my-pi/pi-coding-agent/session-channels/manager";
import type { ChannelAgentSnapshot, ChannelSessionSnapshot } from "@oh-my-pi/pi-coding-agent/session-channels/protocol";
import type { TuiSlashCommandRuntime } from "@oh-my-pi/pi-coding-agent/slash-commands/types";

function agent(id: string, kind: "main" | "sub" = "main"): ChannelAgentSnapshot {
	return { id, displayName: id, kind, status: "running", lastActivity: Date.now() };
}

function channelSession(id: string, agents: ChannelAgentSnapshot[] = [agent("Main")]): ChannelSessionSnapshot {
	return {
		id,
		pid: process.pid,
		sessionId: `persisted-${id}`,
		cwd: `/tmp/${id}`,
		startedAt: Date.now(),
		agents,
	};
}

async function drainChannelUpdate(broker: SessionChannelBroker, socket: net.Socket, sessionId: string): Promise<void> {
	const result = await broker.dispatch({ op: "wait", sessionId, timeoutMs: 1 }, socket);
	expect(result.op).toBe("wait");
	if (result.op === "wait") expect(result.event?.type).toBe("channel-updated");
}

type DeliveredMessage = { from: string; to: string; body: string };

function waitForPeers(manager: SessionChannelManager, check: () => boolean): Promise<void> {
	if (check()) return Promise.resolve();
	const { promise, resolve } = Promise.withResolvers<void>();
	const unsubscribe = manager.onPeersChanged(() => {
		if (!check()) return;
		unsubscribe();
		resolve();
	});
	return promise;
}

interface Participant {
	registry: AgentRegistry;
	bus: IrcBus;
	session: AgentSession;
	delivered: DeliveredMessage[];
	waitForMessage: (predicate: (message: DeliveredMessage) => boolean) => Promise<DeliveredMessage>;
}

function participant(name: string): Participant {
	const registry = new AgentRegistry();
	const bus = new IrcBus(registry);
	const delivered: DeliveredMessage[] = [];
	const waiters = new Set<{
		predicate: (message: DeliveredMessage) => boolean;
		resolve: (message: DeliveredMessage) => void;
	}>();
	const session = {
		sessionManager: SessionManager.inMemory(`/tmp/${name}`),
		deliverIrcMessage: async (message: DeliveredMessage) => {
			delivered.push(message);
			for (const waiter of waiters) {
				if (!waiter.predicate(message)) continue;
				waiters.delete(waiter);
				waiter.resolve(message);
			}
			return "injected" as const;
		},
		emitIrcRelayObservation: () => {},
	} as unknown as AgentSession;
	registry.register({ id: "Main", displayName: name, kind: "main", session });
	return {
		registry,
		bus,
		session,
		delivered,
		waitForMessage: predicate => {
			const existing = delivered.find(predicate);
			if (existing) return Promise.resolve(existing);
			const { promise, resolve } = Promise.withResolvers<DeliveredMessage>();
			waiters.add({ predicate, resolve });
			return promise;
		},
	};
}

describe("cross-session channels", () => {
	const managers: SessionChannelManager[] = [];

	afterEach(async () => {
		await Promise.all(managers.splice(0).map(manager => manager.close()));
		vi.restoreAllMocks();
	});

	it("authorizes bidirectional messaging and supports groups larger than two sessions", async () => {
		const broker = new SessionChannelBroker();
		const socketA = new net.Socket();
		const socketB = new net.Socket();
		const socketC = new net.Socket();
		await broker.dispatch({ op: "register", session: channelSession("aaaaaaaaaaaaaaaa") }, socketA);
		await broker.dispatch({ op: "register", session: channelSession("bbbbbbbbbbbbbbbb") }, socketB);
		await broker.dispatch({ op: "register", session: channelSession("cccccccccccccccc") }, socketC);

		const opened = await broker.dispatch(
			{
				op: "open",
				sessionId: "aaaaaaaaaaaaaaaa",
				memberIds: ["bbbbbbbbbbbbbbbb", "cccccccccccccccc"],
			},
			socketA,
		);
		expect(opened.op).toBe("open");
		if (opened.op !== "open") throw new Error("Expected open result");
		expect(opened.channel.members).toHaveLength(3);
		await drainChannelUpdate(broker, socketA, "aaaaaaaaaaaaaaaa");
		await drainChannelUpdate(broker, socketB, "bbbbbbbbbbbbbbbb");
		await drainChannelUpdate(broker, socketC, "cccccccccccccccc");

		const aToB = await broker.dispatch(
			{
				op: "send",
				sessionId: "aaaaaaaaaaaaaaaa",
				channelId: opened.channel.id,
				fromAgentId: "Main",
				targetSessionId: "bbbbbbbbbbbbbbbb",
				targetAgentId: "Main",
				body: "from A",
			},
			socketA,
		);
		expect(aToB).toEqual({ op: "send", targets: 1 });
		const atB = await broker.dispatch({ op: "wait", sessionId: "bbbbbbbbbbbbbbbb", timeoutMs: 1 }, socketB);
		expect(atB.op === "wait" && atB.event).toMatchObject({
			type: "message",
			fromSessionId: "aaaaaaaaaaaaaaaa",
			body: "from A",
		});

		await broker.dispatch(
			{
				op: "send",
				sessionId: "bbbbbbbbbbbbbbbb",
				channelId: opened.channel.id,
				fromAgentId: "Main",
				targetSessionId: "aaaaaaaaaaaaaaaa",
				targetAgentId: "Main",
				body: "from B",
			},
			socketB,
		);
		const atA = await broker.dispatch({ op: "wait", sessionId: "aaaaaaaaaaaaaaaa", timeoutMs: 1 }, socketA);
		expect(atA.op === "wait" && atA.event).toMatchObject({
			type: "message",
			fromSessionId: "bbbbbbbbbbbbbbbb",
			body: "from B",
		});
	});

	it("notifies every remaining session and keeps a three-session channel open after termination", async () => {
		const broker = new SessionChannelBroker();
		const socketA = new net.Socket();
		const socketB = new net.Socket();
		const socketC = new net.Socket();
		for (const [socket, snapshot] of [
			[socketA, channelSession("aaaaaaaaaaaaaaaa")],
			[socketB, channelSession("bbbbbbbbbbbbbbbb")],
			[socketC, channelSession("cccccccccccccccc")],
		] as const) {
			await broker.dispatch({ op: "register", session: snapshot }, socket);
		}
		const opened = await broker.dispatch(
			{ op: "open", sessionId: "aaaaaaaaaaaaaaaa", memberIds: ["bbbbbbbbbbbbbbbb", "cccccccccccccccc"] },
			socketA,
		);
		if (opened.op !== "open") throw new Error("Expected open result");
		await drainChannelUpdate(broker, socketA, "aaaaaaaaaaaaaaaa");
		await drainChannelUpdate(broker, socketB, "bbbbbbbbbbbbbbbb");
		await drainChannelUpdate(broker, socketC, "cccccccccccccccc");

		broker.disconnectSocket(socketB);
		for (const [socket, sessionId] of [
			[socketA, "aaaaaaaaaaaaaaaa"],
			[socketC, "cccccccccccccccc"],
		] as const) {
			const result = await broker.dispatch({ op: "wait", sessionId, timeoutMs: 1 }, socket);
			expect(result.op === "wait" && result.event).toMatchObject({
				type: "member-left",
				reason: "session-ended",
				closed: false,
			});
			if (result.op === "wait" && result.event?.type === "member-left") {
				expect(result.event.remainingMembers).toHaveLength(2);
			}
		}

		const sendAfterTermination = await broker.dispatch(
			{
				op: "send",
				sessionId: "cccccccccccccccc",
				channelId: opened.channel.id,
				fromAgentId: "Main",
				targetSessionId: "aaaaaaaaaaaaaaaa",
				targetAgentId: "Main",
				body: "still connected",
			},
			socketC,
		);
		expect(sendAfterTermination).toEqual({ op: "send", targets: 1 });
	});

	it("closes severed pair channels and requires a new authorization", async () => {
		const broker = new SessionChannelBroker();
		const socketA = new net.Socket();
		const socketB = new net.Socket();
		await broker.dispatch({ op: "register", session: channelSession("aaaaaaaaaaaaaaaa") }, socketA);
		await broker.dispatch({ op: "register", session: channelSession("bbbbbbbbbbbbbbbb") }, socketB);
		const opened = await broker.dispatch(
			{ op: "open", sessionId: "aaaaaaaaaaaaaaaa", memberIds: ["bbbbbbbbbbbbbbbb"] },
			socketA,
		);
		if (opened.op !== "open") throw new Error("Expected open result");
		await drainChannelUpdate(broker, socketA, "aaaaaaaaaaaaaaaa");
		await drainChannelUpdate(broker, socketB, "bbbbbbbbbbbbbbbb");
		await broker.dispatch(
			{ op: "leave", sessionId: "bbbbbbbbbbbbbbbb", channelId: opened.channel.id, reason: "agent" },
			socketB,
		);
		const notice = await broker.dispatch({ op: "wait", sessionId: "aaaaaaaaaaaaaaaa", timeoutMs: 1 }, socketA);
		expect(notice.op === "wait" && notice.event).toMatchObject({
			type: "member-left",
			reason: "agent",
			closed: true,
		});
		await expect(
			broker.dispatch(
				{
					op: "send",
					sessionId: "aaaaaaaaaaaaaaaa",
					channelId: opened.channel.id,
					fromAgentId: "Main",
					targetSessionId: "bbbbbbbbbbbbbbbb",
					targetAgentId: "Main",
					body: "must fail",
				},
				socketA,
			),
		).rejects.toThrow("Unknown or closed channel");
	});

	it("keeps multiple channels for one session independent", async () => {
		const broker = new SessionChannelBroker();
		const socketA = new net.Socket();
		const socketB = new net.Socket();
		const socketC = new net.Socket();
		for (const [socket, snapshot] of [
			[socketA, channelSession("aaaaaaaaaaaaaaaa")],
			[socketB, channelSession("bbbbbbbbbbbbbbbb")],
			[socketC, channelSession("cccccccccccccccc")],
		] as const) {
			await broker.dispatch({ op: "register", session: snapshot }, socket);
		}

		const first = await broker.dispatch(
			{ op: "open", sessionId: "aaaaaaaaaaaaaaaa", memberIds: ["bbbbbbbbbbbbbbbb"] },
			socketA,
		);
		if (first.op !== "open") throw new Error("Expected first open result");
		await drainChannelUpdate(broker, socketA, "aaaaaaaaaaaaaaaa");
		await drainChannelUpdate(broker, socketB, "bbbbbbbbbbbbbbbb");
		const second = await broker.dispatch(
			{ op: "open", sessionId: "aaaaaaaaaaaaaaaa", memberIds: ["cccccccccccccccc"] },
			socketA,
		);
		if (second.op !== "open") throw new Error("Expected second open result");
		await drainChannelUpdate(broker, socketA, "aaaaaaaaaaaaaaaa");
		await drainChannelUpdate(broker, socketC, "cccccccccccccccc");

		const beforeClose = await broker.dispatch({ op: "list", sessionId: "aaaaaaaaaaaaaaaa" }, socketA);
		if (beforeClose.op !== "list") throw new Error("Expected list result");
		expect(beforeClose.channels).toHaveLength(2);
		expect(beforeClose.channels.map(channel => channel.id)).toEqual(
			expect.arrayContaining([first.channel.id, second.channel.id]),
		);

		await broker.dispatch({ op: "close", sessionId: "aaaaaaaaaaaaaaaa", channelId: first.channel.id }, socketA);
		await broker.dispatch({ op: "wait", sessionId: "aaaaaaaaaaaaaaaa", timeoutMs: 1 }, socketA);
		await broker.dispatch({ op: "wait", sessionId: "bbbbbbbbbbbbbbbb", timeoutMs: 1 }, socketB);
		const afterClose = await broker.dispatch({ op: "list", sessionId: "aaaaaaaaaaaaaaaa" }, socketA);
		expect(afterClose.op === "list" && afterClose.channels.map(channel => channel.id)).toEqual([second.channel.id]);
	});

	it("atomically toggles user-selected members and notifies removed sessions", async () => {
		const broker = new SessionChannelBroker();
		const socketA = new net.Socket();
		const socketB = new net.Socket();
		const socketC = new net.Socket();
		const socketD = new net.Socket();
		for (const [socket, snapshot] of [
			[socketA, channelSession("aaaaaaaaaaaaaaaa")],
			[socketB, channelSession("bbbbbbbbbbbbbbbb")],
			[socketC, channelSession("cccccccccccccccc")],
			[socketD, channelSession("dddddddddddddddd")],
		] as const) {
			await broker.dispatch({ op: "register", session: snapshot }, socket);
		}
		const opened = await broker.dispatch(
			{ op: "open", sessionId: "aaaaaaaaaaaaaaaa", memberIds: ["bbbbbbbbbbbbbbbb", "cccccccccccccccc"] },
			socketA,
		);
		if (opened.op !== "open") throw new Error("Expected open result");
		await drainChannelUpdate(broker, socketA, "aaaaaaaaaaaaaaaa");
		await drainChannelUpdate(broker, socketB, "bbbbbbbbbbbbbbbb");
		await drainChannelUpdate(broker, socketC, "cccccccccccccccc");

		const toggled = await broker.dispatch(
			{
				op: "set-members",
				sessionId: "aaaaaaaaaaaaaaaa",
				channelId: opened.channel.id,
				memberIds: ["bbbbbbbbbbbbbbbb", "dddddddddddddddd"],
			},
			socketA,
		);
		expect(toggled.op === "set-members" && toggled.channel.members.map(member => member.id)).toEqual([
			"aaaaaaaaaaaaaaaa",
			"bbbbbbbbbbbbbbbb",
			"dddddddddddddddd",
		]);
		for (const [socket, sessionId] of [
			[socketA, "aaaaaaaaaaaaaaaa"],
			[socketB, "bbbbbbbbbbbbbbbb"],
			[socketC, "cccccccccccccccc"],
		] as const) {
			const result = await broker.dispatch({ op: "wait", sessionId, timeoutMs: 1 }, socket);
			expect(result.op === "wait" && result.event).toMatchObject({
				type: "member-left",
				reason: "user",
				closed: false,
			});
		}
		await drainChannelUpdate(broker, socketA, "aaaaaaaaaaaaaaaa");
		await drainChannelUpdate(broker, socketB, "bbbbbbbbbbbbbbbb");
		await drainChannelUpdate(broker, socketD, "dddddddddddddddd");

		await broker.dispatch({ op: "close", sessionId: "aaaaaaaaaaaaaaaa", channelId: opened.channel.id }, socketA);
		for (const [socket, sessionId] of [
			[socketA, "aaaaaaaaaaaaaaaa"],
			[socketB, "bbbbbbbbbbbbbbbb"],
			[socketD, "dddddddddddddddd"],
		] as const) {
			const result = await broker.dispatch({ op: "wait", sessionId, timeoutMs: 1 }, socket);
			expect(result.op === "wait" && result.event).toMatchObject({ type: "channel-closed", reason: "user" });
		}
		await expect(
			broker.dispatch(
				{
					op: "send",
					sessionId: "bbbbbbbbbbbbbbbb",
					channelId: opened.channel.id,
					fromAgentId: "Main",
					targetSessionId: "aaaaaaaaaaaaaaaa",
					targetAgentId: "Main",
					body: "closed",
				},
				socketB,
			),
		).rejects.toThrow("Unknown or closed channel");
	});

	it("opens and toggles among multiple channels through checkbox selectors", async () => {
		const broker = new SessionChannelBroker();
		vi.spyOn(launchClient, "createDaemonBrokerClient").mockImplementation(async () => {
			const socket = new net.Socket();
			return {
				request: async (operation: DaemonOperation) => {
					if (operation.op !== "channel") throw new Error("Expected channel operation");
					return { op: "channel", result: await broker.dispatch(operation.operation, socket) };
				},
				close: () => broker.disconnectSocket(socket),
			} as unknown as DaemonBrokerClient;
		});

		const a = participant("A");
		const b = participant("B");
		const c = participant("C");
		const managerA = await SessionChannelManager.start(a.session, a.registry, a.bus);
		const managerB = await SessionChannelManager.start(b.session, b.registry, b.bus);
		const managerC = await SessionChannelManager.start(c.session, c.registry, c.bus);
		managers.push(managerA, managerB, managerC);

		type SelectorChoice = (labels: string[]) => string | undefined;
		const choices: SelectorChoice[] = [
			labels => labels.find(label => label.startsWith(managerB.id)),
			labels => labels.find(label => label.startsWith(managerC.id)),
			labels => labels.find(label => label === "Done (2 selected)"),
		];
		const selectorStates: Array<{ title: string; checked: readonly number[] | undefined }> = [];
		const statuses: string[] = [];
		const errors: string[] = [];
		const ctx = {
			session: a.session,
			editor: { setText: () => {} },
			showStatus: (message: string) => statuses.push(message),
			showError: (message: string) => errors.push(message),
			showHookSelector: async (
				title: string,
				options: ExtensionUISelectItem[],
				dialogOptions?: InteractiveSelectorDialogOptions,
			) => {
				const labels = options.map(getExtensionUISelectOptionLabel);
				selectorStates.push({ title, checked: dialogOptions?.checkedIndices });
				return choices.shift()?.(labels);
			},
		};
		// InteractiveModeContext is intentionally narrowed to the fields used by the command handler.
		const runtime = { ctx } as unknown as TuiSlashCommandRuntime;

		await handleSessionChannelTuiCommand({ name: "channel", args: "open", text: "/channel open" }, runtime);
		const openedState = await managerA.state();
		expect(openedState.channels).toHaveLength(1);
		expect(openedState.channels[0]?.members).toHaveLength(3);
		expect(selectorStates.filter(state => state.title === "Open channel with sessions").at(-1)?.checked).toHaveLength(
			2,
		);

		const second = await managerA.open([managerB.id]);
		choices.push(
			labels => labels.find(label => label.startsWith(second.id)),
			labels => labels.find(label => label.startsWith(managerB.id)),
			labels => labels.find(label => label.startsWith(managerC.id)),
			labels => labels.find(label => label === "Done (1 selected)"),
		);
		await handleSessionChannelTuiCommand({ name: "channel", args: "toggle", text: "/channel toggle" }, runtime);

		const toggledState = await managerA.state();
		expect(toggledState.channels).toHaveLength(2);
		const toggled = toggledState.channels.find(channel => channel.id === second.id);
		expect(toggled?.members).toHaveLength(2);
		expect(toggled?.members.map(member => member.id)).toEqual(expect.arrayContaining([managerA.id, managerC.id]));
		expect(statuses.some(message => message.includes("opened with 3 sessions"))).toBe(true);
		expect(errors).toEqual([]);
	});

	it("delivers session and subagent termination notices to every local channel agent", async () => {
		const broker = new SessionChannelBroker();
		vi.spyOn(launchClient, "createDaemonBrokerClient").mockImplementation(async () => {
			const socket = new net.Socket();
			return {
				request: async (operation: DaemonOperation) => {
					if (operation.op !== "channel") throw new Error("Expected channel operation");
					return { op: "channel", result: await broker.dispatch(operation.operation, socket) };
				},
				close: () => broker.disconnectSocket(socket),
			} as unknown as DaemonBrokerClient;
		});

		const a = participant("A");
		const b = participant("B");
		const c = participant("C");
		const managerA = await SessionChannelManager.start(a.session, a.registry, a.bus);
		const managerB = await SessionChannelManager.start(b.session, b.registry, b.bus);
		const managerC = await SessionChannelManager.start(c.session, c.registry, c.bus);
		managers.push(managerA, managerB, managerC);
		const channel = await managerA.open([managerB.id, managerC.id]);
		await Promise.all([
			waitForPeers(managerB, () => managerB.listPeers().length === 2),
			waitForPeers(managerC, () => managerC.listPeers().length === 2),
		]);

		const subSession = {
			deliverIrcMessage: async () => "injected" as const,
			emitIrcRelayObservation: () => {},
		} as unknown as AgentSession;
		const subAppeared = waitForPeers(managerA, () => managerA.listPeers().some(peer => peer.id.endsWith("/C-Sub")));
		c.registry.register({ id: "C-Sub", displayName: "C subagent", kind: "sub", session: subSession });
		await managerC.state();
		await subAppeared;

		const subNoticeA = a.waitForMessage(
			message => message.body.includes("C-Sub") && message.body.includes("terminated"),
		);
		const subNoticeC = c.waitForMessage(
			message => message.body.includes("C-Sub") && message.body.includes("terminated"),
		);
		c.registry.unregister("C-Sub");
		await managerC.state();
		await Promise.all([subNoticeA, subNoticeC]);

		const sessionNoticeA = a.waitForMessage(
			message => message.body.includes(`Session ${managerB.id}`) && message.body.includes("terminated"),
		);
		const sessionNoticeC = c.waitForMessage(message => message.body.includes(`Session ${managerB.id}`));
		await managerB.close();
		managers.splice(managers.indexOf(managerB), 1);
		await Promise.all([sessionNoticeA, sessionNoticeC]);
		expect(managerA.listPeers().every(peer => peer.channelId === channel.id && !peer.id.includes(managerB.id))).toBe(
			true,
		);
	});
	it("notifies local agents when the broker connection drops their channels", async () => {
		const broker = new SessionChannelBroker();
		const sockets: net.Socket[] = [];
		vi.spyOn(Bun, "sleep").mockResolvedValue();
		vi.spyOn(launchClient, "createDaemonBrokerClient").mockImplementation(async () => {
			const socket = new net.Socket();
			sockets.push(socket);
			return {
				request: async (operation: DaemonOperation) => {
					if (operation.op !== "channel") throw new Error("Expected channel operation");
					return { op: "channel", result: await broker.dispatch(operation.operation, socket) };
				},
				close: () => broker.disconnectSocket(socket),
			} as unknown as DaemonBrokerClient;
		});

		const a = participant("A");
		const b = participant("B");
		const managerA = await SessionChannelManager.start(a.session, a.registry, a.bus);
		const managerB = await SessionChannelManager.start(b.session, b.registry, b.bus);
		managers.push(managerA, managerB);
		await managerA.open([managerB.id]);
		await waitForPeers(managerB, () => managerB.listPeers().length === 1);

		const notice = a.waitForMessage(
			message => message.body.includes("channel broker disconnected") && message.body.includes("authorization"),
		);
		const socketA = sockets[0];
		if (!socketA) throw new Error("Expected manager A broker socket");
		broker.disconnectSocket(socketA);
		await notice;
		expect(managerA.listPeers()).toEqual([]);
	});
});
