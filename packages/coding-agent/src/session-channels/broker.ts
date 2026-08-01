import type * as net from "node:net";
import type {
	ChannelLeaveReason,
	ChannelSessionSnapshot,
	SessionChannelEvent,
	SessionChannelOperation,
	SessionChannelResult,
	SessionChannelSnapshot,
} from "./protocol";

const EVENT_QUEUE_CAP = 100;

interface PendingEventWait {
	resolve: (event: SessionChannelEvent | null) => void;
	timer?: NodeJS.Timeout;
}

interface RegisteredChannelSession {
	snapshot: ChannelSessionSnapshot;
	socket: net.Socket;
	events: SessionChannelEvent[];
	waiter?: PendingEventWait;
}

interface ChannelRecord {
	id: string;
	name?: string;
	createdAt: number;
	members: Set<string>;
}

/** User-global channel state hosted inside the authenticated daemon broker. */
export class SessionChannelBroker {
	readonly #sessions = new Map<string, RegisteredChannelSession>();
	readonly #sessionIdsBySocket = new Map<net.Socket, string>();
	readonly #channels = new Map<string, ChannelRecord>();

	async dispatch(operation: SessionChannelOperation, socket: net.Socket): Promise<SessionChannelResult> {
		switch (operation.op) {
			case "register":
				return this.#register(operation.session, socket);
			case "unregister":
				this.#assertSocketSession(operation.sessionId, socket);
				this.#dropSession(operation.sessionId, "session-ended");
				return { op: "unregister" };
			case "list": {
				this.#assertSocketSession(operation.sessionId, socket);
				const channels = [...this.#channels.values()]
					.filter(channel => channel.members.has(operation.sessionId))
					.map(channel => this.#snapshot(channel));
				return {
					op: "list",
					sessions: [...this.#sessions.values()]
						.map(record => record.snapshot)
						.sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id)),
					channels,
				};
			}
			case "open":
				this.#assertSocketSession(operation.sessionId, socket);
				return { op: "open", channel: this.#open(operation.sessionId, operation.memberIds, operation.name) };
			case "set-members":
				this.#assertSocketSession(operation.sessionId, socket);
				return {
					op: "set-members",
					channel: this.#setMembers(operation.sessionId, operation.channelId, operation.memberIds),
				};
			case "close":
				this.#assertSocketSession(operation.sessionId, socket);
				this.#close(this.#memberChannel(operation.channelId, operation.sessionId), operation.sessionId);
				return { op: "close" };
			case "leave":
				this.#assertSocketSession(operation.sessionId, socket);
				return {
					op: "leave",
					channel: this.#removeMember(
						this.#memberChannel(operation.channelId, operation.sessionId),
						operation.sessionId,
						operation.reason,
						operation.sessionId,
					),
				};
			case "update":
				return this.#update(operation.session, socket);
			case "send":
				this.#assertSocketSession(operation.sessionId, socket);
				return { op: "send", targets: this.#send(operation) };
			case "wait":
				this.#assertSocketSession(operation.sessionId, socket);
				return { op: "wait", event: await this.#wait(operation.sessionId, operation.timeoutMs) };
		}
	}

	disconnectSocket(socket: net.Socket): void {
		const sessionId = this.#sessionIdsBySocket.get(socket);
		if (sessionId) this.#dropSession(sessionId, "session-ended");
	}

	shutdown(): void {
		for (const record of this.#sessions.values()) {
			clearTimeout(record.waiter?.timer);
			record.waiter?.resolve(null);
		}
		this.#sessions.clear();
		this.#sessionIdsBySocket.clear();
		this.#channels.clear();
	}

	#register(snapshot: ChannelSessionSnapshot, socket: net.Socket): SessionChannelResult {
		const socketSessionId = this.#sessionIdsBySocket.get(socket);
		if (socketSessionId && socketSessionId !== snapshot.id) {
			throw new Error(`Broker connection is already registered as session ${socketSessionId}`);
		}
		const existing = this.#sessions.get(snapshot.id);
		if (existing && existing.socket !== socket) throw new Error(`Session ${snapshot.id} is already registered`);
		if (existing) {
			existing.snapshot = snapshot;
		} else {
			this.#sessions.set(snapshot.id, { snapshot, socket, events: [] });
			this.#sessionIdsBySocket.set(socket, snapshot.id);
		}
		return { op: "register", session: snapshot };
	}

	#update(snapshot: ChannelSessionSnapshot, socket: net.Socket): SessionChannelResult {
		this.#assertSocketSession(snapshot.id, socket);
		const record = this.#session(snapshot.id);
		const currentAgentIds = new Set(snapshot.agents.map(agent => agent.id));
		const departedAgents = record.snapshot.agents.filter(agent => !currentAgentIds.has(agent.id));
		record.snapshot = snapshot;
		for (const channel of this.#channels.values()) {
			if (!channel.members.has(snapshot.id)) continue;
			for (const agent of departedAgents) {
				this.#broadcast(channel, {
					type: "agent-left",
					channelId: channel.id,
					channelName: channel.name,
					sessionId: snapshot.id,
					agent,
				});
			}
			this.#broadcast(channel, { type: "channel-updated", channel: this.#snapshot(channel) });
		}
		return { op: "update", session: snapshot };
	}

	#open(sessionId: string, requestedMemberIds: string[], name?: string): SessionChannelSnapshot {
		const memberIds = [...new Set([sessionId, ...requestedMemberIds])];
		if (memberIds.length < 2) throw new Error("Opening a channel requires at least one other running session");
		for (const memberId of memberIds) this.#session(memberId);
		let id: string;
		do {
			id = crypto.randomUUID().replaceAll("-", "").slice(0, 16);
		} while (this.#channels.has(id));
		const channel: ChannelRecord = { id, name, createdAt: Date.now(), members: new Set(memberIds) };
		this.#channels.set(id, channel);
		const snapshot = this.#snapshot(channel);
		this.#broadcast(channel, { type: "channel-updated", channel: snapshot });
		return snapshot;
	}

	#setMembers(sessionId: string, channelId: string, requestedMemberIds: string[]): SessionChannelSnapshot {
		const channel = this.#memberChannel(channelId, sessionId);
		const nextMemberIds = [...new Set([sessionId, ...requestedMemberIds])];
		if (nextMemberIds.length < 2) throw new Error("A channel requires at least one other running session");
		for (const memberId of nextMemberIds) this.#session(memberId);

		const previousMemberIds = new Set(channel.members);
		const nextMembers = new Set(nextMemberIds);
		const removedIds = [...previousMemberIds].filter(memberId => !nextMembers.has(memberId));
		const retainedIds = nextMemberIds.filter(memberId => previousMemberIds.has(memberId));
		channel.members = nextMembers;
		const remainingMembers = nextMemberIds.map(memberId => this.#session(memberId).snapshot);

		for (const removedId of removedIds) {
			const member = this.#session(removedId).snapshot;
			this.#purgeMessages(channel.id, removedId);
			const event: SessionChannelEvent = {
				type: "member-left",
				channelId: channel.id,
				channelName: channel.name,
				member,
				reason: "user",
				actorSessionId: sessionId,
				remainingMembers,
				closed: false,
			};
			for (const retainedId of retainedIds) this.#enqueue(this.#session(retainedId), event);
			this.#enqueue(this.#session(removedId), event);
		}

		const snapshot = this.#snapshot(channel);
		this.#broadcast(channel, { type: "channel-updated", channel: snapshot });
		return snapshot;
	}

	#close(channel: ChannelRecord, actorSessionId: string): void {
		const snapshot = this.#snapshot(channel);
		this.#channels.delete(channel.id);
		this.#broadcast(channel, {
			type: "channel-closed",
			channel: snapshot,
			reason: "user",
			actorSessionId,
		});
	}

	#removeMember(
		channel: ChannelRecord,
		memberId: string,
		reason: ChannelLeaveReason,
		actorSessionId?: string,
	): SessionChannelSnapshot | null {
		if (!channel.members.has(memberId)) throw new Error(`Session ${memberId} is not in channel ${channel.id}`);
		const member = this.#session(memberId).snapshot;
		channel.members.delete(memberId);
		this.#purgeMessages(channel.id, memberId);
		const remainingMembers = [...channel.members].map(id => this.#session(id).snapshot);
		const closed = channel.members.size < 2;
		if (closed) this.#channels.delete(channel.id);
		const event: SessionChannelEvent = {
			type: "member-left",
			channelId: channel.id,
			channelName: channel.name,
			member,
			reason,
			actorSessionId,
			remainingMembers,
			closed,
		};
		for (const remainingId of channel.members) this.#enqueue(this.#session(remainingId), event);
		if (reason === "user" && actorSessionId !== memberId) {
			this.#enqueue(this.#session(memberId), event);
		}
		return closed ? null : this.#snapshot(channel);
	}

	#dropSession(sessionId: string, reason: "session-ended"): void {
		const record = this.#sessions.get(sessionId);
		if (!record) return;
		for (const channel of [...this.#channels.values()]) {
			if (channel.members.has(sessionId)) this.#removeMember(channel, sessionId, reason);
		}
		clearTimeout(record.waiter?.timer);
		record.waiter?.resolve(null);
		this.#sessions.delete(sessionId);
		this.#sessionIdsBySocket.delete(record.socket);
	}

	#send(operation: Extract<SessionChannelOperation, { op: "send" }>): number {
		const channel = this.#memberChannel(operation.channelId, operation.sessionId);
		const sender = this.#session(operation.sessionId).snapshot;
		if (!sender.agents.some(agent => agent.id === operation.fromAgentId)) {
			throw new Error(`Agent ${operation.fromAgentId} is not registered in session ${operation.sessionId}`);
		}

		const channelWide = operation.targetSessionId === undefined;
		const targetSessions = operation.targetSessionId ? [operation.targetSessionId] : [...channel.members];
		let targets = 0;
		for (const targetSessionId of targetSessions) {
			if (!channel.members.has(targetSessionId)) {
				throw new Error(`Session ${targetSessionId} is not in channel ${channel.id}`);
			}
			const target = this.#session(targetSessionId);
			const targetAgentIds =
				operation.targetAgentId === "all"
					? target.snapshot.agents.map(agent => agent.id)
					: [operation.targetAgentId];
			for (const targetAgentId of targetAgentIds) {
				if (targetSessionId === operation.sessionId && targetAgentId === operation.fromAgentId) continue;
				if (!target.snapshot.agents.some(agent => agent.id === targetAgentId)) {
					throw new Error(`Agent ${targetAgentId} is not registered in session ${targetSessionId}`);
				}
				if (!channelWide && targetSessionId === operation.sessionId) {
					throw new Error("Direct channel targets must belong to another session");
				}
				this.#enqueue(target, {
					type: "message",
					channelId: channel.id,
					fromSessionId: operation.sessionId,
					fromAgentId: operation.fromAgentId,
					toAgentId: targetAgentId,
					body: operation.body,
					replyTo: operation.replyTo,
				});
				targets++;
			}
		}
		if (targets === 0) throw new Error("No other agents are available in this channel");
		return targets;
	}

	#wait(sessionId: string, timeoutMs: number): Promise<SessionChannelEvent | null> {
		const record = this.#session(sessionId);
		const pending = record.events.shift();
		if (pending) return Promise.resolve(pending);
		if (record.waiter) throw new Error(`Session ${sessionId} already has a pending channel wait`);
		const { promise, resolve } = Promise.withResolvers<SessionChannelEvent | null>();
		const waiter: PendingEventWait = { resolve };
		if (timeoutMs > 0) {
			waiter.timer = setTimeout(() => {
				if (record.waiter !== waiter) return;
				record.waiter = undefined;
				resolve(null);
			}, timeoutMs);
			waiter.timer.unref?.();
		}
		record.waiter = waiter;
		return promise;
	}

	#enqueue(record: RegisteredChannelSession, event: SessionChannelEvent): void {
		const waiter = record.waiter;
		if (waiter) {
			record.waiter = undefined;
			clearTimeout(waiter.timer);
			waiter.resolve(event);
			return;
		}
		record.events.push(event);
		if (record.events.length > EVENT_QUEUE_CAP) record.events.shift();
	}

	#broadcast(channel: ChannelRecord, event: SessionChannelEvent): void {
		for (const memberId of channel.members) this.#enqueue(this.#session(memberId), event);
	}

	#purgeMessages(channelId: string, departedSessionId: string): void {
		for (const record of this.#sessions.values()) {
			for (let index = record.events.length - 1; index >= 0; index--) {
				const event = record.events[index];
				if (
					event?.type === "message" &&
					event.channelId === channelId &&
					event.fromSessionId === departedSessionId
				) {
					record.events.splice(index, 1);
				}
			}
		}
	}

	#snapshot(channel: ChannelRecord): SessionChannelSnapshot {
		return {
			id: channel.id,
			name: channel.name,
			createdAt: channel.createdAt,
			members: [...channel.members]
				.map(id => this.#session(id).snapshot)
				.sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id)),
		};
	}

	#session(sessionId: string): RegisteredChannelSession {
		const session = this.#sessions.get(sessionId);
		if (!session) throw new Error(`Unknown running session ${sessionId}`);
		return session;
	}

	#memberChannel(channelId: string, sessionId: string): ChannelRecord {
		const channel = this.#channels.get(channelId);
		if (!channel) throw new Error(`Unknown or closed channel ${channelId}`);
		if (!channel.members.has(sessionId)) throw new Error(`Session ${sessionId} is not in channel ${channelId}`);
		return channel;
	}

	#assertSocketSession(sessionId: string, socket: net.Socket): void {
		const registeredId = this.#sessionIdsBySocket.get(socket);
		if (registeredId !== sessionId) throw new Error(`Broker connection is not registered as session ${sessionId}`);
	}
}
