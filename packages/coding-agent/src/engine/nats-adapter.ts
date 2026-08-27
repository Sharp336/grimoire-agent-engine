import {
	AckPolicy,
	type ConsumerMessages,
	DeliverPolicy,
	DiscardPolicy,
	JetStreamApiCodes,
	JetStreamApiError,
	type JetStreamClient,
	type JetStreamManager,
	type JsMsg,
	jetstream,
	jetstreamManager,
	ReplayPolicy,
	RetentionPolicy,
	StorageType,
	type StreamConfig,
} from "@nats-io/jetstream";
import { connect, type NatsConnection, type NodeConnectionOptions, nanos } from "@nats-io/transport-node";
import type { EngineEvent, EngineLaunchProfile } from "./contracts";
import { EngineTargetError } from "./contracts";
import { engineRouteToken } from "./route";
import type { EngineRuntime } from "./runtime";

export const ENGINE_COMMAND_STREAM = "GRIMOIRE_ENGINE_COMMANDS";
export const ENGINE_EVENT_STREAM = "GRIMOIRE_ENGINE_EVENTS";
export const AGENT_MESSAGE_STREAM = "GRIMOIRE_AGENT_MESSAGES";
export const ENGINE_MAX_ENVELOPE_BYTES = 256 * 1024;

export type EngineCommandOp = "start" | "steer" | "cancel" | "reconcile";

export interface EngineCommandEnvelope {
	schema: "grimoire.engine.command.v1";
	commandId: string;
	op: EngineCommandOp;
	deviceId: string;
	engineId: string;
	engineGeneration: number;
	agentInstanceId: string;
	runtimeBindingId?: string;
	bindingGeneration?: number;
	executionId?: string;
	attemptId?: string;
	authorityGeneration: number;
	issuedAt: number;
	payload: Record<string, unknown>;
}

export interface AgentMessageEnvelope {
	schema: "grimoire.agent.message.v1";
	messageId: string;
	fromAgentInstanceId: string;
	toAgentInstanceId: string;
	authorityGeneration: number;
	sentAt: number;
	kind: string;
	payload: Record<string, unknown>;
	executionId?: string;
	attemptId?: string;
	replyToMessageId?: string;
}

export interface EngineEventEnvelope {
	schema: "grimoire.engine.event.v1";
	eventId: string;
	agentSeq: number;
	causationCommandId: string;
	deviceId: string;
	engineId: string;
	engineGeneration: number;
	agentInstanceId: string;
	runtimeBindingId: string;
	bindingGeneration: number;
	executionId: string;
	attemptId: string;
	authorityGeneration: number;
	type: string;
	at: number;
	payload?: Record<string, unknown>;
}

export interface NatsEngineAdapterOptions {
	runtime: EngineRuntime;
	deviceId: string;
	engineId: string;
	servers: string | string[];
	connectionOptions?: NodeConnectionOptions;
	authorizeCommand: (command: EngineCommandEnvelope) => void | Promise<void>;
	authorizeMessage: (message: AgentMessageEnvelope) => void | Promise<void>;
	resolveLaunchProfile: (command: EngineCommandEnvelope) => EngineLaunchProfile | Promise<EngineLaunchProfile>;
	onError?: (error: Error) => void;
}

class PoisonMessageError extends Error {}
class StaleEngineLeaseError extends Error {}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const routePattern = /^[0-9a-f]{32}$/;
const dayNanos = nanos(24 * 60 * 60 * 1000);
const duplicateWindowNanos = nanos(2 * 60 * 1000);

export class NatsEngineAdapter {
	readonly runtime: EngineRuntime;
	readonly deviceRoute: string;
	readonly engineRoute: string;
	readonly #options: NatsEngineAdapterOptions;
	readonly #connection: NatsConnection;
	readonly #jetstream: JetStreamClient;
	readonly #manager: JetStreamManager;
	readonly #agentRoutes = new Map<string, string>();
	readonly #consumers = new Set<ConsumerMessages>();
	readonly #loops = new Set<Promise<void>>();
	readonly #mailboxes = new Map<string, Promise<void>>();
	#commandMessages: ConsumerMessages | undefined;
	#unsubscribeRuntime: () => void = () => {};
	#outboxFlush: Promise<void> | undefined;
	#stopping = false;

	private constructor(
		options: NatsEngineAdapterOptions,
		connection: NatsConnection,
		manager: JetStreamManager,
		js: JetStreamClient,
	) {
		this.#options = options;
		this.runtime = options.runtime;
		this.#connection = connection;
		this.#manager = manager;
		this.#jetstream = js;
		this.deviceRoute = engineRouteToken(options.deviceId);
		this.engineRoute = engineRouteToken(options.engineId);
	}

	static async connect(options: NatsEngineAdapterOptions): Promise<NatsEngineAdapter> {
		if (!options.deviceId.trim() || !options.engineId.trim()) {
			throw new Error("deviceId and engineId must be non-empty strings");
		}
		const connection = await connect({
			...options.connectionOptions,
			servers: options.servers,
			name: `grimoire-engine-${engineRouteToken(options.engineId)}`,
		});
		try {
			const manager = await jetstreamManager(connection);
			const js = jetstream(connection);
			const adapter = new NatsEngineAdapter(options, connection, manager, js);
			await adapter.#start();
			return adapter;
		} catch (error) {
			await connection.close();
			throw error;
		}
	}

	commandSubject(agentInstanceId: string, op: EngineCommandOp): string {
		return `grimoire.engine.v1.d.${this.deviceRoute}.e.${this.engineRoute}.a.${engineRouteToken(agentInstanceId)}.cmd.${op}`;
	}

	eventSubject(agentInstanceId: string, kind: string): string {
		return `grimoire.engine.v1.d.${this.deviceRoute}.e.${this.engineRoute}.a.${engineRouteToken(agentInstanceId)}.evt.${kind}`;
	}

	messageSubject(fromAgentInstanceId: string, toAgentInstanceId: string): string {
		return `grimoire.agent.v1.d.${this.deviceRoute}.to.${engineRouteToken(toAgentInstanceId)}.from.${engineRouteToken(fromAgentInstanceId)}.msg`;
	}

	async provisionMailbox(agentInstanceId: string): Promise<void> {
		if (!agentInstanceId.trim()) throw new Error("agentInstanceId must be a non-empty string");
		if (this.#stopping) throw new Error("NatsEngineAdapter is stopping");
		const route = this.#registerAgentRoute(agentInstanceId);
		const existing = this.#mailboxes.get(agentInstanceId);
		if (existing) return await existing;
		const provision = this.#provisionMailbox(agentInstanceId, route);
		this.#mailboxes.set(agentInstanceId, provision);
		try {
			await provision;
		} catch (error) {
			this.#mailboxes.delete(agentInstanceId);
			throw error;
		}
	}

	async flushEvents(): Promise<void> {
		if (this.#outboxFlush) return await this.#outboxFlush;
		const flush = this.#flushEvents();
		this.#outboxFlush = flush;
		try {
			await flush;
		} finally {
			if (this.#outboxFlush === flush) this.#outboxFlush = undefined;
		}
	}

	async dispose(): Promise<void> {
		if (this.#stopping) return;
		this.#stopping = true;
		this.#unsubscribeRuntime();
		await Promise.all([...this.#consumers].map(consumer => consumer.close()));
		await Promise.all(this.#loops);
		await this.flushEvents().catch(error => this.#report(error));
		await this.#connection.drain();
	}

	async #start(): Promise<void> {
		if (!(await this.runtime.store.isCurrentEngineGeneration(this.runtime.engineGeneration))) {
			throw new StaleEngineLeaseError("Engine generation lease is no longer current");
		}
		await this.#ensureStreams();
		const durable = `engine_${this.engineRoute}`;
		const filter = `grimoire.engine.v1.d.${this.deviceRoute}.e.${this.engineRoute}.a.*.cmd.*`;
		await this.#ensureConsumer(ENGINE_COMMAND_STREAM, durable, filter, 128);
		const consumer = await this.#jetstream.consumers.get(ENGINE_COMMAND_STREAM, durable);
		const messages = await consumer.consume({ max_messages: 128 });
		this.#commandMessages = messages;
		this.#consumers.add(messages);
		this.#trackLoop(this.#consumeCommands(messages));
		this.#unsubscribeRuntime = this.runtime.subscribe(() => {
			void this.flushEvents().catch(error => this.#report(error));
		});
		await this.flushEvents();
	}

	async #ensureStreams(): Promise<void> {
		await this.#ensureStream({
			name: ENGINE_COMMAND_STREAM,
			subjects: ["grimoire.engine.v1.d.*.e.*.a.*.cmd.*"],
			retention: RetentionPolicy.Workqueue,
			storage: StorageType.File,
		});
		await this.#ensureStream({
			name: ENGINE_EVENT_STREAM,
			subjects: ["grimoire.engine.v1.d.*.e.*.a.*.evt.*"],
			retention: RetentionPolicy.Limits,
			storage: StorageType.File,
		});
		await this.#ensureStream({
			name: AGENT_MESSAGE_STREAM,
			subjects: ["grimoire.agent.v1.d.*.to.*.from.*.msg"],
			retention: RetentionPolicy.Workqueue,
			storage: StorageType.File,
		});
	}

	async #ensureStream(required: Pick<StreamConfig, "name" | "subjects" | "retention" | "storage">): Promise<void> {
		try {
			const current = await this.#manager.streams.info(required.name);
			if (
				current.config.retention !== required.retention ||
				current.config.storage !== required.storage ||
				current.config.max_age !== dayNanos ||
				current.config.max_bytes !== 256 * 1024 * 1024 ||
				current.config.max_msg_size !== ENGINE_MAX_ENVELOPE_BYTES ||
				current.config.num_replicas !== 1 ||
				current.config.subjects.length !== required.subjects.length ||
				current.config.subjects.some((subject, index) => subject !== required.subjects[index])
			) {
				throw new Error(`NATS stream ${required.name} does not match the Engine contract`);
			}
			return;
		} catch (error) {
			if (!isJetStreamCode(error, JetStreamApiCodes.StreamNotFound)) throw error;
		}
		await this.#manager.streams.add({
			...required,
			discard: DiscardPolicy.Old,
			max_age: dayNanos,
			max_bytes: 256 * 1024 * 1024,
			max_msg_size: ENGINE_MAX_ENVELOPE_BYTES,
			duplicate_window: duplicateWindowNanos,
			num_replicas: 1,
		});
	}

	async #ensureConsumer(stream: string, durable: string, filter: string, maxAckPending: number): Promise<void> {
		try {
			const current = await this.#manager.consumers.info(stream, durable);
			if (
				current.config.filter_subject !== filter ||
				current.config.ack_policy !== AckPolicy.Explicit ||
				current.config.deliver_policy !== DeliverPolicy.All ||
				current.config.replay_policy !== ReplayPolicy.Instant ||
				current.config.max_ack_pending !== maxAckPending
			) {
				throw new Error(`NATS consumer ${durable} does not match the Engine contract`);
			}
			return;
		} catch (error) {
			if (!isJetStreamCode(error, JetStreamApiCodes.ConsumerNotFound)) throw error;
		}
		await this.#manager.consumers.add(stream, {
			durable_name: durable,
			ack_policy: AckPolicy.Explicit,
			deliver_policy: DeliverPolicy.All,
			replay_policy: ReplayPolicy.Instant,
			filter_subject: filter,
			max_ack_pending: maxAckPending,
		});
	}

	async #provisionMailbox(agentInstanceId: string, route: string): Promise<void> {
		const durable = `agent_${route}`;
		const filter = `grimoire.agent.v1.d.${this.deviceRoute}.to.${route}.from.*.msg`;
		await this.#ensureConsumer(AGENT_MESSAGE_STREAM, durable, filter, 32);
		const consumer = await this.#jetstream.consumers.get(AGENT_MESSAGE_STREAM, durable);
		const messages = await consumer.consume({ max_messages: 32 });
		this.#consumers.add(messages);
		this.#trackLoop(this.#consumeMailbox(agentInstanceId, messages));
	}

	async #consumeCommands(messages: ConsumerMessages): Promise<void> {
		for await (const message of messages) {
			if (this.#stopping) break;
			this.#trackLoop(this.#handleCommand(message));
		}
	}

	async #handleCommand(message: JsMsg): Promise<void> {
		let command: EngineCommandEnvelope | undefined;
		message.working();
		const heartbeat = setInterval(() => message.working(), 10_000);
		try {
			command = this.#parseCommand(message);
			await this.#options.authorizeCommand(command);
			await this.#dispatchCommand(command);
			message.ack();
		} catch (error) {
			if (error instanceof StaleEngineLeaseError) {
				message.nak(250);
				void this.#commandMessages?.close();
				this.#report(error);
				return;
			}
			if (error instanceof PoisonMessageError) {
				message.term(error.message.slice(0, 128));
				return;
			}
			if (error instanceof EngineTargetError) {
				if (error.code === "agent_busy") {
					message.nak(1_000);
					return;
				}
				if (command?.executionId && command.attemptId) {
					await this.runtime
						.recordCommandRejection({
							commandId: command.commandId,
							agentInstanceId: command.agentInstanceId,
							executionId: command.executionId,
							attemptId: command.attemptId,
							authorityGeneration: command.authorityGeneration,
							bindingGeneration: command.bindingGeneration,
							code: error.code,
							message: error.message,
						})
						.catch(reportError => this.#report(reportError));
				}
				message.ack();
				return;
			}
			message.nak(1_000);
			this.#report(error);
		} finally {
			clearInterval(heartbeat);
		}
	}

	async #dispatchCommand(command: EngineCommandEnvelope): Promise<void> {
		if (!(await this.runtime.store.isCurrentEngineGeneration(this.runtime.engineGeneration))) {
			throw new StaleEngineLeaseError("Engine generation lease is no longer current");
		}
		if (command.engineGeneration !== this.runtime.engineGeneration) {
			throw new EngineTargetError("stale_target", `Engine generation ${command.engineGeneration} is stale`);
		}
		switch (command.op) {
			case "start": {
				const executionId = requiredEnvelopeString(command.executionId, "executionId");
				const attemptId = requiredEnvelopeString(command.attemptId, "attemptId");
				const input = requiredRecordString(command.payload, "input");
				const cwd = requiredRecordString(command.payload, "cwd");
				const profileDigest = requiredRecordString(command.payload, "profileDigest");
				const profile = await this.#options.resolveLaunchProfile(command);
				if (profile.profileDigest !== profileDigest) {
					throw new EngineTargetError("invalid_request", "launch profile digest mismatch");
				}
				await this.provisionMailbox(command.agentInstanceId);
				await this.runtime.start(
					{
						commandId: command.commandId,
						agentInstanceId: command.agentInstanceId,
						executionId,
						attemptId,
						authorityGeneration: command.authorityGeneration,
						cwd,
						input,
					},
					profile,
				);
				return;
			}
			case "steer":
				await this.runtime.steer({
					...boundTarget(command),
					commandId: command.commandId,
					message: requiredRecordString(command.payload, "text"),
				});
				return;
			case "cancel":
				await this.runtime.cancel({
					...boundTarget(command),
					commandId: command.commandId,
					reason: optionalRecordString(command.payload, "reason"),
				});
				return;
			case "reconcile":
				await this.runtime.reconcile({
					commandId: command.commandId,
					agentInstanceId: command.agentInstanceId,
					authorityGeneration: command.authorityGeneration,
				});
		}
	}

	#parseCommand(message: JsMsg): EngineCommandEnvelope {
		const [deviceRoute, engineRoute, agentRoute, op] = parseCommandSubject(message.subject);
		if (deviceRoute !== this.deviceRoute || engineRoute !== this.engineRoute) {
			throw new PoisonMessageError("command is addressed to another Engine");
		}
		const value = parseJsonRecord(message.data);
		if (value.schema !== "grimoire.engine.command.v1") throw new PoisonMessageError("unsupported command schema");
		const command = value as unknown as EngineCommandEnvelope;
		for (const key of ["commandId", "deviceId", "engineId", "agentInstanceId"] as const) {
			requiredRecordString(value, key);
		}
		if (!isCommandOp(value.op) || value.op !== op) throw new PoisonMessageError("command op does not match subject");
		requiredSafeInteger(value, "engineGeneration");
		requiredSafeInteger(value, "authorityGeneration");
		requiredSafeInteger(value, "issuedAt");
		requiredRecord(value, "payload");
		if (command.deviceId !== this.#options.deviceId || command.engineId !== this.#options.engineId) {
			throw new PoisonMessageError("command canonical Engine ids do not match subject");
		}
		if (this.#registerAgentRoute(command.agentInstanceId) !== agentRoute) {
			throw new PoisonMessageError("command agent route does not match canonical id");
		}
		return command;
	}

	async #consumeMailbox(recipientId: string, messages: ConsumerMessages): Promise<void> {
		for await (const message of messages) {
			if (this.#stopping) break;
			try {
				const envelope = this.#parseMessage(message, recipientId);
				await this.#options.authorizeMessage(envelope);
				const receipt = await this.runtime.deliverPeerMessage({
					messageId: envelope.messageId,
					fromAgentInstanceId: envelope.fromAgentInstanceId,
					toAgentInstanceId: envelope.toAgentInstanceId,
					body: requiredRecordString(envelope.payload, "body"),
				});
				if (receipt.outcome === "failed") message.nak(1_000);
				else message.ack();
			} catch (error) {
				if (error instanceof PoisonMessageError || error instanceof EngineTargetError) {
					message.term(error.message.slice(0, 128));
				} else {
					message.nak(1_000);
					this.#report(error);
				}
			}
		}
	}

	#parseMessage(message: JsMsg, recipientId: string): AgentMessageEnvelope {
		const [deviceRoute, recipientRoute, senderRoute] = parseMessageSubject(message.subject);
		if (deviceRoute !== this.deviceRoute) throw new PoisonMessageError("message is addressed to another device");
		const value = parseJsonRecord(message.data);
		if (value.schema !== "grimoire.agent.message.v1") throw new PoisonMessageError("unsupported message schema");
		const envelope = value as unknown as AgentMessageEnvelope;
		for (const key of ["messageId", "fromAgentInstanceId", "toAgentInstanceId", "kind"] as const) {
			requiredRecordString(value, key);
		}
		requiredSafeInteger(value, "authorityGeneration");
		requiredSafeInteger(value, "sentAt");
		requiredRecord(value, "payload");
		if (envelope.toAgentInstanceId !== recipientId) throw new PoisonMessageError("recipient id mismatch");
		if (this.#registerAgentRoute(envelope.toAgentInstanceId) !== recipientRoute) {
			throw new PoisonMessageError("recipient route mismatch");
		}
		if (this.#registerAgentRoute(envelope.fromAgentInstanceId) !== senderRoute) {
			throw new PoisonMessageError("sender route mismatch");
		}
		return envelope;
	}

	async #flushEvents(): Promise<void> {
		for (;;) {
			if (!(await this.runtime.store.isCurrentEngineGeneration(this.runtime.engineGeneration))) {
				throw new StaleEngineLeaseError("Engine generation lease is no longer current");
			}
			const events = await this.runtime.store.pendingEvents(100);
			if (events.length === 0) return;
			for (const event of events) {
				const envelope = this.#eventEnvelope(event);
				const payload = encodeEnvelope(envelope);
				await this.#jetstream.publish(this.eventSubject(event.agentInstanceId, event.kind), payload, {
					msgID: String(event.eventId),
				});
				await this.runtime.store.markEventPublished(event.eventId);
			}
		}
	}

	#eventEnvelope(event: EngineEvent): EngineEventEnvelope {
		return {
			schema: "grimoire.engine.event.v1",
			eventId: String(event.eventId),
			agentSeq: event.seq,
			causationCommandId: event.causationCommandId,
			deviceId: this.#options.deviceId,
			engineId: this.#options.engineId,
			engineGeneration: event.engineGeneration,
			agentInstanceId: event.agentInstanceId,
			runtimeBindingId: event.bindingId,
			bindingGeneration: event.bindingGeneration,
			executionId: event.executionId,
			attemptId: event.attemptId,
			authorityGeneration: event.authorityGeneration,
			type: eventType(event.kind),
			at: event.createdAt,
			payload: event.payload,
		};
	}

	#registerAgentRoute(agentInstanceId: string): string {
		const route = engineRouteToken(agentInstanceId);
		const existing = this.#agentRoutes.get(route);
		if (existing && existing !== agentInstanceId) {
			throw new PoisonMessageError(`route collision between ${existing} and ${agentInstanceId}`);
		}
		this.#agentRoutes.set(route, agentInstanceId);
		return route;
	}

	#trackLoop(loop: Promise<void>): void {
		const tracked = loop.catch(error => {
			if (!this.#stopping) this.#report(error);
		});
		this.#loops.add(tracked);
		void tracked.finally(() => this.#loops.delete(tracked));
	}

	#report(error: unknown): void {
		this.#options.onError?.(error instanceof Error ? error : new Error(String(error)));
	}
}

function parseCommandSubject(subject: string): [string, string, string, EngineCommandOp] {
	const tokens = subject.split(".");
	if (
		tokens.length !== 11 ||
		tokens[0] !== "grimoire" ||
		tokens[1] !== "engine" ||
		tokens[2] !== "v1" ||
		tokens[3] !== "d" ||
		tokens[5] !== "e" ||
		tokens[7] !== "a" ||
		tokens[9] !== "cmd" ||
		!routePattern.test(tokens[4] ?? "") ||
		!routePattern.test(tokens[6] ?? "") ||
		!routePattern.test(tokens[8] ?? "") ||
		!isCommandOp(tokens[10])
	) {
		throw new PoisonMessageError("invalid command subject");
	}
	return [tokens[4], tokens[6], tokens[8], tokens[10]];
}

function parseMessageSubject(subject: string): [string, string, string] {
	const tokens = subject.split(".");
	if (
		tokens.length !== 10 ||
		tokens[0] !== "grimoire" ||
		tokens[1] !== "agent" ||
		tokens[2] !== "v1" ||
		tokens[3] !== "d" ||
		tokens[5] !== "to" ||
		tokens[7] !== "from" ||
		tokens[9] !== "msg" ||
		!routePattern.test(tokens[4] ?? "") ||
		!routePattern.test(tokens[6] ?? "") ||
		!routePattern.test(tokens[8] ?? "")
	) {
		throw new PoisonMessageError("invalid message subject");
	}
	return [tokens[4], tokens[6], tokens[8]];
}

function parseJsonRecord(data: Uint8Array): Record<string, unknown> {
	if (data.byteLength === 0 || data.byteLength > ENGINE_MAX_ENVELOPE_BYTES) {
		throw new PoisonMessageError("envelope size is outside the accepted range");
	}
	try {
		const value: unknown = JSON.parse(decoder.decode(data));
		if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("not an object");
		return value as Record<string, unknown>;
	} catch (error) {
		throw new PoisonMessageError(`invalid UTF-8 JSON envelope: ${error instanceof Error ? error.message : error}`);
	}
}

function requiredRecord(record: Record<string, unknown>, key: string): Record<string, unknown> {
	const value = record[key];
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new PoisonMessageError(`${key} must be an object`);
	}
	return value as Record<string, unknown>;
}

function requiredRecordString(record: Record<string, unknown>, key: string): string {
	return requiredEnvelopeString(record[key], key);
}

function requiredEnvelopeString(value: unknown, key: string): string {
	if (typeof value !== "string" || !value.trim()) throw new PoisonMessageError(`${key} must be a non-empty string`);
	return value;
}

function optionalRecordString(record: Record<string, unknown>, key: string): string | undefined {
	const value = record[key];
	if (value === undefined || value === null) return undefined;
	return requiredEnvelopeString(value, key);
}

function requiredSafeInteger(record: Record<string, unknown>, key: string): number {
	const value = record[key];
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
		throw new PoisonMessageError(`${key} must be a non-negative safe integer`);
	}
	return value;
}

function isCommandOp(value: unknown): value is EngineCommandOp {
	return value === "start" || value === "steer" || value === "cancel" || value === "reconcile";
}

function boundTarget(command: EngineCommandEnvelope) {
	return {
		bindingId: requiredEnvelopeString(command.runtimeBindingId, "runtimeBindingId"),
		agentInstanceId: command.agentInstanceId,
		executionId: requiredEnvelopeString(command.executionId, "executionId"),
		attemptId: requiredEnvelopeString(command.attemptId, "attemptId"),
		authorityGeneration: command.authorityGeneration,
		engineGeneration: command.engineGeneration,
		bindingGeneration: requiredSafeInteger(command as unknown as Record<string, unknown>, "bindingGeneration"),
	};
}

function eventType(kind: EngineEvent["kind"]): string {
	switch (kind) {
		case "accepted":
			return "command.accepted";
		case "rejected":
			return "command.rejected";
		case "running":
			return "attempt.started";
		case "reconciled":
			return "reconcile.snapshot";
		case "steered":
			return "command.steered";
		default:
			return `attempt.${kind}`;
	}
}

function encodeEnvelope(envelope: object): Uint8Array {
	const data = encoder.encode(JSON.stringify(envelope));
	if (data.byteLength > ENGINE_MAX_ENVELOPE_BYTES) throw new Error("Engine envelope exceeds 256 KiB");
	return data;
}

function isJetStreamCode(error: unknown, code: number): boolean {
	return error instanceof JetStreamApiError && error.code === code;
}
