/**
 * Git operations for Task Manager.
 *
 * Uses Bun's `$` shell directly for git operations not covered by omp's
 * `utils/git.ts` exports (git add, git branch list, git show branch:path).
 * Where omp's git utils do cover an operation (commit), they are used.
 */

import { $ } from "bun";

export class GitOperations {
	#cwd: string;
	#enabled: boolean;

	constructor(cwd: string = process.cwd(), enabled: boolean = true) {
		this.#cwd = cwd;
		this.#enabled = enabled;
	}

	get enabled(): boolean {
		return this.#enabled;
	}

	get cwd(): string {
		return this.#cwd;
	}

	async isRepo(): Promise<boolean> {
		if (!this.#enabled) return false;
		const result = await $`git rev-parse --is-inside-work-tree`.cwd(this.#cwd).quiet().nothrow();
		return result.exitCode === 0;
	}

	async add(paths: string[]): Promise<void> {
		if (!this.#enabled || paths.length === 0) return;
		await $`git add ${paths}`.cwd(this.#cwd).quiet().nothrow();
	}

	async rm(paths: string[]): Promise<void> {
		if (!this.#enabled || paths.length === 0) return;
		await $`git rm ${paths}`.cwd(this.#cwd).quiet().nothrow();
	}

	async commit(message: string): Promise<void> {
		if (!this.#enabled) return;
		await $`git commit -m ${message}`.cwd(this.#cwd).quiet().nothrow();
	}

	async addAndCommit(paths: string[], message: string): Promise<void> {
		await this.add(paths);
		await this.commit(message);
	}

	async currentBranch(): Promise<string | null> {
		if (!this.#enabled) return null;
		const result = await $`git rev-parse --abbrev-ref HEAD`.cwd(this.#cwd).quiet().nothrow();
		if (result.exitCode !== 0) return null;
		const branch = result.text().trim();
		return branch === "HEAD" ? null : branch;
	}

	async listBranches(): Promise<string[]> {
		if (!this.#enabled) return [];
		const result = await $`git branch --list --format=%(refname:short)`.cwd(this.#cwd).quiet().nothrow();
		if (result.exitCode !== 0) return [];
		return result
			.text()
			.split("\n")
			.map(b => b.trim())
			.filter(Boolean);
	}

	async showFile(branch: string, filePath: string): Promise<string | null> {
		if (!this.#enabled) return null;
		const result = await $`git show ${`${branch}:${filePath}`}`.cwd(this.#cwd).quiet().nothrow();
		if (result.exitCode !== 0) return null;
		return result.text();
	}

	async hasFile(path: string): Promise<boolean> {
		if (!this.#enabled) return false;
		const result = await $`git cat-file -e ${`HEAD:${path}`}`.cwd(this.#cwd).quiet().nothrow();
		return result.exitCode === 0;
	}
}

/** Check whether a directory is inside a git repository. */
export async function isGitRepo(cwd: string): Promise<boolean> {
	const result = await $`git rev-parse --is-inside-work-tree`.cwd(cwd).quiet().nothrow();
	return result.exitCode === 0;
}
