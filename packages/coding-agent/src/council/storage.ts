import * as fs from "node:fs/promises";
import * as path from "node:path";
import { hasFsCode, logger } from "@oh-my-pi/pi-utils";
import { resolveLocalUrlToPath } from "../internal-urls";
import type { ToolSession } from "../tools";
import {
	COUNCIL_READ_FLAGS,
	COUNCIL_STAGE_FLAGS,
	COUNCIL_STAGE_MODE,
	canonicalizeLocalRoot,
	councilTempPath,
	linkExclusive,
	renameReplacing,
	syncDirectory,
} from "./durable-fs";
import { COUNCIL_RUN_MESSAGE_TYPE } from "./events";
import { sha256CouncilContent } from "./hash";
import { publishedCouncilPlanMatches } from "./publication";
import {
	type CouncilAdjudication,
	validateCouncilAdjudication,
	validateCouncilPlannerOutput,
	validatePersistedCouncilReport,
} from "./schema";
import {
	type CouncilArtifactReference,
	type CouncilManifest,
	CouncilManifestError,
	normalizeRecoveredCouncilManifest,
	parseCouncilInstructionSnapshot,
	parseCouncilManifest,
} from "./state";

export const COUNCIL_ARTIFACT_NAME_PATTERN =
	/^(?:instructions\.json|draft\.md|round[12]\.md|[a-z][a-z0-9]{0,63}-r[12]\.json|manifest\.json)$/;
const COUNCIL_RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const COUNCIL_FLAT_FILENAME_PATTERN =
	/^council-(?:[A-Za-z0-9][A-Za-z0-9_.-]{0,127})-(?:instructions\.json|draft\.md|round[12]\.md|[a-z][a-z0-9]{0,63}-r[12]\.json|manifest\.json)$/;
const COUNCIL_INSTRUCTION_ARTIFACT_BYTE_LIMIT = 4 * 1024 * 1024;

export type CouncilStorageErrorCode =
	| "COUNCIL_STORAGE_UNAVAILABLE"
	| "COUNCIL_RUN_EXISTS"
	| "COUNCIL_RUN_NOT_FOUND"
	| "COUNCIL_RECOVERY_CORRUPT"
	| "COUNCIL_ARTIFACT_INVALID"
	| "COUNCIL_ARTIFACT_HASH_MISMATCH"
	| "COUNCIL_STORAGE_IO";

export class CouncilStorageError extends Error {
	readonly spending = false;

	constructor(
		readonly code: CouncilStorageErrorCode,
		message: string,
		options?: ErrorOptions,
	) {
		super(message, options);
		this.name = "CouncilStorageError";
	}
}

export interface CouncilStorageFileSystem {
	open: typeof fs.open;
	lstat: typeof fs.lstat;
	realpath: typeof fs.realpath;
	mkdir: typeof fs.mkdir;
	link: typeof fs.link;
	rename: typeof fs.rename;
	unlink: typeof fs.unlink;
	readdir: typeof fs.readdir;
}

export type CouncilStorageDurabilityOperation =
	| "file-sync"
	| "link"
	| "rename"
	| "unlink"
	| "directory-sync"
	| "journal";

export interface CouncilStorageOptions {
	filesystem?: CouncilStorageFileSystem;
	now?: () => string;
	randomUUID?: () => string;
	onDurabilityOperation?: (operation: CouncilStorageDurabilityOperation, targetPath: string) => void;
}

function assertRunId(runId: string): void {
	if (!COUNCIL_RUN_ID_PATTERN.test(runId) || runId === "." || runId === "..") {
		throw new CouncilStorageError("COUNCIL_ARTIFACT_INVALID", `Invalid council run id ${JSON.stringify(runId)}`);
	}
}

function assertArtifactName(name: string): void {
	if (!COUNCIL_ARTIFACT_NAME_PATTERN.test(name)) {
		throw new CouncilStorageError(
			"COUNCIL_ARTIFACT_INVALID",
			`Invalid council artifact name ${JSON.stringify(name)}`,
		);
	}
}

/** The only council filename builder. Council artifacts are direct children of the active local:// root. */
export function councilArtifactFilename(runId: string, name: string): string {
	assertRunId(runId);
	assertArtifactName(name);
	const filename = `council-${runId}-${name}`;
	if (!COUNCIL_FLAT_FILENAME_PATTERN.test(filename)) {
		throw new CouncilStorageError(
			"COUNCIL_ARTIFACT_INVALID",
			`Invalid council artifact filename ${JSON.stringify(filename)}`,
		);
	}
	return filename;
}

export function councilArtifactUrl(runId: string, name: string): string {
	return `local://${councilArtifactFilename(runId, name)}`;
}

interface CouncilStorageSession {
	localProtocolOptions: NonNullable<ToolSession["localProtocolOptions"]>;
	sessionManager: NonNullable<ToolSession["sessionManager"]>;
	sessionId: string;
}

function requireIdentity(value: string | null | undefined, source: string): string {
	if (typeof value !== "string" || value.length === 0) {
		throw new CouncilStorageError(
			"COUNCIL_STORAGE_UNAVAILABLE",
			`Council storage requires ${source} session identity`,
		);
	}
	return value;
}

function requireStorageSession(
	session: Pick<ToolSession, "localProtocolOptions" | "sessionManager">,
): CouncilStorageSession {
	if (!session.localProtocolOptions) {
		throw new CouncilStorageError(
			"COUNCIL_STORAGE_UNAVAILABLE",
			"Council storage requires the calling ToolSession.localProtocolOptions",
		);
	}
	if (!session.sessionManager) {
		throw new CouncilStorageError(
			"COUNCIL_STORAGE_UNAVAILABLE",
			"Council storage requires the calling session manager",
		);
	}
	const localSessionId = requireIdentity(session.localProtocolOptions.getSessionId?.(), "localProtocolOptions");
	const managerSessionId = requireIdentity(session.sessionManager.getSessionId(), "sessionManager");
	if (localSessionId !== managerSessionId) {
		throw new CouncilStorageError(
			"COUNCIL_STORAGE_UNAVAILABLE",
			`Council storage session identities disagree: ${JSON.stringify(localSessionId)} != ${JSON.stringify(managerSessionId)}`,
		);
	}
	return {
		localProtocolOptions: session.localProtocolOptions,
		sessionManager: session.sessionManager,
		sessionId: localSessionId,
	};
}

async function assertFinalNotSymlink(filesystem: CouncilStorageFileSystem, targetPath: string): Promise<void> {
	try {
		const info = await filesystem.lstat(targetPath);
		if (info.isSymbolicLink() || !info.isFile()) throw new Error("target is not a real file");
	} catch (error) {
		if (!hasFsCode(error, "ENOENT")) throw error;
	}
}

async function durableReplace(
	filesystem: CouncilStorageFileSystem,
	targetPath: string,
	content: string,
	canonicalRoot: string,
	options: Required<Pick<CouncilStorageOptions, "randomUUID">> & Pick<CouncilStorageOptions, "onDurabilityOperation">,
): Promise<void> {
	const tempPath = councilTempPath(canonicalRoot, path.basename(targetPath), options.randomUUID());
	let handle: fs.FileHandle | undefined;
	try {
		if (
			path.dirname(targetPath) !== canonicalRoot ||
			(await filesystem.realpath(path.dirname(targetPath))) !== canonicalRoot
		) {
			throw new Error("council artifact parent escapes canonical local root");
		}
		await assertFinalNotSymlink(filesystem, targetPath);
		handle = await filesystem.open(tempPath, COUNCIL_STAGE_FLAGS, COUNCIL_STAGE_MODE);
		await handle.writeFile(content, "utf8");
		await handle.sync();
		options.onDurabilityOperation?.("file-sync", tempPath);
		await handle.close();
		handle = undefined;
		if ((await filesystem.realpath(path.dirname(targetPath))) !== canonicalRoot) {
			throw new Error("council artifact parent changed before rename");
		}
		await assertFinalNotSymlink(filesystem, targetPath);
		await renameReplacing(filesystem, tempPath, targetPath);
		options.onDurabilityOperation?.("rename", targetPath);
		if ((await filesystem.realpath(path.dirname(targetPath))) !== canonicalRoot) {
			throw new Error("council artifact parent changed after rename");
		}
		await assertFinalNotSymlink(filesystem, targetPath);
		await syncDirectory(filesystem, canonicalRoot, options.onDurabilityOperation);
	} catch (error) {
		await handle?.close().catch(() => {});
		await filesystem.unlink(tempPath).catch(() => {});
		throw error;
	}
}

async function durableCreate(
	filesystem: CouncilStorageFileSystem,
	targetPath: string,
	content: string,
	canonicalRoot: string,
	options: Required<Pick<CouncilStorageOptions, "randomUUID">> & Pick<CouncilStorageOptions, "onDurabilityOperation">,
): Promise<void> {
	const tempPath = councilTempPath(canonicalRoot, path.basename(targetPath), options.randomUUID());
	let handle: fs.FileHandle | undefined;
	let staged = false;
	try {
		if (
			path.dirname(targetPath) !== canonicalRoot ||
			(await filesystem.realpath(path.dirname(targetPath))) !== canonicalRoot
		) {
			throw new Error("council artifact parent escapes canonical local root");
		}
		handle = await filesystem.open(tempPath, COUNCIL_STAGE_FLAGS, COUNCIL_STAGE_MODE);
		staged = true;
		await handle.writeFile(content, "utf8");
		await handle.sync();
		options.onDurabilityOperation?.("file-sync", tempPath);
		await handle.close();
		handle = undefined;
		if ((await filesystem.realpath(path.dirname(targetPath))) !== canonicalRoot) {
			throw new Error("council artifact parent changed before install");
		}
		try {
			await linkExclusive(filesystem, tempPath, targetPath);
		} catch (error) {
			if (hasFsCode(error, "EEXIST")) {
				throw new CouncilStorageError("COUNCIL_RUN_EXISTS", "Council run manifest already exists", {
					cause: error,
				});
			}
			throw error;
		}
		options.onDurabilityOperation?.("link", targetPath);
		if ((await filesystem.realpath(path.dirname(targetPath))) !== canonicalRoot) {
			throw new Error("council artifact parent changed after install");
		}
		await assertFinalNotSymlink(filesystem, targetPath);
		await syncDirectory(filesystem, canonicalRoot, options.onDurabilityOperation);
		await filesystem.unlink(tempPath);
		staged = false;
		options.onDurabilityOperation?.("unlink", tempPath);
		await syncDirectory(filesystem, canonicalRoot, options.onDurabilityOperation);
	} catch (error) {
		await handle?.close().catch(() => {});
		if (staged) {
			try {
				await filesystem.unlink(tempPath);
				options.onDurabilityOperation?.("unlink", tempPath);
				await syncDirectory(filesystem, canonicalRoot, options.onDurabilityOperation);
			} catch (cleanupError) {
				// The target was already installed, so the original failure is what the operator must
				// see; the cleanup failure only explains the leftover temp file.
				throw new Error(`Could not durably remove staged council artifact: ${String(cleanupError)}`, {
					cause: error,
				});
			}
		}
		throw error;
	}
}

type ArtifactOwner =
	| {
			reference: CouncilArtifactReference;
			expectedUrl: string;
			kind: "instructions";
	  }
	| {
			reference: CouncilArtifactReference;
			expectedUrl: string;
			kind: "member";
			roundIndex: number;
			memberIndex: number;
	  }
	| {
			reference: CouncilArtifactReference;
			expectedUrl: string;
			kind: "plan";
			planIndex: number;
	  };

interface OrphanArtifact {
	reference: CouncilArtifactReference;
	content: string;
}

interface ArtifactProblem {
	owner: ArtifactOwner;
	reason: string;
	code: CouncilStorageErrorCode;
}

const PLANNER_METADATA_MARKER = "council-planner-metadata";
const ADJUDICATION_METADATA_MARKER = "council-adjudication-metadata";

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodeCouncilMetadata(content: string, marker: string): { plan: string; metadata: unknown } {
	const match = new RegExp(`\\n\\n<!-- ${marker}:([A-Za-z0-9+/=]+) -->\\n$`).exec(content);
	if (!match) throw new Error(`Council artifact is missing exact ${marker} framing`);
	const encoded = match[1];
	if (!encoded) throw new Error(`Council artifact has empty ${marker}`);
	const metadata: unknown = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
	return { plan: content.slice(0, match.index), metadata };
}

function validateArtifactContent(
	manifest: CouncilManifest,
	owner: ArtifactOwner,
	content: string,
	priorCanonicalIds: readonly string[],
): readonly string[] {
	if (owner.kind === "instructions") {
		const candidate: unknown = JSON.parse(content);
		parseCouncilInstructionSnapshot(candidate, manifest.repoRoot);
		return priorCanonicalIds;
	}
	if (owner.kind === "member") {
		const round = manifest.rounds[owner.roundIndex];
		const member = round?.members[owner.memberIndex];
		if (!round || !member) throw new Error("Council member artifact owner is outside the persisted roster");
		const candidate: unknown = JSON.parse(content);
		const report = validatePersistedCouncilReport(
			candidate,
			owner.roundIndex * manifest.roster.length + owner.memberIndex,
		);
		const reportIds = report.findings.map(finding => finding.id);
		if (
			reportIds.length !== member.findingIds.length ||
			reportIds.some((findingId, index) => findingId !== member.findingIds[index])
		) {
			throw new Error(`Persisted council report finding IDs do not match ${member.role} round ${round.round}`);
		}
		return priorCanonicalIds;
	}

	const version = manifest.planVersions[owner.planIndex];
	if (!version) throw new Error("Council plan artifact owner is outside the persisted plan versions");
	if (version.kind === "draft") {
		const { plan, metadata } = decodeCouncilMetadata(content, PLANNER_METADATA_MARKER);
		if (!isUnknownRecord(metadata)) throw new Error("Council planner metadata is not an object");
		validateCouncilPlannerOutput({
			plan,
			assumptions: metadata.assumptions,
			blockers: metadata.blockers,
			evidenceVersion: metadata.evidenceVersion,
		});
		return priorCanonicalIds;
	}

	const { plan, metadata } = decodeCouncilMetadata(content, ADJUDICATION_METADATA_MARKER);
	if (!isUnknownRecord(metadata)) throw new Error("Council adjudication metadata is not an object");
	const round = manifest.rounds[version.round - 1];
	if (!round) throw new Error(`Council plan version ${version.version} has no owning round`);
	const expectedIds = round.members.flatMap(member => member.findingIds);
	const adjudication = validateCouncilAdjudication(metadata.adjudication, expectedIds, priorCanonicalIds);
	if (adjudication.plan !== plan)
		throw new Error(`Council plan version ${version.version} metadata disagrees with its plan`);
	return adjudication.dispositions
		.filter(disposition => disposition.disposition !== "duplicate")
		.map(disposition => disposition.id);
}

export class CouncilStorage {
	readonly rootPath: string;
	readonly rootUrl = "local://";
	readonly #session: CouncilStorageSession;
	readonly #filesystem: CouncilStorageFileSystem;
	readonly #now: () => string;
	readonly #randomUUID: () => string;
	readonly #onDurabilityOperation: CouncilStorageOptions["onDurabilityOperation"];

	constructor(
		session: Pick<ToolSession, "localProtocolOptions" | "sessionManager">,
		options: CouncilStorageOptions = {},
	) {
		this.#session = requireStorageSession(session);
		this.#filesystem = options.filesystem ?? fs;
		this.#now = options.now ?? (() => new Date().toISOString());
		this.#randomUUID = options.randomUUID ?? Bun.randomUUIDv7;
		this.#onDurabilityOperation = options.onDurabilityOperation;
		this.rootPath = resolveLocalUrlToPath("local://", this.#session.localProtocolOptions);
	}

	artifactUrl(runId: string, name: string): string {
		return councilArtifactUrl(runId, name);
	}

	/**
	 * Canonical directory council plans are published into — the same session `local://` root the
	 * run's artifacts already live in, so a council run creates nothing in the working tree.
	 */
	async canonicalPlanRoot(): Promise<string> {
		return this.#canonicalRoot(true);
	}

	async create(manifest: CouncilManifest): Promise<CouncilManifest> {
		let snapshot = parseCouncilManifest(structuredClone(manifest));
		this.#assertManifestIdentity(snapshot);
		snapshot.timestamps.updatedAt = this.#now();
		snapshot = parseCouncilManifest(snapshot);
		const canonicalRoot = await this.#canonicalRoot(true);
		const manifestPath = path.join(canonicalRoot, councilArtifactFilename(snapshot.runId, "manifest.json"));
		try {
			await durableCreate(this.#filesystem, manifestPath, `${JSON.stringify(snapshot, null, 2)}\n`, canonicalRoot, {
				randomUUID: this.#randomUUID,
				onDurabilityOperation: this.#onDurabilityOperation,
			});
			const journalSnapshot = structuredClone(snapshot);
			this.#assertCurrentSessionIdentity();
			this.#session.sessionManager.appendCustomEntry(COUNCIL_RUN_MESSAGE_TYPE, journalSnapshot);
			this.#onDurabilityOperation?.("journal", manifestPath);
		} catch (error) {
			if (error instanceof CouncilStorageError) {
				if (error.code === "COUNCIL_RUN_EXISTS") {
					throw new CouncilStorageError("COUNCIL_RUN_EXISTS", `Council run ${snapshot.runId} already exists`, {
						cause: error,
					});
				}
				throw error;
			}
			throw new CouncilStorageError("COUNCIL_STORAGE_IO", `Could not create council run ${snapshot.runId}`, {
				cause: error,
			});
		}
		return structuredClone(snapshot);
	}

	async createArtifact(runId: string, name: string, content: string): Promise<CouncilArtifactReference> {
		assertRunId(runId);
		assertArtifactName(name);
		if (name === "manifest.json") {
			throw new CouncilStorageError(
				"COUNCIL_ARTIFACT_INVALID",
				`Invalid creatable council artifact ${JSON.stringify(name)}`,
			);
		}
		const canonicalRoot = await this.#canonicalRoot(true);
		const targetPath = path.join(canonicalRoot, councilArtifactFilename(runId, name));
		try {
			await durableCreate(this.#filesystem, targetPath, content, canonicalRoot, {
				randomUUID: this.#randomUUID,
				onDurabilityOperation: this.#onDurabilityOperation,
			});
		} catch (error) {
			if (error instanceof CouncilStorageError) throw error;
			throw new CouncilStorageError("COUNCIL_STORAGE_IO", `Could not create council artifact ${name}`, {
				cause: error,
			});
		}
		return {
			url: councilArtifactUrl(runId, name),
			sha256: sha256CouncilContent(content),
			bytes: Buffer.byteLength(content),
		};
	}

	async checkpoint(manifest: CouncilManifest): Promise<CouncilManifest> {
		return this.#persistCheckpoint(manifest, this.#now());
	}

	async writeArtifact(runId: string, name: string, content: string): Promise<CouncilArtifactReference> {
		assertRunId(runId);
		assertArtifactName(name);
		if (name === "manifest.json" || name === "instructions.json") {
			throw new CouncilStorageError(
				"COUNCIL_ARTIFACT_INVALID",
				`Invalid writable council artifact ${JSON.stringify(name)}`,
			);
		}
		const canonicalRoot = await this.#canonicalRoot(false);
		const targetPath = path.join(canonicalRoot, councilArtifactFilename(runId, name));
		try {
			await durableCreate(this.#filesystem, targetPath, content, canonicalRoot, {
				randomUUID: this.#randomUUID,
				onDurabilityOperation: this.#onDurabilityOperation,
			});
		} catch (error) {
			if (error instanceof CouncilStorageError) throw error;
			throw new CouncilStorageError("COUNCIL_STORAGE_IO", `Could not write council artifact ${name}`, {
				cause: error,
			});
		}
		return {
			url: councilArtifactUrl(runId, name),
			sha256: sha256CouncilContent(content),
			bytes: Buffer.byteLength(content),
		};
	}

	async readArtifact(reference: CouncilArtifactReference): Promise<string> {
		const parsed = this.#parseArtifactUrl(reference.url);
		const canonicalRoot = await this.#canonicalRoot(false);
		const artifactPath = path.join(canonicalRoot, councilArtifactFilename(parsed.runId, parsed.name));
		return this.#readVerifiedArtifact(
			reference,
			artifactPath,
			canonicalRoot,
			parsed.name === "instructions.json" ? COUNCIL_INSTRUCTION_ARTIFACT_BYTE_LIMIT : undefined,
		);
	}

	async load(runId: string): Promise<CouncilManifest> {
		assertRunId(runId);
		const canonicalRoot = await this.#canonicalRoot(false).catch(error => {
			if (hasFsCode(error, "ENOENT")) {
				throw new CouncilStorageError("COUNCIL_RUN_NOT_FOUND", `Council run ${runId} has no manifest`, {
					cause: error,
				});
			}
			throw error;
		});
		const manifestPath = path.join(canonicalRoot, councilArtifactFilename(runId, "manifest.json"));
		let raw: string;
		try {
			raw = await this.#readFileNoFollow(manifestPath, canonicalRoot);
		} catch (error) {
			if (hasFsCode(error, "ENOENT")) {
				throw new CouncilStorageError("COUNCIL_RUN_NOT_FOUND", `Council run ${runId} has no manifest`, {
					cause: error,
				});
			}
			throw new CouncilStorageError("COUNCIL_RECOVERY_CORRUPT", `Council manifest for ${runId} is unreadable`, {
				cause: error,
			});
		}
		let candidate: unknown;
		try {
			candidate = JSON.parse(raw);
		} catch (error) {
			throw new CouncilStorageError("COUNCIL_RECOVERY_CORRUPT", `Council manifest for ${runId} is invalid JSON`, {
				cause: error,
			});
		}
		let manifest: CouncilManifest;
		try {
			manifest = parseCouncilManifest(candidate);
		} catch (error) {
			const diagnostic = error instanceof CouncilManifestError ? error.message : String(error);
			throw new CouncilStorageError("COUNCIL_RECOVERY_CORRUPT", diagnostic, { cause: error });
		}
		if (manifest.runId !== runId) {
			throw new CouncilStorageError(
				"COUNCIL_RECOVERY_CORRUPT",
				`Council manifest runId ${JSON.stringify(manifest.runId)} does not match requested run ${JSON.stringify(runId)}`,
			);
		}
		this.#assertManifestIdentity(manifest);

		const owners = this.#artifactOwners(manifest);
		const seen = new Set<string>();
		for (const owner of owners) {
			if (owner.reference.url !== owner.expectedUrl || seen.has(owner.reference.url)) {
				throw new CouncilStorageError(
					"COUNCIL_RECOVERY_CORRUPT",
					`Council manifest ${runId} contains a foreign or ambiguous artifact reference ${owner.reference.url}`,
				);
			}
			seen.add(owner.reference.url);
		}

		const problems: ArtifactProblem[] = [];
		let priorCanonicalIds: readonly string[] = [];
		let planValidationBlocked = false;
		for (const owner of owners) {
			const filename = owner.expectedUrl.slice("local://".length);
			try {
				const content = await this.#readVerifiedArtifact(
					owner.reference,
					path.join(canonicalRoot, filename),
					canonicalRoot,
					owner.kind === "instructions" ? COUNCIL_INSTRUCTION_ARTIFACT_BYTE_LIMIT : undefined,
				);
				if (owner.kind !== "plan" || !planValidationBlocked) {
					try {
						priorCanonicalIds = validateArtifactContent(manifest, owner, content, priorCanonicalIds);
					} catch (error) {
						throw new CouncilStorageError(
							"COUNCIL_RECOVERY_CORRUPT",
							`Council artifact ${owner.reference.url} is semantically invalid: ${
								error instanceof Error ? error.message : String(error)
							}`,
							{ cause: error },
						);
					}
				}
			} catch (error) {
				if (!(error instanceof CouncilStorageError)) throw error;
				if (owner.kind === "instructions") throw error;
				if (error.code !== "COUNCIL_RECOVERY_CORRUPT" || !hasFsCode(error.cause, "ENOENT")) throw error;
				problems.push({ owner, reason: error.message, code: error.code });
				if (owner.kind === "plan") planValidationBlocked = true;
			}
		}
		if (problems.length > 0) {
			const recoveryTime = this.#now();
			const recovered = this.#reconcileArtifactProblems(manifest, problems, recoveryTime);
			await this.#persistCheckpoint(recovered, recoveryTime);
			return recovered;
		}
		const orphanTime = this.#now();
		const adopted = await this.#adoptOrphanArtifacts(manifest, canonicalRoot, priorCanonicalIds, orphanTime);
		if (adopted) {
			manifest = adopted;
			await this.#persistCheckpoint(manifest, orphanTime);
		}

		if (manifest.published && manifest.state !== "completed" && manifest.state !== "completed-degraded") {
			let matches: boolean;
			try {
				matches = await publishedCouncilPlanMatches(canonicalRoot, manifest.outputPath, manifest.published, {
					filesystem: this.#filesystem,
				});
			} catch (error) {
				throw new CouncilStorageError(
					"COUNCIL_RECOVERY_CORRUPT",
					`Published council plan ${manifest.outputPath} could not be verified`,
					{ cause: error },
				);
			}
			if (!matches) {
				throw new CouncilStorageError(
					"COUNCIL_ARTIFACT_HASH_MISMATCH",
					`Published council plan ${manifest.outputPath} does not match manifest hash ${manifest.published.sha256}`,
				);
			}
		}
		const recoveryTime = this.#now();
		const recovered = normalizeRecoveredCouncilManifest(manifest, recoveryTime);
		if (recovered.state !== manifest.state) await this.#persistCheckpoint(recovered, recoveryTime);
		return recovered;
	}

	async list(): Promise<CouncilManifest[]> {
		let canonicalRoot: string;
		try {
			canonicalRoot = await this.#canonicalRoot(false);
		} catch (error) {
			if (hasFsCode(error, "ENOENT")) return [];
			if (error instanceof CouncilStorageError) throw error;
			throw new CouncilStorageError("COUNCIL_STORAGE_IO", "Could not list council runs", { cause: error });
		}
		let names: string[];
		try {
			names = await this.#filesystem.readdir(canonicalRoot);
		} catch (error) {
			throw new CouncilStorageError("COUNCIL_STORAGE_IO", "Could not list council runs", { cause: error });
		}
		const suffix = "-manifest.json";
		const runIds = names
			.filter(name => name.startsWith("council-") && name.endsWith(suffix))
			.map(name => name.slice("council-".length, -suffix.length))
			.filter(runId => COUNCIL_RUN_ID_PATTERN.test(runId))
			// Codepoint order, not `localeCompare`. `sort` is stable and both callers re-sort by
			// `createdAt` and take the head, so this is the tie-break when two runs share a millisecond:
			// under ICU collation `-`, `_`, and `.` are variable-weighted, which would make
			// `/council resume` pick a different run on a different host locale or ICU build.
			.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
		const manifests: CouncilManifest[] = [];
		for (const id of runIds) {
			try {
				manifests.push(await this.load(id));
			} catch (error) {
				if (!(error instanceof CouncilStorageError)) throw error;
				logger.warn("Skipping unreadable council run while listing", {
					runId: id,
					code: error.code,
					error: error.message,
				});
			}
		}
		return manifests;
	}

	/**
	 * Decode every persisted adjudication, keyed by the round it settled.
	 *
	 * Keyed by round rather than exposed one version at a time because a `CouncilPlanVersion` carries
	 * no finding ids, and a round-two adjudication legitimately contains **only** round-two
	 * dispositions: validating every member's `findingIds` against the final adjudication alone would
	 * drop or mis-flag every round-one disposition. Each version is therefore validated against its
	 * own round's expected ids and the previous round's canonical duplicate targets, exactly as
	 * `load()` does while verifying artifact content.
	 */
	async readAdjudications(manifest: CouncilManifest): Promise<Map<number, CouncilAdjudication>> {
		const adjudications = new Map<number, CouncilAdjudication>();
		let priorCanonicalIds: readonly string[] = [];
		const ordered = [...manifest.planVersions].sort((left, right) => left.version - right.version);
		for (const version of ordered) {
			if (version.kind !== "round" && version.kind !== "final") continue;
			const round = manifest.rounds[version.round - 1];
			if (!round) {
				throw new CouncilStorageError(
					"COUNCIL_RECOVERY_CORRUPT",
					`Council plan version ${version.version} has no owning round`,
				);
			}
			const content = await this.readArtifact(version.artifact);
			let adjudication: CouncilAdjudication;
			try {
				const { metadata } = decodeCouncilMetadata(content, ADJUDICATION_METADATA_MARKER);
				if (!isUnknownRecord(metadata)) throw new Error("Council adjudication metadata is not an object");
				adjudication = validateCouncilAdjudication(
					metadata.adjudication,
					round.members.flatMap(member => member.findingIds),
					priorCanonicalIds,
				);
			} catch (error) {
				throw new CouncilStorageError(
					"COUNCIL_RECOVERY_CORRUPT",
					`Council artifact ${version.artifact.url} is semantically invalid: ${
						error instanceof Error ? error.message : String(error)
					}`,
					{ cause: error },
				);
			}
			adjudications.set(version.round, adjudication);
			priorCanonicalIds = adjudication.dispositions
				.filter(disposition => disposition.disposition !== "duplicate")
				.map(disposition => disposition.id);
		}
		return adjudications;
	}

	async #persistCheckpoint(manifest: CouncilManifest, updatedAt: string): Promise<CouncilManifest> {
		let snapshot = parseCouncilManifest(structuredClone(manifest));
		this.#assertManifestIdentity(snapshot);
		snapshot.timestamps.updatedAt = updatedAt;
		snapshot = parseCouncilManifest(snapshot);
		const canonicalRoot = await this.#canonicalRoot(true);
		const targetPath = path.join(canonicalRoot, councilArtifactFilename(snapshot.runId, "manifest.json"));
		try {
			await durableReplace(this.#filesystem, targetPath, `${JSON.stringify(snapshot, null, 2)}\n`, canonicalRoot, {
				randomUUID: this.#randomUUID,
				onDurabilityOperation: this.#onDurabilityOperation,
			});
			const journalSnapshot = structuredClone(snapshot);
			this.#assertCurrentSessionIdentity();
			this.#session.sessionManager.appendCustomEntry(COUNCIL_RUN_MESSAGE_TYPE, journalSnapshot);
			this.#onDurabilityOperation?.("journal", targetPath);
		} catch (error) {
			if (error instanceof CouncilStorageError) throw error;
			throw new CouncilStorageError("COUNCIL_STORAGE_IO", `Could not checkpoint council run ${snapshot.runId}`, {
				cause: error,
			});
		}
		return structuredClone(snapshot);
	}

	#assertManifestIdentity(manifest: CouncilManifest): void {
		if (manifest.sessionId !== this.#session.sessionId) {
			throw new CouncilStorageError(
				"COUNCIL_RECOVERY_CORRUPT",
				`Council manifest sessionId ${JSON.stringify(manifest.sessionId)} does not match active session ${JSON.stringify(this.#session.sessionId)}`,
			);
		}
	}

	#assertCurrentSessionIdentity(): void {
		const localSessionId = requireIdentity(
			this.#session.localProtocolOptions.getSessionId?.(),
			"localProtocolOptions",
		);
		const managerSessionId = requireIdentity(this.#session.sessionManager.getSessionId(), "sessionManager");
		if (localSessionId !== this.#session.sessionId || managerSessionId !== this.#session.sessionId) {
			throw new CouncilStorageError(
				"COUNCIL_STORAGE_UNAVAILABLE",
				`Council storage session changed before journal append: expected ${JSON.stringify(
					this.#session.sessionId,
				)}, received local=${JSON.stringify(localSessionId)}, manager=${JSON.stringify(managerSessionId)}`,
			);
		}
	}

	async #canonicalRoot(create: boolean): Promise<string> {
		return canonicalizeLocalRoot(this.rootPath, this.#filesystem, {
			create,
			onDurabilityOperation: this.#onDurabilityOperation,
		});
	}

	async #readFileNoFollow(targetPath: string, canonicalRoot: string, maxBytes?: number): Promise<string> {
		if (
			path.dirname(targetPath) !== canonicalRoot ||
			(await this.#filesystem.realpath(path.dirname(targetPath))) !== canonicalRoot
		) {
			throw new Error("council artifact parent escapes canonical local root");
		}
		const info = await this.#filesystem.lstat(targetPath);
		if (info.isSymbolicLink() || !info.isFile()) throw new Error("council artifact is not a real file");
		const handle = await this.#filesystem.open(targetPath, COUNCIL_READ_FLAGS);
		try {
			const openedInfo = await handle.stat();
			if (!openedInfo.isFile()) throw new Error("council artifact is not a regular file");
			// `O_NOFOLLOW` is a no-op on Windows, where reparse points still exist, so identity of the
			// opened file against the `lstat` above is what actually closes the check-then-open race.
			if (openedInfo.dev !== info.dev || openedInfo.ino !== info.ino) {
				throw new Error("council artifact changed during read");
			}
			if (maxBytes !== undefined && openedInfo.size > maxBytes) {
				throw new Error(`council artifact exceeds ${maxBytes} byte read limit`);
			}
			if ((await this.#filesystem.realpath(path.dirname(targetPath))) !== canonicalRoot) {
				throw new Error("council artifact parent changed during read");
			}
			return await handle.readFile("utf8");
		} finally {
			await handle.close();
		}
	}

	async #readVerifiedArtifact(
		reference: CouncilArtifactReference,
		artifactPath: string,
		canonicalRoot: string,
		maxBytes?: number,
	): Promise<string> {
		let content: Buffer;
		try {
			if (maxBytes !== undefined && reference.bytes > maxBytes) {
				throw new Error(`council artifact reference exceeds ${maxBytes} byte read limit`);
			}
			const raw = await this.#readFileNoFollow(artifactPath, canonicalRoot, maxBytes);
			content = Buffer.from(raw, "utf8");
		} catch (error) {
			const condition = hasFsCode(error, "ENOENT") ? "is missing" : "is unreadable";
			throw new CouncilStorageError("COUNCIL_RECOVERY_CORRUPT", `Council artifact ${reference.url} ${condition}`, {
				cause: error,
			});
		}
		const actualHash = sha256CouncilContent(content);
		if (actualHash !== reference.sha256 || content.byteLength !== reference.bytes) {
			throw new CouncilStorageError(
				"COUNCIL_ARTIFACT_HASH_MISMATCH",
				`Council artifact ${reference.url} hash/size mismatch: expected ${reference.sha256}/${reference.bytes}, received ${actualHash}/${content.byteLength}`,
			);
		}
		return content.toString("utf8");
	}

	async #readOrphanArtifact(runId: string, name: string, canonicalRoot: string): Promise<OrphanArtifact | undefined> {
		const targetPath = path.join(canonicalRoot, councilArtifactFilename(runId, name));
		let content: string;
		try {
			content = await this.#readFileNoFollow(targetPath, canonicalRoot);
		} catch (error) {
			if (hasFsCode(error, "ENOENT")) return undefined;
			throw new CouncilStorageError(
				"COUNCIL_RECOVERY_CORRUPT",
				`Council orphan artifact ${councilArtifactUrl(runId, name)} is unreadable`,
				{ cause: error },
			);
		}
		return {
			reference: {
				url: councilArtifactUrl(runId, name),
				sha256: sha256CouncilContent(content),
				bytes: Buffer.byteLength(content),
			},
			content,
		};
	}

	async #adoptOrphanArtifacts(
		manifest: CouncilManifest,
		canonicalRoot: string,
		priorCanonicalIds: readonly string[],
		now: string,
	): Promise<CouncilManifest | undefined> {
		const recovered = structuredClone(manifest);
		try {
			if (recovered.planVersions.length === 0) {
				const draft = await this.#readOrphanArtifact(recovered.runId, "draft.md", canonicalRoot);
				if (!draft) return undefined;
				recovered.planVersions.push({
					version: 1,
					round: 0,
					kind: "draft",
					artifact: draft.reference,
					createdAt: now,
				});
				validateArtifactContent(
					recovered,
					{ kind: "plan", reference: draft.reference, expectedUrl: draft.reference.url, planIndex: 0 },
					draft.content,
					[],
				);
				return parseCouncilManifest(recovered);
			}

			const roundNumber = recovered.planVersions.length;
			if (roundNumber > recovered.rounds.length) return undefined;
			const round = recovered.rounds[roundNumber - 1];
			if (!round) return undefined;
			let adoptedMember = false;
			for (const [memberIndex, member] of round.members.entries()) {
				if (member.artifact || member.status === "succeeded") continue;
				const orphan = await this.#readOrphanArtifact(
					recovered.runId,
					`${member.role}-r${roundNumber}.json`,
					canonicalRoot,
				);
				if (!orphan) continue;
				if (member.attempts === 0 || member.startedAt === null || member.resolvedModel === null) {
					throw new Error(
						`Council orphan report ${orphan.reference.url} has no durable running-slot prerequisite`,
					);
				}
				const candidate: unknown = JSON.parse(orphan.content);
				const report = validatePersistedCouncilReport(
					candidate,
					(roundNumber - 1) * recovered.roster.length + memberIndex,
				);
				member.status = "succeeded";
				member.finishedAt = now;
				member.artifact = orphan.reference;
				member.failureReason = null;
				member.findingIds = report.findings.map(finding => finding.id);
				adoptedMember = true;
			}
			if (adoptedMember) {
				if (round.members.every(member => member.status !== "pending" && member.status !== "running")) {
					round.status = "settled";
					round.finishedAt = now;
				} else if (!round.members.some(member => member.status === "running")) {
					throw new Error(`Council round ${roundNumber} orphan reports have no active durable slot`);
				}
				return parseCouncilManifest(recovered);
			}

			if (round.status !== "settled") return undefined;
			const orphan = await this.#readOrphanArtifact(recovered.runId, `round${roundNumber}.md`, canonicalRoot);
			if (!orphan) return undefined;
			const planIndex = recovered.planVersions.length;
			recovered.planVersions.push({
				version: planIndex + 1,
				round: roundNumber,
				kind: roundNumber === recovered.config.rounds ? "final" : "round",
				artifact: orphan.reference,
				createdAt: now,
			});
			validateArtifactContent(
				recovered,
				{ kind: "plan", reference: orphan.reference, expectedUrl: orphan.reference.url, planIndex },
				orphan.content,
				priorCanonicalIds,
			);
			return parseCouncilManifest(recovered);
		} catch (error) {
			if (error instanceof CouncilStorageError) throw error;
			throw new CouncilStorageError(
				"COUNCIL_RECOVERY_CORRUPT",
				`Council run ${manifest.runId} contains an invalid deterministic orphan artifact: ${
					error instanceof Error ? error.message : String(error)
				}`,
				{ cause: error },
			);
		}
	}

	#artifactOwners(manifest: CouncilManifest): ArtifactOwner[] {
		const owners: ArtifactOwner[] = [];
		owners.push({
			reference: manifest.instructionSnapshot.artifact,
			expectedUrl: councilArtifactUrl(manifest.runId, "instructions.json"),
			kind: "instructions",
		});
		for (const [roundIndex, round] of manifest.rounds.entries()) {
			for (const [memberIndex, member] of round.members.entries()) {
				if (!member.artifact) continue;
				owners.push({
					reference: member.artifact,
					expectedUrl: councilArtifactUrl(manifest.runId, `${member.role}-r${round.round}.json`),
					kind: "member",
					roundIndex,
					memberIndex,
				});
			}
		}
		for (const [planIndex, version] of manifest.planVersions.entries()) {
			const name = version.kind === "draft" ? "draft.md" : `round${version.round}.md`;
			owners.push({
				reference: version.artifact,
				expectedUrl: councilArtifactUrl(manifest.runId, name),
				kind: "plan",
				planIndex,
			});
		}
		return owners;
	}

	#reconcileArtifactProblems(
		manifest: CouncilManifest,
		problems: readonly ArtifactProblem[],
		now: string,
	): CouncilManifest {
		const recovered = structuredClone(manifest);
		let firstLostPlanIndex = recovered.planVersions.length;
		let resetAfterRound: number | undefined;
		let firstBadPlanIndex: number | undefined;
		let firstBadPlanReason: string | undefined;
		let firstBadPlanCode: CouncilStorageErrorCode | undefined;

		for (const problem of problems) {
			if (problem.owner.kind === "member") {
				const round = recovered.rounds[problem.owner.roundIndex];
				const member = round?.members[problem.owner.memberIndex];
				if (!round || !member) throw new Error("Council member artifact problem has no owning slot");
				member.status = "interrupted";
				member.finishedAt = now;
				member.artifact = null;
				member.findingIds = [];
				member.failureReason = `Recovery interrupted ${member.role} round ${round.round}: ${problem.reason}`;
				round.status = "interrupted";
				round.finishedAt = now;
				resetAfterRound = Math.min(resetAfterRound ?? round.round, round.round);
				const dependentPlanIndex = recovered.planVersions.findIndex(version => version.round >= round.round);
				if (dependentPlanIndex >= 0) firstLostPlanIndex = Math.min(firstLostPlanIndex, dependentPlanIndex);
				continue;
			}
			if (problem.owner.kind === "instructions") {
				throw new Error("Council instruction artifact cannot be reconciled");
			}

			if (firstBadPlanIndex === undefined || problem.owner.planIndex < firstBadPlanIndex) {
				firstBadPlanIndex = problem.owner.planIndex;
				firstBadPlanReason = problem.reason;
				firstBadPlanCode = problem.code;
			}
		}

		if (firstBadPlanIndex !== undefined) {
			const badVersion = recovered.planVersions[firstBadPlanIndex];
			if (!badVersion) throw new Error("Council plan artifact problem has no owning version");
			if (firstBadPlanReason === undefined || firstBadPlanCode === undefined) {
				throw new Error("Council plan artifact problem is missing recovery diagnostics");
			}
			firstLostPlanIndex = Math.min(firstLostPlanIndex, firstBadPlanIndex);
			resetAfterRound = Math.min(resetAfterRound ?? badVersion.round, badVersion.round);
			recovered.failure = {
				phase: `planVersions[${firstBadPlanIndex}]`,
				reason: `Recovery interrupted planner output: ${firstBadPlanReason}`,
				code: firstBadPlanCode,
				time: now,
			};
		}

		if (firstLostPlanIndex < recovered.planVersions.length) {
			recovered.planVersions = recovered.planVersions.slice(0, firstLostPlanIndex);
		}
		delete recovered.published;

		for (const round of recovered.rounds) {
			if (resetAfterRound !== undefined && round.round > resetAfterRound) {
				round.status = "pending";
				round.startedAt = null;
				round.finishedAt = null;
				for (const member of round.members) {
					member.status = "pending";
					member.attempts = 0;
					member.startedAt = null;
					member.finishedAt = null;
					member.artifact = null;
					member.resolvedModel = null;
					member.authFallbackUsed = false;
					member.failureReason = null;
					member.findingIds = [];
				}
				continue;
			}
			if (round.status !== "running") continue;
			round.status = "interrupted";
			round.finishedAt = now;
			for (const member of round.members) {
				if (member.status !== "running") continue;
				member.status = "interrupted";
				member.finishedAt = now;
			}
		}
		recovered.state = "interrupted";
		recovered.timestamps.updatedAt = now;
		recovered.timestamps.finishedAt = now;
		recovered.timestamps.interruptedAt = now;
		return parseCouncilManifest(recovered);
	}

	#parseArtifactUrl(url: string): { runId: string; name: string } {
		if (!url.startsWith("local://")) {
			throw new CouncilStorageError(
				"COUNCIL_ARTIFACT_INVALID",
				`Invalid council artifact URL ${JSON.stringify(url)}`,
			);
		}
		const filename = url.slice("local://".length);
		if (!COUNCIL_FLAT_FILENAME_PATTERN.test(filename) || filename.includes("/")) {
			throw new CouncilStorageError(
				"COUNCIL_ARTIFACT_INVALID",
				`Invalid council artifact URL ${JSON.stringify(url)}`,
			);
		}
		const body = filename.slice("council-".length);
		const suffixes = [
			/^(.*)-(instructions\.json)$/,
			/^(.*)-(draft\.md)$/,
			/^(.*)-(round[12]\.md)$/,
			/^(.*)-([a-z][a-z0-9]{0,63}-r[12]\.json)$/,
			/^(.*)-(manifest\.json)$/,
		] as const;
		for (const pattern of suffixes) {
			const match = pattern.exec(body);
			if (!match) continue;
			const runId = match[1]!;
			const name = match[2]!;
			assertRunId(runId);
			assertArtifactName(name);
			if (councilArtifactFilename(runId, name) === filename) return { runId, name };
		}
		throw new CouncilStorageError("COUNCIL_ARTIFACT_INVALID", `Invalid council artifact URL ${JSON.stringify(url)}`);
	}
}

export function createCouncilStorage(
	session: Pick<ToolSession, "localProtocolOptions" | "sessionManager">,
	options?: CouncilStorageOptions,
): CouncilStorage {
	return new CouncilStorage(session, options);
}

/**
 * Canonical council publication root for a session, resolvable before any manifest or storage
 * instance exists — preflight needs it to promise an output path before model spend.
 */
export async function councilPlanRoot(
	session: Pick<ToolSession, "localProtocolOptions" | "sessionManager">,
	options?: CouncilStorageOptions,
): Promise<string> {
	return new CouncilStorage(session, options).canonicalPlanRoot();
}
