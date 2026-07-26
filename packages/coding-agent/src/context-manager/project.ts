import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as git from "../utils/git";
import type { ContextProjectIdentity } from "./types";

/** Hash the canonical project identity with a runtime-stable cryptographic digest. */
export function hashContextProjectIdentity(canonicalIdentity: string): string {
	const hasher = new Bun.CryptoHasher("sha256");
	hasher.update(canonicalIdentity);
	return hasher.digest("hex");
}

async function canonicalPath(value: string): Promise<string> {
	try {
		return await fs.realpath(value);
	} catch {
		return path.resolve(value);
	}
}

function stripGitSuffix(value: string): string {
	return value.replace(/\/+$/, "").replace(/\.git$/i, "");
}

/** Normalize transport-specific clone URLs into a stable host/repository identity. */
export async function normalizeGitRemoteIdentity(remoteUrl: string, repoRoot: string): Promise<string | undefined> {
	const value = remoteUrl.trim();
	if (!value) return undefined;

	if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
		try {
			const url = new URL(value);
			if (url.protocol === "file:") {
				return `file:${stripGitSuffix(await canonicalPath(url.pathname))}`;
			}
			const pathname = stripGitSuffix(url.pathname.replace(/^\/+/, ""));
			if (!url.hostname || !pathname) return undefined;
			const port = url.port ? `:${url.port}` : "";
			return `${url.hostname.toLowerCase()}${port}/${pathname}`;
		} catch {
			return undefined;
		}
	}

	const scpLike = /^(?:[^@/\s]+@)?([^:/\s]+):(.+)$/.exec(value);
	if (scpLike) {
		const host = scpLike[1]?.toLowerCase();
		const pathname = stripGitSuffix(scpLike[2] ?? "").replace(/^\/+/, "");
		return host && pathname ? `${host}/${pathname}` : undefined;
	}

	const localPath = path.isAbsolute(value) ? value : path.resolve(repoRoot, value);
	return `file:${stripGitSuffix(await canonicalPath(localPath))}`;
}

async function resolveRemoteIdentity(repoRoot: string, signal?: AbortSignal): Promise<string | undefined> {
	let names: string[];
	try {
		names = await git.remote.list(repoRoot, signal);
	} catch {
		signal?.throwIfAborted();
		return undefined;
	}
	const ordered = names.sort((left, right) => {
		if (left === "origin") return -1;
		if (right === "origin") return 1;
		return left.localeCompare(right);
	});
	for (const name of ordered) {
		try {
			const remoteUrl = await git.remote.url(repoRoot, name, signal);
			if (!remoteUrl) continue;
			const normalized = await normalizeGitRemoteIdentity(remoteUrl, repoRoot);
			if (normalized) return normalized;
		} catch {
			signal?.throwIfAborted();
		}
	}
	return undefined;
}

/** Resolve a worktree/clone-stable project identity without mutating repository state. */
export async function resolveContextProjectIdentity(
	cwd: string,
	signal?: AbortSignal,
): Promise<ContextProjectIdentity> {
	const canonicalCwd = await canonicalPath(cwd);
	const repoRoot = await git.repo.root(canonicalCwd, signal);
	if (!repoRoot) {
		const canonicalIdentity = `directory\0${canonicalCwd}`;
		return {
			id: hashContextProjectIdentity(canonicalIdentity),
			kind: "directory",
			canonicalIdentity,
			cwd: canonicalCwd,
			root: canonicalCwd,
		};
	}

	const canonicalRoot = await canonicalPath(repoRoot);
	const primaryRoot = await canonicalPath((await git.repo.primaryRoot(canonicalRoot, signal)) ?? canonicalRoot);
	const rootCommit = (await git.repo.rootCommit(canonicalRoot, signal)) ?? undefined;
	const remoteIdentity = await resolveRemoteIdentity(canonicalRoot, signal);
	const canonicalIdentity =
		remoteIdentity && rootCommit
			? `git-remote\0${remoteIdentity}\0${rootCommit}`
			: `git-local\0${primaryRoot}\0${rootCommit ?? "unborn"}`;

	return {
		id: hashContextProjectIdentity(canonicalIdentity),
		kind: "git",
		canonicalIdentity,
		cwd: canonicalCwd,
		root: canonicalRoot,
		primaryRoot,
		rootCommit,
		remoteIdentity,
	};
}
