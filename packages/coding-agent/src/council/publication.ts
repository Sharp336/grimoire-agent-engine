import * as nodeFs from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { sha256CouncilContent } from "./hash";
import { type CouncilPublishedArtifact, isValidCouncilOutputPath } from "./state";

export { sha256CouncilContent as hashCouncilContent } from "./hash";

export const COUNCIL_SLUG_MAX_LENGTH = 80;

export interface CouncilPublicationTarget {
	repoRoot: string;
	plansDirectory: string;
	slug: string;
	relativePath: string;
	absolutePath: string;
}

export interface StagedCouncilPublication {
	tempPath: string;
	sha256: string;
	bytes: number;
}

export interface CouncilPublicationResult extends CouncilPublishedArtifact {
	path: string;
	idempotent: boolean;
}

export interface CouncilPublicationFileSystem {
	open: typeof fs.open;
	lstat: typeof fs.lstat;
	realpath: typeof fs.realpath;
	mkdir: typeof fs.mkdir;
	link: typeof fs.link;
	unlink: typeof fs.unlink;
}

export type CouncilPublicationDurabilityOperation = "file-sync" | "link" | "directory-sync" | "unlink";

export interface CouncilPublicationDurabilityOptions {
	filesystem?: CouncilPublicationFileSystem;
	randomUUID?: () => string;
	onDurabilityOperation?: (operation: CouncilPublicationDurabilityOperation, targetPath: string) => void;
}

export interface CouncilPublicationCommitOptions extends CouncilPublicationDurabilityOptions {
	/** Recovery-only: adopt EEXIST exactly when the promised target equals this durable hash and byte count. */
	adoptExisting?: Pick<CouncilPublishedArtifact, "sha256" | "bytes">;
	signal?: AbortSignal;
}

export class CouncilPublicationError extends Error {
	readonly terminal: boolean;

	constructor(
		readonly code: "INVALID_TARGET" | "EEXIST" | "IO",
		message: string,
		options?: ErrorOptions,
	) {
		super(message, options);
		this.name = "CouncilPublicationError";
		this.terminal = code === "EEXIST";
	}
}

/** Lowercase kebab slug, bounded for suffixes and prohibited from ending in the ambiguous `-plan`. */
export function councilPublicationSlug(task: string): string {
	let slug = task
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, COUNCIL_SLUG_MAX_LENGTH)
		.replace(/-+$/g, "");
	while (slug.endsWith("-plan")) slug = slug.slice(0, -5).replace(/-+$/g, "");
	if (slug === "" || slug === "plan") slug = "council";
	return slug;
}

function isContained(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function isErrorCode(error: unknown, code: string): boolean {
	return error instanceof Error && "code" in error && error.code === code;
}

async function syncDirectory(
	filesystem: CouncilPublicationFileSystem,
	directory: string,
	onOperation?: CouncilPublicationDurabilityOptions["onDurabilityOperation"],
): Promise<void> {
	const handle = await filesystem.open(directory, "r");
	try {
		await handle.sync();
		onOperation?.("directory-sync", directory);
	} finally {
		await handle.close();
	}
}

export async function ensureCouncilPlansDirectory(
	repoRoot: string,
	options: CouncilPublicationDurabilityOptions = {},
): Promise<{ repoRoot: string; plansDirectory: string }> {
	const filesystem = options.filesystem ?? fs;
	const lexicalRoot = path.resolve(repoRoot);
	let canonicalRoot: string;
	try {
		const rootInfo = await filesystem.lstat(lexicalRoot);
		if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
			throw new CouncilPublicationError(
				"INVALID_TARGET",
				`Council repository root ${lexicalRoot} is not a real directory`,
			);
		}
		canonicalRoot = await filesystem.realpath(lexicalRoot);
	} catch (error) {
		if (error instanceof CouncilPublicationError) throw error;
		throw new CouncilPublicationError("INVALID_TARGET", `Council repository root is unusable: ${String(error)}`, {
			cause: error,
		});
	}
	const plansDirectory = path.join(canonicalRoot, "plans");
	let created = false;
	try {
		await filesystem.mkdir(plansDirectory);
		created = true;
	} catch (error) {
		if (!isErrorCode(error, "EEXIST")) {
			throw new CouncilPublicationError("IO", `Could not create council plans directory: ${String(error)}`, {
				cause: error,
			});
		}
	}
	try {
		const info = await filesystem.lstat(plansDirectory);
		if (info.isSymbolicLink() || !info.isDirectory()) {
			throw new CouncilPublicationError(
				"INVALID_TARGET",
				`Council publication path ${plansDirectory} is not a real directory`,
			);
		}
		const canonicalPlans = await filesystem.realpath(plansDirectory);
		if (canonicalPlans !== plansDirectory || !isContained(canonicalRoot, canonicalPlans)) {
			throw new CouncilPublicationError(
				"INVALID_TARGET",
				`Council publication path ${plansDirectory} escapes the repository`,
			);
		}
		if (created) await syncDirectory(filesystem, canonicalRoot, options.onDurabilityOperation);
	} catch (error) {
		if (error instanceof CouncilPublicationError) throw error;
		throw new CouncilPublicationError("INVALID_TARGET", `Council plans directory is unusable: ${String(error)}`, {
			cause: error,
		});
	}
	return { repoRoot: canonicalRoot, plansDirectory };
}

/** Resolve and promise a collision-free target once, before any child model is launched. */
export async function resolveCouncilPublicationTarget(
	repoRoot: string,
	task: string,
	options: CouncilPublicationDurabilityOptions = {},
): Promise<CouncilPublicationTarget> {
	const filesystem = options.filesystem ?? fs;
	const canonical = await ensureCouncilPlansDirectory(repoRoot, options);
	const baseSlug = councilPublicationSlug(task);
	for (let suffix = 1; suffix < Number.MAX_SAFE_INTEGER; suffix++) {
		const suffixText = suffix === 1 ? "" : `-${suffix}`;
		const stem = baseSlug.slice(0, COUNCIL_SLUG_MAX_LENGTH - suffixText.length).replace(/-+$/g, "");
		const slug = `${stem}${suffixText}`;
		const absolutePath = path.join(canonical.plansDirectory, `${slug}.md`);
		try {
			await filesystem.lstat(absolutePath);
		} catch (error) {
			if (isErrorCode(error, "ENOENT")) {
				return {
					repoRoot: canonical.repoRoot,
					plansDirectory: canonical.plansDirectory,
					slug,
					relativePath: path.posix.join("plans", `${slug}.md`),
					absolutePath,
				};
			}
			throw new CouncilPublicationError("IO", `Could not inspect council publication target: ${String(error)}`, {
				cause: error,
			});
		}
	}
	throw new CouncilPublicationError("IO", "Could not allocate a council publication target");
}

/** Revalidate a manifest's already-promised target without allocating a collision suffix. */
export async function resolvePromisedCouncilPublicationTarget(
	repoRoot: string,
	outputPath: string,
	options: CouncilPublicationDurabilityOptions = {},
): Promise<CouncilPublicationTarget> {
	const canonical = await ensureCouncilPlansDirectory(repoRoot, options);
	const absolutePath = resolvePromisedTarget(canonical.repoRoot, outputPath);
	if (
		!isContained(canonical.plansDirectory, absolutePath) ||
		path.dirname(absolutePath) !== canonical.plansDirectory
	) {
		throw new CouncilPublicationError("INVALID_TARGET", `Council outputPath escapes plans/: ${outputPath}`);
	}
	const slug = path.basename(absolutePath, ".md");
	return {
		repoRoot: canonical.repoRoot,
		plansDirectory: canonical.plansDirectory,
		slug,
		relativePath: outputPath,
		absolutePath,
	};
}

function resolvePromisedTarget(repoRoot: string, outputPath: string): string {
	if (
		path.isAbsolute(outputPath) ||
		outputPath.split(/[\\/]/).includes("..") ||
		!isValidCouncilOutputPath(outputPath)
	) {
		throw new CouncilPublicationError(
			"INVALID_TARGET",
			`Council outputPath must be a valid repo-relative promised plan path under plans/: ${outputPath}`,
		);
	}
	return path.resolve(repoRoot, ...outputPath.split("/"));
}

async function fileMatches(
	filesystem: CouncilPublicationFileSystem,
	finalPath: string,
	expected: Pick<CouncilPublishedArtifact, "sha256" | "bytes">,
): Promise<boolean> {
	try {
		const info = await filesystem.lstat(finalPath);
		if (info.isSymbolicLink() || !info.isFile() || info.size !== expected.bytes) return false;
		const handle = await filesystem.open(finalPath, nodeFs.constants.O_RDONLY | nodeFs.constants.O_NOFOLLOW);
		try {
			const openedInfo = await handle.stat();
			if (!openedInfo.isFile() || openedInfo.size !== expected.bytes) return false;
			return sha256CouncilContent(await handle.readFile()) === expected.sha256;
		} finally {
			await handle.close();
		}
	} catch (error) {
		if (isErrorCode(error, "ENOENT")) return false;
		throw error;
	}
}

export async function publishedCouncilPlanMatches(
	repoRoot: string,
	outputPath: string,
	published: Pick<CouncilPublishedArtifact, "sha256" | "bytes">,
	options: CouncilPublicationDurabilityOptions = {},
): Promise<boolean> {
	const filesystem = options.filesystem ?? fs;
	const canonical = await ensureCouncilPlansDirectory(repoRoot, options);
	const finalPath = resolvePromisedTarget(canonical.repoRoot, outputPath);
	if (!isContained(canonical.plansDirectory, finalPath)) {
		throw new CouncilPublicationError("INVALID_TARGET", `Council outputPath escapes plans/: ${outputPath}`);
	}
	try {
		return await fileMatches(filesystem, finalPath, published);
	} catch (error) {
		throw new CouncilPublicationError("IO", `Could not verify published council plan: ${String(error)}`, {
			cause: error,
		});
	}
}
export type CouncilPromisedPublicationStatus = "missing" | "matches" | "collision";

/**
 * Inspect a resume run's immutable promised path without allocating another suffix.
 * An existing entry matches only when an expected final content reference is supplied.
 */
export async function inspectPromisedCouncilPublication(
	repoRoot: string,
	outputPath: string,
	expected?: Pick<CouncilPublishedArtifact, "sha256" | "bytes">,
	options: CouncilPublicationDurabilityOptions = {},
): Promise<CouncilPromisedPublicationStatus> {
	const filesystem = options.filesystem ?? fs;
	const canonical = await ensureCouncilPlansDirectory(repoRoot, options);
	const finalPath = resolvePromisedTarget(canonical.repoRoot, outputPath);
	if (!isContained(canonical.plansDirectory, finalPath)) {
		throw new CouncilPublicationError("INVALID_TARGET", `Council outputPath escapes plans/: ${outputPath}`);
	}
	try {
		await filesystem.lstat(finalPath);
	} catch (error) {
		if (isErrorCode(error, "ENOENT")) return "missing";
		throw new CouncilPublicationError("IO", `Could not inspect promised council plan: ${String(error)}`, {
			cause: error,
		});
	}
	if (!expected) return "collision";
	try {
		return (await fileMatches(filesystem, finalPath, expected)) ? "matches" : "collision";
	} catch (error) {
		throw new CouncilPublicationError("IO", `Could not verify promised council plan: ${String(error)}`, {
			cause: error,
		});
	}
}

/** FileHandle-based durable staging. Merely staging can never expose a partial final plan. */
export async function stageCouncilPublication(
	plansDirectory: string,
	content: string,
	options: CouncilPublicationDurabilityOptions = {},
): Promise<StagedCouncilPublication> {
	const filesystem = options.filesystem ?? fs;
	const info = await filesystem.lstat(plansDirectory).catch(error => {
		throw new CouncilPublicationError("INVALID_TARGET", `Council plans directory is unusable: ${String(error)}`, {
			cause: error,
		});
	});
	if (info.isSymbolicLink() || !info.isDirectory()) {
		throw new CouncilPublicationError(
			"INVALID_TARGET",
			`Council publication path ${plansDirectory} is not a real directory`,
		);
	}
	const canonicalPlans = await filesystem.realpath(plansDirectory);
	if (canonicalPlans !== path.resolve(plansDirectory)) {
		throw new CouncilPublicationError("INVALID_TARGET", `Council plans directory ${plansDirectory} is not canonical`);
	}
	const bytes = Buffer.byteLength(content);
	const sha256 = sha256CouncilContent(content);
	const tempPath = path.join(canonicalPlans, `.council-${(options.randomUUID ?? (() => Bun.randomUUIDv7()))()}.tmp`);
	let handle: fs.FileHandle | undefined;
	try {
		handle = await filesystem.open(
			tempPath,
			nodeFs.constants.O_CREAT | nodeFs.constants.O_EXCL | nodeFs.constants.O_WRONLY | nodeFs.constants.O_NOFOLLOW,
			0o600,
		);
		await handle.writeFile(content, "utf8");
		await handle.sync();
		options.onDurabilityOperation?.("file-sync", tempPath);
		await handle.close();
		handle = undefined;
		return { tempPath, sha256, bytes };
	} catch (error) {
		await handle?.close().catch(() => {});
		await filesystem.unlink(tempPath).catch(() => {});
		throw new CouncilPublicationError("IO", `Could not stage council plan: ${String(error)}`, { cause: error });
	}
}

/** No-clobber commit. Existing files are adopted only through the explicit, hash-bound recovery option. */
export async function commitStagedCouncilPublication(
	staged: StagedCouncilPublication,
	finalPath: string,
	options: CouncilPublicationCommitOptions = {},
): Promise<void> {
	const filesystem = options.filesystem ?? fs;
	const plansDirectory = path.dirname(finalPath);
	let failure: unknown;
	try {
		options.signal?.throwIfAborted();
		if ((await filesystem.realpath(path.dirname(staged.tempPath))) !== (await filesystem.realpath(plansDirectory))) {
			throw new CouncilPublicationError("INVALID_TARGET", "Staged and final council plans must share one directory");
		}
		options.signal?.throwIfAborted();
		await filesystem.link(staged.tempPath, finalPath);
		options.onDurabilityOperation?.("link", finalPath);
		await syncDirectory(filesystem, plansDirectory, options.onDurabilityOperation);
	} catch (error) {
		if (options.signal?.aborted) {
			failure = options.signal.reason ?? new DOMException("This operation was aborted", "AbortError");
		} else if (isErrorCode(error, "EEXIST")) {
			let adopt = false;
			if (options.adoptExisting) {
				try {
					adopt = await fileMatches(filesystem, finalPath, options.adoptExisting);
					if (adopt) await syncDirectory(filesystem, plansDirectory, options.onDurabilityOperation);
				} catch {
					adopt = false;
				}
			}
			if (!adopt) {
				failure = new CouncilPublicationError("EEXIST", `Council publication target already exists: ${finalPath}`, {
					cause: error,
				});
			}
		} else {
			failure =
				error instanceof CouncilPublicationError
					? error
					: new CouncilPublicationError("IO", `Could not publish council plan: ${String(error)}`, {
							cause: error,
						});
		}
	}
	try {
		await filesystem.unlink(staged.tempPath);
		options.onDurabilityOperation?.("unlink", staged.tempPath);
		await syncDirectory(filesystem, path.dirname(staged.tempPath), options.onDurabilityOperation);
	} catch (error) {
		if (!failure) {
			failure = new CouncilPublicationError("IO", `Could not clean staged council plan: ${String(error)}`, {
				cause: error,
			});
		}
	}
	if (failure) throw failure;
}

export async function publishCouncilPlan(options: {
	repoRoot: string;
	outputPath: string;
	content: string;
	published?: CouncilPublishedArtifact;
	now?: string;
	/** Recovery-only opt-in to adopt an existing promised target after exact durable-content verification. */
	resume?: boolean;
	adoptExisting?: boolean;
	durability?: CouncilPublicationDurabilityOptions;
	signal?: AbortSignal;
}): Promise<CouncilPublicationResult> {
	const durability = options.durability ?? {};
	options.signal?.throwIfAborted();
	const canonical = await ensureCouncilPlansDirectory(options.repoRoot, durability);
	const finalPath = resolvePromisedTarget(canonical.repoRoot, options.outputPath);
	if (!isContained(canonical.plansDirectory, finalPath)) {
		throw new CouncilPublicationError("INVALID_TARGET", `Council outputPath escapes plans/: ${options.outputPath}`);
	}
	if (options.published && options.published.path !== options.outputPath) {
		throw new CouncilPublicationError("INVALID_TARGET", "Recovered publication reference does not match outputPath");
	}
	const contentReference = {
		sha256: sha256CouncilContent(options.content),
		bytes: Buffer.byteLength(options.content),
	};
	const adoptionReference = options.published ?? contentReference;
	const mayAdopt = options.resume === true || options.adoptExisting === true;
	if (
		mayAdopt &&
		(await publishedCouncilPlanMatches(canonical.repoRoot, options.outputPath, adoptionReference, durability))
	) {
		await syncDirectory(durability.filesystem ?? fs, canonical.plansDirectory, durability.onDurabilityOperation);
		return {
			...(options.published ?? {
				...contentReference,
				publishedAt: options.now ?? new Date().toISOString(),
			}),
			path: options.outputPath,
			idempotent: true,
		};
	}
	options.signal?.throwIfAborted();
	const staged = await stageCouncilPublication(canonical.plansDirectory, options.content, durability);
	await commitStagedCouncilPublication(staged, finalPath, {
		...durability,
		signal: options.signal,
		...(mayAdopt ? { adoptExisting: adoptionReference } : {}),
	});
	return {
		sha256: staged.sha256,
		bytes: staged.bytes,
		publishedAt: options.now ?? new Date().toISOString(),
		path: options.outputPath,
		idempotent: false,
	};
}
