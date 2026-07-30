import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** On-disk format version for session lock records. */
export const SESSION_LOCK_PROTOCOL_VERSION = 1;
/** Default interval between owner heartbeat updates. */
export const SESSION_LOCK_HEARTBEAT_MS = 5_000;
/** Age after which a lock is reported as suspect. */
export const SESSION_LOCK_SUSPECT_AFTER_MS = 15_000;
/** Minimum age before a lock owned by a confirmed-dead process may be replaced. */
export const SESSION_LOCK_STEAL_AFTER_MS = 20_000;
const MAX_LOCK_BYTES = 16 * 1024;
const MAX_OWNER_ID_BYTES = 64;
const MAX_MARKER_BYTES = 256;
const MAX_HOSTNAME_BYTES = 255;
const MAX_SESSION_PATH_BYTES = 4 * 1024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LOCK_KEYS: Record<string, true> = {
	protocolVersion: true,
	ownerId: true,
	pid: true,
	processStartMarker: true,
	hostname: true,
	createdAt: true,
	heartbeatAt: true,
	sessionFile: true,
};

type ErrorCode = "EEXIST" | "ENOENT" | string;

/** Classification of the current sidecar lock state. */
export type SessionLockStatus = "missing" | "live" | "suspect" | "stale" | "malformed";
/**
 * Stable error categories reported by session lock operations. `unsupported`
 * means the session file itself cannot carry a single-writer guarantee, which
 * is distinct from a well-formed lock held by someone else (`locked`).
 */
export type SessionLockErrorCode = "locked" | "malformed" | "not-owner" | "io" | "unsupported";

/** Validated owner record persisted in the sidecar lock file. */
export interface SessionLockRecord {
	protocolVersion: number;
	ownerId: string;
	pid: number;
	processStartMarker: string;
	hostname: string;
	createdAt: number;
	heartbeatAt: number;
	sessionFile: string;
}

/** Platform-specific process identity checks used for stale-owner recovery. */
export interface SessionLockProcessProbe {
	isAlive(pid: number, processStartMarker: string): boolean | "unknown";
	processStartMarker(pid: number): string | null;
}

/** Overrides for lock identity, timing, and process probing. */
export interface SessionLockOptions {
	now?: () => number;
	ownerId?: string;
	pid?: number;
	hostname?: string;
	processStartMarker?: string;
	processProbe?: SessionLockProcessProbe;
	heartbeatIntervalMs?: number;
	onHeartbeatError?: (error: SessionLockError) => void;
}

/** Observed lock state and stale-recovery eligibility. */
export interface SessionLockInspection {
	lockPath: string;
	status: SessionLockStatus;
	record?: SessionLockRecord;
	heartbeatAgeMs?: number;
	processAlive?: boolean | "unknown";
	stealable: boolean;
}

/** Error raised when lock ownership or lock-file I/O prevents an operation. */
export class SessionLockError extends Error {
	readonly code: SessionLockErrorCode;
	readonly sessionFile: string;
	readonly lockPath: string;
	readonly inspection?: SessionLockInspection;
	readonly owner?: SessionLockRecord;
	readonly cause?: unknown;

	constructor(
		code: SessionLockErrorCode,
		message: string,
		sessionFile: string,
		lockPath: string,
		inspection?: SessionLockInspection,
		cause?: unknown,
	) {
		super(message, cause === undefined ? undefined : { cause });
		this.name = "SessionLockError";
		this.code = code;
		this.sessionFile = sessionFile;
		this.lockPath = lockPath;
		this.inspection = inspection;
		this.owner = inspection?.record;
		this.cause = cause;
	}
}

interface PathSessionLockHandle {
	readonly record: SessionLockRecord;
	readonly lockPath: string;
	heartbeat(): void;
	release(): void;
	readonly released: boolean;
}

/** Exclusive session ownership handle with heartbeat and release operations. */
export interface SessionLockHandle extends PathSessionLockHandle {
	/** Device/inode identity currently owned for the published session file. */
	readonly fileIdentity: SessionFileIdentity | undefined;
	/**
	 * Claim the identity of a staged session file before publishing it.
	 * Commit the claim after publication, or roll it back if publication fails.
	 */
	prepareFileIdentity(filePath: string): SessionFileIdentityClaim;
	/** Transfer an already-held file identity to another path lock without releasing the identity lock. */
	transferFileIdentityTo(target: SessionLockHandle, filePath: string): void;
}

/** Stable filesystem identity used to fence path replacements and hard-link aliases. */
export interface SessionFileIdentity {
	dev: number;
	ino: number;
}

/** Prepared identity-lock rotation for an atomic session-file publication. */
export interface SessionFileIdentityClaim {
	readonly identity: SessionFileIdentity;
	commit(): void;
	rollback(): void;
}

const sessionLockIdentityReceivers = new WeakMap<
	SessionLockHandle,
	(identity: SessionFileIdentity, handle: PathSessionLockHandle) => void
>();

interface SessionLockClaim {
	protocolVersion: number;
	ownerId: string;
	pid: number;
	processStartMarker: string;
	hostname: string;
	createdAt: number;
	sessionFile: string;
}
interface SessionLockRuntime {
	now: () => number;
	ownerId: string;
	pid: number;
	hostname: string;
	processProbe: SessionLockProcessProbe;
	processStartMarker: string;
	heartbeatIntervalMs: number;
	onHeartbeatError?: (error: SessionLockError) => void;
}

function byteLength(value: string): number {
	return Buffer.byteLength(value, "utf8");
}

function errorCode(error: unknown): ErrorCode | undefined {
	return error instanceof Error && "code" in error ? String((error as NodeJS.ErrnoException).code) : undefined;
}

function defaultProcessStartMarker(pid: number): string | null {
	if (process.platform === "linux") {
		try {
			const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
			const closingParen = stat.lastIndexOf(")");
			if (closingParen < 0) return null;
			// After the comm field, fields[0] is stat field 3 (state), so
			// starttime (field 22) is index 19.
			const fields = stat
				.slice(closingParen + 1)
				.trim()
				.split(/\s+/);
			const startTime = fields[19];
			return startTime ? `linux:${startTime}` : null;
		} catch {
			return null;
		}
	}

	if (process.platform === "darwin") {
		try {
			const processInfo = Bun.spawnSync(["ps", "-p", String(pid), "-o", "lstart="], {
				stdin: "ignore",
				stdout: "pipe",
				stderr: "ignore",
				timeout: 3_000,
			});
			if (!processInfo.success) return null;
			const value = processInfo.stdout.toString().trim();
			return value ? `darwin:${value}` : null;
		} catch {
			return null;
		}
	}

	if (process.platform === "win32") {
		try {
			const processInfo = Bun.spawnSync(
				[
					"powershell.exe",
					"-NoProfile",
					"-NonInteractive",
					"-Command",
					`(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToFileTimeUtc()`,
				],
				{
					stdin: "ignore",
					stdout: "pipe",
					stderr: "ignore",
					timeout: 3_000,
				},
			);
			if (!processInfo.success) return null;
			const value = processInfo.stdout.toString().trim();
			return value ? `win32:${value}` : null;
		} catch {
			return null;
		}
	}

	return null;
}

const defaultProcessProbe: SessionLockProcessProbe = {
	processStartMarker: defaultProcessStartMarker,
	isAlive(pid, processStartMarker) {
		try {
			process.kill(pid, 0);
		} catch (error) {
			return errorCode(error) === "ESRCH" ? false : "unknown";
		}
		const currentMarker = defaultProcessStartMarker(pid);
		if (currentMarker === null) return "unknown";
		return currentMarker === processStartMarker;
	},
};

/**
 * Canonical identity of a session path: the same absolute target the lock
 * pins after resolving symlinks. Callers that compare a caller-supplied path
 * against a manager's live session file MUST normalize both sides through
 * this, because the manager reports the canonicalized target.
 */
export function canonicalSessionPath(sessionFile: string): string {
	return normalizeSessionFile(sessionFile);
}

function normalizeSessionFile(sessionFile: string): string {
	const resolved = path.resolve(sessionFile);
	try {
		return fs.realpathSync(resolved);
	} catch {
		try {
			return path.join(fs.realpathSync(path.dirname(resolved)), path.basename(resolved));
		} catch {
			return resolved;
		}
	}
}

function lockPathFor(sessionFile: string): string {
	return `${normalizeSessionFile(sessionFile)}.lock`;
}

function claimPathFor(lockPath: string): string {
	return `${lockPath}.steal`;
}

function runtime(options: SessionLockOptions): SessionLockRuntime {
	const pid = options.pid ?? process.pid;
	if (!Number.isInteger(pid) || pid <= 0) throw new Error("Session lock pid is invalid");
	const processProbe = options.processProbe ?? defaultProcessProbe;
	const processStartMarker = options.processStartMarker ?? processProbe.processStartMarker(pid);
	if (!processStartMarker) throw new Error(`Unable to determine process start marker for pid ${pid}`);
	const ownerId = options.ownerId ?? Bun.randomUUIDv7();
	if (!UUID_PATTERN.test(ownerId)) throw new Error("Session lock ownerId must be a UUID");
	const hostname = options.hostname ?? os.hostname();
	if (!hostname || byteLength(hostname) > MAX_HOSTNAME_BYTES) throw new Error("Session lock hostname is invalid");
	if (byteLength(processStartMarker) > MAX_MARKER_BYTES) throw new Error("Session lock process marker is too long");
	return {
		now: options.now ?? Date.now,
		ownerId,
		pid,
		hostname,
		processProbe,
		processStartMarker,
		heartbeatIntervalMs: options.heartbeatIntervalMs ?? SESSION_LOCK_HEARTBEAT_MS,
		onHeartbeatError: options.onHeartbeatError,
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseRecord(text: string, expectedSessionFile?: string): SessionLockRecord | null {
	if (byteLength(text) > MAX_LOCK_BYTES) return null;
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return null;
	}
	if (!isRecord(value)) return null;
	if (Object.keys(value).length !== Object.keys(LOCK_KEYS).length || Object.keys(value).some(key => !LOCK_KEYS[key]))
		return null;
	const protocolVersion = value.protocolVersion;
	const ownerId = value.ownerId;
	const pid = value.pid;
	const processStartMarker = value.processStartMarker;
	const hostname = value.hostname;
	const createdAt = value.createdAt;
	const heartbeatAt = value.heartbeatAt;
	const sessionFile = value.sessionFile;
	if (
		protocolVersion !== SESSION_LOCK_PROTOCOL_VERSION ||
		typeof ownerId !== "string" ||
		!UUID_PATTERN.test(ownerId) ||
		byteLength(ownerId) > MAX_OWNER_ID_BYTES ||
		!Number.isSafeInteger(pid) ||
		(pid as number) <= 0 ||
		typeof processStartMarker !== "string" ||
		!processStartMarker ||
		byteLength(processStartMarker) > MAX_MARKER_BYTES ||
		typeof hostname !== "string" ||
		!hostname ||
		byteLength(hostname) > MAX_HOSTNAME_BYTES ||
		typeof createdAt !== "number" ||
		!Number.isFinite(createdAt) ||
		createdAt < 0 ||
		typeof heartbeatAt !== "number" ||
		!Number.isFinite(heartbeatAt) ||
		heartbeatAt < 0 ||
		typeof sessionFile !== "string" ||
		!sessionFile ||
		byteLength(sessionFile) > MAX_SESSION_PATH_BYTES ||
		sessionFile !== normalizeSessionFile(sessionFile) ||
		(expectedSessionFile !== undefined && sessionFile !== normalizeSessionFile(expectedSessionFile))
	) {
		return null;
	}
	return {
		protocolVersion: protocolVersion as number,
		ownerId: ownerId as string,
		pid: pid as number,
		processStartMarker: processStartMarker as string,
		hostname: hostname as string,
		createdAt: createdAt as number,
		heartbeatAt: heartbeatAt as number,
		sessionFile: sessionFile as string,
	};
}

function parseClaim(text: string, expectedSessionFile: string): SessionLockClaim | null {
	if (byteLength(text) > MAX_LOCK_BYTES) return null;
	try {
		const value = JSON.parse(text) as Record<string, unknown>;
		const expectedKeys = [
			"protocolVersion",
			"ownerId",
			"pid",
			"processStartMarker",
			"hostname",
			"createdAt",
			"sessionFile",
		];
		if (
			!isRecord(value) ||
			Object.keys(value).length !== expectedKeys.length ||
			Object.keys(value).some(key => !expectedKeys.includes(key))
		)
			return null;
		if (
			value.protocolVersion !== SESSION_LOCK_PROTOCOL_VERSION ||
			typeof value.ownerId !== "string" ||
			!UUID_PATTERN.test(value.ownerId) ||
			byteLength(value.ownerId) > MAX_OWNER_ID_BYTES ||
			typeof value.pid !== "number" ||
			!Number.isSafeInteger(value.pid) ||
			value.pid <= 0 ||
			typeof value.processStartMarker !== "string" ||
			!value.processStartMarker ||
			byteLength(value.processStartMarker) > MAX_MARKER_BYTES ||
			typeof value.hostname !== "string" ||
			!value.hostname ||
			byteLength(value.hostname) > MAX_HOSTNAME_BYTES ||
			typeof value.createdAt !== "number" ||
			!Number.isFinite(value.createdAt) ||
			value.createdAt < 0 ||
			typeof value.sessionFile !== "string" ||
			!value.sessionFile ||
			byteLength(value.sessionFile) > MAX_SESSION_PATH_BYTES ||
			value.sessionFile !== normalizeSessionFile(expectedSessionFile)
		)
			return null;
		return value as unknown as SessionLockClaim;
	} catch {
		return null;
	}
}

type LoadedRecord = { kind: "missing" } | { kind: "malformed" } | { kind: "record"; record: SessionLockRecord };

function readRecord(lockPath: string, expectedSessionFile: string): LoadedRecord {
	let stat: fs.Stats;
	try {
		stat = fs.statSync(lockPath);
	} catch (error) {
		if (errorCode(error) === "ENOENT") return { kind: "missing" };
		throw error;
	}
	if (!stat.isFile() || stat.size > MAX_LOCK_BYTES) return { kind: "malformed" };
	try {
		const record = parseRecord(fs.readFileSync(lockPath, "utf8"), expectedSessionFile);
		return record ? { kind: "record", record } : { kind: "malformed" };
	} catch (error) {
		if (errorCode(error) === "ENOENT") return { kind: "missing" };
		throw error;
	}
}

function processAlive(
	record: Pick<SessionLockRecord, "hostname" | "pid" | "processStartMarker">,
	rt: SessionLockRuntime,
): boolean | "unknown" {
	if (record.hostname !== rt.hostname) return "unknown";
	try {
		return rt.processProbe.isAlive(record.pid, record.processStartMarker);
	} catch {
		return "unknown";
	}
}

function inspectWithRuntime(sessionFile: string, rt: SessionLockRuntime): SessionLockInspection {
	const normalized = normalizeSessionFile(sessionFile);
	const lockPath = lockPathFor(normalized);
	const loaded = readRecord(lockPath, normalized);
	if (loaded.kind === "missing") return { lockPath, status: "missing", stealable: false };
	if (loaded.kind === "malformed") return { lockPath, status: "malformed", stealable: false };
	const record = loaded.record;
	const alive = processAlive(record, rt);
	const rawHeartbeatAgeMs = rt.now() - record.heartbeatAt;
	// A definitively dead local owner remains recoverable after a backward clock
	// correction. Live/unknown owners retain the normal grace period.
	const heartbeatAgeMs =
		rawHeartbeatAgeMs < 0 && alive === false ? SESSION_LOCK_STEAL_AFTER_MS : Math.max(0, rawHeartbeatAgeMs);
	const stale = heartbeatAgeMs >= SESSION_LOCK_STEAL_AFTER_MS && alive === false;
	const status: SessionLockStatus = stale
		? "stale"
		: heartbeatAgeMs >= SESSION_LOCK_SUSPECT_AFTER_MS
			? "suspect"
			: "live";
	return { lockPath, status, record, heartbeatAgeMs, processAlive: alive, stealable: stale };
}

/** Inspect a session sidecar without acquiring ownership. */
export function inspectSessionLock(sessionFile: string, options: SessionLockOptions = {}): SessionLockInspection {
	const normalized = normalizeSessionFile(sessionFile);
	const lockPath = lockPathFor(normalized);
	try {
		return inspectWithRuntime(normalized, runtime(options));
	} catch (error) {
		if (error instanceof SessionLockError) throw error;
		throw ioError(normalized, lockPath, error);
	}
}

function sameOwner(a: SessionLockRecord, b: SessionLockRecord): boolean {
	return (
		a.protocolVersion === b.protocolVersion &&
		a.ownerId === b.ownerId &&
		a.pid === b.pid &&
		a.processStartMarker === b.processStartMarker &&
		a.hostname === b.hostname &&
		a.sessionFile === b.sessionFile
	);
}

function serializedRecord(record: SessionLockRecord): Buffer {
	const data = Buffer.from(JSON.stringify(record), "utf8");
	if (data.byteLength > MAX_LOCK_BYTES) throw new Error("Session lock record exceeds size limit");
	return data;
}

function writeFullyAndSync(fd: number, data: Buffer): void {
	let offset = 0;
	while (offset < data.byteLength) {
		const written = fs.writeSync(fd, data, offset, data.byteLength - offset);
		if (written === 0) throw new Error("Session lock write made no progress");
		offset += written;
	}
	fs.fsyncSync(fd);
}

function writeExclusive(lockPath: string, record: SessionLockRecord): boolean {
	const tempPath = `${lockPath}.${record.ownerId}.tmp`;
	let fd: number | undefined;
	try {
		fd = fs.openSync(tempPath, "wx", 0o600);
		writeFullyAndSync(fd, serializedRecord(record));
		fs.closeSync(fd);
		fd = undefined;
		try {
			fs.linkSync(tempPath, lockPath);
			return true;
		} catch (error) {
			if (errorCode(error) === "EEXIST") return false;
			throw error;
		}
	} finally {
		if (fd !== undefined) fs.closeSync(fd);
		try {
			fs.unlinkSync(tempPath);
		} catch {
			// The temp was already cleaned or is an orphan left by a killed writer.
		}
	}
}

function writeClaim(claimPath: string, claim: SessionLockClaim): boolean {
	const tempPath = `${claimPath}.${claim.ownerId}.tmp`;
	let fd: number | undefined;
	try {
		fd = fs.openSync(tempPath, "wx", 0o600);
		const data = Buffer.from(JSON.stringify(claim), "utf8");
		if (data.byteLength > MAX_LOCK_BYTES) throw new Error("Session lock claim exceeds size limit");
		writeFullyAndSync(fd, data);
		fs.closeSync(fd);
		fd = undefined;
		try {
			fs.linkSync(tempPath, claimPath);
			return true;
		} catch (error) {
			if (errorCode(error) === "EEXIST") return false;
			throw error;
		}
	} finally {
		if (fd !== undefined) fs.closeSync(fd);
		try {
			fs.unlinkSync(tempPath);
		} catch {
			// The temp was already cleaned or is an orphan left by a killed writer.
		}
	}
}

function recoverableClaim(
	claimPath: string,
	sessionFile: string,
	rt: SessionLockRuntime,
): SessionLockClaim | undefined {
	try {
		const stat = fs.statSync(claimPath);
		if (!stat.isFile() || stat.size > MAX_LOCK_BYTES) return undefined;
		const claim = parseClaim(fs.readFileSync(claimPath, "utf8"), sessionFile);
		if (!claim || claim.hostname !== rt.hostname) return undefined;
		const alive = processAlive(claim, rt);
		const ageMs = rt.now() - claim.createdAt;
		if (alive !== false || (ageMs >= 0 && ageMs < SESSION_LOCK_STEAL_AFTER_MS)) return undefined;
		return claim;
	} catch {
		return undefined;
	}
}

function recoverClaim(claimPath: string, sessionFile: string, rt: SessionLockRuntime): void {
	const claim = recoverableClaim(claimPath, sessionFile, rt);
	if (claim) removeClaim(claimPath, sessionFile, claim.ownerId);
}

function removeClaim(claimPath: string, sessionFile: string, ownerId: string): boolean {
	try {
		const claim = parseClaim(fs.readFileSync(claimPath, "utf8"), sessionFile);
		if (!claim || claim.ownerId !== ownerId) return false;
		fs.unlinkSync(claimPath);
		return true;
	} catch (error) {
		if (errorCode(error) === "ENOENT") return false;
		throw error;
	}
}

function writeAtomic(lockPath: string, record: SessionLockRecord): void {
	const tempPath = `${lockPath}.${record.ownerId}.tmp`;
	let fd: number | undefined;
	try {
		fd = fs.openSync(tempPath, "wx", 0o600);
		writeFullyAndSync(fd, serializedRecord(record));
		fs.closeSync(fd);
		fd = undefined;
		fs.renameSync(tempPath, lockPath);
	} finally {
		if (fd !== undefined) fs.closeSync(fd);
		try {
			fs.unlinkSync(tempPath);
		} catch {
			// The rename already removed the temporary file.
		}
	}
}

function malformedError(sessionFile: string, inspection: SessionLockInspection): SessionLockError {
	return new SessionLockError(
		"malformed",
		`Session lock is malformed; refusing to overwrite ${inspection.lockPath}`,
		sessionFile,
		inspection.lockPath,
		inspection,
	);
}

function lockedError(sessionFile: string, inspection: SessionLockInspection): SessionLockError {
	return new SessionLockError(
		"locked",
		`Session is already writable by ${inspection.record?.ownerId ?? "another process"}`,
		sessionFile,
		inspection.lockPath,
		inspection,
	);
}

function ioError(sessionFile: string, lockPath: string, error: unknown): SessionLockError {
	return new SessionLockError(
		"io",
		`Session lock I/O failed for ${lockPath}`,
		sessionFile,
		lockPath,
		undefined,
		error,
	);
}

/**
 * Sidecar locks are keyed by path, so two hard links to one session would each
 * get their own lock and both writers would append to the same inode. Refuse
 * writable ownership instead; read-only snapshot loads are unaffected.
 */
function rejectHardLinkedSessionFile(sessionFile: string, lockPath: string): void {
	let links: number;
	try {
		links = fs.statSync(sessionFile).nlink;
	} catch (error) {
		if (errorCode(error) === "ENOENT") return;
		throw ioError(sessionFile, lockPath, error);
	}
	if (links <= 1) return;
	throw new SessionLockError(
		"unsupported",
		`Session file has ${links} hard links; a single writer cannot be guaranteed. Copy it to a new path to resume writing.`,
		sessionFile,
		lockPath,
	);
}

/** Acquire exclusive write ownership for a session until the returned handle is released. */
function acquirePathSessionLock(sessionFile: string, options: SessionLockOptions = {}): PathSessionLockHandle {
	const normalized = normalizeSessionFile(sessionFile);
	if (byteLength(normalized) > MAX_SESSION_PATH_BYTES) {
		throw new SessionLockError(
			"malformed",
			"Session path exceeds lock record limit",
			normalized,
			lockPathFor(normalized),
		);
	}
	const lockPath = lockPathFor(normalized);
	rejectHardLinkedSessionFile(normalized, lockPath);
	const rt = runtime(options);
	try {
		fs.mkdirSync(path.dirname(lockPath), { recursive: true });
	} catch (error) {
		throw ioError(normalized, lockPath, error);
	}
	const claim = (): SessionLockClaim => ({
		protocolVersion: SESSION_LOCK_PROTOCOL_VERSION,
		ownerId: rt.ownerId,
		pid: rt.pid,
		processStartMarker: rt.processStartMarker,
		hostname: rt.hostname,
		createdAt: rt.now(),
		sessionFile: normalized,
	});
	const timestamp = rt.now();
	const record: SessionLockRecord = {
		protocolVersion: SESSION_LOCK_PROTOCOL_VERSION,
		ownerId: rt.ownerId,
		pid: rt.pid,
		processStartMarker: rt.processStartMarker,
		hostname: rt.hostname,
		createdAt: timestamp,
		heartbeatAt: timestamp,
		sessionFile: normalized,
	};

	const claimPath = claimPathFor(lockPath);
	let acquired = false;
	let initialClaimed = false;
	let initialClaimRemovalError: SessionLockError | undefined;
	try {
		recoverClaim(claimPath, normalized, rt);
		initialClaimed = writeClaim(claimPath, claim());
		if (!initialClaimed) {
			throw new SessionLockError(
				"locked",
				"Session lock mutation is claimed by another owner",
				normalized,
				lockPath,
			);
		}
		acquired = writeExclusive(lockPath, record);
	} catch (error) {
		if (error instanceof SessionLockError) throw error;
		throw ioError(normalized, lockPath, error);
	} finally {
		if (initialClaimed) {
			try {
				removeClaim(claimPath, normalized, rt.ownerId);
			} catch (error) {
				initialClaimRemovalError = ioError(normalized, lockPath, error);
			}
		}
	}
	if (initialClaimRemovalError) {
		if (acquired) {
			try {
				const current = readRecord(lockPath, normalized);
				if (current.kind === "record" && sameOwner(current.record, record)) fs.unlinkSync(lockPath);
			} catch {
				// Preserve the claim-cleanup failure; lock inspection remains fail-closed.
			}
		}
		throw initialClaimRemovalError;
	}
	if (!acquired) {
		let inspection: SessionLockInspection;
		try {
			inspection = inspectWithRuntime(normalized, rt);
		} catch (error) {
			throw ioError(normalized, lockPath, error);
		}
		if (inspection.status === "malformed") throw malformedError(normalized, inspection);
		if (!inspection.stealable || !inspection.record) throw lockedError(normalized, inspection);

		let claimed = false;
		let claimRemovalError: SessionLockError | undefined;
		try {
			recoverClaim(claimPath, normalized, rt);
			claimed = writeClaim(claimPath, claim());
			if (!claimed) throw lockedError(normalized, inspection);
			const current = inspectWithRuntime(normalized, rt);
			if (current.status !== "stale" || !current.record || !sameOwner(current.record, inspection.record)) {
				throw lockedError(normalized, current);
			}
			writeAtomic(lockPath, record);
			acquired = true;
		} catch (error) {
			if (error instanceof SessionLockError) throw error;
			throw ioError(normalized, lockPath, error);
		} finally {
			if (claimed) {
				try {
					removeClaim(claimPath, normalized, rt.ownerId);
				} catch (error) {
					if (acquired) claimRemovalError = ioError(normalized, lockPath, error);
				}
			}
		}
		if (claimRemovalError) {
			try {
				const current = readRecord(lockPath, normalized);
				if (current.kind === "record" && sameOwner(current.record, record)) fs.unlinkSync(lockPath);
			} catch {
				// Preserve the claim-cleanup failure. A later inspection still fails
				// closed if the newly installed owner record could not be removed.
			}
			throw claimRemovalError;
		}
	}
	if (!acquired) throw lockedError(normalized, inspectWithRuntime(normalized, rt));

	let released = false;
	let timer: Timer | undefined;
	const heartbeat = (): void => {
		if (released) return;
		const claimPath = claimPathFor(lockPath);
		let claimed = false;
		let failure: SessionLockError | undefined;
		try {
			recoverClaim(claimPath, normalized, rt);
			claimed = writeClaim(claimPath, claim());
			if (!claimed) {
				const current = readRecord(lockPath, normalized);
				if (current.kind === "record" && sameOwner(current.record, record)) return;
				throw new SessionLockError(
					"not-owner",
					`Session lock ownership was lost for ${normalized}`,
					normalized,
					lockPath,
				);
			}
			const current = readRecord(lockPath, normalized);
			if (current.kind !== "record" || !sameOwner(current.record, record)) {
				throw new SessionLockError(
					"not-owner",
					`Session lock ownership was lost for ${normalized}`,
					normalized,
					lockPath,
				);
			}
			const next: SessionLockRecord = { ...record, heartbeatAt: rt.now() };
			writeAtomic(lockPath, next);
			record.heartbeatAt = next.heartbeatAt;
		} catch (error) {
			failure = error instanceof SessionLockError ? error : ioError(normalized, lockPath, error);
		}
		if (claimed) {
			try {
				removeClaim(claimPath, normalized, rt.ownerId);
			} catch (error) {
				failure ??= ioError(normalized, lockPath, error);
			}
		}
		if (failure) throw failure;
	};
	const reportHeartbeatError = (error: unknown): void => {
		const typed = error instanceof SessionLockError ? error : ioError(normalized, lockPath, error);
		clearInterval(timer);
		try {
			rt.onHeartbeatError?.(typed);
		} catch {
			// A diagnostic callback cannot keep a lost-lock timer alive.
		}
	};
	timer = setInterval(() => {
		try {
			heartbeat();
		} catch (error) {
			reportHeartbeatError(error);
		}
	}, rt.heartbeatIntervalMs);
	timer.unref?.();

	return {
		record,
		lockPath,
		heartbeat,
		release(): void {
			if (released) return;
			let current: LoadedRecord;
			try {
				current = readRecord(lockPath, normalized);
			} catch (error) {
				throw ioError(normalized, lockPath, error);
			}
			// Clear our mutation claim before removing the visible owner record.
			// If claim cleanup fails, retaining the owner keeps every observer
			// fail-closed and lets this handle retry release safely.
			try {
				removeClaim(claimPathFor(lockPath), normalized, rt.ownerId);
			} catch (error) {
				throw ioError(normalized, lockPath, error);
			}
			if (current.kind === "record" && sameOwner(current.record, record)) {
				try {
					fs.unlinkSync(lockPath);
				} catch (error) {
					if (errorCode(error) !== "ENOENT") throw ioError(normalized, lockPath, error);
				}
			}
			released = true;
			clearInterval(timer);
		},
		get released() {
			return released;
		},
	};
}

function fileIdentity(sessionFile: string): SessionFileIdentity | undefined {
	let stat: fs.Stats;
	try {
		stat = fs.statSync(sessionFile);
	} catch (error) {
		if (errorCode(error) === "ENOENT") return undefined;
		throw error;
	}
	return { dev: stat.dev, ino: stat.ino };
}

function identityLockTarget(identity: SessionFileIdentity): string {
	const uid = typeof process.getuid === "function" ? process.getuid() : "user";
	const identityDir = path.join(os.tmpdir(), `oh-my-pi-session-identities-${uid}`);
	fs.mkdirSync(identityDir, { recursive: true, mode: 0o700 });
	fs.chmodSync(identityDir, 0o700);
	return path.join(identityDir, `${identity.dev.toString(16)}-${identity.ino.toString(16)}.identity`);
}

/** Acquire exclusive write ownership for a session until the returned handle is released. */
export function acquireSessionLock(sessionFile: string, options: SessionLockOptions = {}): SessionLockHandle {
	const normalized = normalizeSessionFile(sessionFile);
	let ownedIdentity = fileIdentity(normalized);
	let identityHandle = ownedIdentity ? acquirePathSessionLock(identityLockTarget(ownedIdentity), options) : undefined;
	const supersededIdentityHandles = new Set<PathSessionLockHandle>();
	let pathHandle: PathSessionLockHandle;
	try {
		pathHandle = acquirePathSessionLock(normalized, options);
	} catch (error) {
		try {
			identityHandle?.release();
		} catch (releaseError) {
			throw new AggregateError(
				[error, releaseError],
				"Failed to acquire session path lock and release identity lock",
			);
		}
		throw error;
	}
	const lockedIdentity = fileIdentity(normalized);
	if (
		(ownedIdentity === undefined) !== (lockedIdentity === undefined) ||
		(ownedIdentity !== undefined &&
			lockedIdentity !== undefined &&
			(ownedIdentity.dev !== lockedIdentity.dev || ownedIdentity.ino !== lockedIdentity.ino))
	) {
		let releaseError: unknown;
		try {
			pathHandle.release();
		} catch (error) {
			releaseError = error;
		}
		try {
			identityHandle?.release();
		} catch (error) {
			if (releaseError) {
				throw new AggregateError([releaseError, error], "Session file changed while releasing acquisition locks");
			}
			throw error;
		}
		if (releaseError) throw releaseError;
		throw new SessionLockError(
			"locked",
			`Session file changed while acquiring writable ownership: ${normalized}`,
			normalized,
			pathHandle.lockPath,
		);
	}
	const sessionLock: SessionLockHandle = {
		record: pathHandle.record,
		lockPath: pathHandle.lockPath,
		get fileIdentity() {
			return ownedIdentity;
		},
		prepareFileIdentity(filePath: string): SessionFileIdentityClaim {
			const nextIdentity = fileIdentity(filePath);
			if (!nextIdentity) throw new Error(`Cannot claim missing session file identity: ${filePath}`);
			if (ownedIdentity && nextIdentity.dev === ownedIdentity.dev && nextIdentity.ino === ownedIdentity.ino) {
				return { identity: nextIdentity, commit() {}, rollback() {} };
			}
			const nextHandle = acquirePathSessionLock(identityLockTarget(nextIdentity), options);
			let settled = false;
			return {
				identity: nextIdentity,
				commit(): void {
					if (settled) return;
					settled = true;
					const previous = identityHandle;
					identityHandle = nextHandle;
					ownedIdentity = nextIdentity;
					if (previous) {
						try {
							previous.release();
						} catch {
							supersededIdentityHandles.add(previous);
						}
					}
				},
				rollback(): void {
					if (settled) return;
					settled = true;
					nextHandle.release();
				},
			};
		},
		transferFileIdentityTo(target: SessionLockHandle, filePath: string): void {
			const nextIdentity = fileIdentity(filePath);
			if (!nextIdentity) throw new Error(`Cannot transfer missing session file identity: ${filePath}`);
			if (
				!ownedIdentity ||
				ownedIdentity.dev !== nextIdentity.dev ||
				ownedIdentity.ino !== nextIdentity.ino ||
				!identityHandle
			) {
				throw new Error(`Cannot transfer unowned session file identity: ${filePath}`);
			}
			const receive = sessionLockIdentityReceivers.get(target);
			if (!receive) throw new Error("Cannot transfer session file identity to an unknown lock");
			const transferred = identityHandle;
			identityHandle = undefined;
			ownedIdentity = undefined;
			receive(nextIdentity, transferred);
		},
		heartbeat(): void {
			identityHandle?.heartbeat();
			pathHandle.heartbeat();
		},
		release(): void {
			let pathError: unknown;
			try {
				pathHandle.release();
			} catch (error) {
				pathError = error;
			}
			try {
				identityHandle?.release();
				for (const handle of supersededIdentityHandles) {
					handle.release();
					supersededIdentityHandles.delete(handle);
				}
			} catch (identityError) {
				if (pathError) {
					throw new AggregateError([pathError, identityError], "Failed to release session locks");
				}
				throw identityError;
			}
			if (pathError) throw pathError;
		},
		get released() {
			return (
				pathHandle.released &&
				(identityHandle?.released ?? true) &&
				Array.from(supersededIdentityHandles).every(handle => handle.released)
			);
		},
	};
	sessionLockIdentityReceivers.set(sessionLock, (identity, handle) => {
		const previous = identityHandle;
		identityHandle = handle;
		ownedIdentity = identity;
		if (previous) supersededIdentityHandles.add(previous);
	});
	return sessionLock;
}

/** Return the canonical sidecar lock path for a session file. */
export function lockPathForSession(sessionFile: string): string {
	return lockPathFor(sessionFile);
}
