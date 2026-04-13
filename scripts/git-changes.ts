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

export async function getPullRequestChangedPaths(): Promise<string[] | null> {
	const refs = await readPullRequestRefs();
	if (!refs) return null;

	const result = await runGitDiffNameOnly([refs.baseSha, refs.headSha]);
	if (result == null) {
		return null;
	}

	return uniqueSorted(result);
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
	const eventName = Bun.env.GITHUB_EVENT_NAME?.trim();
	const eventPath = Bun.env.GITHUB_EVENT_PATH?.trim();
	if (eventName !== "pull_request" || !eventPath) return null;

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
