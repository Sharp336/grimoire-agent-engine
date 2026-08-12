export const PRIME_DAEMON_PROTOCOL_NAME = "prime-agent.daemon" as const;
export const PRIME_DAEMON_PROTOCOL_VERSION = 7 as const;

export type PrimeDaemonProtocolName = typeof PRIME_DAEMON_PROTOCOL_NAME;

export interface BridgeMessage {
	meshMessageId: string;
	idempotencyKey: string;
	originHarness: "omp" | "prime";
	originSessionId: string;
	targetHarness: "omp" | "prime";
	targetId: string;
	body: string;
	replyTo?: string;
	projectRoot: string;
	createdAt: string;
}

export type BridgeReceiptStatus = "delivered" | "queued" | "injected" | "woken" | "revived" | "failed";

export interface BridgeReceipt {
	meshMessageId: string;
	status: BridgeReceiptStatus;
	error?: string;
	[key: string]: unknown;
}

export interface ExternalPeer {
	id: string;
	displayName: string;
	status: string;
	[key: string]: unknown;
}

export interface PrimeDaemonCursor {
	generation: string;
	sequence: number;
	[key: string]: unknown;
}

export interface PrimeDaemonProtocolInfo {
	name: PrimeDaemonProtocolName;
	version: number;
	[key: string]: unknown;
}

export interface PrimeDaemonHello {
	type: "daemon_hello";
	socketPath: string;
	protocol: PrimeDaemonProtocolInfo;
	clientId: string;
	serverCapabilities: readonly string[];
	schemaId?: string;
	schemaRevision?: number;
	appVersion?: string;
	runtime?: {
		buildId: string;
		executablePath: string;
		entrypointPath?: string;
		launcherPath?: string;
		[key: string]: unknown;
	};
	supervisorGeneration?: string;
	supervisorPid?: number;
	supervisorOwnerToken?: string;
	supervisorProcessStartId?: string;
	supervisorSocketPath?: string;
	[key: string]: unknown;
}

export interface PrimeDaemonCommandEnvelope<TCommand extends object = Record<string, unknown>> {
	type: "command";
	id: string;
	protocol: PrimeDaemonProtocolInfo;
	clientId?: string;
	command: TCommand;
	[key: string]: unknown;
}

export interface PrimeDaemonResponse {
	type: "response";
	id?: string;
	command: string;
	success: boolean;
	data?: unknown;
	error?: string;
	errorInfo?: unknown;
	protocol?: PrimeDaemonProtocolInfo;
	[key: string]: unknown;
}

export interface PrimeDaemonEventMeta {
	id: string;
	protocol: PrimeDaemonProtocolInfo;
	activeSessionId?: string;
	sequence?: number;
	cursor?: PrimeDaemonCursor;
	emittedAt: string;
	replayed?: boolean;
	[key: string]: unknown;
}

export interface PrimeDaemonEvent {
	type: string;
	activeSessionId?: string;
	meta?: PrimeDaemonEventMeta;
	[key: string]: unknown;
}

export interface PrimeDaemonEventEnvelope {
	type: "event";
	id: string;
	protocol: PrimeDaemonProtocolInfo;
	activeSessionId?: string;
	sequence?: number;
	cursor?: PrimeDaemonCursor;
	emittedAt: string;
	event: Record<string, unknown>;
	[key: string]: unknown;
}

export type PrimeDaemonOutbound = PrimeDaemonHello | PrimeDaemonResponse | PrimeDaemonEventEnvelope | PrimeDaemonEvent;
export type PrimeDaemonFrame = PrimeDaemonHello | PrimeDaemonOutbound;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseInput(value: unknown): unknown {
	if (typeof value !== "string") {
		return value;
	}
	try {
		return JSON.parse(value) as unknown;
	} catch (error) {
		throw new Error(`Invalid daemon frame JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function validateProtocol(value: unknown): asserts value is PrimeDaemonProtocolInfo {
	if (!isRecord(value)) {
		throw new Error("Daemon frame protocol must be an object");
	}
	if (value.name !== PRIME_DAEMON_PROTOCOL_NAME) {
		throw new Error(`Unsupported daemon protocol name: ${String(value.name)}`);
	}
	if (
		typeof value.version !== "number" ||
		!Number.isSafeInteger(value.version) ||
		value.version < PRIME_DAEMON_PROTOCOL_VERSION
	) {
		throw new Error(`Unsupported daemon protocol version: ${String(value.version)}`);
	}
}

function validateCursor(value: unknown): asserts value is PrimeDaemonCursor {
	if (!isRecord(value)) {
		throw new Error("Daemon cursor must be an object");
	}
	const hasGeneration = Object.hasOwn(value, "generation");
	const hasSequence = Object.hasOwn(value, "sequence");
	if (hasGeneration !== hasSequence) {
		throw new Error("Daemon cursor requires generation and sequence together");
	}
	if (!hasGeneration) {
		throw new Error("Daemon cursor requires generation and sequence together");
	}
	if (typeof value.generation !== "string" || value.generation.length === 0) {
		throw new Error("Daemon cursor generation must be a non-empty string");
	}
	if (typeof value.sequence !== "number" || !Number.isInteger(value.sequence) || value.sequence < 0) {
		throw new Error("Daemon cursor sequence must be a non-negative integer");
	}
}

function validateCursorFields(value: Record<string, unknown>): void {
	if (Object.hasOwn(value, "cursor")) {
		validateCursor(value.cursor);
	}
	const meta = value.meta;
	if (isRecord(meta) && Object.hasOwn(meta, "cursor")) {
		validateCursor(meta.cursor);
	}
	if (Object.hasOwn(value, "protocol")) {
		validateProtocol(value.protocol);
	}
}

function validateHello(value: Record<string, unknown>): asserts value is PrimeDaemonHello {
	if (value.type !== "daemon_hello") {
		throw new Error("Daemon frame is not a hello");
	}
	validateProtocol(value.protocol);
	if (typeof value.socketPath !== "string") {
		throw new Error("Daemon hello socketPath must be a string");
	}
	if (typeof value.clientId !== "string") {
		throw new Error("Daemon hello clientId must be a string");
	}
	if (value.schemaId !== undefined && typeof value.schemaId !== "string") {
		throw new Error("Daemon hello schemaId must be a string");
	}
	if (
		!Array.isArray(value.serverCapabilities) ||
		!value.serverCapabilities.every((capability): capability is string => typeof capability === "string")
	) {
		throw new Error("Daemon hello serverCapabilities must be an array of strings");
	}
	if (value.schemaRevision !== undefined && typeof value.schemaRevision !== "number") {
		throw new Error("Daemon hello schemaRevision must be a number");
	}
	if (value.appVersion !== undefined && typeof value.appVersion !== "string") {
		throw new Error("Daemon hello appVersion must be a string");
	}
	if (value.runtime !== undefined) {
		if (!isRecord(value.runtime)) {
			throw new Error("Daemon hello runtime must be an object");
		}
		if (typeof value.runtime.buildId !== "string" || typeof value.runtime.executablePath !== "string") {
			throw new Error("Daemon hello runtime buildId and executablePath must be strings");
		}
		if (value.runtime.entrypointPath !== undefined && typeof value.runtime.entrypointPath !== "string") {
			throw new Error("Daemon hello runtime entrypointPath must be a string");
		}
		if (value.runtime.launcherPath !== undefined && typeof value.runtime.launcherPath !== "string") {
			throw new Error("Daemon hello runtime launcherPath must be a string");
		}
	}
	if (value.supervisorGeneration !== undefined && typeof value.supervisorGeneration !== "string") {
		throw new Error("Daemon hello supervisorGeneration must be a string");
	}
	if (value.supervisorOwnerToken !== undefined && typeof value.supervisorOwnerToken !== "string") {
		throw new Error("Daemon hello supervisorOwnerToken must be a string");
	}
	if (value.supervisorProcessStartId !== undefined && typeof value.supervisorProcessStartId !== "string") {
		throw new Error("Daemon hello supervisorProcessStartId must be a string");
	}
	if (value.supervisorSocketPath !== undefined && typeof value.supervisorSocketPath !== "string") {
		throw new Error("Daemon hello supervisorSocketPath must be a string");
	}
	if (value.supervisorPid !== undefined && typeof value.supervisorPid !== "number") {
		throw new Error("Daemon hello supervisorPid must be a number");
	}
	validateCursorFields(value);
}

function validateResponse(value: Record<string, unknown>): asserts value is PrimeDaemonResponse {
	if (value.type !== "response") {
		throw new Error("Daemon frame is not a response");
	}
	if (value.id !== undefined && typeof value.id !== "string") {
		throw new Error("Daemon response id must be a string");
	}
	if (typeof value.error !== "undefined" && typeof value.error !== "string") {
		throw new Error("Daemon response error must be a string");
	}
	if (typeof value.command !== "string") {
		throw new Error("Daemon response command must be a string");
	}
	if (typeof value.success !== "boolean") {
		throw new Error("Daemon response success must be a boolean");
	}
	if (value.success === false && typeof value.error !== "string") {
		throw new Error("Failed daemon response error must be a string");
	}
	validateCursorFields(value);
}

function validateEvent(value: Record<string, unknown>): asserts value is PrimeDaemonEventEnvelope {
	if (value.type !== "event") {
		throw new Error("Daemon frame is not an event");
	}
	validateProtocol(value.protocol);
	if (typeof value.id !== "string") {
		throw new Error("Daemon event id must be a string");
	}
	if (!isRecord(value.event)) {
		throw new Error("Daemon event payload must be an object");
	}
	if (value.activeSessionId !== undefined && typeof value.activeSessionId !== "string") {
		throw new Error("Daemon event activeSessionId must be a string");
	}
	if (value.sequence !== undefined && (typeof value.sequence !== "number" || !Number.isInteger(value.sequence))) {
		throw new Error("Daemon event sequence must be an integer");
	}
	if (typeof value.emittedAt !== "string") {
		throw new Error("Daemon event emittedAt must be a string");
	}
	validateCursorFields(value);
}

function validateDirectEvent(value: Record<string, unknown>): asserts value is PrimeDaemonEvent {
	if (typeof value.type !== "string" || value.type === "command") {
		throw new Error("Daemon event type must be a non-command string");
	}
	if (value.activeSessionId !== undefined && typeof value.activeSessionId !== "string") {
		throw new Error("Daemon event activeSessionId must be a string");
	}
	const meta = value.meta;
	if (meta === undefined) {
		validateCursorFields(value);
		return;
	}
	if (!isRecord(meta)) {
		throw new Error("Daemon event metadata must be an object");
	}
	if (typeof meta.id !== "string") {
		throw new Error("Daemon event metadata id must be a string");
	}
	validateProtocol(meta.protocol);
	if (meta.activeSessionId !== undefined && typeof meta.activeSessionId !== "string") {
		throw new Error("Daemon event metadata activeSessionId must be a string");
	}
	if (meta.sequence !== undefined && (typeof meta.sequence !== "number" || !Number.isInteger(meta.sequence))) {
		throw new Error("Daemon event metadata sequence must be an integer");
	}
	if (typeof meta.emittedAt !== "string") {
		throw new Error("Daemon event metadata emittedAt must be a string");
	}
	if (meta.replayed !== undefined && typeof meta.replayed !== "boolean") {
		throw new Error("Daemon event metadata replayed must be a boolean");
	}
	validateCursorFields(meta);
	validateCursorFields(value);
}

export function parsePrimeDaemonHello(value: unknown): PrimeDaemonHello {
	const parsed = parseInput(value);
	if (!isRecord(parsed)) {
		throw new Error("Daemon hello must be an object");
	}
	validateHello(parsed);
	return parsed;
}

export function parsePrimeDaemonCommandEnvelope(value: unknown): PrimeDaemonCommandEnvelope<Record<string, unknown>> {
	const parsed = parseInput(value);
	if (!isRecord(parsed)) {
		throw new Error("Daemon command envelope must be an object");
	}
	if (parsed.type !== "command") {
		throw new Error("Daemon frame is not a command envelope");
	}
	if (typeof parsed.id !== "string") {
		throw new Error("Daemon command envelope id must be a string");
	}
	validateProtocol(parsed.protocol);
	if (parsed.clientId !== undefined && typeof parsed.clientId !== "string") {
		throw new Error("Daemon command envelope clientId must be a string");
	}
	if (!isRecord(parsed.command)) {
		throw new Error("Daemon command envelope command must be an object");
	}
	validateCursorFields(parsed);
	return parsed as PrimeDaemonCommandEnvelope<Record<string, unknown>>;
}

export function parsePrimeDaemonOutbound(value: unknown): PrimeDaemonOutbound {
	const parsed = parseInput(value);
	if (!isRecord(parsed)) {
		throw new Error("Daemon outbound frame must be an object");
	}
	if (parsed.type === "daemon_hello") {
		validateHello(parsed);
		return parsed;
	}
	if (parsed.type === "response") {
		validateResponse(parsed);
		return parsed;
	}
	if (parsed.type === "event") {
		validateEvent(parsed);
		return parsed;
	}
	validateDirectEvent(parsed);
	return parsed;
}

export function parsePrimeDaemonFrame(value: unknown): PrimeDaemonFrame {
	const parsed = parseInput(value);
	if (!isRecord(parsed)) {
		throw new Error("Daemon frame must be an object");
	}
	if (parsed.type === "daemon_hello") {
		validateHello(parsed);
		return parsed;
	}
	return parsePrimeDaemonOutbound(parsed);
}

export function isPrimeDaemonFrame(value: unknown): value is PrimeDaemonFrame {
	try {
		parsePrimeDaemonFrame(value);
		return true;
	} catch {
		return false;
	}
}
