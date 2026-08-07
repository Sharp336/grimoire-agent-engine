export type ChannelAgentStatus = "running" | "idle" | "parked";
export type ChannelAgentKind = "main" | "sub";

export interface ChannelAgentSnapshot {
	id: string;
	displayName: string;
	kind: ChannelAgentKind;
	status: ChannelAgentStatus;
	parentId?: string;
	lastActivity: number;
	activity?: string;
}

/** One running top-level session registered with the user-global broker. */
export interface ChannelSessionSnapshot {
	id: string;
	pid: number;
	sessionId: string;
	title?: string;
	cwd: string;
	startedAt: number;
	agents: ChannelAgentSnapshot[];
}

/** A user-authorized group. Every member may message every other member. */
export interface SessionChannelSnapshot {
	id: string;
	name?: string;
	createdAt: number;
	members: ChannelSessionSnapshot[];
}

export type ChannelLeaveReason = "user" | "agent" | "session-ended";

export type SessionChannelEvent =
	| { type: "channel-updated"; channel: SessionChannelSnapshot }
	| {
			type: "member-left";
			channelId: string;
			channelName?: string;
			member: ChannelSessionSnapshot;
			reason: ChannelLeaveReason;
			actorSessionId?: string;
			remainingMembers: ChannelSessionSnapshot[];
			closed: boolean;
	  }
	| {
			type: "agent-left";
			channelId: string;
			channelName?: string;
			sessionId: string;
			agent: ChannelAgentSnapshot;
	  }
	| {
			type: "channel-closed";
			channel: SessionChannelSnapshot;
			reason: "user";
			actorSessionId: string;
	  }
	| {
			type: "message";
			channelId: string;
			fromSessionId: string;
			fromAgentId: string;
			toAgentId: string;
			body: string;
			replyTo?: string;
	  };

export type SessionChannelOperation =
	| { op: "register"; session: ChannelSessionSnapshot }
	| { op: "unregister"; sessionId: string }
	| { op: "list"; sessionId: string }
	| { op: "open"; sessionId: string; memberIds: string[]; name?: string }
	| { op: "set-members"; sessionId: string; channelId: string; memberIds: string[] }
	| { op: "close"; sessionId: string; channelId: string }
	| { op: "leave"; sessionId: string; channelId: string; reason: "user" | "agent" }
	| { op: "update"; session: ChannelSessionSnapshot }
	| {
			op: "send";
			sessionId: string;
			channelId: string;
			fromAgentId: string;
			targetSessionId?: string;
			targetAgentId: string;
			body: string;
			replyTo?: string;
	  }
	| { op: "wait"; sessionId: string; timeoutMs: number };

export type SessionChannelResult =
	| { op: "register"; session: ChannelSessionSnapshot }
	| { op: "unregister" }
	| { op: "list"; sessions: ChannelSessionSnapshot[]; channels: SessionChannelSnapshot[] }
	| { op: "open"; channel: SessionChannelSnapshot }
	| { op: "set-members"; channel: SessionChannelSnapshot }
	| { op: "close" }
	| { op: "leave"; channel: SessionChannelSnapshot | null }
	| { op: "update"; session: ChannelSessionSnapshot }
	| { op: "send"; targets: number }
	| { op: "wait"; event: SessionChannelEvent | null };

const RUNTIME_ID_RE = /^[a-f0-9]{16}$/;
const CHANNEL_NAME_MAX = 80;
const MESSAGE_MAX = 64 * 1024;

function record(value: unknown, label: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new Error(`${label} must be an object`);
	return value as Record<string, unknown>;
}

function stringValue(value: unknown, label: string, max = 512): string {
	if (typeof value !== "string" || value.length === 0 || value.length > max) {
		throw new Error(`${label} must be a non-empty string up to ${max} characters`);
	}
	return value;
}

function optionalString(value: unknown, label: string, max = 512): string | undefined {
	return value === undefined ? undefined : stringValue(value, label, max);
}

function numberValue(value: unknown, label: string): number {
	if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} must be a finite number`);
	return value;
}

function booleanValue(value: unknown, label: string): boolean {
	if (typeof value !== "boolean") throw new Error(`${label} must be a boolean`);
	return value;
}

function runtimeId(value: unknown, label: string): string {
	const id = stringValue(value, label, 16);
	if (!RUNTIME_ID_RE.test(id)) throw new Error(`${label} must be 16 lowercase hexadecimal characters`);
	return id;
}

function stringArray(value: unknown, label: string): string[] {
	if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
	return value.map((entry, index) => runtimeId(entry, `${label}[${index}]`));
}

function agentStatus(value: unknown): ChannelAgentStatus {
	if (value === "running" || value === "idle" || value === "parked") return value;
	throw new Error("agent.status must be running, idle, or parked");
}

function agentKind(value: unknown): ChannelAgentKind {
	if (value === "main" || value === "sub") return value;
	throw new Error("agent.kind must be main or sub");
}

export function parseChannelAgentSnapshot(value: unknown): ChannelAgentSnapshot {
	const source = record(value, "channel agent");
	return {
		id: stringValue(source.id, "agent.id", 128),
		displayName: stringValue(source.displayName, "agent.displayName", 256),
		kind: agentKind(source.kind),
		status: agentStatus(source.status),
		parentId: optionalString(source.parentId, "agent.parentId", 128),
		lastActivity: numberValue(source.lastActivity, "agent.lastActivity"),
		activity: optionalString(source.activity, "agent.activity", 512),
	};
}

export function parseChannelSessionSnapshot(value: unknown): ChannelSessionSnapshot {
	const source = record(value, "channel session");
	if (!Array.isArray(source.agents)) throw new Error("session.agents must be an array");
	return {
		id: runtimeId(source.id, "session.id"),
		pid: numberValue(source.pid, "session.pid"),
		sessionId: stringValue(source.sessionId, "session.sessionId", 128),
		title: optionalString(source.title, "session.title", 256),
		cwd: stringValue(source.cwd, "session.cwd", 4096),
		startedAt: numberValue(source.startedAt, "session.startedAt"),
		agents: source.agents.map(parseChannelAgentSnapshot),
	};
}

export function parseSessionChannelSnapshot(value: unknown): SessionChannelSnapshot {
	const source = record(value, "session channel");
	if (!Array.isArray(source.members)) throw new Error("channel.members must be an array");
	return {
		id: runtimeId(source.id, "channel.id"),
		name: optionalString(source.name, "channel.name", CHANNEL_NAME_MAX),
		createdAt: numberValue(source.createdAt, "channel.createdAt"),
		members: source.members.map(parseChannelSessionSnapshot),
	};
}

function leaveReason(value: unknown): ChannelLeaveReason {
	if (value === "user" || value === "agent" || value === "session-ended") return value;
	throw new Error("event.reason must be user, agent, or session-ended");
}

export function parseSessionChannelEvent(value: unknown): SessionChannelEvent {
	const source = record(value, "session channel event");
	const eventType = stringValue(source.type, "event.type");
	switch (eventType) {
		case "channel-updated":
			return { type: eventType, channel: parseSessionChannelSnapshot(source.channel) };
		case "member-left": {
			if (!Array.isArray(source.remainingMembers)) throw new Error("event.remainingMembers must be an array");
			return {
				type: eventType,
				channelId: runtimeId(source.channelId, "event.channelId"),
				channelName: optionalString(source.channelName, "event.channelName", CHANNEL_NAME_MAX),
				member: parseChannelSessionSnapshot(source.member),
				reason: leaveReason(source.reason),
				actorSessionId:
					source.actorSessionId === undefined
						? undefined
						: runtimeId(source.actorSessionId, "event.actorSessionId"),
				remainingMembers: source.remainingMembers.map(parseChannelSessionSnapshot),
				closed: booleanValue(source.closed, "event.closed"),
			};
		}
		case "agent-left":
			return {
				type: eventType,
				channelId: runtimeId(source.channelId, "event.channelId"),
				channelName: optionalString(source.channelName, "event.channelName", CHANNEL_NAME_MAX),
				sessionId: runtimeId(source.sessionId, "event.sessionId"),
				agent: parseChannelAgentSnapshot(source.agent),
			};
		case "channel-closed":
			if (source.reason !== "user") throw new Error("channel-closed reason must be user");
			return {
				type: eventType,
				channel: parseSessionChannelSnapshot(source.channel),
				reason: "user",
				actorSessionId: runtimeId(source.actorSessionId, "event.actorSessionId"),
			};
		case "message":
			return {
				type: eventType,
				channelId: runtimeId(source.channelId, "event.channelId"),
				fromSessionId: runtimeId(source.fromSessionId, "event.fromSessionId"),
				fromAgentId: stringValue(source.fromAgentId, "event.fromAgentId", 128),
				toAgentId: stringValue(source.toAgentId, "event.toAgentId", 128),
				body: stringValue(source.body, "event.body", MESSAGE_MAX),
				replyTo: optionalString(source.replyTo, "event.replyTo", 128),
			};
		default:
			throw new Error(`Unknown session channel event: ${eventType}`);
	}
}

export function parseSessionChannelOperation(value: unknown): SessionChannelOperation {
	const source = record(value, "session channel operation");
	const op = stringValue(source.op, "operation.op");
	switch (op) {
		case "register":
		case "update":
			return { op, session: parseChannelSessionSnapshot(source.session) };
		case "unregister":
		case "list":
			return { op, sessionId: runtimeId(source.sessionId, "operation.sessionId") };
		case "open":
			return {
				op,
				sessionId: runtimeId(source.sessionId, "operation.sessionId"),
				memberIds: stringArray(source.memberIds, "operation.memberIds"),
				name: optionalString(source.name, "operation.name", CHANNEL_NAME_MAX),
			};
		case "set-members":
			return {
				op,
				sessionId: runtimeId(source.sessionId, "operation.sessionId"),
				channelId: runtimeId(source.channelId, "operation.channelId"),
				memberIds: stringArray(source.memberIds, "operation.memberIds"),
			};
		case "close":
			return {
				op,
				sessionId: runtimeId(source.sessionId, "operation.sessionId"),
				channelId: runtimeId(source.channelId, "operation.channelId"),
			};
		case "leave": {
			const reason = leaveReason(source.reason);
			if (reason === "session-ended") throw new Error("leave reason must be user or agent");
			return {
				op,
				sessionId: runtimeId(source.sessionId, "operation.sessionId"),
				channelId: runtimeId(source.channelId, "operation.channelId"),
				reason,
			};
		}
		case "send":
			return {
				op,
				sessionId: runtimeId(source.sessionId, "operation.sessionId"),
				channelId: runtimeId(source.channelId, "operation.channelId"),
				fromAgentId: stringValue(source.fromAgentId, "operation.fromAgentId", 128),
				targetSessionId:
					source.targetSessionId === undefined
						? undefined
						: runtimeId(source.targetSessionId, "operation.targetSessionId"),
				targetAgentId: stringValue(source.targetAgentId, "operation.targetAgentId", 128),
				body: stringValue(source.body, "operation.body", MESSAGE_MAX),
				replyTo: optionalString(source.replyTo, "operation.replyTo", 128),
			};
		case "wait":
			return {
				op,
				sessionId: runtimeId(source.sessionId, "operation.sessionId"),
				timeoutMs: numberValue(source.timeoutMs, "operation.timeoutMs"),
			};
		default:
			throw new Error(`Unknown session channel operation: ${op}`);
	}
}

export function parseSessionChannelResult(operation: SessionChannelOperation, value: unknown): SessionChannelResult {
	const source = record(value, `${operation.op} result`);
	const op = stringValue(source.op, "result.op");
	if (op !== operation.op) throw new Error(`Expected ${operation.op} result, received ${op}`);
	switch (operation.op) {
		case "register":
		case "update":
			return { op: operation.op, session: parseChannelSessionSnapshot(source.session) };
		case "unregister":
		case "close":
			return { op: operation.op };
		case "list":
			if (!Array.isArray(source.sessions)) throw new Error("result.sessions must be an array");
			if (!Array.isArray(source.channels)) throw new Error("result.channels must be an array");
			return {
				op: "list",
				sessions: source.sessions.map(parseChannelSessionSnapshot),
				channels: source.channels.map(parseSessionChannelSnapshot),
			};
		case "open":
		case "set-members":
			return { op: operation.op, channel: parseSessionChannelSnapshot(source.channel) };
		case "leave":
			return {
				op: operation.op,
				channel: source.channel === null ? null : parseSessionChannelSnapshot(source.channel),
			};
		case "send":
			return { op: "send", targets: numberValue(source.targets, "result.targets") };
		case "wait":
			return { op: "wait", event: source.event === null ? null : parseSessionChannelEvent(source.event) };
	}
}
