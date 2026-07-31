import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as git from "../utils/git";
import type { WorkspaceSnapshotData, WorkspaceSnapshotOptions, WorkspaceSnapshotService } from "./types";

export const UNDO_SNAPSHOT_CUSTOM_TYPE = "undo-snapshot";
export type { WorkspaceSnapshotData, WorkspaceSnapshotOptions, WorkspaceSnapshotService };

const SNAPSHOT_GIT_DIR = "git";
const MAX_UNTRACKED_FILE_BYTES_DEFAULT = 2 * 1024 * 1024;

interface GitDirs {
	worktree: string;
	gitDir: string;
}

export class HiddenWorkspaceSnapshotService implements WorkspaceSnapshotService {
	readonly #projectRoot: string;
	readonly #agentDataDir: string;
	readonly #maxUntrackedFileBytes: number;
	#dirs: GitDirs | undefined | null = undefined;

	constructor(options: WorkspaceSnapshotOptions) {
		this.#projectRoot = path.resolve(options.projectRoot);
		this.#agentDataDir = options.agentDataDir;
		this.#maxUntrackedFileBytes = options.maxUntrackedFileBytes ?? MAX_UNTRACKED_FILE_BYTES_DEFAULT;
	}

	async isSupported(): Promise<boolean> {
		const dirs = await this.#resolveDirs();
		return dirs !== null;
	}

	async capture(): Promise<string | undefined> {
		const dirs = await this.#resolveDirs();
		if (!dirs) return undefined;
		const env = this.#gitEnv(dirs.gitDir);
		const files = await this.#listFilesToStage(dirs);
		if (files.length > 0) {
			await git.run(
				dirs.worktree,
				["--git-dir", dirs.gitDir, "--work-tree", dirs.worktree, "add", "--force", "--", ...files],
				{
					env,
				},
			);
		}
		const result = await git.run(
			dirs.worktree,
			["--git-dir", dirs.gitDir, "--work-tree", dirs.worktree, "write-tree"],
			{ env },
		);
		return result.stdout.trim() || undefined;
	}

	async restore(snapshotId: string, files: readonly string[]): Promise<void> {
		const dirs = await this.#resolveDirs();
		if (!dirs) throw new Error("Snapshot repository not available");
		if (files.length === 0) return;
		for (const file of files) {
			const absolute = path.resolve(dirs.worktree, file);
			if (!isWithin(dirs.worktree, absolute)) {
				throw new Error(`Refusing to restore path outside project: ${file}`);
			}
		}
		const env = this.#gitEnv(dirs.gitDir);
		const tmpIndex = path.join(dirs.gitDir, `restore-index-${Date.now()}-${process.hrtime.bigint().toString(36)}`);
		try {
			// Build a temporary index containing the target tree.
			await git.run(
				dirs.worktree,
				["--git-dir", dirs.gitDir, "--work-tree", dirs.worktree, "read-tree", snapshotId],
				{ env: { ...env, GIT_INDEX_FILE: tmpIndex } },
			);
			// Check out the requested paths from that temporary index.
			await git.run(
				dirs.worktree,
				["--git-dir", dirs.gitDir, "--work-tree", dirs.worktree, "checkout-index", "--force", "--", ...files],
				{ env: { ...env, GIT_INDEX_FILE: tmpIndex } },
			);
			// Delete paths that were requested but do not exist in the target tree.
			const present = new Set(await this.#listTreePaths(dirs, snapshotId, files, env));
			for (const file of files) {
				if (!present.has(file)) {
					try {
						await fs.rm(path.join(dirs.worktree, file), { force: true, recursive: true });
					} catch {
						// Best-effort removal.
					}
				}
			}
		} finally {
			try {
				await fs.unlink(tmpIndex);
			} catch {
				// Ignore cleanup errors.
			}
		}
	}

	async listChangedFiles(fromSnapshotId: string, toSnapshotId: string): Promise<string[]> {
		const dirs = await this.#resolveDirs();
		if (!dirs) return [];
		const env = this.#gitEnv(dirs.gitDir);
		const result = await git.run(
			dirs.worktree,
			[
				"--git-dir",
				dirs.gitDir,
				"--work-tree",
				dirs.worktree,
				"diff-tree",
				"-r",
				"--name-only",
				fromSnapshotId,
				toSnapshotId,
			],
			{ env },
		);
		return result.stdout
			.split("\n")
			.map(line => line.trim())
			.filter(Boolean);
	}

	async #resolveDirs(): Promise<GitDirs | null> {
		if (this.#dirs === undefined) {
			this.#dirs = await this.#initDirs();
		}
		return this.#dirs;
	}

	async #initDirs(): Promise<GitDirs | null> {
		if (!(await isGitAvailable())) return null;
		const worktree = this.#projectRoot;
		let statOk = false;
		try {
			const stat = await fs.stat(worktree);
			statOk = stat.isDirectory();
		} catch {}
		if (!statOk) return null;
		const projectId = hashPath(worktree);
		const gitDir = path.join(this.#agentDataDir, "snapshots", projectId, SNAPSHOT_GIT_DIR);
		await fs.mkdir(gitDir, { recursive: true });
		const hasHead = await fs.access(path.join(gitDir, "HEAD")).then(
			() => true,
			() => false,
		);
		if (!hasHead) {
			const result = await git.run(worktree, ["init", "--bare", gitDir]);
			if (result.exitCode !== 0) return null;
			await fs.writeFile(path.join(gitDir, "config"), `[core]\n	worktree = ${worktree.replace(/\\\\/g, "/")}\n`, {
				flag: "a",
			});
		}
		return { worktree, gitDir };
	}

	async #listFilesToStage(dirs: GitDirs): Promise<string[]> {
		const userGitDir = await discoverUserGitDir(dirs.worktree);
		const tracked = userGitDir ? await git.ls.files(dirs.worktree) : [];
		const untracked = userGitDir
			? await git.ls.untracked(dirs.worktree)
			: await manualWalk(dirs.worktree, this.#maxUntrackedFileBytes);
		const selected = new Set<string>();
		for (const file of tracked) selected.add(normalizeSep(file));
		for (const file of untracked) {
			const normalized = normalizeSep(file);
			if (selected.has(normalized)) continue;
			const absolute = path.join(dirs.worktree, normalized);
			if (await exceedsSize(absolute, this.#maxUntrackedFileBytes)) continue;
			selected.add(normalized);
		}
		return Array.from(selected);
	}

	async #listTreePaths(
		dirs: GitDirs,
		tree: string,
		files: readonly string[],
		env: Record<string, string>,
	): Promise<string[]> {
		const result = await git.run(
			dirs.worktree,
			[
				"--git-dir",
				dirs.gitDir,
				"--work-tree",
				dirs.worktree,
				"ls-tree",
				"--name-only",
				"-r",
				"-z",
				tree,
				"--",
				...files,
			],
			{ env },
		);
		return result.stdout.split("\0").filter(Boolean);
	}

	#gitEnv(gitDir: string): Record<string, string> {
		return {
			...process.env,
			GIT_INDEX_FILE: path.join(gitDir, "index"),
		};
	}
}

async function isGitAvailable(): Promise<boolean> {
	try {
		const result = await git.run(os.homedir(), ["--version"]);
		return result.exitCode === 0;
	} catch {
		return false;
	}
}

async function discoverUserGitDir(worktree: string): Promise<string | undefined> {
	try {
		const result = await git.run(worktree, ["rev-parse", "--git-dir"]);
		if (result.exitCode !== 0) return undefined;
		const raw = result.stdout.trim();
		if (!raw) return undefined;
		return path.isAbsolute(raw) ? raw : path.resolve(worktree, raw);
	} catch {
		return undefined;
	}
}

function hashPath(p: string): string {
	return createHash("sha256").update(path.resolve(p)).digest("hex").slice(0, 16);
}

function normalizeSep(p: string): string {
	return p.replace(/\\/g, "/");
}

function isWithin(root: string, target: string): boolean {
	const rel = path.relative(root, target);
	return !rel.startsWith("..") && !path.isAbsolute(rel);
}

async function exceedsSize(filePath: string, maxBytes: number): Promise<boolean> {
	try {
		const stat = await fs.stat(filePath);
		return stat.isFile() && stat.size > maxBytes;
	} catch {
		return true;
	}
}

async function manualWalk(root: string, maxBytes: number): Promise<string[]> {
	const results: string[] = [];
	const skip = new Set([".git", ".omp", "node_modules", ".next", ".dist", "dist", "build"]);
	const queue: string[] = [""];
	while (queue.length > 0) {
		const relative = queue.shift()!;
		const absolute = path.join(root, relative);
		let entries: Dirent[];
		try {
			entries = await fs.readdir(absolute, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			const entryRel = relative ? `${relative}/${entry.name}` : entry.name;
			if (skip.has(entry.name)) continue;
			if (entry.isDirectory()) {
				queue.push(entryRel);
			} else if (entry.isFile()) {
				const full = path.join(root, entryRel);
				if (!(await exceedsSize(full, maxBytes))) {
					results.push(entryRel);
				}
			}
		}
	}
	return results;
}
