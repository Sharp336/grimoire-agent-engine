#!/usr/bin/env bun

import * as path from "node:path";
import { $ } from "bun";

const CHANGELOG_PATHSPEC = "packages/*/CHANGELOG.md";
const FIRST_RELEASE_HEADING = /^## \[(?!Unreleased\])[^\]\r\n]+\][^\r\n]*$/m;

export interface ChangelogHistoryViolation {
	path: string;
	message: string;
}

export interface ChangelogHistoryCheckResult {
	checkedPaths: string[];
	violations: ChangelogHistoryViolation[];
}

export function decodeChangelog(bytes: Uint8Array, label: string): string {
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		throw new Error(`${label} is not valid UTF-8`);
	}
}

export function releasedHistory(content: string): string | undefined {
	const match = FIRST_RELEASE_HEADING.exec(content);
	return match?.index === undefined ? undefined : content.slice(match.index);
}

export function releasedHistoryViolation(baseContent: string, headContent: string): string | undefined {
	const baseHistory = releasedHistory(baseContent);
	if (baseHistory === undefined) return undefined;

	const headHistory = releasedHistory(headContent);
	if (headHistory === undefined) {
		return "removed every released section";
	}
	if (headHistory === baseHistory) return undefined;

	const firstHeading = baseHistory.split(/\r?\n/, 1)[0] ?? "the first released section";
	return `changed immutable history beginning at ${JSON.stringify(firstHeading)}`;
}

async function git(args: readonly string[], cwd: string): Promise<Uint8Array> {
	const result = await $`git -c core.fsmonitor=false -c core.untrackedCache=false ${args}`.cwd(cwd).quiet().nothrow();
	if (result.exitCode !== 0) {
		const stderr = result.stderr.toString().trim();
		throw new Error(`git ${args.join(" ")} failed${stderr ? `: ${stderr}` : ""}`);
	}
	return result.bytes();
}

async function modifiedChangelogPaths(repoRoot: string, baseRef: string): Promise<string[]> {
	const output = decodeChangelog(
		await git(["diff", "--name-only", "--diff-filter=M", baseRef, "--", CHANGELOG_PATHSPEC], repoRoot),
		"git changelog path output",
	);
	return output
		.split("\n")
		.map(line => line.trim())
		.filter(line => line.length > 0);
}

export async function checkChangelogHistories(repoRoot: string, baseRef: string): Promise<ChangelogHistoryCheckResult> {
	const checkedPaths = await modifiedChangelogPaths(repoRoot, baseRef);
	const violations: ChangelogHistoryViolation[] = [];

	for (const changelogPath of checkedPaths) {
		try {
			const baseContent = decodeChangelog(
				await git(["show", `${baseRef}:${changelogPath}`], repoRoot),
				`${changelogPath} at ${baseRef}`,
			);
			const headContent = decodeChangelog(
				new Uint8Array(await Bun.file(path.join(repoRoot, changelogPath)).arrayBuffer()),
				changelogPath,
			);
			const message = releasedHistoryViolation(baseContent, headContent);
			if (message) violations.push({ path: changelogPath, message });
		} catch (error) {
			violations.push({
				path: changelogPath,
				message: error instanceof Error ? error.message : String(error),
			});
		}
	}

	return { checkedPaths, violations };
}

function parseBaseRef(args: readonly string[]): string {
	const baseIndex = args.indexOf("--base");
	const baseRef = baseIndex === -1 ? process.env.CHANGELOG_BASE_REF : args[baseIndex + 1];
	if (!baseRef) {
		throw new Error("Usage: bun scripts/check-changelog-history.ts --base <git-ref>");
	}
	return baseRef;
}

async function main(): Promise<void> {
	try {
		const repoRoot = path.join(import.meta.dir, "..");
		const baseRef = parseBaseRef(process.argv.slice(2));
		const result = await checkChangelogHistories(repoRoot, baseRef);
		if (result.violations.length > 0) {
			console.error("Released changelog history is immutable; only [Unreleased] may change:");
			for (const violation of result.violations) {
				console.error(`  ${violation.path}: ${violation.message}`);
			}
			process.exit(1);
		}
		console.log(`Checked ${result.checkedPaths.length} modified changelog(s); released history is unchanged.`);
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	}
}

if (import.meta.main) {
	await main();
}
