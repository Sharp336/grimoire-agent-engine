import { createHash, randomUUID } from "node:crypto";
import type { Dir, Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getBlobsDir, withFileLock } from "@oh-my-pi/pi-utils";
import { blobExtensionForImageMimeType } from "../../session/blob-store";
import { persistConvertedSession } from "../../session/foreign-session-import";
import type { PrimeSessionProvenance } from "../../session/foreign-session-store";
import type { SessionEntry } from "../../session/session-entries";
import { visitEntriesFromFileStream } from "../../session/session-loader";
import { SessionManager } from "../../session/session-manager";
import { revalidatePrimeSource } from "./source";
import type {
	PrimeImportLoss,
	PrimeImportLossCode,
	PrimeNormalizedSession,
	PrimeNormalizedSessionEntry,
	PrimeRollbackManifestEntry,
	PrimeSessionContent,
	PrimeSessionContentBlock,
	PrimeSessionMessage,
	PrimeSourceFile,
	PrimeSourceSnapshot,
} from "./types";

export type { PrimeRollbackManifestEntry } from "./types";

const SCHEMA_VERSION = 1 as const;
const HASH_RE = /^[a-f0-9]{64}$/;
const compare = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);
const sha256 = (value: Uint8Array): string => createHash("sha256").update(value).digest("hex");
const isRecord = (value: unknown): value is Record<string, unknown> =>
	value !== null && typeof value === "object" && !Array.isArray(value);
class PrimeOperationalError extends Error {}
const inRoot = (root: string, candidate: string): boolean => {
	const relative = path.relative(path.resolve(root), path.resolve(candidate));
	return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
};
const loss = (
	code: PrimeImportLossCode,
	sourceRef: string,
	domain: PrimeImportLoss["domain"],
	target?: string,
): PrimeImportLoss => ({ code, domain, sourceRef, ...(target ? { path: target } : {}) });

export interface PrimeSessionApplyInput {
	readonly snapshot: PrimeSourceSnapshot;
	readonly sessions: readonly PrimeNormalizedSession[];
	readonly sourceFiles: readonly PrimeSourceFile[];
	readonly losses?: readonly PrimeImportLoss[];
}

export interface PrimeSessionApplyOptions {
	readonly destinationCwd?: string;
	readonly sessionDir?: string;
	readonly blobDir?: string;
	readonly rollbackManifestPath?: string;
	readonly initialRollbackEntries?: readonly PrimeRollbackManifestEntry[];
	readonly validateDestinationRollbackEntry?: (entry: PrimeRollbackManifestEntry) => boolean | Promise<boolean>;
}

export interface PrimeSessionApplyItem {
	readonly itemId: string;
	readonly kind: "sessions";
	readonly sourceRefs: readonly string[];
	readonly outcome: "imported" | "skipped" | "lost";
	readonly destinationRef?: string;
	readonly lossCodes?: readonly PrimeImportLossCode[];
}

export interface PrimeSessionRollbackManifest {
	readonly schemaVersion: typeof SCHEMA_VERSION;
	readonly snapshotId: string;
	readonly source: {
		readonly sourceRoot: string;
		readonly sessionRoot: string;
		readonly cwd: string;
	};
	readonly destination: {
		readonly cwd: string;
		readonly sessionDir: string;
		readonly blobDir: string;
	};
	readonly entries: readonly PrimeRollbackManifestEntry[];
}

export interface PrimeSessionApplyReport {
	readonly schemaVersion: typeof SCHEMA_VERSION;
	readonly snapshotId: string;
	readonly items: readonly PrimeSessionApplyItem[];
	readonly losses: readonly PrimeImportLoss[];
	readonly partialApply: boolean;
	readonly rollbackManifest?: PrimeSessionRollbackManifest & { readonly path: string };
}

export type PrimeRollbackManifest = PrimeSessionRollbackManifest;

interface ImageCandidate {
	readonly hash: string;
	readonly bytes: Buffer;
	readonly mimeType: string;
}
interface ValidatedSession {
	readonly session: PrimeNormalizedSession;
	readonly sourceFile: PrimeSourceFile;
	readonly images: readonly ImageCandidate[];
	readonly itemId: string;
}
interface NodeDigest {
	readonly exists: boolean;
	readonly digest?: string;
	readonly regular: boolean;
	readonly identity?: NodeIdentity;
}
interface NodeIdentity {
	readonly dev: number;
	readonly ino: number;
}

function sortLosses(values: readonly PrimeImportLoss[]): PrimeImportLoss[] {
	return [...values].sort((left, right) =>
		compare(
			`${left.sourceRef}\u0000${left.path ?? ""}\u0000${left.line ?? 0}\u0000${left.code}`,
			`${right.sourceRef}\u0000${right.path ?? ""}\u0000${right.line ?? 0}\u0000${right.code}`,
		),
	);
}
function sortItems(values: readonly PrimeSessionApplyItem[]): PrimeSessionApplyItem[] {
	return [...values].sort((left, right) =>
		compare(`${left.kind}\u0000${left.itemId}`, `${right.kind}\u0000${right.itemId}`),
	);
}
function uniqueLosses(values: readonly PrimeImportLoss[]): PrimeImportLoss[] {
	const seen = new Set<string>();
	return sortLosses(values).filter(value => {
		const key = JSON.stringify(value);
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}
function strictBase64(value: string): Buffer | undefined {
	if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return undefined;
	const bytes = Buffer.from(value, "base64");
	return bytes.toString("base64") === value ? bytes : undefined;
}
function imageCandidates(value: unknown, out: ImageCandidate[]): boolean {
	if (Array.isArray(value)) return value.every(item => imageCandidates(item, out));
	if (!isRecord(value)) return true;
	if (value.type === "image") {
		if (typeof value.data !== "string" || typeof value.mimeType !== "string") return false;
		const bytes = strictBase64(value.data);
		if (!bytes) return false;
		out.push({ hash: sha256(bytes), bytes, mimeType: value.mimeType });
		return true;
	}
	return Object.values(value).every(item => imageCandidates(item, out));
}
function replaceImages(value: unknown, refs: ReadonlyMap<string, string>): unknown {
	if (Array.isArray(value)) return value.map(item => replaceImages(item, refs));
	if (!isRecord(value)) return value;
	if (value.type === "image" && typeof value.data === "string") {
		const bytes = strictBase64(value.data);
		return bytes ? { ...value, data: refs.get(sha256(bytes)) ?? value.data } : value;
	}
	return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replaceImages(item, refs)]));
}
function validateReferencedArtifact(
	value: unknown,
	sourceFiles: ReadonlyMap<string, PrimeSourceFile>,
	snapshot: PrimeSourceSnapshot,
	losses: PrimeImportLoss[],
): boolean {
	if (Array.isArray(value))
		return value.every(item => validateReferencedArtifact(item, sourceFiles, snapshot, losses));
	if (!isRecord(value)) return true;
	if (typeof value.fullOutputSourceRef === "string") {
		const sourceRef = value.fullOutputSourceRef;
		const file = sourceFiles.get(sourceRef);
		if (!file) {
			losses.push(loss("source-missing", sourceRef, "artifacts"));
			return false;
		}
		const sourceLoss = validateSourceFile(snapshot, file);
		if (sourceLoss || (typeof value.fullOutputSha256 === "string" && file.sha256 !== value.fullOutputSha256)) {
			losses.push(sourceLoss ?? loss("source-drift", sourceRef, "artifacts", file.canonicalPath));
			return false;
		}
	}
	return Object.values(value).every(item => validateReferencedArtifact(item, sourceFiles, snapshot, losses));
}
function replaceMessageImages(message: PrimeSessionMessage, refs: ReadonlyMap<string, string>): PrimeSessionMessage {
	if (message.role === "user" || message.role === "toolResult" || message.role === "custom")
		return {
			...message,
			content: replaceImages(message.content, refs) as PrimeSessionContent,
		} as PrimeSessionMessage;
	if (message.role === "assistant")
		return { ...message, content: replaceImages(message.content, refs) as readonly PrimeSessionContentBlock[] };
	return message;
}
function toSessionEntry(entry: PrimeNormalizedSessionEntry, refs: ReadonlyMap<string, string>): SessionEntry {
	if (entry.type === "message")
		return { ...entry, message: replaceMessageImages(entry.message, refs) } as unknown as SessionEntry;
	return entry as unknown as SessionEntry;
}
function sourceBytes(file: PrimeSourceFile): Buffer | undefined {
	const bytes = Buffer.from(file.contentBase64, "base64");
	return bytes.length === file.size && sha256(bytes) === file.sha256 ? bytes : undefined;
}
function validateSourceFile(snapshot: PrimeSourceSnapshot, file: PrimeSourceFile): PrimeImportLoss | undefined {
	const allowedRoots =
		file.domain === "sessions" || file.domain === "artifacts"
			? [
					snapshot.sourceRoot,
					snapshot.sessionRoot,
					...(file.domain === "artifacts"
						? [path.join(path.dirname(snapshot.sessionRoot), "session-artifacts")]
						: []),
				]
			: [snapshot.sourceRoot];
	if (!allowedRoots.some(root => inRoot(root, file.canonicalPath)))
		return loss("source-path-escape", file.sourceRef, file.domain, file.canonicalPath);
	if (!sourceBytes(file)) return loss("source-drift", file.sourceRef, file.domain, file.canonicalPath);
	const metadata = snapshot.files.find(candidate => candidate.sourceRef === file.sourceRef);
	if (
		!metadata ||
		metadata.kind !== file.kind ||
		metadata.domain !== file.domain ||
		metadata.sha256 !== file.sha256 ||
		metadata.size !== file.size ||
		metadata.canonicalPath !== file.canonicalPath ||
		metadata.mode !== file.mode ||
		metadata.mtimeMs !== file.mtimeMs
	)
		return loss("source-drift", file.sourceRef, file.domain, file.canonicalPath);
	return undefined;
}
function operational(error: unknown): boolean {
	if (!isRecord(error) || typeof error.code !== "string") return false;
	return [
		"ENOENT",
		"EEXIST",
		"EACCES",
		"EPERM",
		"ENOTDIR",
		"ELOOP",
		"EISDIR",
		"ENOSPC",
		"EMFILE",
		"ENFILE",
		"EIO",
	].includes(error.code);
}
export function canonicalPrimeImportOsPath(candidate: string, platform = process.platform): string {
	const resolved = path.resolve(candidate);
	if (platform === "darwin" && (resolved === "/var" || resolved.startsWith("/var/"))) return `/private${resolved}`;
	if (platform === "darwin" && (resolved === "/tmp" || resolved.startsWith("/tmp/"))) return `/private${resolved}`;
	return resolved;
}
async function openNode(candidate: string): Promise<fs.FileHandle> {
	return fs.open(
		canonicalPrimeImportOsPath(candidate),
		fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
	);
}
function ownedAnchor(stat: Stats): boolean {
	const uid = process.getuid?.();
	return uid === undefined || (stat.uid === uid && (stat.mode & 0o022) === 0);
}
async function safePath(candidate: string): Promise<boolean> {
	const resolved = canonicalPrimeImportOsPath(candidate);
	const root = path.parse(resolved).root;
	const relative = path.relative(root, resolved);
	let current = root;
	let anchor: Stats | undefined;
	for (const part of relative.split(path.sep).filter(Boolean)) {
		current = path.join(current, part);
		try {
			const handle = await openNode(current);
			try {
				const stat = await handle.stat();
				if (!stat.isDirectory() && current !== resolved) return false;
				anchor = stat;
			} finally {
				await handle.close();
			}
		} catch (error) {
			if (isRecord(error) && error.code === "ENOENT") break;
			if (operational(error)) return false;
			throw error;
		}
	}
	return !anchor || ownedAnchor(anchor);
}
async function safeDirectoryPath(candidate: string): Promise<boolean> {
	if (!(await safePath(candidate))) return false;
	try {
		const handle = await openNode(candidate);
		try {
			const stat = await handle.stat();
			return stat.isDirectory() && ownedAnchor(stat);
		} finally {
			await handle.close();
		}
	} catch (error) {
		if (isRecord(error) && error.code === "ENOENT") return true;
		if (operational(error)) return false;
		throw error;
	}
}
async function nodeDigest(file: string): Promise<NodeDigest> {
	try {
		const handle = await openNode(file);
		try {
			const stat = await handle.stat();
			if (!stat.isFile()) return { exists: true, regular: false };
			return {
				exists: true,
				regular: true,
				identity: { dev: stat.dev, ino: stat.ino },
				digest: sha256(await handle.readFile()),
			};
		} finally {
			await handle.close();
		}
	} catch (error) {
		if (isRecord(error) && error.code === "ENOENT") return { exists: false, regular: false };
		if (operational(error)) return { exists: true, regular: false };
		throw error;
	}
}
async function removeOwnedFile(file: string | undefined, owned: NodeIdentity | undefined): Promise<boolean> {
	if (!file || !owned) return false;
	const candidate = canonicalPrimeImportOsPath(file);
	const current = await nodeDigest(candidate);
	if (!current.exists) return true;
	if (
		!current.regular ||
		!current.identity ||
		current.identity.dev !== owned.dev ||
		current.identity.ino !== owned.ino
	)
		return false;
	const quarantine = `${candidate}.cleanup-${randomUUID()}`;
	try {
		await fs.rename(candidate, quarantine);
	} catch (error) {
		if (isRecord(error) && error.code === "ENOENT") return true;
		throw error;
	}
	const moved = await nodeDigest(quarantine);
	if (!moved.exists || !moved.identity || moved.identity.dev !== owned.dev || moved.identity.ino !== owned.ino)
		return false;
	try {
		await fs.unlink(quarantine);
		return true;
	} catch (error) {
		await fs.rename(quarantine, candidate).catch(() => undefined);
		throw error;
	}
}
async function ensureDirectory(directory: string): Promise<void> {
	const resolved = canonicalPrimeImportOsPath(directory);
	const root = path.parse(resolved).root;
	let current = root;
	for (const part of path.relative(root, resolved).split(path.sep).filter(Boolean)) {
		current = path.join(current, part);
		try {
			await fs.mkdir(current, { mode: 0o700 });
		} catch (error) {
			if (!(isRecord(error) && error.code === "EEXIST")) throw error;
		}
		const handle = await openNode(current);
		try {
			const stat = await handle.stat();
			if (
				!stat.isDirectory() ||
				((current === resolved || current === path.dirname(resolved)) && !ownedAnchor(stat))
			)
				throw new PrimeOperationalError("destination directory is not owned and private");
		} finally {
			await handle.close();
		}
	}
}
function manifestKey(entry: PrimeRollbackManifestEntry): string {
	const canonical =
		entry.kind === "sessions" || entry.kind === "artifacts"
			? path.resolve(entry.canonicalDestinationRef ?? entry.destinationRef)
			: (entry.canonicalDestinationRef ?? entry.destinationRef);
	return `${entry.kind}\u0000${entry.itemId}\u0000${canonical}`;
}

function hasManifestKeyFields(value: unknown): value is PrimeRollbackManifestEntry {
	if (
		!isRecord(value) ||
		!["sessions", "artifacts", "settings", "models", "credentials", "skills"].includes(value.kind as string) ||
		typeof value.itemId !== "string" ||
		typeof value.destinationRef !== "string"
	)
		return false;
	return (
		(value.canonicalDestinationRef === undefined || typeof value.canonicalDestinationRef === "string") &&
		(value.logicalDestinationRef === undefined || typeof value.logicalDestinationRef === "string")
	);
}
async function validateManifest(
	manifest: unknown,
	expected: PrimeSessionRollbackManifest,
	budget: Pick<PrimeSourceSnapshot, "maxFileBytes" | "maxEntries">,
	validateDestinationRollbackEntry?: PrimeSessionApplyOptions["validateDestinationRollbackEntry"],
): Promise<boolean> {
	if (!isRecord(manifest) || manifest.schemaVersion !== SCHEMA_VERSION || manifest.snapshotId !== expected.snapshotId)
		return false;
	if (!Array.isArray(manifest.entries) || manifest.entries.length > budget.maxEntries) return false;
	const serialized = JSON.stringify(manifest);
	if (serialized === undefined || Buffer.byteLength(serialized) > budget.maxFileBytes) return false;
	if (
		JSON.stringify(manifest.source) !== JSON.stringify(expected.source) ||
		JSON.stringify(manifest.destination) !== JSON.stringify(expected.destination)
	)
		return false;
	const keys = new Set<string>();
	for (const raw of manifest.entries) {
		if (
			!isRecord(raw) ||
			!["sessions", "artifacts", "settings", "models", "credentials", "skills"].includes(raw.kind as string) ||
			typeof raw.itemId !== "string" ||
			typeof raw.destinationRef !== "string" ||
			Buffer.byteLength(raw.itemId) > budget.maxFileBytes ||
			Buffer.byteLength(raw.destinationRef) > budget.maxFileBytes
		)
			return false;
		if (
			typeof raw.created !== "boolean" ||
			typeof raw.priorExists !== "boolean" ||
			(raw.nodeType !== "regular-file" && raw.nodeType !== "directory-tree") ||
			typeof raw.currentSha256 !== "string" ||
			!HASH_RE.test(raw.currentSha256)
		)
			return false;
		if (raw.priorSha256 !== undefined && (typeof raw.priorSha256 !== "string" || !HASH_RE.test(raw.priorSha256)))
			return false;
		const canonical =
			typeof raw.canonicalDestinationRef === "string" ? raw.canonicalDestinationRef : raw.destinationRef;
		const logical = typeof raw.logicalDestinationRef === "string" ? raw.logicalDestinationRef : raw.destinationRef;
		const filesystemBound = raw.kind === "sessions" || raw.kind === "artifacts";
		if (filesystemBound) {
			const root = raw.kind === "sessions" ? expected.destination.sessionDir : expected.destination.blobDir;
			if (
				raw.nodeType !== "regular-file" ||
				!inRoot(root, raw.destinationRef) ||
				!inRoot(root, canonical) ||
				!inRoot(root, logical) ||
				!(await safePath(raw.destinationRef)) ||
				!(await safePath(canonical)) ||
				!(await safePath(logical))
			)
				return false;
			for (const destination of new Set([raw.destinationRef, canonical, logical])) {
				const node = await nodeDigest(destination);
				if (!node.exists || !node.regular || node.digest !== raw.currentSha256) return false;
			}
		} else {
			if (
				raw.destinationRef.length === 0 ||
				raw.destinationRef.includes("\u0000") ||
				canonical.includes("\u0000") ||
				logical.includes("\u0000")
			)
				return false;
			if (
				!validateDestinationRollbackEntry ||
				!(await validateDestinationRollbackEntry(raw as unknown as PrimeRollbackManifestEntry))
			)
				return false;
		}
		if (keys.has(manifestKey(raw as unknown as PrimeRollbackManifestEntry))) return false;
		keys.add(manifestKey(raw as unknown as PrimeRollbackManifestEntry));
	}
	return true;
}
function manifestBase(
	snapshot: PrimeSourceSnapshot,
	destinationCwd: string,
	sessionDir: string,
	blobDir: string,
): PrimeSessionRollbackManifest {
	return {
		schemaVersion: SCHEMA_VERSION,
		snapshotId: snapshot.snapshotId,
		source: {
			sourceRoot: snapshot.sourceRoot,
			sessionRoot: snapshot.sessionRoot,
			cwd: snapshot.cwd,
		},
		destination: { cwd: destinationCwd, sessionDir, blobDir },
		entries: [],
	};
}

export async function preflightPrimeSessionRollbackManifest(
	snapshot: PrimeSourceSnapshot,
	options: PrimeSessionApplyOptions = {},
): Promise<PrimeImportLoss | undefined> {
	const destinationCwd = path.resolve(options.destinationCwd ?? snapshot.cwd);
	const sessionDir = path.resolve(options.sessionDir ?? SessionManager.getDefaultSessionDir(destinationCwd));
	const blobDir = path.resolve(options.blobDir ?? getBlobsDir());
	const manifestPath = path.resolve(
		options.rollbackManifestPath ?? path.join(sessionDir, `.prime-rollback-${snapshot.snapshotId}.json`),
	);
	const lockPath = path.join(
		path.dirname(path.dirname(manifestPath)),
		`.${path.basename(sessionDir)}.prime-import.lock`,
	);
	const invalid = (): PrimeImportLoss => loss("destination-invalid", "destination", "sessions", manifestPath);
	try {
		if (
			!(await safePath(manifestPath)) ||
			!(await safeDirectoryPath(path.dirname(manifestPath))) ||
			!(await safePath(lockPath))
		)
			return invalid();
		const prior = await existingManifest(manifestPath, snapshot.maxFileBytes, snapshot.maxEntries);
		if (prior === undefined) return undefined;
		return (await validateManifest(
			prior,
			manifestBase(snapshot, destinationCwd, sessionDir, blobDir),
			snapshot,
			options.validateDestinationRollbackEntry,
		))
			? undefined
			: invalid();
	} catch (error) {
		if (!operational(error) && !(error instanceof PrimeOperationalError)) throw error;
		return invalid();
	}
}
function entryFor(
	itemId: string,
	kind: "sessions" | "artifacts",
	destinationRef: string,
	prior: NodeDigest,
	currentSha256: string,
	created: boolean,
	canonicalDestinationRef?: string,
	logicalDestinationRef?: string,
): PrimeRollbackManifestEntry {
	return {
		itemId,
		kind,
		destinationRef,
		...(canonicalDestinationRef && canonicalDestinationRef !== destinationRef ? { canonicalDestinationRef } : {}),
		...(logicalDestinationRef && logicalDestinationRef !== destinationRef ? { logicalDestinationRef } : {}),
		created,
		priorExists: prior.exists,
		...(prior.digest ? { priorSha256: prior.digest, preconditionSha256: prior.digest } : {}),
		currentSha256,
		nodeType: "regular-file",
	};
}
async function readNodeBytes(
	file: string,
	maxBytes?: number,
): Promise<{ readonly bytes: Buffer; readonly digest: string } | undefined> {
	try {
		const handle = await openNode(file);
		try {
			const stat = await handle.stat();
			if (!stat.isFile()) throw new PrimeOperationalError("rollback manifest is not a regular file");
			if (maxBytes !== undefined && stat.size > maxBytes)
				throw new PrimeOperationalError("rollback manifest byte budget exhausted");
			const bytes = await handle.readFile();
			if (maxBytes !== undefined && bytes.length > maxBytes)
				throw new PrimeOperationalError("rollback manifest byte budget exhausted");
			return { bytes, digest: sha256(bytes) };
		} finally {
			await handle.close();
		}
	} catch (error) {
		if (isRecord(error) && error.code === "ENOENT") return undefined;
		throw error;
	}
}
function manifestGenerationPrefix(file: string): string {
	return `.${path.basename(file)}.generation-`;
}

async function latestManifestPath(file: string, maxEntries = 256, maxBytes?: number): Promise<string | undefined> {
	const directory = path.dirname(file);
	const base = path.basename(file);
	if (base.includes(".generation-")) return (await readNodeBytes(file, maxBytes)) ? file : undefined;
	const candidates: string[] = [];
	if (await readNodeBytes(file, maxBytes)) candidates.push(file);
	let directoryHandle: Dir;
	try {
		directoryHandle = await fs.opendir(directory);
	} catch (error) {
		if (isRecord(error) && error.code === "ENOENT") return candidates[0];
		throw error;
	}
	let inspectedEntries = 0;
	try {
		for await (const entry of directoryHandle) {
			inspectedEntries += 1;
			if (inspectedEntries > maxEntries)
				throw new PrimeOperationalError("rollback manifest generation budget exhausted");
			if (!entry.name.startsWith(manifestGenerationPrefix(file)) || !entry.name.endsWith(".json")) continue;
			candidates.push(path.join(directory, entry.name));
		}
	} catch (error) {
		if (!(isRecord(error) && error.code === "ENOENT")) throw error;
	}
	return candidates.sort(compare).at(-1);
}

async function existingManifest(file: string, maxBytes?: number, maxEntries?: number): Promise<unknown | undefined> {
	const candidate = await latestManifestPath(file, maxEntries, maxBytes);
	const node = await readNodeBytes(candidate ?? file, maxBytes);
	if (!node) return undefined;
	try {
		return JSON.parse(node.bytes.toString("utf8"));
	} catch (error) {
		if (error instanceof SyntaxError) throw new PrimeOperationalError("rollback manifest is malformed");
		throw error;
	}
}

async function writeManifest(
	file: string,
	manifest: PrimeSessionRollbackManifest,
	budget: Pick<PrimeSourceSnapshot, "maxFileBytes" | "maxEntries">,
): Promise<string> {
	if (manifest.entries.length > budget.maxEntries)
		throw new PrimeOperationalError("rollback manifest entry budget exhausted");
	const content = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
	if (content.length > budget.maxFileBytes) throw new PrimeOperationalError("rollback manifest byte budget exhausted");
	const priorPath = await latestManifestPath(file, budget.maxEntries, budget.maxFileBytes);
	let prior: unknown;
	const priorNode = priorPath ? await readNodeBytes(priorPath, budget.maxFileBytes) : undefined;
	if (priorPath && priorNode) {
		try {
			prior = JSON.parse(priorNode.bytes.toString("utf8"));
		} catch (error) {
			if (error instanceof SyntaxError) throw new PrimeOperationalError("rollback manifest is malformed");
			throw error;
		}
		if (!isRecord(prior) || !Array.isArray(prior.entries))
			throw new PrimeOperationalError("rollback manifest is invalid");
		if (prior.entries.length > budget.maxEntries)
			throw new PrimeOperationalError("rollback manifest entry budget exhausted");
		const candidateByKey = new Map(manifest.entries.map(entry => [manifestKey(entry), JSON.stringify(entry)]));
		for (const raw of prior.entries) {
			if (!hasManifestKeyFields(raw)) throw new PrimeOperationalError("rollback manifest is invalid");
			const existing = candidateByKey.get(manifestKey(raw));
			if (existing !== JSON.stringify(raw)) throw new PrimeOperationalError("rollback manifest subset changed");
		}
		const currentNode = await readNodeBytes(priorPath, budget.maxFileBytes);
		if (!currentNode || currentNode.digest !== priorNode.digest)
			throw new PrimeOperationalError("rollback manifest changed during CAS");
	}
	const directory = path.dirname(file);
	await ensureDirectory(directory);
	const temporary = path.join(directory, `.${path.basename(file)}.${randomUUID()}.tmp`);
	const handle = await fs.open(
		temporary,
		fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
		0o600,
	);
	let writeFailure: unknown;
	try {
		await handle.writeFile(content);
		await handle.sync();
	} catch (error) {
		writeFailure = error;
	}
	try {
		await handle.close();
	} catch (closeError) {
		if (writeFailure === undefined) writeFailure = closeError;
	}
	if (writeFailure !== undefined) {
		await fs.rm(temporary, { force: true }).catch(() => undefined);
		throw writeFailure;
	}
	let publishedPath = file;
	try {
		if (priorPath) {
			publishedPath = path.join(
				directory,
				`${manifestGenerationPrefix(file)}${Date.now().toString(36)}-${randomUUID()}.json`,
			);
			await fs.link(temporary, publishedPath);
		} else {
			try {
				await fs.link(temporary, file);
			} catch (error) {
				if (!operational(error)) throw error;
				const raced = await readNodeBytes(file, budget.maxFileBytes);
				if (!raced || raced.digest !== sha256(content))
					throw new PrimeOperationalError("rollback manifest CAS race");
			}
		}
	} finally {
		await fs.rm(temporary, { force: true });
	}
	if (priorPath) {
		const raced = await readNodeBytes(priorPath, budget.maxFileBytes);
		if (!raced || raced.digest !== priorNode?.digest)
			throw new PrimeOperationalError("rollback manifest changed during immutable publication");
	}
	const reopened = await readNodeBytes(publishedPath, budget.maxFileBytes);
	if (!reopened || reopened.digest !== sha256(content))
		throw new PrimeOperationalError("rollback manifest CAS verification failed");
	return publishedPath;
}
async function scanExistingSessions(
	sessionDir: string,
	candidates: readonly ValidatedSession[],
	snapshot: PrimeSourceSnapshot,
): Promise<ReadonlyMap<string, string>> {
	if (candidates.length === 0) return new Map();
	let directory: Dir;
	try {
		directory = await fs.opendir(sessionDir);
	} catch (error) {
		if (isRecord(error) && error.code === "ENOENT") return new Map();
		throw error;
	}
	let totalBytes = 0;
	let totalEntries = 0;
	const matches = new Map<string, string>();
	try {
		for await (const entry of directory) {
			totalEntries += 1;
			if (totalEntries > snapshot.maxEntries)
				throw new PrimeOperationalError("destination duplicate scan entry budget exhausted");
			const nameBytes = Buffer.byteLength(entry.name);
			if (nameBytes > snapshot.maxTotalBytes - totalBytes)
				throw new PrimeOperationalError("destination duplicate scan byte budget exhausted");
			totalBytes += nameBytes;
			const file = path.join(sessionDir, entry.name);
			let stat: Stats;
			try {
				const handle = await openNode(file);
				try {
					stat = await handle.stat();
				} finally {
					await handle.close();
				}
			} catch (error) {
				if (isRecord(error) && error.code === "ENOENT") continue;
				if (isRecord(error) && error.code === "ELOOP") continue;
				throw error;
			}
			if (!stat.isFile()) continue;
			if (stat.size > snapshot.maxTotalBytes - totalBytes)
				throw new PrimeOperationalError("destination duplicate scan byte budget exhausted");
			totalBytes += stat.size;
			if (!entry.name.endsWith(".jsonl")) continue;
			let firstEntry = true;
			let validHeader = false;
			let headerCwd: string | undefined;
			const contentEntries: Array<{
				readonly type: string;
				readonly id: string;
				readonly parentId: string | null;
				readonly title?: string;
				readonly source?: string;
			}> = [];
			let provenance: Record<string, unknown> | undefined;
			let visitedRecords = 0;
			try {
				await visitEntriesFromFileStream(
					file,
					parsed => {
						visitedRecords += 1;
						if (visitedRecords > snapshot.maxEntries)
							throw new PrimeOperationalError("destination duplicate scan record budget exhausted");
						if (firstEntry) {
							firstEntry = false;
							validHeader = isRecord(parsed) && parsed.type === "session" && typeof parsed.id === "string";
							if (validHeader && isRecord(parsed) && typeof parsed.cwd === "string") headerCwd = parsed.cwd;
							return validHeader;
						}
						if (!validHeader || !isRecord(parsed)) return;
						if (
							parsed.type === "custom" &&
							parsed.customType === "prime_session_import" &&
							isRecord(parsed.data)
						) {
							provenance = parsed.data;
							return;
						}
						if (parsed.type === "custom" && parsed.customType === "foreign_session_import") return;
						if (typeof parsed.type === "string" && typeof parsed.id === "string") {
							contentEntries.push({
								type: parsed.type,
								id: parsed.id,
								parentId: typeof parsed.parentId === "string" ? parsed.parentId : null,
								...(typeof parsed.title === "string" ? { title: parsed.title } : {}),
								...(typeof parsed.source === "string" ? { source: parsed.source } : {}),
							});
						}
					},
					{ maxRecords: snapshot.maxEntries + 1 },
				);
				for (const candidate of candidates) {
					const data = provenance;
					const expectedIds = new Set(candidate.session.entries.map(entry => entry.id));
					const generatedTitleEntries = contentEntries.filter(
						entry =>
							entry.type === "title_change" &&
							!expectedIds.has(entry.id) &&
							entry.title === candidate.session.header.title &&
							entry.source === "auto",
					);
					const comparableEntries = contentEntries.filter(entry => !generatedTitleEntries.includes(entry));
					if (
						data === undefined ||
						data.sourceRef !== candidate.session.sourceRef ||
						data.sourceSha256 !== candidate.session.sourceSha256 ||
						data.sourceRoot !== snapshot.sourceRoot ||
						data.sessionRoot !== snapshot.sessionRoot ||
						data.sourceCwd !== candidate.session.header.cwd ||
						headerCwd !== candidate.session.header.cwd ||
						generatedTitleEntries.length > 1 ||
						comparableEntries.length !== candidate.session.entries.length ||
						candidate.session.entries.some(
							(expected, index) =>
								comparableEntries[index]?.id !== expected.id ||
								comparableEntries[index]?.type !== expected.type ||
								comparableEntries[index]?.parentId !== expected.parentId,
						)
					)
						continue;
					const prior = matches.get(candidate.itemId);
					if (!prior || file < prior) matches.set(candidate.itemId, file);
				}
			} catch (error) {
				if (operational(error)) throw new PrimeOperationalError("destination duplicate scan read failed");
				throw error;
			}
		}
	} catch (error) {
		if (isRecord(error) && error.code === "ENOENT") return new Map();
		throw error;
	}
	return matches;
}

async function persistBlob(
	image: ImageCandidate,
	blobDir: string,
	createdNodes?: Map<string, NodeIdentity>,
	onPublished?: (entry: PrimeRollbackManifestEntry, identity: NodeIdentity) => void | Promise<void>,
	onCleanupFailure?: (entry: PrimeRollbackManifestEntry, error: unknown) => void | Promise<void>,
): Promise<PrimeRollbackManifestEntry[]> {
	const canonical = path.join(blobDir, image.hash);
	const before = await nodeDigest(canonical);
	if (before.exists && (!before.regular || before.digest !== image.hash))
		throw new PrimeOperationalError("blob destination drift");
	let canonicalCreated = false;
	let canonicalOwned: NodeIdentity | undefined = before.identity;
	let display: string | undefined;
	let displayCreated = false;
	const entries: PrimeRollbackManifestEntry[] = [];
	if (!before.exists) {
		try {
			const handle = await fs.open(canonical, "wx", 0o600);
			try {
				const stat = await handle.stat();
				canonicalOwned = { dev: stat.dev, ino: stat.ino };
				canonicalCreated = true;
				await handle.writeFile(image.bytes);
			} finally {
				await handle.close();
			}
		} catch (error) {
			if (isRecord(error) && error.code === "EEXIST") {
				// A concurrent publisher owns this path; verify it below without adopting it.
			} else {
				if (canonicalCreated && canonicalOwned) {
					try {
						if (!(await removeOwnedFile(canonical, canonicalOwned)))
							await onCleanupFailure?.(
								entryFor(`blob:${image.hash}`, "artifacts", canonical, before, image.hash, true),
								new PrimeOperationalError("blob cleanup could not be proven"),
							);
					} catch (cleanupError) {
						await onCleanupFailure?.(
							entryFor(`blob:${image.hash}`, "artifacts", canonical, before, image.hash, true),
							cleanupError,
						);
					}
				}
				throw error;
			}
		}
	}
	const after = await nodeDigest(canonical);
	if (!after.exists || !after.regular || after.digest !== image.hash)
		throw new PrimeOperationalError("blob CAS verification failed");
	canonicalOwned ??= after.identity;
	if (!canonicalOwned) throw new PrimeOperationalError("blob ownership unavailable");
	if (canonicalCreated) {
		createdNodes?.set(canonical, canonicalOwned);
		const entry = entryFor(`blob:${image.hash}`, "artifacts", canonical, before, image.hash, true);
		entries.push(entry);
		await onPublished?.(entry, canonicalOwned);
	}
	try {
		const extension = blobExtensionForImageMimeType(image.mimeType);
		if (!extension) return entries;
		display = `${canonical}.${extension}`;
		const prior = await nodeDigest(display);
		if (prior.exists && (!prior.regular || prior.digest !== image.hash))
			throw new PrimeOperationalError("blob display destination drift");
		if (!prior.exists) {
			try {
				await fs.link(canonical, display);
				displayCreated = true;
				createdNodes?.set(display, canonicalOwned);
			} catch (error) {
				if (!operational(error)) throw error;
				const raced = await nodeDigest(display);
				if (!raced.exists || !raced.regular || raced.digest !== image.hash)
					throw new PrimeOperationalError("blob display CAS verification failed");
			}
		}
		if (displayCreated) {
			const entry = entryFor(
				`blob:${image.hash}:display`,
				"artifacts",
				display,
				prior,
				image.hash,
				true,
				canonical,
				display,
			);
			entries.push(entry);
			await onPublished?.(entry, canonicalOwned);
		}
		const verified = await nodeDigest(display);
		if (!verified.exists || !verified.regular || verified.digest !== image.hash)
			throw new PrimeOperationalError("blob display verification failed");
		return entries;
	} catch (error) {
		const cleanup = async (
			file: string | undefined,
			itemId: string,
			identity: NodeIdentity | undefined,
		): Promise<void> => {
			if (!file || !identity) return;
			try {
				const removed = await removeOwnedFile(file, identity);
				if (!removed) {
					await onCleanupFailure?.(
						entries.find(entry => entry.itemId === itemId) ??
							entryFor(itemId, "artifacts", file, { exists: true, regular: true, identity }, image.hash, true),
						new PrimeOperationalError("blob cleanup could not be proven"),
					);
				}
			} catch (cleanupError) {
				await onCleanupFailure?.(
					entries.find(entry => entry.itemId === itemId) ??
						entryFor(itemId, "artifacts", file, { exists: true, regular: true, identity }, image.hash, true),
					cleanupError,
				);
			}
		};
		if (displayCreated) await cleanup(display, `blob:${image.hash}:display`, canonicalOwned);
		if (canonicalCreated) await cleanup(canonical, `blob:${image.hash}`, canonicalOwned);
		throw error;
	}
}

/** Stage and apply parsed Prime sessions without touching settings, models, skills, or credentials. */
export async function applyPrimeSessions(
	input: PrimeSessionApplyInput,
	options: PrimeSessionApplyOptions = {},
): Promise<PrimeSessionApplyReport> {
	const destinationCwd = path.resolve(options.destinationCwd ?? input.snapshot.cwd);
	const sessionDir = path.resolve(options.sessionDir ?? SessionManager.getDefaultSessionDir(destinationCwd));
	const blobDir = path.resolve(options.blobDir ?? getBlobsDir());
	const manifestPath = path.resolve(
		options.rollbackManifestPath ?? path.join(sessionDir, `.prime-rollback-${input.snapshot.snapshotId}.json`),
	);
	const sourceFiles = new Map(input.sourceFiles.map(file => [file.sourceRef, file] as const));
	const losses: PrimeImportLoss[] = [...(input.losses ?? [])];
	const byId = new Map<string, PrimeSessionApplyItem>();
	const validated: ValidatedSession[] = [];
	const images = new Map<string, ImageCandidate>();
	const usedItemIds = new Set<string>();
	for (const session of [...input.sessions].sort((left, right) =>
		compare(`${left.sourceRef}\u0000${left.header.id}`, `${right.sourceRef}\u0000${right.header.id}`),
	)) {
		const baseItemId = `session:${session.header.id}`;
		let itemId = baseItemId;
		let suffix = 1;
		while (usedItemIds.has(itemId)) itemId = `${baseItemId}:${suffix++}`;
		usedItemIds.add(itemId);
		const itemLosses: PrimeImportLoss[] = [];
		for (const code of session.fatalLossCodes ?? []) itemLosses.push(loss(code, session.sourceRef, "sessions"));
		const file = sourceFiles.get(session.sourceRef);
		if (!file) itemLosses.push(loss("source-missing", session.sourceRef, "sessions"));
		else {
			const sourceLoss = validateSourceFile(input.snapshot, file);
			if (sourceLoss || file.sha256 !== session.sourceSha256)
				itemLosses.push(sourceLoss ?? loss("source-drift", session.sourceRef, "sessions", file.canonicalPath));
		}
		const sessionImages: ImageCandidate[] = [];
		for (const entry of session.entries) {
			if (entry.type !== "message") continue;
			if (!imageCandidates(entry.message, sessionImages))
				itemLosses.push(loss("sessions-invalid-entry", session.sourceRef, "sessions"));
			if (!validateReferencedArtifact(entry.message, sourceFiles, input.snapshot, itemLosses))
				itemLosses.push(loss("sessions-missing-full-output", session.sourceRef, "sessions"));
		}
		if (itemLosses.length || !file) {
			losses.push(...itemLosses);
			byId.set(itemId, {
				itemId,
				kind: "sessions",
				sourceRefs: [session.sourceRef],
				outcome: "lost",
				lossCodes: [...new Set(itemLosses.map(value => value.code))].sort(compare),
			});
			continue;
		}
		for (const image of sessionImages) images.set(image.hash, image);
		validated.push({ session, sourceFile: file, images: sessionImages, itemId });
	}
	const lockPath = path.join(
		path.dirname(path.dirname(manifestPath)),
		`.${path.basename(sessionDir)}.prime-import.lock`,
	);
	const manifestPreflightLoss = await preflightPrimeSessionRollbackManifest(input.snapshot, options);
	const preflightOk =
		manifestPreflightLoss === undefined &&
		(await safePath(manifestPath)) &&
		(await safeDirectoryPath(path.dirname(manifestPath))) &&
		(await safePath(lockPath));
	const destinationLoss =
		manifestPreflightLoss ?? loss("destination-invalid", "destination", "sessions", manifestPath);
	const markUnprocessedSessionsLost = (
		code: PrimeImportLoss["code"],
		candidates: readonly ValidatedSession[] = validated,
	): void => {
		for (const candidate of candidates)
			if (!byId.has(candidate.itemId))
				byId.set(candidate.itemId, {
					itemId: candidate.itemId,
					kind: "sessions",
					sourceRefs: [candidate.session.sourceRef],
					outcome: "lost",
					lossCodes: [code],
				});
	};
	if (!preflightOk) {
		losses.push(destinationLoss);
		markUnprocessedSessionsLost(destinationLoss.code);
		return {
			schemaVersion: SCHEMA_VERSION,
			snapshotId: input.snapshot.snapshotId,
			items: sortItems([...byId.values()]),
			losses: uniqueLosses(losses),
			partialApply: (options.initialRollbackEntries?.length ?? 0) > 0,
		};
	}

	let manifestReport: (PrimeSessionRollbackManifest & { readonly path: string }) | undefined;
	let partialApply = false;
	try {
		await withFileLock(lockPath, async () => {
			const expectedBase = manifestBase(input.snapshot, destinationCwd, sessionDir, blobDir);
			const initialEntries = [...(options.initialRollbackEntries ?? [])];
			const initialValid = initialEntries.every(entry => entry.itemId.length > 0 && entry.destinationRef.length > 0)
				? await validateManifest(
						{ ...expectedBase, entries: initialEntries },
						{ ...expectedBase, entries: initialEntries },
						input.snapshot,
						options.validateDestinationRollbackEntry,
					)
				: false;
			const publishAndVerifyManifest = async (manifest: PrimeSessionRollbackManifest): Promise<string> => {
				await ensureDirectory(path.dirname(manifestPath));
				const publishedPath = await writeManifest(manifestPath, manifest, input.snapshot);
				const saved = await existingManifest(publishedPath, input.snapshot.maxFileBytes, input.snapshot.maxEntries);
				if (
					!(await validateManifest(saved, manifest, input.snapshot, options.validateDestinationRollbackEntry)) ||
					JSON.stringify(saved) !== JSON.stringify(manifest)
				)
					throw new PrimeOperationalError("rollback manifest verification failed");
				return publishedPath;
			};
			const publishInitialManifest = async (): Promise<void> => {
				try {
					const manifest: PrimeSessionRollbackManifest = { ...expectedBase, entries: initialEntries };
					const publishedPath = await publishAndVerifyManifest(manifest);
					manifestReport = { ...manifest, path: publishedPath };
				} catch (error) {
					if (!operational(error) && !(error instanceof PrimeOperationalError)) throw error;
					losses.push(loss("destination-apply-failed", "rollback-manifest", "sessions", manifestPath));
				}
			};

			if (initialEntries.length > 0 && !initialValid) {
				losses.push(destinationLoss);
				partialApply = true;
				return;
			}
			const sourceDrift = await revalidatePrimeSource(input.snapshot);
			if (!sourceDrift.ok) {
				losses.push(...sourceDrift.losses);
				markUnprocessedSessionsLost("source-drift");
				partialApply = initialEntries.length > 0;
				if (initialEntries.length > 0 && initialValid) await publishInitialManifest();
				return;
			}
			if (!(await safeDirectoryPath(sessionDir)) || !(await safeDirectoryPath(blobDir))) {
				losses.push(destinationLoss);
				markUnprocessedSessionsLost(destinationLoss.code);
				partialApply = initialEntries.length > 0;
				if (initialEntries.length > 0) await publishInitialManifest();
				return;
			}
			const prior = await existingManifest(manifestPath, input.snapshot.maxFileBytes, input.snapshot.maxEntries);
			const priorEntries =
				isRecord(prior) && Array.isArray(prior.entries) ? (prior.entries as PrimeRollbackManifestEntry[]) : [];
			const priorManifestValid =
				prior === undefined ||
				(await validateManifest(prior, expectedBase, input.snapshot, options.validateDestinationRollbackEntry));
			if (prior !== undefined && !priorManifestValid) {
				losses.push(destinationLoss);
				markUnprocessedSessionsLost(destinationLoss.code);
				return;
			}
			let existingSessions: ReadonlyMap<string, string>;
			try {
				existingSessions = await scanExistingSessions(sessionDir, validated, input.snapshot);
			} catch (error) {
				if (!operational(error) && !(error instanceof PrimeOperationalError)) throw error;
				losses.push(loss("destination-apply-failed", "destination-scan", "sessions", sessionDir));
				markUnprocessedSessionsLost("destination-apply-failed");
				return;
			}
			let priorOwnershipValid = true;
			for (const entry of priorEntries) {
				if (entry.kind === "sessions") {
					const candidate = validated.find(value => value.itemId === entry.itemId);
					const found = candidate ? existingSessions.get(candidate.itemId) : undefined;
					if (
						!candidate ||
						path.resolve(found ?? "") !== path.resolve(entry.destinationRef) ||
						path.resolve(entry.canonicalDestinationRef ?? entry.destinationRef) !==
							path.resolve(entry.destinationRef) ||
						path.resolve(entry.logicalDestinationRef ?? entry.destinationRef) !==
							path.resolve(entry.destinationRef)
					)
						priorOwnershipValid = false;
				} else if (entry.kind === "artifacts") {
					const image = [...images.values()].find(
						value => entry.itemId === `blob:${value.hash}` || entry.itemId === `blob:${value.hash}:display`,
					);
					if (!image) {
						priorOwnershipValid = false;
						continue;
					}
					const canonical = path.join(blobDir, image.hash);
					const expectedPath = entry.itemId.endsWith(":display")
						? `${canonical}.${blobExtensionForImageMimeType(image.mimeType) ?? ""}`
						: canonical;
					if (
						path.resolve(entry.destinationRef) !== path.resolve(expectedPath) ||
						path.resolve(entry.canonicalDestinationRef ?? canonical) !== path.resolve(canonical) ||
						path.resolve(entry.logicalDestinationRef ?? entry.destinationRef) !==
							path.resolve(entry.destinationRef)
					)
						priorOwnershipValid = false;
				}
			}
			if (prior !== undefined && !priorOwnershipValid) {
				losses.push(destinationLoss);
				markUnprocessedSessionsLost(destinationLoss.code);
				return;
			}
			if (initialEntries.length + priorEntries.length > input.snapshot.maxEntries) {
				losses.push(destinationLoss);
				markUnprocessedSessionsLost(destinationLoss.code);
				partialApply = initialEntries.length > 0;
				return;
			}
			const manifestEntries: PrimeRollbackManifestEntry[] = [...initialEntries, ...priorEntries];
			const runCreated = new Set<string>();
			const runCreatedNodes = new Map<string, NodeIdentity>();
			const runSessionItems = new Set<string>();
			const entryIndexes = new Map(manifestEntries.map((entry, index) => [manifestKey(entry), index]));
			const addEntry = (entry: PrimeRollbackManifestEntry, identity?: NodeIdentity): void => {
				const key = manifestKey(entry);
				const existingIndex = entryIndexes.get(key);
				if (existingIndex !== undefined) {
					if (runCreated.has(key)) manifestEntries[existingIndex] = entry;
					if (identity && runCreated.has(key)) runCreatedNodes.set(entry.destinationRef, identity);
					return;
				}
				if (manifestEntries.length >= input.snapshot.maxEntries)
					throw new PrimeOperationalError("rollback manifest entry budget exhausted");
				entryIndexes.set(key, manifestEntries.length);
				manifestEntries.push(entry);
				runCreated.add(key);
				if (identity) runCreatedNodes.set(entry.destinationRef, identity);
			};
			const forgetRunEntry = (key: string): void => {
				const index = entryIndexes.get(key);
				if (index === undefined || !runCreated.has(key)) return;
				const [entry] = manifestEntries.splice(index, 1);
				runCreated.delete(key);
				if (entry) runCreatedNodes.delete(entry.destinationRef);
				entryIndexes.clear();
				for (let current = 0; current < manifestEntries.length; current += 1)
					entryIndexes.set(manifestKey(manifestEntries[current]), current);
			};
			const manifest: PrimeSessionRollbackManifest = { ...expectedBase, entries: manifestEntries };
			const validateLogicalEntries = async (): Promise<void> => {
				for (const entry of manifestEntries)
					if (entry.kind !== "sessions" && entry.kind !== "artifacts") {
						if (
							!options.validateDestinationRollbackEntry ||
							!(await options.validateDestinationRollbackEntry(entry))
						)
							throw new PrimeOperationalError("destination rollback entry is no longer valid");
					}
			};
			const failed = new Set<string>();
			const blobRefs = new Map<string, string>();
			try {
				for (const image of [...images.values()].sort((left, right) => compare(left.hash, right.hash))) {
					try {
						await ensureDirectory(blobDir);
						await validateLogicalEntries();
						if (!(await safePath(blobDir))) throw new PrimeOperationalError("blob destination is unsafe");
						const projectedEntries =
							manifestEntries.length + (blobExtensionForImageMimeType(image.mimeType) ? 2 : 1);
						if (projectedEntries > input.snapshot.maxEntries)
							throw new PrimeOperationalError("rollback manifest entry budget exhausted");
						const blobEntries = await persistBlob(
							image,
							blobDir,
							runCreatedNodes,
							async (entry, identity) => addEntry(entry, identity),
							async entry => {
								losses.push(
									loss("destination-cleanup-failed", entry.itemId, "artifacts", entry.destinationRef),
								);
								partialApply = true;
							},
						);
						for (const entry of blobEntries) addEntry(entry, runCreatedNodes.get(entry.destinationRef));
						blobRefs.set(image.hash, `blob:sha256:${image.hash}`);
					} catch (error) {
						if (!operational(error) && !(error instanceof PrimeOperationalError)) throw error;
						for (const entry of [...manifestEntries]) {
							if (entry.itemId !== `blob:${image.hash}` && entry.itemId !== `blob:${image.hash}:display`)
								continue;
							if (!(await nodeDigest(entry.destinationRef)).exists) forgetRunEntry(manifestKey(entry));
						}
						failed.add(image.hash);
						losses.push(
							loss(
								"destination-apply-failed",
								`blob:${image.hash}`,
								"artifacts",
								path.join(blobDir, image.hash),
							),
						);
					}
				}
			} catch (error) {
				if (!operational(error)) throw error;
				losses.push(loss("destination-apply-failed", "artifacts", "artifacts", blobDir));
			}
			if (failed.size) {
				for (const candidate of validated)
					if (!byId.has(candidate.itemId))
						byId.set(candidate.itemId, {
							itemId: candidate.itemId,
							kind: "sessions",
							sourceRefs: [candidate.session.sourceRef],
							outcome: "lost",
							lossCodes: ["destination-apply-failed"],
						});
				partialApply = partialApply || runCreated.size > 0;
			} else {
				for (let index = 0; index < validated.length; index += 1) {
					const candidate = validated[index];
					if (byId.has(candidate.itemId)) continue;
					const { session, sourceFile } = candidate;
					let durablePath: string | undefined;
					let persisted: SessionManager | undefined;
					let ownedSession: NodeIdentity | undefined;

					try {
						if (!(await safePath(sessionDir))) throw new PrimeOperationalError("session destination is unsafe");
						await ensureDirectory(sessionDir);
						const existing = existingSessions.get(candidate.itemId);
						if (existing) {
							byId.set(candidate.itemId, {
								itemId: candidate.itemId,
								kind: "sessions",
								sourceRefs: [session.sourceRef],
								outcome: "skipped",
								destinationRef: existing,
							});
							continue;
						}
						const converted = SessionManager.inMemory(session.header.cwd);
						for (const entry of session.entries) converted.ingestReplicatedEntry(toSessionEntry(entry, blobRefs));
						await validateLogicalEntries();
						if (session.header.title) await converted.setSessionName(session.header.title, "auto");
						const provenance: PrimeSessionProvenance = {
							sourceRef: session.sourceRef,
							sourcePath: sourceFile.canonicalPath,
							sourceSha256: session.sourceSha256,
							snapshotId: input.snapshot.snapshotId,
							sourceRoot: input.snapshot.sourceRoot,
							sessionRoot: input.snapshot.sessionRoot,
							sourceCwd: session.header.cwd,
							destinationCwd,
							...(session.header.title ? { title: session.header.title } : {}),
							...(session.header.parentSession ? { parentSession: session.header.parentSession } : {}),
							...(session.header.rlmDepth === undefined ? {} : { rlmDepth: session.header.rlmDepth }),
							child: session.header.lineage?.child ?? Boolean(session.header.parentSession),
						};
						await validateLogicalEntries();
						persisted = await persistConvertedSession(
							converted,
							{
								source: "prime",
								sourceId: session.header.id,
								sourcePath: sourceFile.canonicalPath,
								sourceCwd: session.header.cwd,
							},
							{
								sessionDir,
								fallbackCwd: destinationCwd,
								suppressBreadcrumb: true,
								onPublished: async publication => {
									durablePath = publication.path;
									ownedSession = publication.identity;
									if (!inRoot(sessionDir, publication.path))
										throw new PrimeOperationalError("session escaped destination");
									const publishedNode = await nodeDigest(publication.path);
									if (!publishedNode.exists || !publishedNode.regular || !publishedNode.digest)
										throw new PrimeOperationalError("session publication digest unavailable");
									if (
										!publishedNode.identity ||
										publishedNode.identity.dev !== publication.identity.dev ||
										publishedNode.identity.ino !== publication.identity.ino
									)
										throw new PrimeOperationalError("session publication identity changed");
									addEntry(
										entryFor(
											candidate.itemId,
											"sessions",
											publication.path,
											{ exists: false, regular: false },
											publishedNode.digest,
											true,
										),
										publication.identity,
									);
								},
								onCleanupFailure: publication => {
									losses.push(
										loss(
											"destination-cleanup-failed",
											candidate.session.sourceRef,
											"sessions",
											publication.path,
										),
									);
									partialApply = true;
								},
							},
						);
						durablePath = persisted.getSessionFile();
						persisted.appendCustomEntry("prime_session_import", provenance);
						await persisted.flush();
						const destinationRef = persisted.getSessionFile();
						await persisted.close();
						if (!destinationRef || !inRoot(sessionDir, destinationRef))
							throw new PrimeOperationalError("session escaped destination");
						const finalNode = await nodeDigest(destinationRef);
						if (!finalNode.exists || !finalNode.regular || !finalNode.digest)
							throw new PrimeOperationalError("session final digest unavailable");
						const sessionIdentity = ownedSession;
						if (!sessionIdentity) throw new PrimeOperationalError("session ownership unavailable");
						addEntry(
							entryFor(
								candidate.itemId,
								"sessions",
								destinationRef,
								{ exists: false, regular: false },
								finalNode.digest,
								true,
							),
							sessionIdentity,
						);
						runSessionItems.add(candidate.itemId);
						byId.set(candidate.itemId, {
							itemId: candidate.itemId,
							kind: "sessions",
							sourceRefs: [session.sourceRef],
							outcome: "imported",
							destinationRef,
						});
					} catch (error) {
						const isOperational = operational(error) || error instanceof PrimeOperationalError;
						if (persisted) {
							try {
								durablePath ??= persisted.getSessionFile();
							} catch {
								// Preserve the primary persistence failure.
							}
							await persisted.close().catch(() => undefined);
						}
						if (durablePath && ownedSession && inRoot(sessionDir, durablePath)) {
							try {
								const cleaned = await removeOwnedFile(durablePath, ownedSession);
								if (!cleaned) {
									losses.push(loss("destination-cleanup-failed", session.sourceRef, "sessions", durablePath));
									partialApply = true;
								}
							} catch {
								losses.push(loss("destination-cleanup-failed", session.sourceRef, "sessions", durablePath));
								partialApply = true;
							}
						}
						if (!isOperational) throw error;
						losses.push(loss("destination-apply-failed", session.sourceRef, "sessions", sessionDir));
						markUnprocessedSessionsLost("destination-apply-failed", validated.slice(index));
						partialApply = partialApply || runCreated.size > 0;
						break;
					}
				}
			}
			const rollbackRunCreated = async (): Promise<PrimeRollbackManifestEntry[]> => {
				const recoveryEntries: PrimeRollbackManifestEntry[] = [];
				for (const entry of manifestEntries) {
					if (!runCreated.has(manifestKey(entry))) {
						recoveryEntries.push(entry);
						continue;
					}
					try {
						const cleaned = await removeOwnedFile(
							entry.destinationRef,
							runCreatedNodes.get(entry.destinationRef),
						);
						if (!cleaned) throw new PrimeOperationalError("published node cleanup could not be proven");
					} catch {
						recoveryEntries.push(entry);
						losses.push(loss("destination-cleanup-failed", entry.itemId, entry.kind, entry.destinationRef));
						partialApply = true;
					}
				}
				return recoveryEntries;
			};
			const shouldWrite =
				manifestEntries.length > 0 && (prior === undefined || JSON.stringify(prior) !== JSON.stringify(manifest));
			if (shouldWrite) {
				try {
					await validateLogicalEntries();
					if (
						!(await validateManifest(
							manifest,
							manifest,
							input.snapshot,
							options.validateDestinationRollbackEntry,
						))
					)
						throw new PrimeOperationalError("rollback manifest entries are no longer valid");
					const publishedPath = await publishAndVerifyManifest(manifest);
					manifestReport = { ...manifest, path: publishedPath };
				} catch (error) {
					if (!operational(error) && !(error instanceof PrimeOperationalError)) throw error;
					const recoveryEntries = await rollbackRunCreated();
					for (const itemId of runSessionItems) {
						const item = byId.get(itemId);
						if (!item) continue;
						byId.set(itemId, {
							itemId,
							kind: "sessions",
							sourceRefs: item.sourceRefs,
							outcome: "lost",
							lossCodes: ["destination-apply-failed"],
						});
					}
					losses.push(loss("destination-apply-failed", "rollback-manifest", "sessions", manifestPath));
					partialApply =
						partialApply ||
						initialEntries.length > 0 ||
						recoveryEntries.some(entry => runCreated.has(manifestKey(entry)));
					if (recoveryEntries.length > 0) {
						const recoveryManifest: PrimeSessionRollbackManifest = { ...expectedBase, entries: recoveryEntries };
						try {
							const recoveryPath = await writeManifest(manifestPath, recoveryManifest, input.snapshot);
							const saved = await existingManifest(
								recoveryPath,
								input.snapshot.maxFileBytes,
								input.snapshot.maxEntries,
							);
							if (
								!(await validateManifest(
									saved,
									recoveryManifest,
									input.snapshot,
									options.validateDestinationRollbackEntry,
								)) ||
								JSON.stringify(saved) !== JSON.stringify(recoveryManifest)
							)
								throw new PrimeOperationalError("rollback recovery verification failed");
							manifestReport = { ...recoveryManifest, path: recoveryPath };
						} catch {
							losses.push(loss("destination-apply-failed", "rollback-recovery", "sessions"));
						}
					}
				}
			}
		});
	} catch (error) {
		if (!operational(error) && !(error instanceof PrimeOperationalError)) throw error;
		losses.push(destinationLoss);
		markUnprocessedSessionsLost(destinationLoss.code);
	}
	return {
		schemaVersion: SCHEMA_VERSION,
		snapshotId: input.snapshot.snapshotId,
		items: sortItems([...byId.values()]),
		losses: uniqueLosses(losses),
		partialApply,
		...(manifestReport ? { rollbackManifest: manifestReport } : {}),
	};
}

export const persistPrimeSessions = applyPrimeSessions;
