import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	getBaseConfigRootDir,
	getProfileRootDir,
	normalizePathForComparison,
	normalizeProfileName,
	pathIsWithin,
	relativePathWithinRoot,
} from "@oh-my-pi/pi-utils/dirs";
import { isEnoent } from "@oh-my-pi/pi-utils/fs-error";
import { type GitRepository, resolveGitRepository } from "@oh-my-pi/pi-utils/git-repository";

export const PROFILE_BINDINGS_VERSION = 1;
const PROFILE_BINDINGS_FILENAME = "profile-bindings.json";

export type ProfileBindingKind = "directory" | "git-common-dir";

export interface ProfileBinding {
	kind: ProfileBindingKind;
	path: string;
	profile: string;
	/** Folder inside each checkout. Omitted when the whole repository is bound. */
	subpath?: string;
}

export interface ProfileBindingsFile {
	version: typeof PROFILE_BINDINGS_VERSION;
	bindings: ProfileBinding[];
}

export interface ResolvedProfileBinding {
	binding: ProfileBinding;
	profile?: string;
}

export interface BindingTarget {
	kind: ProfileBindingKind;
	path: string;
	subpath?: string;
}

export function getProfileBindingsPath(): string {
	return path.join(getBaseConfigRootDir(), PROFILE_BINDINGS_FILENAME);
}

function emptyBindingsFile(): ProfileBindingsFile {
	return { version: PROFILE_BINDINGS_VERSION, bindings: [] };
}

function isValidSubpath(value: unknown): value is string | undefined {
	if (value === undefined) return true;
	if (typeof value !== "string" || value.length === 0) return false;
	const portable = value.replaceAll("\\", "/");
	if (portable.startsWith("/") || /^[A-Za-z]:\//.test(portable)) return false;
	const normalized = path.posix.normalize(portable);
	return normalized !== "." && normalized !== ".." && !normalized.startsWith("../");
}

function isProfileBinding(value: unknown): value is ProfileBinding {
	if (value === null || typeof value !== "object") return false;
	const record = value as Record<string, unknown>;
	if (
		(record.kind !== "directory" && record.kind !== "git-common-dir") ||
		typeof record.path !== "string" ||
		!path.isAbsolute(record.path) ||
		typeof record.profile !== "string" ||
		record.profile.length === 0 ||
		!isValidSubpath(record.subpath) ||
		(record.kind === "directory" && record.subpath !== undefined)
	) {
		return false;
	}
	try {
		normalizeProfileName(record.profile);
		return true;
	} catch {
		return false;
	}
}

function parseBindingsFile(value: unknown, filePath: string): ProfileBindingsFile {
	if (value === null || typeof value !== "object") {
		throw new Error(`Invalid profile bindings file at ${filePath}: expected an object`);
	}
	const record = value as Record<string, unknown>;
	if (record.version !== PROFILE_BINDINGS_VERSION) {
		throw new Error(
			`Unsupported profile bindings version at ${filePath}: expected ${PROFILE_BINDINGS_VERSION}, found ${String(record.version)}`,
		);
	}
	if (!Array.isArray(record.bindings) || !record.bindings.every(isProfileBinding)) {
		throw new Error(`Invalid profile bindings file at ${filePath}: "bindings" must be an array of folder bindings`);
	}
	return { version: PROFILE_BINDINGS_VERSION, bindings: record.bindings };
}

export async function loadProfileBindings(filePath: string = getProfileBindingsPath()): Promise<ProfileBindingsFile> {
	try {
		return parseBindingsFile(await Bun.file(filePath).json(), filePath);
	} catch (error) {
		if (isEnoent(error)) return emptyBindingsFile();
		if (error instanceof SyntaxError) {
			throw new Error(`Invalid JSON in profile bindings file at ${filePath}: ${error.message}`);
		}
		throw error;
	}
}

export async function resolveBindingTarget(inputPath: string): Promise<BindingTarget> {
	const absolutePath = path.resolve(inputPath);
	try {
		const stat = await fs.stat(absolutePath);
		if (!stat.isDirectory()) throw new Error("path is not a directory");
	} catch (error) {
		throw new Error(`Cannot bind folder ${absolutePath}: ${error instanceof Error ? error.message : String(error)}`);
	}

	const folder = normalizePathForComparison(absolutePath);
	const repository = await resolveGitRepository(folder);
	if (!repository) return { kind: "directory", path: folder };

	const repoRoot = normalizePathForComparison(repository.repoRoot);
	const subpath = relativePathWithinRoot(repoRoot, folder) ?? undefined;
	return {
		kind: "git-common-dir",
		path: normalizePathForComparison(repository.commonDir),
		...(subpath ? { subpath } : {}),
	};
}

export function storedProfileName(profile: string): string {
	return normalizeProfileName(profile) ?? "default";
}

export async function assertProfileExists(profile: string): Promise<void> {
	const normalized = normalizeProfileName(profile);
	if (!normalized) return;
	try {
		if ((await fs.stat(getProfileRootDir(normalized))).isDirectory()) return;
	} catch {}
	throw new Error(`OMP profile "${normalized}" does not exist. Start it once with: omp --profile ${normalized}`);
}

function gitBindingRoot(binding: ProfileBinding, commonDir: string, repoRoot: string): string | null {
	if (binding.kind !== "git-common-dir" || binding.path !== commonDir) return null;
	if (!binding.subpath) return repoRoot;
	const bindingRoot = normalizePathForComparison(
		path.resolve(repoRoot, ...binding.subpath.replaceAll("\\", "/").split("/")),
	);
	return pathIsWithin(repoRoot, bindingRoot) ? bindingRoot : null;
}

async function enclosingGitRepositories(folder: string): Promise<GitRepository[]> {
	const repositories: GitRepository[] = [];
	const seen = new Set<string>();
	let searchFrom = folder;
	while (true) {
		const repository = await resolveGitRepository(searchFrom);
		if (!repository) return repositories;
		const key = `${normalizePathForComparison(repository.commonDir)}\0${normalizePathForComparison(repository.repoRoot)}`;
		if (seen.has(key)) return repositories;
		seen.add(key);
		repositories.push(repository);
		const parent = path.dirname(repository.repoRoot);
		if (parent === repository.repoRoot) return repositories;
		searchFrom = parent;
	}
}

export async function resolveProfileBindingFromData(
	inputPath: string,
	data: ProfileBindingsFile,
): Promise<ResolvedProfileBinding | null> {
	if (data.bindings.length === 0) return null;
	const folder = normalizePathForComparison(path.resolve(inputPath));
	const gitMatches: Array<{ binding: ProfileBinding; root: string }> = [];
	for (const repository of await enclosingGitRepositories(folder)) {
		const commonDir = normalizePathForComparison(repository.commonDir);
		const repoRoot = normalizePathForComparison(repository.repoRoot);
		for (const binding of data.bindings) {
			const root = gitBindingRoot(binding, commonDir, repoRoot);
			if (root && pathIsWithin(root, folder)) gitMatches.push({ binding, root });
		}
	}
	gitMatches.sort((left, right) => right.root.length - left.root.length);
	const gitBinding = gitMatches[0]?.binding;
	if (gitBinding) return { binding: gitBinding, profile: normalizeProfileName(gitBinding.profile) };
	const directoryBinding = data.bindings
		.filter(binding => binding.kind === "directory" && pathIsWithin(binding.path, folder))
		.sort((left, right) => right.path.length - left.path.length)[0];
	if (!directoryBinding) return null;
	return { binding: directoryBinding, profile: normalizeProfileName(directoryBinding.profile) };
}

export async function resolveProfileBinding(
	inputPath: string = process.cwd(),
	filePath: string = getProfileBindingsPath(),
): Promise<ResolvedProfileBinding | null> {
	return resolveProfileBindingFromData(inputPath, await loadProfileBindings(filePath));
}

export async function resolveExistingProfileBinding(
	inputPath: string = process.cwd(),
	filePath: string = getProfileBindingsPath(),
): Promise<ResolvedProfileBinding | null> {
	const resolved = await resolveProfileBinding(inputPath, filePath);
	if (!resolved?.profile) return resolved;
	await assertProfileExists(resolved.profile);
	return resolved;
}
