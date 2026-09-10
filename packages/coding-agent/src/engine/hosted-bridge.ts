import {
	AckPolicy,
	type ConsumerMessages,
	DeliverPolicy,
	JetStreamApiCodes,
	JetStreamApiError,
	type JetStreamClient,
	jetstream,
	jetstreamManager,
	ReplayPolicy,
} from "@nats-io/jetstream";
import { connect, type NatsConnection, type NodeConnectionOptions } from "@nats-io/transport-node";
import type { EngineChildLaunchResult } from "../tools";
import {
	type AgentMessageEnvelope,
	ENGINE_EVENT_STREAM,
	ENGINE_MAX_ENVELOPE_BYTES,
	type EngineCommandEnvelope,
	type EngineEventEnvelope,
} from "./nats-adapter";
import { engineAgentInstanceId, engineRouteToken } from "./route";
import type { LegacyOwnershipProof } from "./runtime-ownership";
import { ENGINE_CONTROL_OPS, runtimeLimits } from "./runtime-protocol";
import type { EngineStore } from "./store";
import { waitForEngineWake } from "./wake";

interface BridgeClaim {
	jobId: string;
	leaseToken: string;
	operationType: "agent_engine_command" | "agent_engine_message";
	work: {
		kind: "command" | "message";
		command?: Omit<EngineCommandEnvelope, "engineGeneration"> & { engineGeneration?: number };
		message?: AgentMessageEnvelope;
	};
	heartbeatFailures: number;
	heartbeatPending: boolean;
	published: boolean;
	accepted: boolean;
}

export interface GrimoireRpc {
	call(tool: string, arguments_: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>>;
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

	async call(
		tool: string,
		arguments_: Record<string, unknown>,
		signal?: AbortSignal,
	): Promise<Record<string, unknown>> {
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
			signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
		});
		if (!response.ok) throw new Error(`Grimoire Host returned HTTP ${response.status}`);
		const json = (await response.json()) as Record<string, unknown>;
		if (json.error) {
			const error = json.error as Record<string, unknown>;
			throw new Error(`Grimoire Host rejected bridge call: ${String(error.message ?? "unknown error")}`);
		}
		const result = json.result as Record<string, unknown> | undefined;
		if (!result) throw new Error("Grimoire Host returned no bridge result");
		const content = Array.isArray(result.content) ? result.content : [];
		const text = content.find(
			item => item && typeof item === "object" && (item as Record<string, unknown>).type === "text",
		) as Record<string, unknown> | undefined;
		const structured = result.structuredContent as Record<string, unknown> | undefined;
		if (result.isError === true) {
			const error = structured?.error;
			const message =
				typeof text?.text === "string"
					? text.text
					: typeof error === "string"
						? error
						: error && typeof error === "object"
							? (error as Record<string, unknown>).message
							: structured?.message;
			throw new Error(
				`Grimoire Host tool ${tool} failed: ${typeof message === "string" && message.trim() ? message : "unknown error"}`,
			);
		}
		if (structured && typeof structured === "object") return structured;
		if (typeof text?.text !== "string") throw new Error("Grimoire Host bridge result has no JSON content");
		return JSON.parse(text.text) as Record<string, unknown>;
	}
}

export async function launchHostedEngineChild(
	rpc: GrimoireRpc,
	request: {
		deviceId: string;
		engineId: string;
		parentAgentInstanceRef: string;
		parentAttemptId: string;
		profileRef: string;
		workStepId: string;
		cwd: string;
		maxSpawnDepth: number;
		signal?: AbortSignal;
		cancelLocal(agentInstanceId: string): Promise<void>;
		enrollChild?(agentInstanceRef: string, attemptId?: string): Promise<void>;
		waitLocal(
			agentInstanceId: string,
			commandId: string,
			attemptId?: string,
			signal?: AbortSignal,
		): Promise<{ attemptId?: string; state: string; payload: Record<string, unknown> }>;
	},
): Promise<EngineChildLaunchResult> {
	request.signal?.throwIfAborted();
	if (typeof request.waitLocal !== "function") throw new Error("Exact local Attempt result wait is unavailable");
	const launched = await rpc.call("grimoire_agent_engine_child_launch", {
		device_id: request.deviceId,
		engine_id: request.engineId,
		parent_agent_instance_ref: request.parentAgentInstanceRef,
		parent_attempt_id: request.parentAttemptId,
		profile_ref: request.profileRef,
		work_step_id: request.workStepId,
		cwd: request.cwd,
		max_spawn_depth: request.maxSpawnDepth,
	});
	const agent = launched.agent_instance as Record<string, unknown> | undefined;
	const job = launched.job as Record<string, unknown> | undefined;
	const agentInstanceRef = String(agent?.agent_instance_ref ?? agent?.grimoire_uri ?? "");
	const agentInstanceId = agentInstanceRef ? engineAgentInstanceId(agentInstanceRef) : "";
	const jobId = String(job?.job_id ?? "");
	if (!agentInstanceId || !agentInstanceRef || !jobId)
		throw new Error("Grimoire child launch returned no durable identity");
	const envelope =
		job?.payload && typeof job.payload === "object"
			? ((job.payload as Record<string, unknown>).command as Record<string, unknown> | undefined)
			: undefined;
	const attemptId =
		typeof envelope?.attemptId === "string"
			? envelope.attemptId
			: typeof launched.attempt_id === "string"
				? launched.attempt_id
				: undefined;
	try {
		await request.enrollChild?.(agentInstanceRef, attemptId);
		const result = await request.waitLocal(agentInstanceId, jobId, attemptId, request.signal);
		if (result.attemptId) await request.enrollChild?.(agentInstanceRef, result.attemptId);
		return {
			agentInstanceId,
			agentInstanceRef,
			status: result.state === "completed" ? "completed" : result.state === "cancelled" ? "cancelled" : "failed",
			assistantFinal: typeof result.payload.assistantFinal === "string" ? result.payload.assistantFinal : undefined,
			transcriptRef: typeof result.payload.transcriptRef === "string" ? result.payload.transcriptRef : undefined,
			...(result.payload.outputTruncated === true ? { outputTruncated: true } : {}),
			...(result.state === "completed" ? {} : { error: String(result.payload.error ?? result.state) }),
		};
	} catch (error) {
		if (!request.signal?.aborted) throw error;
		await request.cancelLocal(agentInstanceId).catch(() => {});
		await rpc.call("grimoire_job_cancel", { job_id: jobId, reason: "parent task aborted" }).catch(() => {});
		return { agentInstanceId, agentInstanceRef, status: "cancelled", error: "Parent task aborted" };
	}
}

export interface HostedEngineBridgeOptions {
	rpc: GrimoireRpc;
	eventStore?: EngineStore;
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
	readonly #eventLanes = new Map<string, Promise<void>>();
	readonly #eventWork = new Set<Promise<void>>();
	readonly #eventRetries = new Map<string, Set<number>>();
	readonly #stop = Promise.withResolvers<void>();
	readonly #admissionCancellation = new AbortController();
	#claimLoop: Promise<void> = Promise.resolve();
	#events: ConsumerMessages | undefined;
	#accepting = true;
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
		await this.stopAdmission();
		this.#stopping = true;
		this.#stop.resolve();
		await this.#events?.close();
		await Promise.all(this.#loops);
		await Promise.all(this.#eventWork);
		this.#eventRetries.clear();
		await this.#connection.drain();
	}

	async stopAdmission(): Promise<void> {
		this.#accepting = false;
		this.#admissionCancellation.abort();
		await this.#claimLoop;
	}

	async drain(timeoutMs = 3_000): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		while (this.#active.size > 0 || this.#eventWork.size > 0 || this.#eventRetries.size > 0) {
			if (Date.now() >= deadline)
				throw new Error(
					`Hosted Engine bridge still has ${this.#active.size} active claim(s), ${this.#eventWork.size} event(s), ${this.#eventRetries.size} retry lane(s)`,
				);
			await Bun.sleep(25);
		}
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
		this.#claimLoop = Promise.all([this.#claimCommands("ordinary"), this.#claimCommands("control")]).then(() => {});
		this.#track(this.#claimLoop);
		this.#track(this.#eventLoop(this.#events));
		this.#track(this.#heartbeatLoop());
		if (this.#options.eventStore) this.#track(this.#ownershipLoop());
	}

	async #ownershipLoop(): Promise<void> {
		const store = this.#options.eventStore!;
		while (this.#accepting && !this.#stopping) {
			try {
				let cursor: string | undefined;
				let unresolved = 0;
				do {
					const page = await store.reconcileLegacyOwnershipPage(
						this.#options.deviceId,
						this.#options.engineId,
						cursor,
					);
					unresolved += page.unresolved.length;
					let candidates = page.candidates;
					while (candidates.length && this.#accepting && !this.#stopping) {
						const response = await this.#options.rpc.call(
							"grimoire_agent_engine_bridge",
							{
								action: "ownership",
								device_id: this.#options.deviceId,
								engine_id: this.#options.engineId,
								candidates,
							},
							this.#admissionCancellation.signal,
						);
						if (response.status !== "ok" || !Array.isArray(response.results))
							throw new Error("Legacy ownership proof endpoint is unavailable");
						const proofs = response.results as LegacyOwnershipProof[];
						const results = await store.enrollLegacyOwnership(candidates, proofs);
						unresolved += results.filter(
							result => !["enrolled", "known", "deferred"].includes(result.status),
						).length;
						const deferred = candidates.filter((_candidate, index) => proofs[index].status === "deferred");
						if (deferred.length === candidates.length)
							throw new Error("Legacy ownership proof page made no progress");
						candidates = deferred;
					}
					cursor = page.nextCursor ?? undefined;
					// Yield between bounded transactions so migration cannot occupy the control lane.
					await Bun.sleep(0);
				} while (cursor && this.#accepting && !this.#stopping);
				if (this.#accepting)
					await store.recordOwnershipMigration(unresolved ? "incomplete" : "complete", unresolved);
			} catch (error) {
				if (this.#accepting) {
					await store.recordOwnershipMigration("unavailable", null);
					this.#report(error);
				}
			}
			await waitForEngineWake(
				this.#stop.promise,
				runtimeLimits.reconciliationMs,
				this.#admissionCancellation.signal,
			);
		}
	}

	async #claimCommands(lane: "ordinary" | "control"): Promise<void> {
		const js = jetstream(this.#connection);
		let generation = 0;
		const belongs = (claim: BridgeClaim) =>
			ENGINE_CONTROL_OPS.has(claim.work.command?.op ?? "") === (lane === "control");
		while (this.#accepting && !this.#stopping) {
			try {
				const claims = [...this.#active.values()].filter(claim => !claim.accepted && belongs(claim));
				const pending = claims.find(claim => !claim.published);
				if (pending) {
					await this.#publishClaim(js, pending);
					continue;
				}
				if (
					claims.length <
					(lane === "control" ? runtimeLimits.controlPendingRecords : runtimeLimits.agentPendingRecords)
				) {
					const result = await this.#options.rpc.call("grimoire_agent_engine_bridge", {
						action: "claim",
						lane,
						device_id: this.#options.deviceId,
						engine_id: this.#options.engineId,
						engine_generation: this.#options.engineGeneration,
						worker_id: `engine-${this.#options.engineGeneration}`,
						lease_ttl_seconds: 90,
					});
					if (result.status === "claimed") {
						const claim = parseClaim(result);
						this.#active.set(claim.jobId, claim);
						if (!claim.accepted) await this.#publishClaim(js, claim);
						continue;
					}
				}
				if (this.#options.pollIntervalMs !== undefined)
					await waitForEngineWake(
						this.#stop.promise,
						this.#options.pollIntervalMs,
						this.#admissionCancellation.signal,
					);
				else {
					const wake = await Promise.race([
						this.#options.rpc.call(
							"grimoire_agent_engine_bridge",
							{
								action: "wait",
								device_id: this.#options.deviceId,
								engine_id: this.#options.engineId,
								wake_generation: generation,
								timeout_ms: runtimeLimits.reconciliationMs,
							},
							this.#admissionCancellation.signal,
						),
						this.#stop.promise.then(() => undefined),
					]);
					if (wake && Number.isSafeInteger(wake.generation)) generation = Number(wake.generation);
				}
			} catch (error) {
				if (!this.#accepting) break;
				this.#report(error);
				await waitForEngineWake(this.#stop.promise, 1000, this.#admissionCancellation.signal);
			}
		}
	}

	async #publishClaim(js: JetStreamClient, claim: BridgeClaim): Promise<void> {
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
			return;
		}
		const command = claim.work.command;
		if (!command) throw new Error("Agent Engine command claim has no command envelope");
		if (
			!Number.isSafeInteger(command.engineGeneration) ||
			Number(command.engineGeneration) <= 0 ||
			Number(command.engineGeneration) > this.#options.engineGeneration
		) {
			throw new Error("Agent Engine command claim has an invalid stored Engine generation");
		}
		const envelope = command as EngineCommandEnvelope;
		await js.publish(commandSubject(envelope), encode(envelope), {
			msgID: `${envelope.commandId}:${envelope.engineGeneration}`,
		});
		claim.published = true;
	}

	async #eventLoop(messages: ConsumerMessages): Promise<void> {
		for await (const message of messages) {
			// ponytail: 128 global unacked events; per-agent consumers are needed for strict flood isolation.
			if (this.#eventWork.size >= 128) await Promise.race(this.#eventWork);
			if (this.#stopping) break;
			let event: EngineEventEnvelope;
			try {
				event = parseEvent(message.data);
				if (
					event.deviceId !== this.#options.deviceId ||
					event.engineId !== this.#options.engineId ||
					engineRouteToken(event.agentInstanceId) !== message.subject.split(".")[8]
				)
					throw new Error("Engine event identity does not match its broker route");
			} catch (error) {
				this.#report(error);
				message.nak(5_000);
				continue;
			}
			const agentId = event.agentInstanceId;
			const sequence = message.info.streamSequence;
			message.working();
			const heartbeat = setInterval(() => message.working(), 10_000);
			const previous = this.#eventLanes.get(agentId) ?? Promise.resolve();
			const work = previous
				.then(async () => {
					const retries = this.#eventRetries.get(agentId);
					try {
						// A NAK must not let later terminal/control/wake events pass the failed event.
						if (retries && sequence > Math.min(...retries)) {
							retries.add(sequence);
							message.nak(5_000);
							return;
						}
						if (!(await this.#deliverEvent(event))) throw new Error("Hosted Engine event was not accepted");
						retries?.delete(sequence);
						if (retries?.size === 0) this.#eventRetries.delete(agentId);
						message.ack();
					} catch (error) {
						this.#eventRetries.set(agentId, (retries ?? new Set<number>()).add(sequence));
						this.#report(error);
						message.nak(5_000);
					}
				})
				.finally(() => {
					clearInterval(heartbeat);
					this.#eventWork.delete(work);
					if (this.#eventLanes.get(agentId) === work) this.#eventLanes.delete(agentId);
				});
			this.#eventLanes.set(agentId, work);
			this.#eventWork.add(work);
		}
	}

	async #eventJobId(event: EngineEventEnvelope): Promise<string> {
		// Command receipts belong to their command; inherited lifecycle effects belong to the affected Start.
		if (event.type.startsWith("command.") || event.type === "attempt.command_receipt")
			return event.causationCommandId;
		const activeCause = this.#active.get(event.causationCommandId)?.work.command;
		const storedCause = activeCause
			? undefined
			: await this.#options.eventStore?.getStartConversationIdentity(event.causationCommandId);
		const causeAgentId = activeCause?.agentInstanceId ?? storedCause?.agentInstanceId;
		if (!causeAgentId || causeAgentId === event.agentInstanceId) return event.causationCommandId;
		if (!["pause", "resume", "cancel"].includes(activeCause?.op ?? storedCause?.operation ?? ""))
			throw new Error("Cross-agent Engine event requires a branch control command");
		const attempt = await this.#options.eventStore?.getAttempt(event.attemptId);
		if (
			!attempt ||
			attempt.agent_instance_id !== event.agentInstanceId ||
			attempt.execution_id !== event.executionId ||
			attempt.attempt_id !== event.attemptId ||
			attempt.binding_id !== event.runtimeBindingId ||
			attempt.engine_generation !== event.engineGeneration ||
			attempt.binding_generation !== event.bindingGeneration ||
			attempt.authority_generation !== event.authorityGeneration
		)
			throw new Error("Inherited Engine event does not match its exact native Attempt");
		// ClientHost validates the original control's ownership and frozen ancestor chain at this recipient.
		return attempt.command_id;
	}

	async #deliverEvent(event: EngineEventEnvelope): Promise<boolean> {
		if (["attempt.agent_registered", "attempt.holds_changed", "attempt.message_updated"].includes(event.type))
			return true;
		if (
			event.type === "attempt.inbox_changed" &&
			typeof event.payload?.action === "string" &&
			["queued", "reorder", "edit", "annotate", "defer", "drop"].includes(event.payload.action)
		) {
			// Query/tool mutations are durable inbox notifications, not hosted command receipts.
			if (
				typeof event.payload.queueId !== "string" ||
				!event.payload.queueId.trim() ||
				!Number.isSafeInteger(event.payload.revision) ||
				Number(event.payload.revision) < 1
			)
				throw new Error("Invalid Engine inbox notification");
			return true;
		}
		if (
			event.type === "attempt.inbox_changed" &&
			event.payload?.action === "acknowledge" &&
			(await this.#options.eventStore?.isInboxNotificationAcknowledgement({
				...event,
				eventId: Number(event.eventId),
				seq: event.agentSeq,
				bindingId: event.runtimeBindingId,
				kind: "inbox_changed",
				createdAt: event.at,
			}))
		)
			return true;
		if (event.type === "attempt.inbox_changed" && event.payload?.action === "wake_due") {
			const result = await this.#options.rpc.call("grimoire_agent_engine_bridge", {
				action: "wake",
				device_id: this.#options.deviceId,
				engine_id: this.#options.engineId,
				engine_generation: this.#options.engineGeneration,
				event,
			});
			if (result.status !== "accepted" && result.status !== "duplicate") {
				throw new Error(`Hosted Engine wake was not durably accepted: ${String(result.status)}`);
			}
			return true;
		}
		const jobId = await this.#eventJobId(event);
		let claim = this.#active.get(jobId);
		if (
			!claim &&
			(await this.#options.eventStore?.isNativeUnadmittedEvent({ ...event, eventId: Number(event.eventId) }))
		)
			return true;
		if (!claim) {
			const recovered = await this.#options.rpc.call("grimoire_agent_engine_bridge", {
				action: "claim",
				device_id: this.#options.deviceId,
				engine_id: this.#options.engineId,
				engine_generation: this.#options.engineGeneration,
				worker_id: `engine-${this.#options.engineGeneration}`,
				job_id: jobId,
				lease_ttl_seconds: 90,
			});
			if (recovered.status !== "claimed") {
				const terminal = await this.#options.rpc.call("grimoire_agent_engine_bridge", {
					action: "event",
					device_id: this.#options.deviceId,
					engine_id: this.#options.engineId,
					job_id: jobId,
					event,
				});
				return terminal.status === "already_terminal";
			}
			claim = parseClaim(recovered);
			if (claim.jobId !== jobId || claim.operationType !== "agent_engine_command") {
				throw new Error("Recovered Agent Engine claim does not match its event");
			}
			claim.published = true;
		}
		if (jobId !== event.causationCommandId) {
			const command = claim.work.command;
			if (
				command?.op !== "start" ||
				command.commandId !== jobId ||
				command.deviceId !== event.deviceId ||
				command.engineId !== event.engineId ||
				command.agentInstanceId !== event.agentInstanceId ||
				command.executionId !== event.executionId ||
				command.attemptId !== event.attemptId ||
				command.engineGeneration !== event.engineGeneration ||
				command.authorityGeneration !== event.authorityGeneration
			)
				throw new Error("Inherited Engine event claim does not match its exact native Attempt");
		}
		this.#active.set(claim.jobId, claim);
		if (event.type === "attempt.command_receipt" && event.payload) {
			const value = (event.payload.value ?? event.payload) as Record<string, unknown>;
			const receipt: Record<string, unknown> = {
				...value,
				browserPayloadHash: value.payloadHash ?? value.browserPayloadHash,
			};
			const accepted = await this.#options.rpc.call("grimoire_agent_engine_bridge", {
				action: "accepted",
				device_id: this.#options.deviceId,
				engine_id: this.#options.engineId,
				job_id: claim.jobId,
				lease_token: claim.leaseToken,
				receipt,
			});
			if (accepted.status !== "accepted") throw new Error("Hosted command receipt was not persisted");
			claim.accepted = true;
			if (
				receipt.stage === "rejected" ||
				receipt.stage === "execution_terminal" ||
				(receipt.stage === "applied" && claim.work.command?.op !== "start")
			)
				this.#active.delete(claim.jobId);
			while (this.#active.size > runtimeLimits.devicePendingRecords) {
				const old = [...this.#active.values()].find(item => item.accepted);
				if (!old) break;
				this.#active.delete(old.jobId);
			}
			return true;
		}

		const result = await this.#options.rpc.call("grimoire_agent_engine_bridge", {
			action: "event",
			device_id: this.#options.deviceId,
			engine_id: this.#options.engineId,
			job_id: jobId,
			lease_token: claim.leaseToken,
			event,
		});
		if (["completed", "cancelled", "failed", "already_terminal"].includes(String(result.status))) {
			this.#active.delete(jobId);
		}
		return true;
	}

	async #heartbeatLoop(): Promise<void> {
		while (!this.#stopping) {
			await waitForEngineWake(this.#stop.promise, this.#options.heartbeatIntervalMs ?? 30_000);
			if (this.#stopping) break;
			for (const claim of this.#active.values()) {
				if (claim.heartbeatPending || claim.accepted) continue;
				claim.heartbeatPending = true;
				this.#track(
					(async () => {
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
						} finally {
							claim.heartbeatPending = false;
						}
					})(),
				);
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
		heartbeatPending: false,
		published: false,
		accepted: Boolean(value.delivery_receipt),
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
		!value.engineId ||
		typeof value.agentInstanceId !== "string" ||
		!value.agentInstanceId
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
