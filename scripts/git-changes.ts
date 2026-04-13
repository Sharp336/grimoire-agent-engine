#!/usr/bin/env bun

import { $ } from "bun";
import * as path from "node:path";

const decoder = new TextDecoder();

export const repoRoot = path.join(import.meta.dir, "..");

interface PullRequestRefs {
	baseSha: string;
	headSha: string;
}

interface GitHubPullRequestEvent {
	pull_request?: {
		base?: { sha?: string };
		head?: { sha?: string };
	};
}

export interface PullRequestChangedPathsResult {
	kind: "not_pull_request" | "resolved" | "unavailable";
	changedPaths: string[];
}

export function isCI(): boolean {
	const value = Bun.env.CI;
	if (!value) return false;
	const normalized = value.trim().toLowerCase();
	return normalized !== "" && normalized !== "0" && normalized !== "false";
}

export async function getWorkingTreeChangedPaths(): Promise<string[] | null> {
	const result = await $`git status --porcelain -z`.cwd(repoRoot).quiet().nothrow();
	if (result.exitCode !== 0) {
		return null;
	}
	return uniqueSorted(getChangedPathsFromPorcelain(result.stdout));
}

export async function getBranchChangedPaths(): Promise<string[] | null> {
	const baseRef = await resolveBaseBranchRef();
	if (!baseRef) {
		return null;
	}

	const result = await runGitDiffNameOnly([baseRef, "HEAD"]);
	if (result == null) {
		return null;
	}

	return uniqueSorted(result);
}

export async function getPullRequestChangedPaths(): Promise<PullRequestChangedPathsResult> {
	const eventName = Bun.env.GITHUB_EVENT_NAME?.trim();
	if (eventName !== "pull_request" && eventName !== "pull_request_target") {
		return { kind: "not_pull_request", changedPaths: [] };
	}

	const refs = await readPullRequestRefs();
	if (!refs) {
		return { kind: "unavailable", changedPaths: [] };
	}

	const result = await runGitDiffNameOnly([refs.baseSha, refs.headSha]);
	if (result == null) {
		return { kind: "unavailable", changedPaths: [] };
	}

	return { kind: "resolved", changedPaths: uniqueSorted(result) };
}

export function getChangedPathsFromPorcelain(buf: Uint8Array): string[] {
	const entries = decoder.decode(buf).split("\0").filter(Boolean);
	const changedPaths: string[] = [];

	for (let index = 0; index < entries.length; index += 1) {
		const entry = entries[index];
		if (entry.length < 4) continue;

		const status = entry.slice(0, 2);
		const changedPath = normalizePath(entry.slice(3));
		if (changedPath !== "") {
			changedPaths.push(changedPath);
		}

		if (status.includes("R") || status.includes("C")) {
			const renamedPath = normalizePath(entries[index + 1] ?? "");
			if (renamedPath !== "") {
				changedPaths.push(renamedPath);
				index += 1;
			}
		}
	}

	return changedPaths;
}

async function readPullRequestRefs(): Promise<PullRequestRefs | null> {
	const eventPath = Bun.env.GITHUB_EVENT_PATH?.trim();
	if (!eventPath) return null;

	try {
		const event = (await Bun.file(eventPath).json()) as GitHubPullRequestEvent;
		const baseSha = event.pull_request?.base?.sha?.trim();
		const headSha = event.pull_request?.head?.sha?.trim();
		if (!baseSha || !headSha) return null;
		return { baseSha, headSha };
	} catch {
		return null;
	}
}

async function resolveBaseBranchRef(): Promise<string | null> {
	const configuredDefaultRef = await getConfiguredRemoteDefaultBranchRef();
	const candidateRefs = [configuredDefaultRef, "origin/main", "origin/master", "main", "master"];
	const seenRefs = new Set<string>();

	for (const candidateRef of candidateRefs) {
		const normalizedCandidateRef = candidateRef?.trim();
		if (!normalizedCandidateRef || seenRefs.has(normalizedCandidateRef)) {
			continue;
		}

		seenRefs.add(normalizedCandidateRef);
		if (await gitRefExists(normalizedCandidateRef)) {
			return normalizedCandidateRef;
		}
	}

	return null;
}

async function getConfiguredRemoteDefaultBranchRef(): Promise<string | null> {
	const result = await $`git symbolic-ref --quiet --short refs/remotes/origin/HEAD`.cwd(repoRoot).quiet().nothrow();
	if (result.exitCode !== 0) {
		return null;
	}

	const resolvedRef = decoder.decode(result.stdout).trim();
	return resolvedRef === "" ? null : resolvedRef;
}

async function gitRefExists(ref: string): Promise<boolean> {
	const commitish = `${ref}^{commit}`;
	const result = await $`git rev-parse --verify --quiet ${commitish}`.cwd(repoRoot).quiet().nothrow();
	return result.exitCode === 0;

}

async function runGitDiffNameOnly(range: readonly [string, string]): Promise<string[] | null> {
	const [baseSha, headSha] = range;
	const result = await $`git diff --name-only -z ${baseSha}...${headSha}`.cwd(repoRoot).quiet().nothrow();
	if (result.exitCode !== 0) {
		return null;
	}
	return decoder.decode(result.stdout).split("\0").map(normalizePath).filter(Boolean);
}

function normalizePath(filePath: string): string {
	return filePath.replace(/\\/g, "/");
}

function uniqueSorted(paths: readonly string[]): string[] {
	return [...new Set(paths)].sort((left, right) => left.localeCompare(right));
}
