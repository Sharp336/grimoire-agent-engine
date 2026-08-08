#!/usr/bin/env bun

/** Generate fork distribution release notes from FORK_CHANGELOG.md and fork-release.json only. */

import * as path from "node:path";
import { type ForkReleaseMetadata, parseForkReleaseMetadata } from "./publish-fork-package";

const repoRoot = path.join(import.meta.dir, "..");

export function extractForkReleaseSection(changelog: string, version: string): string {
	const heading = `## [${version}]`;
	const start = changelog.indexOf(heading);
	if (start < 0) throw new Error(`FORK_CHANGELOG.md has no ${heading} section`);
	const bodyStart = changelog.indexOf("\n", start) + 1;
	const next = changelog.indexOf("\n## [", bodyStart);
	const body = changelog.slice(bodyStart, next < 0 ? changelog.length : next).trim();
	if (!body) throw new Error(`${heading} has no release notes`);
	return body;
}

export function renderForkReleaseNotes(metadata: ForkReleaseMetadata, releaseSection: string): string {
	return [
		`# omp-cn ${metadata.forkVersion}`,
		"",
		releaseSection.trim(),
		"",
		"## 发行基线",
		"",
		`- 上游版本：\`${metadata.upstreamVersion}\``,
		`- 原生模块版本：\`${metadata.nativeVersion}\``,
		`- 上游提交：\`${metadata.upstreamCommit}\``,
		`- 标签：\`omp-cn-v${metadata.forkVersion}\``,
		"",
	].join("\n");
}

async function main(): Promise<void> {
	const metadataPath = path.join(repoRoot, "packages/coding-agent/fork-release.json");
	const changelogPath = path.join(repoRoot, "docs/FORK_CHANGELOG.md");
	const outputPath = path.resolve(process.argv[2] ?? "fork-release-notes.md");
	const metadata = parseForkReleaseMetadata(await Bun.file(metadataPath).json());
	const section = extractForkReleaseSection(await Bun.file(changelogPath).text(), metadata.forkVersion);
	await Bun.write(outputPath, renderForkReleaseNotes(metadata, section));
	console.log(`Wrote fork release notes to ${outputPath}`);
}

if (import.meta.main) await main();
