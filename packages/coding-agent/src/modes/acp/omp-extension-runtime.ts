import * as path from "node:path";
import { getAgentDir, logger, VERSION } from "@oh-my-pi/pi-utils";
import type { AgentSideConnection } from "@oh-my-pi/pi-utils/acp";
import type { Settings } from "../../config/settings";
import { type DaemonBrokerClient, daemonClientForProject } from "../../launch/client";
import type { DaemonOperation, DaemonRpcResult, DaemonSnapshot } from "../../launch/protocol";
import { resolveMemoryBackend } from "../../memory-backend/resolve";
import type { MemoryBackend, MemoryBackendStatus } from "../../memory-backend/types";
import type { AgentSession, AgentSessionEvent } from "../../session/agent-session";
import {
	boundedInteger,
	createOmpExtensionCapabilities,
	createOmpExtensionEnvelope,
	createOmpExtensionSequenceState,
	OMP_EXTENSION_EVENTS,
	OMP_EXTENSION_MAX_TEXT_BYTES,
	OMP_EXTENSION_METHODS,
	OMP_EXTENSION_SCHEMA_VERSION,
	type OmpExtensionEnvelope,
	type OmpExtensionRequestContext,
	type OmpExtensionSequenceState,
	optionalBoolean,
	optionalString,
	parseOmpExtensionRequest,
	requiredBoolean,
	requiredString,
} from "./omp-extension-protocol";

type ExtensionConnection = Pick<AgentSideConnection, "extNotification">;
type SessionResolver = (sessionId: string) => AgentSession | undefined;
type MemoryResolver = (settings: Settings) => Promise<MemoryBackend>;
type DaemonClientResolver = (cwd: string) => Promise<DaemonBrokerClient>;

export interface OmpAcpExtensionRuntimeOptions {
	connection: ExtensionConnection;
	getSession: SessionResolver;
	getAgentDir?: () => string;
	resolveMemoryBackend?: MemoryResolver;
	daemonClientForProject?: DaemonClientResolver;
}

interface ManagedExtensionState extends OmpExtensionSequenceState {
	session: AgentSession;
	sessionId: string;
	aliases: Set<string>;
	negotiated: boolean;
	droppedNotifications: number;
	unsubscribe: () => void;
}

interface MemoryClearChallenge {
	id: string;
	expiresAt: number;
	backend: string;
}

const WRITE_OR_EXEC_TOOLS = new Set(["bash", "edit", "write", "delete", "apply_patch", "python"]);
const MEMORY_TEXT_LIMIT = 16 * 1024;
const MEMORY_CLEAR_CHALLENGE_TTL_MS = 60_000;
const MAX_STATUS_ITEMS = 256;
const MAX_PENDING_NOTIFICATIONS = 256;

function asRecord<T extends Record<string, unknown>>(envelope: OmpExtensionEnvelope<T>): Record<string, unknown> {
	return { ...envelope };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatModel(model: unknown): Record<string, unknown> | undefined {
	if (!isRecord(model)) return undefined;
	const provider = typeof model.provider === "string" ? model.provider : undefined;
	const id = typeof model.id === "string" ? model.id : undefined;
	if (!provider && !id) return undefined;
	return { ...(provider ? { provider } : {}), ...(id ? { id } : {}) };
}

function sanitizeError(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return message.length > 2_000 ? `${message.slice(0, 1_997)}...` : message;
}

function boundedText(value: string | undefined, limit = MEMORY_TEXT_LIMIT): string | undefined {
	if (value === undefined) return undefined;
	if (Buffer.byteLength(value, "utf8") <= limit) return value;
	let end = Math.min(value.length, limit);
	while (end > 0 && Buffer.byteLength(value.slice(0, end), "utf8") > limit) end--;
	return `${value.slice(0, end)}...`;
}

function redactText(session: AgentSession, value: string | undefined, limit = MEMORY_TEXT_LIMIT): string | undefined {
	const bounded = boundedText(value, limit);
	if (!bounded) return bounded;
	return session.obfuscator?.hasSecrets() === true ? session.obfuscator.obfuscate(bounded) : bounded;
}

function safeMemoryStatus(status: MemoryBackendStatus): Record<string, unknown> {
	return {
		backend: status.backend,
		active: status.active,
		writable: status.writable,
		searchable: status.searchable,
		scope: status.scope,
		storage: {
			kind: status.database ? "database" : status.backend === "off" ? "none" : "backend-managed",
			pathId: status.database ? path.basename(status.database) : undefined,
		},
		queue: {
			workingCount: status.workingCount,
			episodicCount: status.episodicCount,
			tripleCount: status.tripleCount,
		},
		lastRecall: status.lastRecall,
		message: status.message,
		error: status.error,
	};
}

function publicDaemonSnapshot(daemon: DaemonSnapshot): Record<string, unknown> {
	return {
		serviceId: daemon.id,
		name: daemon.name,
		state: daemon.state,
		pid: daemon.pid,
		startedAt: daemon.startedAt === 0 ? undefined : new Date(daemon.startedAt).toISOString(),
		exitedAt: daemon.exitedAt === undefined ? undefined : new Date(daemon.exitedAt).toISOString(),
		exitCode: daemon.exitCode,
		failure: daemon.exitReason,
		restartCount: daemon.restartCount,
		outputBytes: daemon.outputBytes,
		owner: daemon.owner,
		persist: daemon.persist,
		detached: daemon.detached,
	};
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
	const timeout = Promise.withResolvers<T>();
	const timer = setTimeout(() => timeout.reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
	return Promise.race([promise, timeout.promise]).finally(() => clearTimeout(timer));
}

export class OmpAcpExtensionRuntime {
	readonly #connection: ExtensionConnection;
	readonly #getSession: SessionResolver;
	readonly #getAgentDir: () => string;
	readonly #resolveMemoryBackend: MemoryResolver;
	readonly #daemonClientForProject: DaemonClientResolver;
	readonly #states = new Map<string, ManagedExtensionState>();
	readonly #memoryClearChallenges = new Map<string, MemoryClearChallenge>();
	#notificationQueue = Promise.resolve();
	#pendingNotifications = 0;

	constructor(options: OmpAcpExtensionRuntimeOptions) {
		this.#connection = options.connection;
		this.#getSession = options.getSession;
		this.#getAgentDir = options.getAgentDir ?? getAgentDir;
		this.#resolveMemoryBackend = options.resolveMemoryBackend ?? resolveMemoryBackend;
		this.#daemonClientForProject = options.daemonClientForProject ?? daemonClientForProject;
	}

	attachSession(session: AgentSession): void {
		const existing = this.#states.get(session.sessionId);
		if (existing?.session === session) return;
		existing?.unsubscribe();
		const sequence = createOmpExtensionSequenceState();
		const state: ManagedExtensionState = {
			...sequence,
			session,
			sessionId: session.sessionId,
			aliases: new Set([session.sessionId]),
			negotiated: false,
			droppedNotifications: 0,
			unsubscribe: () => {},
		};
		const unsubscribeEvents = session.subscribe(event => this.#onSessionEvent(state, event));
		const unsubscribeSessionChange = session.registerSessionChangeCallback(() => this.#rotateSessionState(state));
		state.unsubscribe = () => {
			unsubscribeEvents();
			unsubscribeSessionChange();
		};
		this.#states.set(session.sessionId, state);
	}

	detachSession(sessionId: string): void {
		const state =
			this.#states.get(sessionId) ?? [...this.#states.values()].find(candidate => candidate.aliases.has(sessionId));
		if (!state) return;
		state.negotiated = false;
		state.generation = crypto.randomUUID();
		state.unsubscribe();
		this.#states.delete(state.sessionId);
		for (const alias of state.aliases) this.#memoryClearChallenges.delete(alias);
	}

	detachAll(): void {
		for (const sessionId of [...this.#states.keys()]) this.detachSession(sessionId);
	}

	async handleMethod(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
		const context = parseOmpExtensionRequest(params);
		const state = this.#resolveState(context.sessionId);
		try {
			const data = await withTimeout(
				this.#handleMethodData(method, params, context, state),
				context.timeoutMs,
				method,
			);
			if (method === OMP_EXTENSION_METHODS.capabilities) state.negotiated = true;
			return asRecord(createOmpExtensionEnvelope(state, context, data));
		} catch (error) {
			state.sequence += 1;
			return {
				schemaVersion: OMP_EXTENSION_SCHEMA_VERSION,
				ompVersion: VERSION,
				sessionId: context.sessionId,
				generation: state.generation,
				sequence: state.sequence,
				timestamp: new Date().toISOString(),
				...(context.correlationId === undefined ? {} : { correlationId: context.correlationId }),
				error: {
					code: this.#errorCode(error),
					message: redactText(state.session, sanitizeError(error), 2_000),
					recoverable: this.#isRecoverable(error),
					detail: { method },
				},
			};
		}
	}

	#resolveState(sessionId: string): ManagedExtensionState {
		const existing = this.#states.get(sessionId);
		if (existing) return existing;
		const session = this.#getSession(sessionId);
		if (!session) throw new Error(`Unsupported ACP session: ${sessionId}`);
		this.attachSession(session);
		const attached = this.#states.get(sessionId);
		if (!attached) throw new Error(`Failed to attach ACP session: ${sessionId}`);
		return attached;
	}

	async #handleMethodData(
		method: string,
		params: Record<string, unknown>,
		context: OmpExtensionRequestContext,
		state: ManagedExtensionState,
	): Promise<Record<string, unknown>> {
		switch (method) {
			case OMP_EXTENSION_METHODS.capabilities:
				return this.#capabilities(state.session, params);
			case OMP_EXTENSION_METHODS.advisorStatus:
				return this.#advisorStatus(state.session);
			case OMP_EXTENSION_METHODS.advisorSet:
				return this.#advisorSet(state.session, params);
			case OMP_EXTENSION_METHODS.advisorDrain:
				return await this.#advisorDrain(state, context.timeoutMs);
			case OMP_EXTENSION_METHODS.autolearnStatus:
				return this.#autolearnStatus(state.session);
			case OMP_EXTENSION_METHODS.autolearnDrain: {
				const result = await state.session.drainAutolearnCaptureForAcp({
					timeoutMs: context.timeoutMs,
					cancel: optionalBoolean(params.cancel, "cancel") ?? false,
				});
				return {
					...result,
					...(typeof result.failure === "string" ? { failure: redactText(state.session, result.failure) } : {}),
					status: this.#autolearnStatus(state.session),
				};
			}
			case OMP_EXTENSION_METHODS.memoryStatus:
				return await this.#memoryStatus(state.session);
			case OMP_EXTENSION_METHODS.memoryStats:
				return await this.#memoryText(state.session, "stats");
			case OMP_EXTENSION_METHODS.memoryDiagnose:
				return await this.#memoryText(state.session, "diagnose");
			case OMP_EXTENSION_METHODS.memoryEnqueue:
				return await this.#memoryEnqueue(state.session);
			case OMP_EXTENSION_METHODS.memoryClear:
				return await this.#memoryClear(state.session, params);
			case OMP_EXTENSION_METHODS.launchList:
			case OMP_EXTENSION_METHODS.launchDescribe:
			case OMP_EXTENSION_METHODS.launchLogs:
			case OMP_EXTENSION_METHODS.launchSend:
			case OMP_EXTENSION_METHODS.launchStop:
			case OMP_EXTENSION_METHODS.launchRestart:
				return await this.#launch(state, method, params, context.timeoutMs);
			default:
				throw new Error(`Unknown OMP typed extension method: ${method}`);
		}
	}

	#capabilities(session: AgentSession, params: Record<string, unknown>): Record<string, unknown> {
		if (params.supportedSchemaVersions !== undefined) {
			if (
				!Array.isArray(params.supportedSchemaVersions) ||
				!params.supportedSchemaVersions.includes(OMP_EXTENSION_SCHEMA_VERSION)
			) {
				throw new Error("Unsupported OMP typed extension schema version");
			}
		}
		return createOmpExtensionCapabilities({
			advisor: session.settings.get("advisor.enabled") === true,
			autolearn: session.settings.get("autolearn.enabled") === true,
			memory: session.settings.get("memory.backend") !== "off",
			launch: true,
		});
	}

	#advisorStatus(session: AgentSession): Record<string, unknown> {
		const stats = session.getAdvisorStats();
		const grantedTools = session.getAdvisorAvailableToolNames();
		const toolRisk = grantedTools.some(tool => WRITE_OR_EXEC_TOOLS.has(tool)) ? "write-or-exec" : "read-only";
		const advisors = stats.advisors.slice(0, MAX_STATUS_ITEMS);
		return {
			enabled: stats.configured,
			active: stats.active,
			model: formatModel(stats.model),
			advisors: advisors.map(advisor => ({
				id: advisor.name,
				status: advisor.status,
				backlog: advisor.backlog,
				inFlight: advisor.inFlight,
				model: formatModel(advisor.model),
				usage: advisor.tokens,
				cost: advisor.cost,
				messages: advisor.messages,
			})),
			advisorsTruncated: stats.advisors.length > advisors.length,
			usage: stats.tokens,
			cost: stats.cost,
			backlog: stats.advisors.reduce((sum, advisor) => sum + advisor.backlog, 0),
			inFlight: stats.advisors.some(advisor => advisor.inFlight),
			lastFailure: stats.advisors.some(advisor => advisor.status === "error")
				? { available: true, message: "One or more advisors report an error." }
				: { available: false },
			grantedTools,
			toolRisk,
		};
	}

	#autolearnStatus(session: AgentSession): Record<string, unknown> {
		const status = session.getAutolearnStatus();
		return {
			...status,
			...(typeof status.lastFailure === "string" ? { lastFailure: redactText(session, status.lastFailure) } : {}),
		};
	}

	#advisorSet(session: AgentSession, params: Record<string, unknown>): Record<string, unknown> {
		const enabled = requiredBoolean(params.enabled, "enabled");
		const active = session.setAdvisorEnabled(enabled);
		return { enabled, active, status: this.#advisorStatus(session) };
	}

	async #advisorDrain(state: ManagedExtensionState, timeoutMs: number): Promise<Record<string, unknown>> {
		const deadline = Date.now() + timeoutMs;
		const advisorSettled = await state.session.waitForAdvisorCatchup(timeoutMs);
		const notificationsSettled = await this.#waitForNotifications(Math.max(0, deadline - Date.now()));
		const droppedNotifications = state.droppedNotifications;
		return {
			settled: advisorSettled && notificationsSettled && droppedNotifications === 0,
			advisorSettled,
			notificationsSettled,
			notificationBackpressure: { dropped: droppedNotifications, recoverable: false },
			timeoutMs,
			status: this.#advisorStatus(state.session),
		};
	}

	async #waitForNotifications(timeoutMs: number): Promise<boolean> {
		if (this.#pendingNotifications === 0) return true;
		if (timeoutMs <= 0) return false;
		const pending = this.#notificationQueue.then(() => true as const);
		const { promise: timedOut, resolve } = Promise.withResolvers<false>();
		const timer = setTimeout(() => resolve(false), timeoutMs);
		try {
			return await Promise.race([pending, timedOut]);
		} finally {
			clearTimeout(timer);
		}
	}

	async #memoryContext(session: AgentSession): Promise<{
		backend: MemoryBackend;
		agentDir: string;
		cwd: string;
	}> {
		return {
			backend: await this.#resolveMemoryBackend(session.settings),
			agentDir: this.#getAgentDir(),
			cwd: session.sessionManager.getCwd(),
		};
	}

	async #memoryStatus(session: AgentSession): Promise<Record<string, unknown>> {
		const { backend, agentDir, cwd } = await this.#memoryContext(session);
		const raw = backend.status
			? await backend.status({ agentDir, cwd, session })
			: ({
					backend: backend.id,
					active: backend.id !== "off",
					writable: backend.id !== "off",
					searchable: backend.id !== "off",
				} satisfies MemoryBackendStatus);
		const safe = safeMemoryStatus(raw);
		if (typeof safe.message === "string") safe.message = redactText(session, safe.message);
		if (typeof safe.error === "string") safe.error = redactText(session, safe.error);
		return safe;
	}

	async #memoryText(session: AgentSession, operation: "stats" | "diagnose"): Promise<Record<string, unknown>> {
		const { backend, agentDir, cwd } = await this.#memoryContext(session);
		const handler = operation === "stats" ? backend.stats : backend.diagnose;
		if (!handler) return { available: false, backend: backend.id };
		const text = await handler.call(backend, agentDir, cwd, session);
		return { available: text !== undefined, backend: backend.id, text: redactText(session, text) };
	}

	async #memoryEnqueue(session: AgentSession): Promise<Record<string, unknown>> {
		const { backend, agentDir, cwd } = await this.#memoryContext(session);
		await backend.enqueue(agentDir, cwd, session);
		return { enqueued: true, backend: backend.id, status: await this.#memoryStatus(session) };
	}

	async #memoryClear(session: AgentSession, params: Record<string, unknown>): Promise<Record<string, unknown>> {
		const { backend, agentDir, cwd } = await this.#memoryContext(session);
		const supplied = optionalString(params.confirmationId, "confirmationId", 512);
		const existing = this.#memoryClearChallenges.get(session.sessionId);
		if (
			!supplied ||
			!existing ||
			existing.id !== supplied ||
			existing.backend !== backend.id ||
			existing.expiresAt < Date.now()
		) {
			const challenge: MemoryClearChallenge = {
				id: crypto.randomUUID(),
				expiresAt: Date.now() + MEMORY_CLEAR_CHALLENGE_TTL_MS,
				backend: backend.id,
			};
			this.#memoryClearChallenges.set(session.sessionId, challenge);
			return {
				cleared: false,
				confirmationRequired: true,
				confirmationId: challenge.id,
				expiresAt: new Date(challenge.expiresAt).toISOString(),
				backend: backend.id,
				scope: path.basename(session.sessionManager.getCwd()),
			};
		}
		this.#memoryClearChallenges.delete(session.sessionId);
		await backend.clear(agentDir, cwd, session);
		return { cleared: true, confirmationRequired: false, backend: backend.id };
	}

	async #launch(
		state: ManagedExtensionState,
		method: string,
		params: Record<string, unknown>,
		timeoutMs: number,
	): Promise<Record<string, unknown>> {
		const session = state.session;
		const client = await this.#daemonClientForProject(session.sessionManager.getCwd());
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		try {
			if (method === OMP_EXTENSION_METHODS.launchList) {
				const result = await client.request({ op: "list" }, controller.signal);
				if (result.op !== "list") throw new Error(`Unexpected launch result: ${result.op}`);
				const owned = this.#ownedDaemons(session, result.daemons);
				return {
					authority: "omp",
					services: owned.slice(0, MAX_STATUS_ITEMS).map(publicDaemonSnapshot),
					servicesTruncated: owned.length > MAX_STATUS_ITEMS,
				};
			}
			const name = requiredString(params.name, "name", 512);
			await this.#assertOwnedDaemon(client, session, name, controller.signal);
			const operation = this.#launchOperation(method, params, name, timeoutMs);
			const result = await client.request(operation, controller.signal);
			const data = this.#launchResult(session, result);
			if (
				"daemon" in result &&
				(method === OMP_EXTENSION_METHODS.launchSend ||
					method === OMP_EXTENSION_METHODS.launchStop ||
					method === OMP_EXTENSION_METHODS.launchRestart)
			) {
				await this.#enqueueNotification(state, OMP_EXTENSION_EVENTS.launchLifecycle, {
					event: method.slice(method.lastIndexOf("/") + 1),
					service: publicDaemonSnapshot(result.daemon),
				});
			}
			return data;
		} finally {
			clearTimeout(timer);
		}
	}

	#launchOperation(method: string, params: Record<string, unknown>, name: string, timeoutMs: number): DaemonOperation {
		switch (method) {
			case OMP_EXTENSION_METHODS.launchDescribe:
				return { op: "describe", name };
			case OMP_EXTENSION_METHODS.launchLogs:
				return {
					op: "logs",
					name,
					lines: boundedInteger(params.lines, "lines", 100, 1, 1_000),
					head: optionalBoolean(params.head, "head") ?? false,
					grep: optionalString(params.grep, "grep", 1_024),
					follow: false,
					cursor: boundedInteger(params.cursor, "cursor", 0, 0, Number.MAX_SAFE_INTEGER),
					renderTerminalRows: true,
					timeoutMs,
				};
			case OMP_EXTENSION_METHODS.launchSend: {
				const data = optionalString(params.data, "data", OMP_EXTENSION_MAX_TEXT_BYTES);
				const signal = optionalString(params.signal, "signal", 16);
				if (!data && !signal) throw new Error("data or signal required");
				if (signal && !["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT", "SIGKILL"].includes(signal)) {
					throw new Error(`Unsupported signal: ${signal}`);
				}
				return {
					op: "send",
					name,
					data,
					signal: signal as "SIGINT" | "SIGTERM" | "SIGHUP" | "SIGQUIT" | "SIGKILL",
				};
			}
			case OMP_EXTENSION_METHODS.launchStop:
				return { op: "stop", name, timeoutMs };
			case OMP_EXTENSION_METHODS.launchRestart:
				return { op: "restart", name };
			default:
				throw new Error(`Unsupported launch method: ${method}`);
		}
	}

	#launchResult(session: AgentSession, result: DaemonRpcResult): Record<string, unknown> {
		switch (result.op) {
			case "describe":
				return {
					authority: "omp",
					service: publicDaemonSnapshot(result.daemon),
					command: redactText(session, [result.spec.application, ...result.spec.args].join(" ")),
					cwd: result.spec.cwd,
					restart: result.spec.restart,
				};
			case "logs":
				return {
					authority: "omp",
					name: result.name,
					state: result.state,
					cursor: result.cursor,
					timedOut: result.timedOut,
					text: redactText(session, result.terminalRows?.join("\n") ?? result.text),
				};
			case "send":
			case "stop":
			case "restart":
				return { authority: "omp", service: publicDaemonSnapshot(result.daemon) };
			default:
				throw new Error(`Unexpected launch result: ${result.op}`);
		}
	}

	async #assertOwnedDaemon(
		client: DaemonBrokerClient,
		session: AgentSession,
		name: string,
		signal: AbortSignal,
	): Promise<void> {
		const listed = await client.request({ op: "list" }, signal);
		if (listed.op !== "list") throw new Error(`Unexpected launch result: ${listed.op}`);
		const daemon = listed.daemons.find(candidate => candidate.name === name);
		if (!daemon) throw new Error(`Unknown OMP service: ${name}`);
		if (daemon.owner !== session.sessionId)
			throw new Error(`OMP service is not owned by session ${session.sessionId}`);
	}

	#ownedDaemons(session: AgentSession, daemons: DaemonSnapshot[]): DaemonSnapshot[] {
		return daemons.filter(daemon => daemon.owner === session.sessionId);
	}

	#onSessionEvent(state: ManagedExtensionState, event: AgentSessionEvent): void {
		if (!state.negotiated) return;
		let method: string | undefined;
		let data: Record<string, unknown> | undefined;
		switch (event.type) {
			case "omp_advisor_note":
				method = OMP_EXTENSION_EVENTS.advisorNote;
				data = {
					advisorId: event.advisorId,
					severity: event.severity,
					delivery: event.delivery,
					content: redactText(state.session, event.content),
					turn: event.turn,
				};
				break;
			case "omp_autolearn_lifecycle":
				method = OMP_EXTENSION_EVENTS.autolearnLifecycle;
				data = {
					event: event.event,
					captureGeneration: event.captureGeneration,
					turn: event.turn,
					failure: redactText(state.session, event.failure),
				};
				break;
			case "omp_launch_lifecycle":
				method = OMP_EXTENSION_EVENTS.launchLifecycle;
				data = { event: event.event, service: publicDaemonSnapshot(event.daemon) };
				break;
			default:
				return;
		}
		void this.#enqueueNotification(state, method, data);
	}

	#rotateSessionState(state: ManagedExtensionState): void {
		const nextSessionId = state.session.sessionId;
		if (nextSessionId === state.sessionId) return;
		this.#states.delete(state.sessionId);
		this.#memoryClearChallenges.delete(state.sessionId);
		state.aliases.add(nextSessionId);
		state.sessionId = nextSessionId;
		state.generation = crypto.randomUUID();
		state.sequence = 0;
		state.negotiated = false;
		state.droppedNotifications = 0;
		this.#states.set(nextSessionId, state);
	}

	#enqueueNotification(state: ManagedExtensionState, method: string, data: Record<string, unknown>): Promise<void> {
		if (this.#pendingNotifications >= MAX_PENDING_NOTIFICATIONS) {
			state.droppedNotifications++;
			logger.warn("OMP typed ACP notification queue full; dropping event", { method, sessionId: state.sessionId });
			return Promise.resolve();
		}
		const expectedSessionId = state.sessionId;
		const expectedGeneration = state.generation;
		this.#pendingNotifications++;
		const send = this.#notificationQueue.then(() =>
			this.#publish(state, method, data, expectedSessionId, expectedGeneration),
		);
		this.#notificationQueue = send
			.catch(() => {})
			.finally(() => {
				this.#pendingNotifications--;
			});
		return send;
	}

	async #publish(
		state: ManagedExtensionState,
		method: string,
		data: Record<string, unknown>,
		expectedSessionId: string,
		expectedGeneration: string,
	): Promise<void> {
		try {
			if (
				this.#states.get(expectedSessionId) !== state ||
				state.sessionId !== expectedSessionId ||
				state.generation !== expectedGeneration
			)
				return;
			const envelope = createOmpExtensionEnvelope(state, { sessionId: expectedSessionId }, data);
			await this.#connection.extNotification(method, asRecord(envelope));
		} catch (error) {
			if (
				this.#states.get(expectedSessionId) === state &&
				state.sessionId === expectedSessionId &&
				state.generation === expectedGeneration
			)
				state.droppedNotifications++;
			logger.debug("OMP typed ACP notification failed", { method, error: sanitizeError(error) });
		}
	}

	#errorCode(error: unknown): string {
		const message = sanitizeError(error).toLowerCase();
		if (message.includes("timed out") || message.includes("aborted")) return "TIMEOUT";
		if (message.includes("owned by") || message.includes("confirmation")) return "PERMISSION_DENIED";
		if (message.includes("unsupported") || message.includes("unknown")) return "UNSUPPORTED";
		return "OPERATION_FAILED";
	}

	#isRecoverable(error: unknown): boolean {
		const message = sanitizeError(error).toLowerCase();
		return message.includes("timed out") || message.includes("unavailable") || message.includes("connect");
	}
}
