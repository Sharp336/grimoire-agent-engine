import * as fs from "node:fs/promises";
import * as path from "node:path";

export const REMOTE_RUNTIME_PROTOCOL_VERSION = "omp.remote-runtime.v1" as const;

const CONFIG_KEYS = [
	"version",
	"socketPath",
	"controllerId",
	"executionId",
	"rootExecutionId",
	"parentExecutionId",
	"assignmentId",
	"depth",
	"revision",
	"grantId",
	"policyDigest",
	"budgetRef",
	"schemaRef",
	"requestTimeoutMs",
] as const;
const CONFIG_KEY_LOOKUP: Record<(typeof CONFIG_KEYS)[number], true> = {
	version: true,
	socketPath: true,
	controllerId: true,
	executionId: true,
	rootExecutionId: true,
	parentExecutionId: true,
	assignmentId: true,
	depth: true,
	revision: true,
	grantId: true,
	policyDigest: true,
	budgetRef: true,
	schemaRef: true,
	requestTimeoutMs: true,
};
const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const REVISION_RE = /^[0-9a-f]{40}$/i;
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/i;
const CONTROLLER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const LOGICAL_REF_RE = /^[a-z][a-z0-9+.-]{0,31}:[A-Za-z0-9._~-]{1,191}$/;
const MAX_CONFIG_BYTES = 16_384;
const MAX_SOCKET_PATH_BYTES = 100;

export class RemoteRuntimeConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "RemoteRuntimeConfigError";
	}
}

/** Immutable, launch-owned authority descriptor. It intentionally has no credential field. */
export interface RemoteRuntimeConfig {
	readonly version: typeof REMOTE_RUNTIME_PROTOCOL_VERSION;
	readonly socketPath: string;
	readonly controllerId: string;
	readonly executionId: string;
	readonly rootExecutionId: string;
	readonly parentExecutionId: string | null;
	readonly assignmentId: string;
	readonly depth: number;
	readonly revision: string;
	readonly grantId: string;
	readonly policyDigest: string;
	readonly budgetRef: string;
	readonly schemaRef: string;
	readonly requestTimeoutMs: number;
}

function requireString(value: unknown, field: string): string {
	if (typeof value !== "string" || value.length === 0 || value !== value.trim() || value.includes("\0")) {
		throw new RemoteRuntimeConfigError(`Remote runtime config field ${field} must be a non-empty normalized string.`);
	}
	return value;
}

function requireUlid(value: unknown, field: string): string {
	const candidate = requireString(value, field);
	if (!ULID_RE.test(candidate))
		throw new RemoteRuntimeConfigError(`Remote runtime config field ${field} must be an uppercase ULID.`);
	return candidate;
}

function requireLogicalRef(value: unknown, field: string): string {
	const candidate = requireString(value, field);
	if (!LOGICAL_REF_RE.test(candidate)) {
		throw new RemoteRuntimeConfigError(`Remote runtime config field ${field} must be a bounded logical reference.`);
	}
	return candidate;
}

/** Validate untrusted JSON without accepting aliases, defaults, or partial authority. */
export function parseRemoteRuntimeConfig(value: unknown): RemoteRuntimeConfig {
	if (process.platform === "win32")
		throw new RemoteRuntimeConfigError("Sealed remote runtime mode requires Unix domain sockets.");
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new RemoteRuntimeConfigError("Remote runtime config must be a JSON object.");
	}
	const candidate = value as Record<string, unknown>;
	for (const key of Object.keys(candidate)) {
		if (!Object.hasOwn(CONFIG_KEY_LOOKUP, key))
			throw new RemoteRuntimeConfigError("Remote runtime config contains unknown fields.");
	}
	for (const key of CONFIG_KEYS) {
		if (!Object.hasOwn(candidate, key))
			throw new RemoteRuntimeConfigError(`Remote runtime config is missing required field ${key}.`);
	}
	if (candidate.version !== REMOTE_RUNTIME_PROTOCOL_VERSION) {
		throw new RemoteRuntimeConfigError(`Remote runtime config version must be ${REMOTE_RUNTIME_PROTOCOL_VERSION}.`);
	}
	const socketPath = requireString(candidate.socketPath, "socketPath");
	if (!path.isAbsolute(socketPath) || /^[A-Za-z]:[\\/]/.test(socketPath)) {
		throw new RemoteRuntimeConfigError("Remote runtime socketPath must be an absolute Unix path.");
	}
	if (Buffer.byteLength(socketPath) > MAX_SOCKET_PATH_BYTES) {
		throw new RemoteRuntimeConfigError("Remote runtime socketPath exceeds the Unix socket path limit.");
	}
	const controllerId = requireString(candidate.controllerId, "controllerId");
	if (!CONTROLLER_ID_RE.test(controllerId))
		throw new RemoteRuntimeConfigError("Remote runtime controllerId is malformed.");
	if (!Number.isSafeInteger(candidate.depth) || (candidate.depth as number) < 0 || (candidate.depth as number) > 64) {
		throw new RemoteRuntimeConfigError("Remote runtime config field depth must be an integer between 0 and 64.");
	}
	const revision = requireString(candidate.revision, "revision");
	if (!REVISION_RE.test(revision)) {
		throw new RemoteRuntimeConfigError("Remote runtime revision must be an immutable 40-character commit hash.");
	}
	const policyDigest = requireString(candidate.policyDigest, "policyDigest");
	if (!DIGEST_RE.test(policyDigest))
		throw new RemoteRuntimeConfigError("Remote runtime policyDigest must be a SHA-256 digest.");
	if (
		!Number.isSafeInteger(candidate.requestTimeoutMs) ||
		(candidate.requestTimeoutMs as number) < 100 ||
		(candidate.requestTimeoutMs as number) > 120_000
	) {
		throw new RemoteRuntimeConfigError("Remote runtime requestTimeoutMs must be an integer between 100 and 120000.");
	}
	const parentExecutionId =
		candidate.parentExecutionId === null ? null : requireUlid(candidate.parentExecutionId, "parentExecutionId");
	const config: RemoteRuntimeConfig = {
		version: REMOTE_RUNTIME_PROTOCOL_VERSION,
		socketPath,
		controllerId,
		executionId: requireUlid(candidate.executionId, "executionId"),
		rootExecutionId: requireUlid(candidate.rootExecutionId, "rootExecutionId"),
		parentExecutionId,
		assignmentId: requireUlid(candidate.assignmentId, "assignmentId"),
		depth: candidate.depth as number,
		revision: revision.toLowerCase(),
		grantId: requireUlid(candidate.grantId, "grantId"),
		policyDigest: policyDigest.toLowerCase(),
		budgetRef: requireLogicalRef(candidate.budgetRef, "budgetRef"),
		schemaRef: requireLogicalRef(candidate.schemaRef, "schemaRef"),
		requestTimeoutMs: candidate.requestTimeoutMs as number,
	};
	if (config.depth === 0 && config.parentExecutionId !== null) {
		throw new RemoteRuntimeConfigError("A root remote runtime config cannot declare parentExecutionId.");
	}
	if (config.depth > 0 && config.parentExecutionId === null) {
		throw new RemoteRuntimeConfigError("A nested remote runtime config requires parentExecutionId.");
	}
	return Object.freeze(config);
}

/** Read one bounded descriptor through a stable file handle, then freeze its validated value. */
export async function loadRemoteRuntimeConfig(configPath: string): Promise<RemoteRuntimeConfig> {
	if (configPath.includes("\0") || !path.isAbsolute(configPath) || /^[A-Za-z]:[\\/]/.test(configPath)) {
		throw new RemoteRuntimeConfigError("--remote-runtime-config requires an absolute Unix path.");
	}
	let handle: fs.FileHandle;
	try {
		handle = await fs.open(configPath, "r");
	} catch {
		throw new RemoteRuntimeConfigError("Remote runtime config could not be opened.");
	}
	try {
		const before = await handle.stat();
		const effectiveUid = process.geteuid?.();
		if (
			!before.isFile() ||
			before.size <= 0 ||
			before.size > MAX_CONFIG_BYTES ||
			effectiveUid === undefined ||
			before.uid !== effectiveUid ||
			(before.mode & 0o077) !== 0
		) {
			throw new RemoteRuntimeConfigError(
				"Remote runtime config must be a current-user-owned, private, non-empty bounded regular file.",
			);
		}
		const text = await handle.readFile({ encoding: "utf8" });
		const after = await handle.stat();
		if (
			before.dev !== after.dev ||
			before.ino !== after.ino ||
			before.size !== after.size ||
			before.mtimeMs !== after.mtimeMs
		) {
			throw new RemoteRuntimeConfigError("Remote runtime config changed while it was being read.");
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch {
			throw new RemoteRuntimeConfigError("Remote runtime config must contain valid JSON.");
		}
		return parseRemoteRuntimeConfig(parsed);
	} catch (error) {
		if (error instanceof RemoteRuntimeConfigError) throw error;
		throw new RemoteRuntimeConfigError("Remote runtime config could not be read.");
	} finally {
		await handle.close().catch(() => {});
	}
}
