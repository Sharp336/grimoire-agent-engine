import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AdvisoryLock, Process as NativeProcess } from "@oh-my-pi/pi-natives";

export const SESSION_LOCK_PROTOCOL_VERSION = 1;
export const SESSION_LOCK_HEARTBEAT_MS = 5_000;
export const SESSION_LOCK_SUSPECT_AFTER_MS = 15_000;
export const SESSION_LOCK_STEAL_AFTER_MS = 20_000;
const MAX_LOCK_BYTES = 16 * 1024;
const MAX_OWNER_ID_BYTES = 64;
const MAX_MARKER_BYTES = 256;
const MAX_HOSTNAME_BYTES = 255;
const MAX_SESSION_PATH_BYTES = 4 * 1024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
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

export type SessionLockStatus = "missing" | "live" | "suspect" | "stale" | "malformed";
export type SessionLockErrorCode = "locked" | "malformed" | "not-owner" | "io";

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

export interface SessionLockProcessProbe {
	isAlive(pid: number, processStartMarker: string): boolean | "unknown";
	processStartMarker(pid: number): string | null;
}

export interface SessionLockOptions {
	/** Enable a filesystem lock when used by SessionManager with custom storage. */
	enabled?: boolean;
	now?: () => number;
	ownerId?: string;
	pid?: number;
	hostname?: string;
	processStartMarker?: string;
	processProbe?: SessionLockProcessProbe;
	heartbeatIntervalMs?: number;
	onHeartbeatError?: (error: SessionLockError) => void;
}

export interface SessionLockInspection {
	lockPath: string;
	status: SessionLockStatus;
	record?: SessionLockRecord;
	heartbeatAgeMs?: number;
	processAlive?: boolean | "unknown";
	stealable: boolean;
}

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

export interface SessionLockHandle {
	readonly record: SessionLockRecord;
	readonly lockPath: string;
	heartbeat(): void;
	release(): void;
	readonly released: boolean;
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

function fallbackProcessStartMarker(pid: number): string | null {
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
			return startTime ? `fallback-linux-proc:${startTime}` : null;
		} catch {
			return null;
		}
	}

	if (process.platform === "darwin") {
		try {
			const result = Bun.spawnSync(["ps", "-p", String(pid), "-o", "lstart="], {
				stdin: "ignore",
				stdout: "pipe",
				stderr: "ignore",
			});
			if (result.exitCode !== 0) return null;
			const value = new TextDecoder().decode(result.stdout).trim();
			return value ? `fallback-darwin-ps:${value}` : null;
		} catch {
			return null;
		}
	}

	return null;
}

function markerSource(marker: string): string | null {
	const separator = marker.indexOf(":");
	return separator > 0 ? marker.slice(0, separator) : null;
}

function compareProcessStartMarkers(recorded: string, observed: string): boolean | "unknown" {
	const recordedSource = markerSource(recorded);
	const observedSource = markerSource(observed);
	if (!recordedSource || !observedSource || recordedSource !== observedSource) return "unknown";
	return recorded === observed;
}

function pidExists(pid: number): boolean | "unknown" {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return errorCode(error) === "ESRCH" ? false : "unknown";
	}
}

function defaultProcessStartMarker(pid: number): string | null {
	try {
		const nativeProcess = NativeProcess.fromPid(pid);
		if (nativeProcess?.startMarker) return nativeProcess.startMarker;
	} catch {
		// Fall through to the platform probe. Observation failures must not make
		// session ownership look stale, but they also must not prevent this process
		// from publishing a compatible marker when the fallback is available.
	}
	return fallbackProcessStartMarker(pid);
}

const defaultProcessProbe: SessionLockProcessProbe = {
	processStartMarker: defaultProcessStartMarker,
	isAlive(pid, processStartMarker) {
		const exists = pidExists(pid);
		if (exists === false) return false;
		try {
			const nativeProcess = NativeProcess.fromPid(pid);
			if (nativeProcess) {
				const compared = compareProcessStartMarkers(processStartMarker, nativeProcess.startMarker);
				if (compared !== "unknown") return compared;
			}
		} catch {
			// Native process observation can transiently fail on macOS. A live PID
			// remains non-stealable unless a compatible marker proves reuse.
		}
		const currentMarker = fallbackProcessStartMarker(pid);
		if (currentMarker !== null) {
			const compared = compareProcessStartMarkers(processStartMarker, currentMarker);
			if (compared !== "unknown") return compared;
		}
		return exists === true ? "unknown" : exists;
	},
};

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

function guardPathFor(lockPath: string): string {
	return `${lockPath}.guard`;
}

function runtime(options: SessionLockOptions): SessionLockRuntime {
	const pid = options.pid ?? process.pid;
	const processProbe = options.processProbe ?? defaultProcessProbe;
	const processStartMarker = options.processStartMarker ?? processProbe.processStartMarker(pid);
	if (!processStartMarker) throw new Error(`Unable to determine process start marker for pid ${pid}`);
	const ownerId = options.ownerId ?? randomUUID();
	if (!UUID_PATTERN.test(ownerId)) throw new Error("Session lock ownerId must be a UUID");
	const hostname = options.hostname ?? os.hostname();
	if (!hostname || byteLength(hostname) > MAX_HOSTNAME_BYTES) throw new Error("Session lock hostname is invalid");
	if (!Number.isInteger(pid) || pid <= 0) throw new Error("Session lock pid is invalid");
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

interface FileSnapshot {
	stat: fs.BigIntStats;
	data: Buffer;
}

type LoadedRecord =
	| { kind: "missing" }
	| { kind: "malformed"; snapshot?: FileSnapshot }
	| { kind: "record"; record: SessionLockRecord };

interface InspectedLock {
	inspection: SessionLockInspection;
	loaded: LoadedRecord;
}

function sameFileIdentity(a: fs.BigIntStats, b: fs.BigIntStats): boolean {
	return (
		a.dev === b.dev &&
		a.ino === b.ino &&
		a.mode === b.mode &&
		a.size === b.size &&
		a.mtimeNs === b.mtimeNs &&
		a.ctimeNs === b.ctimeNs
	);
}

function sameFileSnapshot(a: FileSnapshot, b: FileSnapshot): boolean {
	return sameFileIdentity(a.stat, b.stat) && a.data.equals(b.data);
}

function snapshotAgeMs(snapshot: FileSnapshot, now: number): number {
	const modifiedAtMs = Number(snapshot.stat.mtimeNs / 1_000_000n);
	return Math.max(0, now - modifiedAtMs);
}

type LoadedFile = { kind: "missing" } | { kind: "malformed" } | { kind: "snapshot"; snapshot: FileSnapshot };

function readFileSnapshot(filePath: string): LoadedFile {
	let fd: number | undefined;
	try {
		fd = fs.openSync(filePath, fs.constants.O_RDONLY);
	} catch (error) {
		if (errorCode(error) === "ENOENT") return { kind: "missing" };
		throw error;
	}
	try {
		const before = fs.fstatSync(fd, { bigint: true });
		if (!before.isFile() || before.size > BigInt(MAX_LOCK_BYTES)) return { kind: "malformed" };
		const data = fs.readFileSync(fd);
		const after = fs.fstatSync(fd, { bigint: true });
		let current: fs.BigIntStats;
		try {
			current = fs.lstatSync(filePath, { bigint: true });
		} catch (error) {
			if (errorCode(error) === "ENOENT") return { kind: "missing" };
			throw error;
		}
		if (
			!current.isFile() ||
			!sameFileIdentity(before, after) ||
			!sameFileIdentity(after, current) ||
			BigInt(data.byteLength) !== after.size
		) {
			return { kind: "malformed" };
		}
		return { kind: "snapshot", snapshot: { stat: after, data } };
	} catch (error) {
		if (errorCode(error) === "ENOENT") return { kind: "missing" };
		throw error;
	} finally {
		if (fd !== undefined) fs.closeSync(fd);
	}
}

function readRecord(lockPath: string, expectedSessionFile: string): LoadedRecord {
	const loaded = readFileSnapshot(lockPath);
	if (loaded.kind !== "snapshot") return loaded;
	const record = parseRecord(loaded.snapshot.data.toString("utf8"), expectedSessionFile);
	return record ? { kind: "record", record } : { kind: "malformed", snapshot: loaded.snapshot };
}

function processAlive(record: SessionLockRecord, rt: SessionLockRuntime): boolean | "unknown" {
	if (record.hostname !== rt.hostname) return "unknown";
	try {
		return rt.processProbe.isAlive(record.pid, record.processStartMarker);
	} catch {
		return "unknown";
	}
}

function inspectStateWithRuntime(sessionFile: string, rt: SessionLockRuntime): InspectedLock {
	const normalized = normalizeSessionFile(sessionFile);
	const lockPath = lockPathFor(normalized);
	const loaded = readRecord(lockPath, normalized);
	if (loaded.kind === "missing") {
		return { loaded, inspection: { lockPath, status: "missing", stealable: false } };
	}
	if (loaded.kind === "malformed") {
		const heartbeatAgeMs = loaded.snapshot ? snapshotAgeMs(loaded.snapshot, rt.now()) : undefined;
		return {
			loaded,
			inspection: {
				lockPath,
				status: "malformed",
				heartbeatAgeMs,
				stealable: heartbeatAgeMs !== undefined && heartbeatAgeMs >= SESSION_LOCK_STEAL_AFTER_MS,
			},
		};
	}
	const record = loaded.record;
	const heartbeatAgeMs = Math.max(0, rt.now() - record.heartbeatAt);
	const alive = processAlive(record, rt);
	const stale = heartbeatAgeMs >= SESSION_LOCK_STEAL_AFTER_MS && alive === false;
	const status: SessionLockStatus = stale
		? "stale"
		: heartbeatAgeMs >= SESSION_LOCK_SUSPECT_AFTER_MS
			? "suspect"
			: "live";
	return {
		loaded,
		inspection: { lockPath, status, record, heartbeatAgeMs, processAlive: alive, stealable: stale },
	};
}

function inspectWithRuntime(sessionFile: string, rt: SessionLockRuntime): SessionLockInspection {
	return inspectStateWithRuntime(sessionFile, rt).inspection;
}

export function inspectSessionLock(sessionFile: string, options: SessionLockOptions = {}): SessionLockInspection {
	const normalized = normalizeSessionFile(sessionFile);
	const lockPath = lockPathFor(normalized);
	try {
		const rt = runtime(options);
		return withSessionGuard(normalized, lockPath, () => inspectWithRuntime(normalized, rt));
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

function writeFully(fd: number, data: Buffer): void {
	let offset = 0;
	while (offset < data.length) {
		const written = fs.writeSync(fd, data, offset, data.length - offset);
		if (written <= 0) throw new Error("Session lock write made no progress");
		offset += written;
	}
}

function writeExclusive(lockPath: string, record: SessionLockRecord): boolean {
	let fd: number | undefined;
	try {
		fd = fs.openSync(lockPath, "wx", 0o600);
		const data = serializedRecord(record);
		writeFully(fd, data);
		fs.fsyncSync(fd);
		return true;
	} catch (error) {
		if (errorCode(error) === "EEXIST") return false;
		throw error;
	} finally {
		if (fd !== undefined) fs.closeSync(fd);
	}
}

function writeAtomic(lockPath: string, record: SessionLockRecord): void {
	const tempPath = `${lockPath}.${record.ownerId}.tmp`;
	let fd: number | undefined;
	try {
		fd = fs.openSync(tempPath, "wx", 0o600);
		const data = serializedRecord(record);
		writeFully(fd, data);
		fs.fsyncSync(fd);
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

function guardBusyError(sessionFile: string, lockPath: string): SessionLockError {
	return new SessionLockError("locked", `Session lock guard is busy for ${sessionFile}`, sessionFile, lockPath);
}

function tryAcquireGuard(sessionFile: string, lockPath: string): AdvisoryLock | null {
	try {
		return AdvisoryLock.tryAcquire(guardPathFor(lockPath));
	} catch (error) {
		throw ioError(sessionFile, lockPath, error);
	}
}

function withSessionGuard<T>(sessionFile: string, lockPath: string, action: () => T): T {
	const guard = tryAcquireGuard(sessionFile, lockPath);
	if (!guard) throw guardBusyError(sessionFile, lockPath);
	let result!: T;
	let actionFailed = false;
	let failure: unknown;
	try {
		result = action();
	} catch (error) {
		actionFailed = true;
		failure = error;
	}
	try {
		guard.release();
	} catch (error) {
		if (!actionFailed) {
			actionFailed = true;
			failure = ioError(sessionFile, lockPath, error);
		}
	}
	if (actionFailed) throw failure;
	return result;
}

export function acquireSessionLock(sessionFile: string, options: SessionLockOptions = {}): SessionLockHandle {
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
	const rt = runtime(options);
	try {
		fs.mkdirSync(path.dirname(lockPath), { recursive: true });
	} catch (error) {
		throw ioError(normalized, lockPath, error);
	}
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

	withSessionGuard(normalized, lockPath, () => {
		let initial: InspectedLock;
		try {
			initial = inspectStateWithRuntime(normalized, rt);
		} catch (error) {
			throw ioError(normalized, lockPath, error);
		}
		if (initial.loaded.kind === "missing") {
			try {
				if (writeExclusive(lockPath, record)) return;
			} catch (error) {
				throw ioError(normalized, lockPath, error);
			}
			const current = inspectWithRuntime(normalized, rt);
			throw current.status === "malformed" ? malformedError(normalized, current) : lockedError(normalized, current);
		}

		const { inspection } = initial;
		const malformedSnapshot = initial.loaded.kind === "malformed" ? initial.loaded.snapshot : undefined;
		if (inspection.status === "malformed" && (!inspection.stealable || !malformedSnapshot)) {
			throw malformedError(normalized, inspection);
		}
		if (inspection.status !== "malformed" && (!inspection.stealable || !inspection.record)) {
			throw lockedError(normalized, inspection);
		}

		// The kernel guard serializes cooperating contenders. Re-read immediately
		// before replacement as a fail-closed check against direct filesystem
		// writers that do not participate in the advisory lock protocol.
		const current = inspectStateWithRuntime(normalized, rt);
		if (malformedSnapshot) {
			if (
				current.loaded.kind !== "malformed" ||
				!current.loaded.snapshot ||
				!sameFileSnapshot(current.loaded.snapshot, malformedSnapshot) ||
				!current.inspection.stealable
			) {
				throw malformedError(normalized, current.inspection);
			}
		} else if (
			current.inspection.status !== "stale" ||
			!current.inspection.record ||
			!inspection.record ||
			!sameOwner(current.inspection.record, inspection.record)
		) {
			throw lockedError(normalized, current.inspection);
		}
		try {
			writeAtomic(lockPath, record);
		} catch (error) {
			throw ioError(normalized, lockPath, error);
		}
	});

	let released = false;
	let timer: Timer | undefined;
	const heartbeat = (): void => {
		if (released) return;
		const guard = tryAcquireGuard(normalized, lockPath);
		// Another short mutation already holds the guard. Skipping one tick is
		// safer than treating transient contention as ownership loss; the next
		// interval retries normally.
		if (!guard) return;
		let failed = false;
		let failure: unknown;
		try {
			const current = inspectWithRuntime(normalized, rt);
			if (current.status === "malformed" || !current.record || !sameOwner(current.record, record)) {
				throw new SessionLockError(
					"not-owner",
					`Session lock ownership was lost for ${normalized}`,
					normalized,
					lockPath,
					current,
				);
			}
			const next: SessionLockRecord = { ...record, heartbeatAt: rt.now() };
			writeAtomic(lockPath, next);
			record.heartbeatAt = next.heartbeatAt;
		} catch (error) {
			failed = true;
			failure = error instanceof SessionLockError ? error : ioError(normalized, lockPath, error);
		} finally {
			guard.release();
		}
		if (failed) throw failure;
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
			withSessionGuard(normalized, lockPath, () => {
				let current: LoadedRecord;
				try {
					current = readRecord(lockPath, normalized);
				} catch (error) {
					throw ioError(normalized, lockPath, error);
				}
				if (current.kind !== "record" || !sameOwner(current.record, record)) return;
				try {
					fs.unlinkSync(lockPath);
				} catch (error) {
					if (errorCode(error) !== "ENOENT") throw ioError(normalized, lockPath, error);
				}
			});
			released = true;
			clearInterval(timer);
		},
		get released() {
			return released;
		},
	};
}

/**
 * Remove the lock left by one appserver-owned child only after that exact PID
 * and process-start marker are proven dead. Fresh heartbeats do not delay this
 * path because the caller has already awaited the child process's exit.
 */
export function reclaimSessionLockAfterProcessExit(
	sessionFile: string,
	expectedPid: number,
	options: SessionLockOptions = {},
): boolean {
	const normalized = normalizeSessionFile(sessionFile);
	const lockPath = lockPathFor(normalized);
	if (!Number.isSafeInteger(expectedPid) || expectedPid <= 0)
		throw new SessionLockError("malformed", "Exited child pid is invalid", normalized, lockPath);
	const rt = runtime(options);
	try {
		return withSessionGuard(normalized, lockPath, () => {
			const initial = inspectStateWithRuntime(normalized, rt);
			if (initial.loaded.kind === "missing") return false;
			if (initial.loaded.kind !== "record" || !initial.inspection.record)
				throw malformedError(normalized, initial.inspection);
			if (initial.inspection.record.pid !== expectedPid) return false;
			if (initial.inspection.processAlive !== false) throw lockedError(normalized, initial.inspection);

			// Cooperating writers are serialized by the guard. Re-read before unlink
			// so a changed owner is never removed on stale evidence.
			const current = inspectStateWithRuntime(normalized, rt);
			if (
				current.loaded.kind !== "record" ||
				!current.inspection.record ||
				!sameOwner(current.inspection.record, initial.inspection.record) ||
				current.inspection.processAlive !== false
			)
				throw lockedError(normalized, current.inspection);
			try {
				fs.unlinkSync(lockPath);
			} catch (error) {
				if (errorCode(error) !== "ENOENT") throw ioError(normalized, lockPath, error);
			}
			return true;
		});
	} catch (error) {
		if (error instanceof SessionLockError) throw error;
		throw ioError(normalized, lockPath, error);
	}
}

export function lockPathForSession(sessionFile: string): string {
	return lockPathFor(sessionFile);
}
export function guardPathForSession(sessionFile: string): string {
	return guardPathFor(lockPathFor(sessionFile));
}
export const __internalsForTesting = {
	parseRecord,
	readRecord,
	defaultProcessStartMarker,
	defaultProcessProbe,
	compareProcessStartMarkers,
};
