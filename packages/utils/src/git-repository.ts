import * as fs from "node:fs";
import * as path from "node:path";
import { hasFsCode, isEacces, isEisdir, isEnoent, isEnotdir } from "./fs-error";

export interface GitRepository {
	commonDir: string;
	gitDir: string;
	gitEntryPath: string;
	headPath: string;
	repoRoot: string;
	isReftable?: boolean;
}

type EntryType = "directory" | "file";
const EINTR_MAX_RETRIES = 3;

function isPermissionError(error: unknown): boolean {
	return isEacces(error) || hasFsCode(error, "EPERM");
}

function shouldRetry(error: unknown, attempt: number): boolean {
	if (
		isEnoent(error) ||
		isEisdir(error) ||
		isEnotdir(error) ||
		hasFsCode(error, "ENFILE") ||
		hasFsCode(error, "EMFILE")
	) {
		return false;
	}
	if (hasFsCode(error, "EINTR")) return attempt < EINTR_MAX_RETRIES;
	throw error;
}

function retryOnEintrSync<T>(operation: () => T): T | null {
	for (let attempt = 0; attempt <= EINTR_MAX_RETRIES; attempt += 1) {
		try {
			return operation();
		} catch (error) {
			if (shouldRetry(error, attempt)) continue;
			return null;
		}
	}
	throw new Error("retryOnEintrSync: exhausted without resolution");
}

async function retryOnEintr<T>(operation: () => Promise<T>): Promise<T | null> {
	for (let attempt = 0; attempt <= EINTR_MAX_RETRIES; attempt += 1) {
		try {
			return await operation();
		} catch (error) {
			if (shouldRetry(error, attempt)) continue;
			return null;
		}
	}
	throw new Error("retryOnEintr: exhausted without resolution");
}

function getEntryTypeSync(gitEntryPath: string): EntryType | null {
	return retryOnEintrSync(() => {
		const stat = fs.statSync(gitEntryPath);
		if (stat.isDirectory()) return "directory";
		if (stat.isFile()) return "file";
		return null;
	});
}

async function getEntryType(gitEntryPath: string): Promise<EntryType | null> {
	return retryOnEintr(async () => {
		const stat = await fs.promises.stat(gitEntryPath);
		if (stat.isDirectory()) return "directory";
		if (stat.isFile()) return "file";
		return null;
	});
}

function readOptionalTextSync(filePath: string): string | null {
	return retryOnEintrSync(() => fs.readFileSync(filePath, "utf8"));
}

async function readOptionalText(filePath: string): Promise<string | null> {
	return retryOnEintr(async () => await Bun.file(filePath).text());
}

export function parseGitDirPointer(content: string): string | null {
	const match = /^gitdir:\s*(.+)\s*$/iu.exec(content.trim());
	return match?.[1] ?? null;
}

function resolveGitDirSync(gitEntryPath: string, entryType: EntryType): string | null {
	if (entryType === "directory") return gitEntryPath;
	const parsed = parseGitDirPointer(readOptionalTextSync(gitEntryPath) ?? "");
	if (!parsed) return null;
	const gitDir = path.resolve(path.dirname(gitEntryPath), parsed);
	return getEntryTypeSync(gitDir) === "directory" ? gitDir : null;
}

async function resolveGitDir(gitEntryPath: string, entryType: EntryType): Promise<string | null> {
	if (entryType === "directory") return gitEntryPath;
	const parsed = parseGitDirPointer((await readOptionalText(gitEntryPath)) ?? "");
	if (!parsed) return null;
	const gitDir = path.resolve(path.dirname(gitEntryPath), parsed);
	return (await getEntryType(gitDir)) === "directory" ? gitDir : null;
}

function resolveCommonDirSync(gitDir: string): string {
	const relative = readOptionalTextSync(path.join(gitDir, "commondir"))?.trim();
	return relative ? path.resolve(gitDir, relative) : gitDir;
}

async function resolveCommonDir(gitDir: string): Promise<string> {
	const relative = (await readOptionalText(path.join(gitDir, "commondir")))?.trim();
	return relative ? path.resolve(gitDir, relative) : gitDir;
}

export function isLinkedGitWorktreeSync(repository: GitRepository): boolean {
	return (
		repository.gitDir !== repository.commonDir &&
		getEntryTypeSync(path.join(repository.gitDir, "commondir")) === "file"
	);
}

export async function isLinkedGitWorktree(repository: GitRepository): Promise<boolean> {
	return (
		repository.gitDir !== repository.commonDir &&
		(await getEntryType(path.join(repository.gitDir, "commondir"))) === "file"
	);
}

export function primaryGitRootSync(repository: GitRepository): string {
	if (path.basename(repository.commonDir) === ".git") return path.dirname(repository.commonDir);
	if (isLinkedGitWorktreeSync(repository)) return repository.commonDir;
	return repository.repoRoot;
}

export async function primaryGitRoot(repository: GitRepository): Promise<string> {
	if (path.basename(repository.commonDir) === ".git") return path.dirname(repository.commonDir);
	if (await isLinkedGitWorktree(repository)) return repository.commonDir;
	return repository.repoRoot;
}

function resolveRepoFromEntrySync(repoRoot: string, gitEntryPath: string, entryType: EntryType): GitRepository | null {
	const gitDir = resolveGitDirSync(gitEntryPath, entryType);
	if (!gitDir) return null;
	return {
		commonDir: resolveCommonDirSync(gitDir),
		gitDir,
		gitEntryPath,
		headPath: path.join(gitDir, "HEAD"),
		repoRoot,
	};
}

async function resolveRepoFromEntry(
	repoRoot: string,
	gitEntryPath: string,
	entryType: EntryType,
): Promise<GitRepository | null> {
	const gitDir = await resolveGitDir(gitEntryPath, entryType);
	if (!gitDir) return null;
	return {
		commonDir: await resolveCommonDir(gitDir),
		gitDir,
		gitEntryPath,
		headPath: path.join(gitDir, "HEAD"),
		repoRoot,
	};
}

export function resolveGitRepositorySync(startDir: string): GitRepository | null {
	let current = path.resolve(startDir);
	while (true) {
		const gitEntryPath = path.join(current, ".git");
		const entryType = getEntryTypeSync(gitEntryPath);
		if (entryType) {
			try {
				const repository = resolveRepoFromEntrySync(current, gitEntryPath, entryType);
				if (repository) return repository;
			} catch (error) {
				if (entryType === "file" && isPermissionError(error)) return null;
				throw error;
			}
		}
		const parent = path.dirname(current);
		if (parent === current) return null;
		current = parent;
	}
}

export async function resolveGitRepository(startDir: string): Promise<GitRepository | null> {
	let current = path.resolve(startDir);
	while (true) {
		const gitEntryPath = path.join(current, ".git");
		const entryType = await getEntryType(gitEntryPath);
		if (entryType) {
			try {
				const repository = await resolveRepoFromEntry(current, gitEntryPath, entryType);
				if (repository) return repository;
			} catch (error) {
				if (entryType === "file" && isPermissionError(error)) return null;
				throw error;
			}
		}
		const parent = path.dirname(current);
		if (parent === current) return null;
		current = parent;
	}
}
