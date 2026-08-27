import {
	AckPolicy,
	type ConsumerMessages,
	DeliverPolicy,
	JetStreamApiCodes,
	JetStreamApiError,
	jetstream,
	jetstreamManager,
	ReplayPolicy,
} from "@nats-io/jetstream";
import { connect, type NatsConnection, type NodeConnectionOptions } from "@nats-io/transport-node";
import {
	type AgentMessageEnvelope,
	ENGINE_EVENT_STREAM,
	ENGINE_MAX_ENVELOPE_BYTES,
	type EngineCommandEnvelope,
	type EngineEventEnvelope,
} from "./nats-adapter";
import { engineRouteToken } from "./route";

interface BridgeClaim {
	jobId: string;
	leaseToken: string;
	operationType: "agent_engine_command" | "agent_engine_message";
	work: {
		kind: "command" | "message";
		command?: Omit<EngineCommandEnvelope, "engineGeneration">;
		message?: AgentMessageEnvelope;
	};
	heartbeatFailures: number;
}

export interface GrimoireRpc {
	call(tool: string, arguments_: Record<string, unknown>): Promise<Record<string, unknown>>;
}

export interface HostedGrimoireRpcOptions {
	serverUrl: string;
	token: string;
	clientId: string;
	clientVersion?: string;
	protocolVersion?: string;
	sourceSignature?: string;
}

export class HostedGrimoireRpc implements GrimoireRpc {
	readonly #options: HostedGrimoireRpcOptions;
	readonly #endpoint: string;
	#requestId = 0;

	constructor(options: HostedGrimoireRpcOptions) {
		if (!options.serverUrl.trim() || !options.token.trim() || !options.clientId.trim()) {
			throw new Error("serverUrl, token and clientId are required");
		}
		this.#options = options;
		const endpoint = new URL(options.serverUrl);
		if (
			!["http:", "https:"].includes(endpoint.protocol) ||
			endpoint.username ||
			endpoint.password ||
			endpoint.search ||
			endpoint.hash
		) {
			throw new Error("serverUrl must be an HTTP(S) URL without userinfo, query or fragment");
		}
		if (!/^\/mcp(?:\/[a-z0-9_-]+)?\/?$/i.test(endpoint.pathname)) {
			endpoint.pathname = `${endpoint.pathname.replace(/\/$/, "")}/mcp`;
		}
		this.#endpoint = endpoint.toString();
	}

	async call(tool: string, arguments_: Record<string, unknown>): Promise<Record<string, unknown>> {
		const response = await fetch(this.#endpoint, {
			method: "POST",
			redirect: "error",
			headers: {
				Accept: "application/json, text/event-stream",
				Authorization: `Bearer ${this.#options.token}`,
				"Content-Type": "application/json",
				"X-Grimoire-Client": this.#options.clientId,
				"X-Grimoire-Client-Name": "grimoire-agent-engine",
				"X-Grimoire-Client-Version": this.#options.clientVersion ?? "0.4.0",
				"X-Grimoire-Client-Surface": "agent_engine_bridge",
				"X-Grimoire-Client-Protocol-Version": this.#options.protocolVersion ?? "2026-08-01",
				...(this.#options.sourceSignature
					? { "X-Grimoire-Client-Source-Signature": this.#options.sourceSignature }
					: {}),
			},
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: ++this.#requestId,
				method: "tools/call",
				params: { name: tool, arguments: arguments_ },
			}),
			signal: AbortSignal.timeout(30_000),
		});
		if (!response.ok) throw new Error(`Grimoire Host returned HTTP ${response.status}`);
		const json = (await response.json()) as Record<string, unknown>;
		if (json.error) {
			const error = json.error as Record<string, unknown>;
			throw new Error(`Grimoire Host rejected bridge call: ${String(error.message ?? "unknown error")}`);
		}
		const result = json.result as Record<string, unknown> | undefined;
		if (!result) throw new Error("Grimoire Host returned no bridge result");
		if (result.structuredContent && typeof result.structuredContent === "object") {
			return result.structuredContent as Record<string, unknown>;
		}
		const content = Array.isArray(result.content) ? result.content : [];
		const text = content.find(
			item => item && typeof item === "object" && (item as Record<string, unknown>).type === "text",
		) as Record<string, unknown> | undefined;
		if (typeof text?.text !== "string") throw new Error("Grimoire Host bridge result has no JSON content");
		return JSON.parse(text.text) as Record<string, unknown>;
	}
}

export interface HostedEngineBridgeOptions {
	rpc: GrimoireRpc;
	deviceId: string;
	engineId: string;
	engineGeneration: number;
	servers: string | string[];
	connectionOptions?: NodeConnectionOptions;
	pollIntervalMs?: number;
	heartbeatIntervalMs?: number;
	onError?: (error: Error) => void;
}

export class HostedEngineBridge {
	readonly #options: HostedEngineBridgeOptions;
	readonly #connection: NatsConnection;
	readonly #active = new Map<string, BridgeClaim>();
	readonly #loops = new Set<Promise<void>>();
	readonly #stop = Promise.withResolvers<void>();
	#events: ConsumerMessages | undefined;
	#stopping = false;

	private constructor(options: HostedEngineBridgeOptions, connection: NatsConnection) {
		this.#options = options;
		this.#connection = connection;
	}

	static async connect(options: HostedEngineBridgeOptions): Promise<HostedEngineBridge> {
		if (!options.deviceId.trim() || !options.engineId.trim()) throw new Error("deviceId and engineId are required");
		const connection = await connect({
			...options.connectionOptions,
			servers: options.servers,
			name: `grimoire-host-bridge-${engineRouteToken(options.engineId)}`,
		});
		try {
			const bridge = new HostedEngineBridge(options, connection);
			await bridge.#start();
			return bridge;
		} catch (error) {
			await connection.close();
			throw error;
		}
	}

	async dispose(): Promise<void> {
		if (this.#stopping) return;
		this.#stopping = true;
		this.#stop.resolve();
		await this.#events?.close();
		await Promise.all(this.#loops);
		await this.#connection.drain();
	}

	async #start(): Promise<void> {
		const manager = await jetstreamManager(this.#connection);
		const deviceRoute = engineRouteToken(this.#options.deviceId);
		const engineRoute = engineRouteToken(this.#options.engineId);
		const durable = `host_${deviceRoute}_${engineRoute}`;
		const filter = `grimoire.engine.v1.d.${deviceRoute}.e.${engineRoute}.a.*.evt.*`;
		try {
			const current = await manager.consumers.info(ENGINE_EVENT_STREAM, durable);
			if (current.config.filter_subject !== filter || current.config.ack_policy !== AckPolicy.Explicit) {
				throw new Error(`NATS consumer ${durable} does not match the hosted bridge contract`);
			}
		} catch (error) {
			if (!isConsumerMissing(error)) throw error;
			await manager.consumers.add(ENGINE_EVENT_STREAM, {
				durable_name: durable,
				ack_policy: AckPolicy.Explicit,
				deliver_policy: DeliverPolicy.All,
				replay_policy: ReplayPolicy.Instant,
				filter_subject: filter,
				max_ack_pending: 128,
			});
		}
		const consumer = await jetstream(this.#connection).consumers.get(ENGINE_EVENT_STREAM, durable);
		this.#events = await consumer.consume({ max_messages: 128 });
		this.#track(this.#claimLoop());
		this.#track(this.#eventLoop(this.#events));
		this.#track(this.#heartbeatLoop());
	}

	async #claimLoop(): Promise<void> {
		const js = jetstream(this.#connection);
		while (!this.#stopping) {
			if (this.#active.size >= 128) {
				await Bun.sleep(this.#options.pollIntervalMs ?? 250);
				continue;
			}
			try {
				const result = await this.#options.rpc.call("grimoire_agent_engine_bridge", {
					action: "claim",
					device_id: this.#options.deviceId,
					engine_id: this.#options.engineId,
					worker_id: `engine-${this.#options.engineGeneration}`,
					lease_ttl_seconds: 90,
				});
				if (result.status !== "claimed") {
					await Bun.sleep(this.#options.pollIntervalMs ?? 250);
					continue;
				}
				const claim = parseClaim(result);
				this.#active.set(claim.jobId, claim);
				if (claim.operationType === "agent_engine_message") {
					const message = claim.work.message;
					if (!message) throw new Error("Agent Engine message claim has no message envelope");
					await js.publish(messageSubject(this.#options.deviceId, message), encode(message), {
						msgID: message.messageId,
					});
					await this.#options.rpc.call("grimoire_agent_engine_bridge", {
						action: "published",
						device_id: this.#options.deviceId,
						engine_id: this.#options.engineId,
						job_id: claim.jobId,
						lease_token: claim.leaseToken,
					});
					this.#active.delete(claim.jobId);
					continue;
				}
				const command = claim.work.command;
				if (!command) throw new Error("Agent Engine command claim has no command envelope");
				const envelope = { ...command, engineGeneration: this.#options.engineGeneration } as EngineCommandEnvelope;
				await js.publish(commandSubject(envelope), encode(envelope), { msgID: envelope.commandId });
			} catch (error) {
				this.#report(error);
				await Bun.sleep(1_000);
			}
		}
	}

	async #eventLoop(messages: ConsumerMessages): Promise<void> {
		for await (const message of messages) {
			if (this.#stopping) break;
			try {
				const event = parseEvent(message.data);
				let claim = this.#active.get(event.causationCommandId);
				if (!claim) {
					const recovered = await this.#options.rpc.call("grimoire_agent_engine_bridge", {
						action: "claim",
						device_id: this.#options.deviceId,
						engine_id: this.#options.engineId,
						worker_id: `engine-${this.#options.engineGeneration}`,
						job_id: event.causationCommandId,
						lease_ttl_seconds: 90,
					});
					if (recovered.status !== "claimed") {
						message.nak(5_000);
						continue;
					}
					claim = parseClaim(recovered);
					if (claim.jobId !== event.causationCommandId || claim.operationType !== "agent_engine_command") {
						throw new Error("Recovered Agent Engine claim does not match its event");
					}
					this.#active.set(claim.jobId, claim);
				}
				const result = await this.#options.rpc.call("grimoire_agent_engine_bridge", {
					action: "event",
					device_id: this.#options.deviceId,
					engine_id: this.#options.engineId,
					job_id: event.causationCommandId,
					lease_token: claim.leaseToken,
					event,
				});
				if (["completed", "cancelled", "failed", "already_terminal"].includes(String(result.status))) {
					this.#active.delete(event.causationCommandId);
				}
				message.ack();
			} catch (error) {
				this.#report(error);
				message.nak(5_000);
			}
		}
	}

	async #heartbeatLoop(): Promise<void> {
		while (!this.#stopping) {
			await Promise.race([Bun.sleep(this.#options.heartbeatIntervalMs ?? 30_000), this.#stop.promise]);
			if (this.#stopping) break;
			for (const claim of [...this.#active.values()]) {
				try {
					await this.#options.rpc.call("grimoire_agent_engine_bridge", {
						action: "heartbeat",
						device_id: this.#options.deviceId,
						engine_id: this.#options.engineId,
						job_id: claim.jobId,
						lease_token: claim.leaseToken,
						lease_ttl_seconds: 90,
					});
					claim.heartbeatFailures = 0;
				} catch (error) {
					claim.heartbeatFailures++;
					if (claim.heartbeatFailures >= 3) this.#active.delete(claim.jobId);
					this.#report(error);
				}
			}
		}
	}

	#track(loop: Promise<void>): void {
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

function parseClaim(value: Record<string, unknown>): BridgeClaim {
	if (typeof value.job_id !== "string" || typeof value.lease_token !== "string") {
		throw new Error("Invalid Agent Engine bridge claim identity");
	}
	if (value.operation_type !== "agent_engine_command" && value.operation_type !== "agent_engine_message") {
		throw new Error("Invalid Agent Engine bridge operation type");
	}
	if (!value.work || typeof value.work !== "object" || Array.isArray(value.work)) {
		throw new Error("Invalid Agent Engine bridge work envelope");
	}
	return {
		jobId: value.job_id,
		leaseToken: value.lease_token,
		operationType: value.operation_type,
		work: value.work as BridgeClaim["work"],
		heartbeatFailures: 0,
	};
}

function parseEvent(data: Uint8Array): EngineEventEnvelope {
	if (data.byteLength > ENGINE_MAX_ENVELOPE_BYTES) throw new Error("Engine event exceeds 256 KiB");
	const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data)) as EngineEventEnvelope;
	if (
		value.schema !== "grimoire.engine.event.v1" ||
		!value.eventId ||
		!value.causationCommandId ||
		!value.deviceId ||
		!value.engineId
	) {
		throw new Error("Invalid Engine event envelope");
	}
	return value;
}

function encode(value: object): Uint8Array {
	const data = new TextEncoder().encode(JSON.stringify(value));
	if (data.byteLength > ENGINE_MAX_ENVELOPE_BYTES) throw new Error("Engine envelope exceeds 256 KiB");
	return data;
}

function commandSubject(command: EngineCommandEnvelope): string {
	return `grimoire.engine.v1.d.${engineRouteToken(command.deviceId)}.e.${engineRouteToken(command.engineId)}.a.${engineRouteToken(command.agentInstanceId)}.cmd.${command.op}`;
}

function messageSubject(deviceId: string, message: AgentMessageEnvelope): string {
	return `grimoire.agent.v1.d.${engineRouteToken(deviceId)}.to.${engineRouteToken(message.toAgentInstanceId)}.from.${engineRouteToken(message.fromAgentInstanceId)}.msg`;
}

function isConsumerMissing(error: unknown): boolean {
	return error instanceof JetStreamApiError && error.code === JetStreamApiCodes.ConsumerNotFound;
}
