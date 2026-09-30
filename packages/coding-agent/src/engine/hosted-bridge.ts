import { createHmac } from "node:crypto";
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
import { isRecord } from "@oh-my-pi/pi-utils";
import { type ApprovalDecision, EngineTargetError } from "./contracts";
import { storageCanonicalJson } from "../session/storage-client";
import {
	type AgentMessageEnvelope,
	ENGINE_EVENT_STREAM,
	engineCommandIdentity,
	ENGINE_MAX_ENVELOPE_BYTES,
	type EngineCommandEnvelope,
	type EngineEventEnvelope,
} from "./nats-adapter";
import type { RocksEngineStore } from "./rocks-runtime-store";
import { engineRouteToken } from "./route";
import { ENGINE_CONTROL_OPS, runtimeLimits } from "./runtime-protocol";
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
	installedSequence?: number;
}

/** A lost authority response is unknown, not an explicit authorization denial. */
export class HostedBridgeUnavailableError extends Error {}

export class HostedGrimoireRpc implements GrimoireRpc {
	readonly #options: HostedGrimoireRpcOptions;
	readonly #endpoint: string;
	readonly #internalEndpoint: string;
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
		const internal = new URL(endpoint);
		internal.pathname = internal.pathname.replace(/\/mcp(?:\/[a-z0-9_-]+)?\/?$/i, "/internal/client/engine");
		this.#internalEndpoint = internal.toString();
	}

	
	async call(
		tool: string,
		arguments_: Record<string, unknown>,
		signal?: AbortSignal,
	): Promise<Record<string, unknown>> {
		const internal = tool === "grimoire_agent_engine_dispatch" || tool === "grimoire_agent_engine_bridge"
			|| tool === "grimoire_job_get" || tool === "grimoire_job_cancel"
			|| tool === "verify_origin_receipt" || tool === "verify_approval_receipt" || tool === "prepare_child_start"
			|| tool === "approval_origin";
		const id = ++this.#requestId;
		const envelope = internal
			? { schema: "grimoire.client_internal_request.v1", operation: "engine_tool", request_id: String(id),
				arguments: { name: tool, arguments: arguments_ } }
			: { jsonrpc: "2.0", id, method: "tools/call", params: { name: tool, arguments: arguments_ } };
		const attestation = internal
			? `hmac-sha256:${createHmac("sha256", this.#options.token)
				.update("grimoire-client-internal-request-v1\0").update(storageCanonicalJson(envelope)).digest("hex")}`
			: undefined;
		let response: Response;
		try {
			response = await fetch(internal ? this.#internalEndpoint : this.#endpoint, {
			method: "POST",
			redirect: "error",
			headers: {
				Accept: "application/json, text/event-stream",
				Authorization: `Bearer ${this.#options.token}`,
				"Content-Type": "application/json",
				...(attestation ? { "X-Grimoire-Client-Internal-Attestation": attestation } : {}),
				"X-Grimoire-Client": this.#options.clientId,
				"X-Grimoire-Client-Name": "grimoire-agent-engine",
				"X-Grimoire-Client-Version": this.#options.clientVersion ?? "0.4.0",
				"X-Grimoire-Client-Surface": "agent_engine_bridge",
				"X-Grimoire-Client-Protocol-Version": this.#options.protocolVersion ?? "2026-08-01",
				"X-Grimoire-Client-Features": '["grimoire.task.v5","agent_binding.v1","grimoire.dispatch.v2"]',
				...(this.#options.installedSequence !== undefined
					? { "X-Grimoire-Client-Installed-Sequence": String(this.#options.installedSequence) } : {}),
				...(this.#options.sourceSignature
					? { "X-Grimoire-Client-Source-Signature": this.#options.sourceSignature }
					: {}),
			},
			body: JSON.stringify(envelope),
			signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
			});
		} catch (error) {
			throw new HostedBridgeUnavailableError(`Grimoire Host transport unavailable: ${String(error)}`);
		}
		if (response.status >= 500 || [408, 425, 429].includes(response.status))
			throw new HostedBridgeUnavailableError(`Grimoire Host returned HTTP ${response.status}`);
		if (!response.ok)
			throw new EngineTargetError("stale_target", `Grimoire Host refused bridge call (HTTP ${response.status})`);
		let json: Record<string, unknown>;
		try {
			json = (await response.json()) as Record<string, unknown>;
		} catch {
			throw new HostedBridgeUnavailableError("Grimoire Host returned no complete bridge response");
		}
		if (json.error) {
			throw new EngineTargetError("stale_target", `Grimoire Host refused ${tool}`);
		}
		const result = json.result as Record<string, unknown> | undefined;
		if (!result) throw new HostedBridgeUnavailableError("Grimoire Host returned no bridge result");
		const content = Array.isArray(result.content) ? result.content : [];
		const text = content.find(
			item => item && typeof item === "object" && (item as Record<string, unknown>).type === "text",
		) as Record<string, unknown> | undefined;
		const structured = result.structuredContent as Record<string, unknown> | undefined;
		if (result.isError === true)
			throw new EngineTargetError("stale_target", `Grimoire Host refused ${tool}`);
		if (structured && typeof structured === "object") return structured;
		if (typeof text?.text !== "string") throw new HostedBridgeUnavailableError("Grimoire Host bridge result has no JSON content");
		try {
			return JSON.parse(text.text) as Record<string, unknown>;
		} catch {
			throw new HostedBridgeUnavailableError("Grimoire Host bridge result is incomplete");
		}
	}
}

export interface HostedEngineBridgeOptions {
	rpc: GrimoireRpc;
	eventStore?: RocksEngineStore;
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
	}

	async #claimCommands(lane: "ordinary" | "control"): Promise<void> {
		const js = jetstream(this.#connection);
		let generation = 0;
		let ownedRoute = false;
		const belongs = (claim: BridgeClaim) =>
			Object.hasOwn(ENGINE_CONTROL_OPS, claim.work.command?.op ?? "") === (lane === "control");
		while (this.#accepting && !this.#stopping) {
			ownedRoute = !ownedRoute;
			const installationId = ownedRoute ? this.#options.eventStore?.verifiedInstallationId : undefined;
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
						...(installationId ? { installation_id: installationId } : {}),
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
								...(installationId ? { installation_id: installationId } : {}),
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
		let command = claim.work.command;
		if (!command) throw new Error("Agent Engine command claim has no command envelope");
		const installationId = this.#options.eventStore?.verifiedInstallationId;
		if (command.bindingSnapshot?.installationId &&
			command.bindingSnapshot.installationId !== installationId) {
			await this.#releaseDelivery(claim, "installation_mismatch");
			return;
		}
		if (command.op === "start") {
			const localized = await this.#options.rpc.call("grimoire_agent_engine_bridge", {
				action: "localize_start", job_id: claim.jobId, lease_token: claim.leaseToken,
				installation_id: installationId ?? null, command,
			});
			if (localized.status === "binding_pending" || localized.status === "host_unavailable") {
				await this.#releaseDelivery(claim, "binding_pending");
				return;
			}
			if (localized.status !== "localized" &&
				!(localized.status === "rejected" && localized.code === "immutable_mismatch"))
				throw new Error("ClientHost did not localize the hosted Start");
			const next = isRecord(localized.command) ? localized.command as unknown as EngineCommandEnvelope : undefined;
			// CH may add executable context/workspace data, never retarget the admitted occurrence.
			const mismatch = localized.status === "rejected" || !next ||
				(["commandId", "agentInstanceId", "agentInstanceRef", "executionId", "attemptId",
					"principalId", "authorityGeneration", "parentAgentInstanceId", "parentAgentInstanceRef",
					"deviceId", "engineId", "engineGeneration", "op"] as const).some(field => next[field] !== command![field]) ||
				!next.bindingSnapshot || !command.bindingSnapshot ||
				storageCanonicalJson(next.bindingSnapshot) !== storageCanonicalJson(command.bindingSnapshot) ||
				["cwd", "input", "dispatchRef", "dispatchHash", "executionConfiguration",
					"originReceiptId", "executionKind", "specialRef"].some(field =>
					command!.payload[field] !== undefined && !(field === "cwd" && !command!.payload[field]) &&
					(next.payload[field] === undefined ||
						storageCanonicalJson(next.payload[field]) !== storageCanonicalJson(command!.payload[field])));
			if (mismatch) {
				if (!this.#options.eventStore) throw new Error("Terminal localization needs the durable event store");
				await this.#options.eventStore.rejectUnadmittedCommand(
					engineCommandIdentity(command as EngineCommandEnvelope),
					{ outcome: "rejected", detail: { code: "invalid_request", message: "Hosted Start immutable localization mismatch" } },
					this.#options.engineGeneration,
				);
				claim.published = true;
				return;
			}
			command = next!;
		}
		if (
			!Number.isSafeInteger(command.engineGeneration) ||
			Number(command.engineGeneration) <= 0 ||
			Number(command.engineGeneration) > this.#options.engineGeneration
		) {
			throw new Error("Agent Engine command claim has an invalid stored Engine generation");
		}
		if (command.op === "resolve_approval") {
			const store = this.#options.eventStore;
			if (!store || !installationId || command.deviceId !== this.#options.deviceId ||
				command.engineId !== this.#options.engineId)
				throw new EngineTargetError("stale_target", "Approval delivery requires its verified destination Engine");
			let delivery = await store.approvalDelivery(
				engineCommandIdentity(command as EngineCommandEnvelope), command.payload.approvalDecision as ApprovalDecision,
				command.payload.expectedInputRevision as number | undefined, this.#options.engineGeneration,
			);
			if (delivery.status === "absent" && command.engineGeneration !== this.#options.engineGeneration) {
				const rebound = await this.#options.rpc.call("grimoire_agent_engine_bridge", {
					action: "rebind_approval", job_id: claim.jobId, lease_token: claim.leaseToken,
					installation_id: installationId, device_id: this.#options.deviceId,
					engine_id: this.#options.engineId, engine_generation: this.#options.engineGeneration,
				});
				const work = isRecord(rebound.work) ? rebound.work : undefined;
				const next = work && isRecord(work.command) ? work.command as unknown as EngineCommandEnvelope : undefined;
				if (rebound.status !== "rebound" || work?.kind !== "command" || !next ||
					storageCanonicalJson(next) !== storageCanonicalJson({
						...command, engineGeneration: this.#options.engineGeneration,
					}))
					throw new EngineTargetError("stale_target", "Approval rebind changed its immutable decision envelope");
				command = next;
				claim.work.command = next;
				// A restart or concurrent admission during the hosted CAS invalidates the proof.
				delivery = await store.approvalDelivery(
					engineCommandIdentity(next), next.payload.approvalDecision as ApprovalDecision,
					next.payload.expectedInputRevision as number | undefined, this.#options.engineGeneration,
				);
			}
			if (delivery.status === "settled")
				command = JSON.parse(delivery.identity.serializedCommand!) as EngineCommandEnvelope;
			claim.work.command = command;
		}
		const envelope = command as EngineCommandEnvelope;
		await js.publish(commandSubject(envelope), encode(envelope), {
			msgID: `${envelope.commandId}:${envelope.engineGeneration}`,
		});
		claim.published = true;
	}

	async #releaseDelivery(claim: BridgeClaim, reason: "installation_mismatch" | "binding_pending"): Promise<void> {
		await this.#options.rpc.call("grimoire_agent_engine_bridge", {
			action: "release_delivery", job_id: claim.jobId, lease_token: claim.leaseToken,
			installation_id: this.#options.eventStore?.verifiedInstallationId ?? null, reason,
		});
		this.#active.delete(claim.jobId);
		await waitForEngineWake(this.#stop.promise, 1_000, this.#admissionCancellation.signal);
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
						await this.#options.eventStore?.markEventDelivered(Number(event.eventId), "hosted-binding");
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
		if (event.type === "attempt.reconciled" && event.payload?.semanticBinding === true) return true;
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
				installation_id: event.bindingSnapshot?.installationId ?? null,
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
				installation_id: event.bindingSnapshot?.installationId ?? null,
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
					installation_id: event.bindingSnapshot?.installationId ?? null,
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
				installation_id: claim.work.command?.bindingSnapshot?.installationId ?? null,
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
			installation_id: claim.work.command?.bindingSnapshot?.installationId ?? null,
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
								installation_id: claim.work.command?.bindingSnapshot?.installationId ?? null,
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
