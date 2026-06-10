import * as fs from "node:fs";
import * as path from "node:path";
import { type GitRepository, repo } from "./utils/git";

const UNKNOWN_PROJECT = "unknown";
const SSH_REMOTE_PATTERN = /^(?:[^@\s/]+@)?([^:\s/]+):(.+)$/;
const UNSAFE_SEGMENT_CHARS = /[^a-z0-9_-]+/g;
const REPEATED_DASHES = /-+/g;

export type MemoryProjectIdentitySource = "explicit" | "git-remote" | "git-common-dir" | "cwd";

export interface MemoryProjectIdentity {
	/** Stable project key used for memory tags and human-facing identity. */
	key: string;
	/** Filesystem/bank-safe key segment derived from `key`. */
	segment: string;
	source: MemoryProjectIdentitySource;
}

export function normalizeMemoryProjectKey(value: string | null | undefined): string | undefined {
	let key = value?.trim();
	if (!key) return undefined;
	key = key.replace(/\\/g, "/").replace(/\/+$/g, "");
	const looksLikeUrl = /^[a-z][a-z0-9+.-]*:\/\//i.test(key);

	if (looksLikeUrl) {
		try {
			const url = new URL(key);
			const pathname = url.pathname.replace(/^\/+/, "");
			key = pathname ? `${url.hostname}/${pathname}` : url.hostname;
		} catch {
			// Plain keys such as `github.com/org/repo` or `repo-name` are valid.
		}
	} else {
		const sshMatch = SSH_REMOTE_PATTERN.exec(key);
		if (sshMatch) {
			const sshHost = sshMatch[1];
			const sshPath = sshMatch[2];
			if (sshHost && sshPath?.includes("/")) key = `${sshHost}/${sshPath}`;
		}
	}

	key = key
		.replace(/\.git$/i, "")
		.replace(/^\/+|\/+$/g, "")
		.toLowerCase();
	return key || undefined;
}

export function memoryProjectSegment(key: string | null | undefined): string {
	const normalized = normalizeMemoryProjectKey(key) ?? UNKNOWN_PROJECT;
	const segment = normalized.replace(UNSAFE_SEGMENT_CHARS, "-").replace(REPEATED_DASHES, "-").replace(/^-|-$/g, "");
	return segment || UNKNOWN_PROJECT;
}

function readGitConfig(configPath: string): string | undefined {
	try {
		return fs.readFileSync(configPath, "utf8");
	} catch {
		return undefined;
	}
}

function canonicalPath(filePath: string): string {
	try {
		return fs.realpathSync.native(filePath);
	} catch {
		return path.resolve(filePath);
	}
}

function normalizeGitRemoteProjectKey(value: string | undefined): string | undefined {
	const remote = value?.trim();
	if (!remote) return undefined;

	const sshMatch = SSH_REMOTE_PATTERN.exec(remote);
	if (sshMatch?.[1] && sshMatch[2]?.includes("/")) {
		return normalizeMemoryProjectKey(remote);
	}

	try {
		const url = new URL(remote);
		if (!url.hostname) return undefined;
		return normalizeMemoryProjectKey(remote);
	} catch {
		return undefined;
	}
}

function remoteProjectKey(repository: GitRepository): string | undefined {
	const configText = readGitConfig(path.join(repository.commonDir, "config"));
	if (!configText) return undefined;

	let remoteName: string | undefined;
	const remotes: Array<{ name: string; key: string }> = [];
	for (const rawLine of configText.split(/\r?\n/)) {
		const line = rawLine.trim();
		const section = /^\[remote\s+"([^"]+)"\]$/.exec(line);
		if (section) {
			remoteName = section[1];
			continue;
		}
		if (line.startsWith("[")) {
			remoteName = undefined;
			continue;
		}
		if (!remoteName) continue;

		const url = /^url\s*=\s*(.+)$/.exec(line);
		if (!url) continue;
		const key = normalizeGitRemoteProjectKey(url[1]);
		if (!key) continue;
		remotes.push({ name: remoteName, key });
	}

	return (
		remotes.find(remote => remote.name === "upstream")?.key ??
		remotes.find(remote => remote.name === "origin")?.key ??
		remotes[0]?.key
	);
}

function localGitProjectKey(repository: GitRepository): string | undefined {
	const commonDir = canonicalPath(repository.commonDir);
	const primaryRoot = path.basename(commonDir) === ".git" ? path.dirname(commonDir) : commonDir;
	const basename = normalizeMemoryProjectKey(path.basename(primaryRoot));
	if (!basename) return undefined;
	return `local/${basename}/${Bun.hash(commonDir).toString(36)}`;
}

function gitProjectIdentity(cwd: string): MemoryProjectIdentity | undefined {
	const repository = repo.resolveSync(cwd);
	if (!repository) return undefined;
	const remoteKey = remoteProjectKey(repository);
	if (remoteKey) {
		return { key: remoteKey, segment: memoryProjectSegment(remoteKey), source: "git-remote" };
	}
	const localKey = localGitProjectKey(repository);
	if (!localKey) return undefined;
	return { key: localKey, segment: memoryProjectSegment(localKey), source: "git-common-dir" };
}

export function resolveMemoryProjectIdentity(cwd: string, explicitProjectKey?: string | null): MemoryProjectIdentity {
	const explicit = normalizeMemoryProjectKey(explicitProjectKey);
	if (explicit) {
		return { key: explicit, segment: memoryProjectSegment(explicit), source: "explicit" };
	}

	if (!cwd) {
		return { key: UNKNOWN_PROJECT, segment: UNKNOWN_PROJECT, source: "cwd" };
	}

	const gitIdentity = gitProjectIdentity(cwd);
	if (gitIdentity) {
		return gitIdentity;
	}

	const fallback = normalizeMemoryProjectKey(path.basename(path.resolve(cwd))) ?? UNKNOWN_PROJECT;
	return { key: fallback, segment: memoryProjectSegment(fallback), source: "cwd" };
}
