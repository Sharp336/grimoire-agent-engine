import * as path from "node:path";
import { getConfigRootDir, logger, postmortem } from "@oh-my-pi/pi-utils";
import { IrcBus, type IrcDeliveryReceipt, type IrcExternalPeer, type IrcExternalTransport } from "../irc/bus";
import type { DaemonBrokerClient } from "../launch/client";
import * as launchClient from "../launch/client";
import type { AgentRef, AgentRegistry } from "../registry/agent-registry";
import type { AgentSession } from "../session/agent-session";
import type {
	ChannelAgentSnapshot,
	ChannelSessionSnapshot,
	SessionChannelEvent,
	SessionChannelOperation,
	SessionChannelResult,
	SessionChannelSnapshot,
} from "./protocol";

const CHANNEL_WAIT_MS = 30_000;
const RECONNECT_DELAY_MS = 250;
const UPDATE_DEBOUNCE_MS = 25;

export interface SessionChannelState {
	self: ChannelSessionSnapshot;
	sessions: ChannelSessionSnapshot[];
	channels: SessionChannelSnapshot[];
}

function channelBrokerScope(): string {
	return path.join(getConfigRootDir(), "run", "session-channels");
}

function channelAddress(channelId: string, sessionId: string, agentId: string): string {
	return `${channelId}/${sessionId}/${agentId}`;
}

function sessionLabel(session: ChannelSessionSnapshot): string {
	return session.title?.trim() || path.basename(session.cwd) || session.id;
}

interface ParsedChannelAddress {
	channelId: string;
	targetSessionId?: string;
	targetAgentId: string;
}

/** Per-running-session bridge between the local IRC bus and user-authorized groups. */
export class SessionChannelManager implements IrcExternalTransport {
	static readonly #byRegistry = new WeakMap<AgentRegistry, SessionChannelManager>();
	static readonly #bySession = new WeakMap<AgentSession, SessionChannelManager>();

	static async start(
		session: AgentSession,
		registry: AgentRegistry,
		bus: IrcBus = IrcBus.global(),
	): Promise<SessionChannelManager> {
		const existing = SessionChannelManager.#byRegistry.get(registry);
		if (existing) return existing;
		const client = await launchClient.createDaemonBrokerClient(channelBrokerScope());
		const manager = new SessionChannelManager(session, registry, bus, client);
		await manager.#register();
		SessionChannelManager.#byRegistry.set(registry, manager);
		SessionChannelManager.#bySession.set(session, manager);
		bus.setExternalTransport(manager);
		manager.#start();
		return manager;
	}

	static forRegistry(registry: AgentRegistry): SessionChannelManager | undefined {
		return SessionChannelManager.#byRegistry.get(registry);
	}

	static forSession(session: AgentSession): SessionChannelManager | undefined {
		return SessionChannelManager.#bySession.get(session);
	}

	readonly id = crypto.randomUUID().replaceAll("-", "").slice(0, 16);
	readonly #startedAt = Date.now();
	readonly #session: AgentSession;
	readonly #registry: AgentRegistry;
	readonly #bus: IrcBus;
	readonly #client: DaemonBrokerClient;
	readonly #channels = new Map<string, SessionChannelSnapshot>();
	readonly #peerListeners = new Set<() => void>();
	#unsubscribeRegistry: (() => void) | undefined;
	#unsubscribeTitle: (() => void) | undefined;
	#cancelPostmortem: (() => void) | undefined;
	#updateTimer: NodeJS.Timeout | undefined;
	#listenTask: Promise<void> | undefined;
	#closed = false;

	private constructor(session: AgentSession, registry: AgentRegistry, bus: IrcBus, client: DaemonBrokerClient) {
		this.#session = session;
		this.#registry = registry;
		this.#bus = bus;
		this.#client = client;
	}

	async state(): Promise<SessionChannelState> {
		await this.#updateNow();
		const result = await this.#request({ op: "list", sessionId: this.id });
		if (result.op !== "list") throw new Error(`Unexpected channel ${result.op} result`);
		for (const channel of result.channels) this.#channels.set(channel.id, channel);
		this.#notifyPeerListeners();
		return { self: this.#snapshot(), sessions: result.sessions, channels: result.channels };
	}

	async open(memberQueries: readonly string[], name?: string): Promise<SessionChannelSnapshot> {
		if (memberQueries.length === 0) throw new Error("Opening a channel requires at least one target session");
		const state = await this.state();
		const memberIds = memberQueries.map(query => this.#resolveSession(query, state.sessions).id);
		const result = await this.#request({ op: "open", sessionId: this.id, memberIds, name });
		if (result.op !== "open") throw new Error(`Unexpected channel ${result.op} result`);
		this.#channels.set(result.channel.id, result.channel);
		this.#notifyPeerListeners();
		return result.channel;
	}

	async setMembers(channelQuery: string, memberQueries: readonly string[]): Promise<SessionChannelSnapshot> {
		if (memberQueries.length === 0) throw new Error("A channel requires at least one other running session");
		const state = await this.state();
		const channel = this.#resolveChannel(channelQuery, state.channels);
		const memberIds = memberQueries.map(query => this.#resolveSession(query, state.sessions).id);
		const result = await this.#request({
			op: "set-members",
			sessionId: this.id,
			channelId: channel.id,
			memberIds,
		});
		if (result.op !== "set-members") throw new Error(`Unexpected channel ${result.op} result`);
		this.#channels.set(result.channel.id, result.channel);
		this.#notifyPeerListeners();
		return result.channel;
	}

	async closeChannel(channelQuery: string): Promise<void> {
		const channel = this.#resolveChannel(channelQuery, [...this.#channels.values()]);
		const result = await this.#request({ op: "close", sessionId: this.id, channelId: channel.id });
		if (result.op !== "close") throw new Error(`Unexpected channel ${result.op} result`);
		this.#channels.delete(channel.id);
		this.#notifyPeerListeners();
	}

	async leave(channelQuery: string, reason: "user" | "agent"): Promise<void> {
		const channel = this.#resolveChannel(channelQuery, [...this.#channels.values()]);
		const result = await this.#request({ op: "leave", sessionId: this.id, channelId: channel.id, reason });
		if (result.op !== "leave") throw new Error(`Unexpected channel ${result.op} result`);
		this.#channels.delete(channel.id);
		this.#notifyPeerListeners();
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		clearTimeout(this.#updateTimer);
		this.#unsubscribeRegistry?.();
		this.#unsubscribeTitle?.();
		this.#cancelPostmortem?.();
		this.#bus.clearExternalTransport(this);
		try {
			await this.#request({ op: "unregister", sessionId: this.id });
		} catch (error) {
			logger.debug("Session channel unregister failed during close", { error: String(error) });
		} finally {
			this.#client.close();
			this.#channels.clear();
			this.#notifyPeerListeners();
			SessionChannelManager.#byRegistry.delete(this.#registry);
			SessionChannelManager.#bySession.delete(this.#session);
		}
		await this.#listenTask?.catch(() => {});
	}

	handles(address: string): boolean {
		return this.#parseAddress(address) !== undefined;
	}

	validateTargets(addresses: readonly string[]): string | undefined {
		if (addresses.length === 0) return "At least one recipient is required.";
		const parsed = addresses.map(address => this.#parseAddress(address));
		if (parsed.some(target => !target || target.targetSessionId === undefined)) {
			return "Recipient arrays must contain concrete agent addresses from `hub list`.";
		}
		const channelIds = new Set(parsed.map(target => target?.channelId));
		return channelIds.size === 1 ? undefined : "Every recipient in an array must belong to the same channel.";
	}

	async send(message: { from: string; to: string; body: string; replyTo?: string }): Promise<IrcDeliveryReceipt> {
		const target = this.#parseAddress(message.to);
		if (!target) return { to: message.to, outcome: "failed", error: "Unknown or closed session channel target" };
		if (target.targetSessionId === this.id) {
			return this.#bus.send({
				from: message.from,
				to: target.targetAgentId,
				body: message.body,
				replyTo: message.replyTo,
			});
		}
		try {
			const result = await this.#request({
				op: "send",
				sessionId: this.id,
				channelId: target.channelId,
				fromAgentId: message.from,
				targetSessionId: target.targetSessionId,
				targetAgentId: target.targetAgentId,
				body: message.body,
				replyTo: message.replyTo,
			});
			if (result.op !== "send") throw new Error(`Unexpected channel ${result.op} result`);
			return { to: message.to, outcome: "injected" };
		} catch (error) {
			return { to: message.to, outcome: "failed", error: error instanceof Error ? error.message : String(error) };
		}
	}

	listPeers(): IrcExternalPeer[] {
		const peers: IrcExternalPeer[] = [];
		for (const channel of this.#channels.values()) {
			for (const member of channel.members) {
				if (member.id === this.id) continue;
				for (const agent of member.agents) {
					peers.push({
						id: channelAddress(channel.id, member.id, agent.id),
						displayName: `${agent.displayName}@${sessionLabel(member)}`,
						kind: `remote-${agent.kind}`,
						status: agent.status,
						parentId: agent.parentId ? channelAddress(channel.id, member.id, agent.parentId) : undefined,
						lastActivity: agent.lastActivity,
						activity: agent.activity,
						channelId: channel.id,
					});
				}
			}
		}
		return peers;
	}

	isPeerRunning(address: string): boolean {
		const target = this.#parseAddress(address);
		if (!target) return false;
		if (!target.targetSessionId) {
			return this.listPeers().some(peer => peer.channelId === target.channelId && peer.status === "running");
		}
		return this.listPeers().some(peer => peer.id === address && peer.status === "running");
	}

	onPeersChanged(listener: () => void): () => void {
		this.#peerListeners.add(listener);
		return () => this.#peerListeners.delete(listener);
	}

	#start(): void {
		this.#unsubscribeRegistry = this.#registry.onChange(() => this.#scheduleUpdate());
		this.#unsubscribeTitle = this.#session.sessionManager.onSessionNameChanged(() => this.#scheduleUpdate());
		this.#cancelPostmortem = postmortem.register(`session-channel:${this.id}`, () => this.close());
		this.#listenTask = this.#listen();
	}

	async #register(): Promise<void> {
		const result = await this.#request({ op: "register", session: this.#snapshot() });
		if (result.op !== "register") throw new Error(`Unexpected channel ${result.op} result`);
	}

	async #listen(): Promise<void> {
		while (!this.#closed) {
			try {
				const result = await this.#request({ op: "wait", sessionId: this.id, timeoutMs: CHANNEL_WAIT_MS });
				if (result.op !== "wait") throw new Error(`Unexpected channel ${result.op} result`);
				if (result.event) await this.#handleEvent(result.event);
			} catch (error) {
				if (this.#closed) return;
				const lostChannels = [...this.#channels.values()];
				this.#channels.clear();
				this.#notifyPeerListeners();
				await Promise.all(
					lostChannels.map(channel =>
						this.#notifyLocalAgents(
							channel.id,
							`Connection to channel ${channel.name ?? channel.id} was lost when the channel broker disconnected. New user authorization is required to reconnect. No response is expected.`,
						),
					),
				).catch(notifyError => {
					logger.debug("Session channel disconnect notification failed", { error: String(notifyError) });
				});
				logger.debug("Session channel event wait failed; reconnecting", { error: String(error) });
				await Bun.sleep(RECONNECT_DELAY_MS);
				try {
					await this.#register();
				} catch (registerError) {
					logger.debug("Session channel reconnect failed", { error: String(registerError) });
				}
			}
		}
	}

	async #handleEvent(event: SessionChannelEvent): Promise<void> {
		switch (event.type) {
			case "channel-updated":
				this.#channels.set(event.channel.id, event.channel);
				this.#notifyPeerListeners();
				return;
			case "message": {
				const from = channelAddress(event.channelId, event.fromSessionId, event.fromAgentId);
				await this.#bus.send({
					from,
					to: event.toAgentId,
					body: event.body,
					replyTo: event.replyTo,
				});
				return;
			}
			case "member-left": {
				const channel = this.#channels.get(event.channelId);
				const stillMember = event.remainingMembers.some(member => member.id === this.id);
				if (event.closed || !channel || !stillMember) this.#channels.delete(event.channelId);
				else this.#channels.set(event.channelId, { ...channel, members: event.remainingMembers });
				this.#notifyPeerListeners();
				const action = event.reason === "session-ended" ? "terminated" : `left by ${event.reason}`;
				const suffix = event.closed
					? " The channel is now closed; new user authorization is required to reconnect."
					: ` ${event.remainingMembers.length} sessions remain connected.`;
				await this.#notifyLocalAgents(
					event.channelId,
					`Session ${event.member.id} (${sessionLabel(event.member)}) ${action} in channel ${event.channelName ?? event.channelId}.${suffix} No response is expected.`,
				);
				return;
			}
			case "agent-left":
				await this.#notifyLocalAgents(
					event.channelId,
					`Agent ${event.agent.id} (${event.agent.displayName}) terminated in session ${event.sessionId} on channel ${event.channelName ?? event.channelId}. No response is expected.`,
				);
				return;
			case "channel-closed":
				this.#channels.delete(event.channel.id);
				this.#notifyPeerListeners();
				await this.#notifyLocalAgents(
					event.channel.id,
					`Channel ${event.channel.name ?? event.channel.id} was closed by its user. New user authorization is required to reconnect. No response is expected.`,
				);
		}
	}

	async #notifyLocalAgents(channelId: string, body: string): Promise<void> {
		const recipients = this.#registry.list().filter(ref => ref.kind !== "advisor" && ref.status !== "aborted");
		await Promise.all(recipients.map(ref => this.#bus.send({ from: `${channelId}/system`, to: ref.id, body })));
	}

	#scheduleUpdate(): void {
		if (this.#closed || this.#updateTimer) return;
		this.#updateTimer = setTimeout(() => {
			this.#updateTimer = undefined;
			void this.#updateNow().catch(error => {
				logger.debug("Session channel roster update failed", { error: String(error) });
			});
		}, UPDATE_DEBOUNCE_MS);
		this.#updateTimer.unref?.();
	}

	async #updateNow(): Promise<void> {
		if (this.#closed) throw new Error("Session channel manager is closed");
		clearTimeout(this.#updateTimer);
		this.#updateTimer = undefined;
		const result = await this.#request({ op: "update", session: this.#snapshot() });
		if (result.op !== "update") throw new Error(`Unexpected channel ${result.op} result`);
	}

	#snapshot(): ChannelSessionSnapshot {
		return {
			id: this.id,
			pid: process.pid,
			sessionId: this.#session.sessionManager.getSessionId(),
			title: this.#session.sessionManager.getSessionName(),
			cwd: this.#session.sessionManager.getCwd(),
			startedAt: this.#startedAt,
			agents: this.#registry
				.list()
				.filter(
					(ref): ref is AgentRef & { kind: "main" | "sub"; status: "running" | "idle" | "parked" } =>
						ref.kind !== "advisor" && ref.status !== "aborted",
				)
				.map(ref => this.#agentSnapshot(ref)),
		};
	}

	#agentSnapshot(
		ref: AgentRef & { kind: "main" | "sub"; status: "running" | "idle" | "parked" },
	): ChannelAgentSnapshot {
		return {
			id: ref.id,
			displayName: ref.displayName,
			kind: ref.kind,
			status: ref.status,
			parentId: ref.parentId,
			lastActivity: ref.lastActivity,
			activity: ref.activity,
		};
	}

	#parseAddress(address: string): ParsedChannelAddress | undefined {
		const parts = address.split("/");
		const channel = this.#channels.get(parts[0] ?? "");
		if (!channel) return undefined;
		if (parts.length === 2 && parts[1] === "all") {
			return { channelId: channel.id, targetAgentId: "all" };
		}
		if (parts.length !== 3) return undefined;
		const targetSessionId = parts[1];
		const targetAgentId = parts[2];
		if (!targetSessionId || !targetAgentId) return undefined;
		const member = channel.members.find(candidate => candidate.id === targetSessionId);
		if (!member?.agents.some(agent => agent.id === targetAgentId)) return undefined;
		return { channelId: channel.id, targetSessionId, targetAgentId };
	}

	#resolveSession(query: string, sessions: readonly ChannelSessionSnapshot[]): ChannelSessionSnapshot {
		const matches = sessions.filter(session => session.id === query || session.id.startsWith(query));
		if (matches.length === 1 && matches[0]) return matches[0];
		if (matches.length === 0) throw new Error(`No running session matches ${query}`);
		throw new Error(`Session prefix ${query} is ambiguous`);
	}

	#resolveChannel(query: string, channels: readonly SessionChannelSnapshot[]): SessionChannelSnapshot {
		const matches = channels.filter(
			channel => channel.id === query || channel.id.startsWith(query) || channel.name === query,
		);
		if (matches.length === 1 && matches[0]) return matches[0];
		if (matches.length === 0) throw new Error(`No open channel matches ${query}`);
		throw new Error(`Channel selector ${query} is ambiguous`);
	}

	#notifyPeerListeners(): void {
		for (const listener of this.#peerListeners) listener();
	}

	async #request(operation: SessionChannelOperation): Promise<SessionChannelResult> {
		const result = await this.#client.request({ op: "channel", operation });
		if (result.op !== "channel") throw new Error(`Unexpected broker ${result.op} result`);
		return result.result;
	}
}
