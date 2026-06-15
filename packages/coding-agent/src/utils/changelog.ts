import { getLastChangelogVersionPath, isEnoent, logger } from "@oh-my-pi/pi-utils";

export interface ChangelogEntry {
	major: number;
	minor: number;
	patch: number;
	content: string;
}

/**
 * Parse changelog entries from the file at `changelogPath`. Scans for `## [x.y.z]`
 * headings and collects each block until the next heading or EOF.
 *
 * Returns `[]` when `changelogPath` is `undefined` (package directory not
 * resolvable — see `getChangelogPath`) or the file is missing. Callers MUST NOT
 * synthesize a fallback path from the host project's cwd; doing so caused issue
 * #1423 (the host project's `CHANGELOG.md` was rendered as omp's).
 */
export async function parseChangelog(changelogPath: string | undefined): Promise<ChangelogEntry[]> {
	if (!changelogPath) {
		return [];
	}
	try {
		return parseChangelogContent(await Bun.file(changelogPath).text());
	} catch (error) {
		if (isEnoent(error)) {
			return [];
		}
		logger.error(`Warning: Could not parse changelog: ${error}`);
		return [];
	}
}

export function parseChangelogContent(content: string): ChangelogEntry[] {
	const lines = content.split("\n");
	const entries: ChangelogEntry[] = [];

	let currentLines: string[] = [];
	let currentVersion: { major: number; minor: number; patch: number } | null = null;

	for (const line of lines) {
		// Check if this is a version header (## [x.y.z] ...)
		if (line.startsWith("## ")) {
			// Save previous entry if exists
			if (currentVersion && currentLines.length > 0) {
				entries.push({
					...currentVersion,
					content: currentLines.join("\n").trim(),
				});
			}

			// Try to parse version from this line
			const versionMatch = line.match(/##\s+\[?(\d+)\.(\d+)\.(\d+)\]?/);
			if (versionMatch) {
				currentVersion = {
					major: Number.parseInt(versionMatch[1], 10),
					minor: Number.parseInt(versionMatch[2], 10),
					patch: Number.parseInt(versionMatch[3], 10),
				};
				currentLines = [line];
			} else {
				// Reset if we can't parse version
				currentVersion = null;
				currentLines = [];
			}
		} else if (currentVersion) {
			// Collect lines for current version
			currentLines.push(line);
		}
	}

	// Save last entry
	if (currentVersion && currentLines.length > 0) {
		entries.push({
			...currentVersion,
			content: currentLines.join("\n").trim(),
		});
	}

	return entries;
}

export function changelogEntryVersion(entry: ChangelogEntry): string {
	return `${entry.major}.${entry.minor}.${entry.patch}`;
}

function compareVersionStrings(a: string, b: string): number {
	try {
		return Bun.semver.order(a, b);
	} catch {
		const pa = a.split(".").map(Number);
		const pb = b.split(".").map(Number);

		for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
			const na = pa[i] || 0;
			const nb = pb[i] || 0;
			if (na !== nb) return na - nb;
		}
		return 0;
	}
}

/**
 * Compare versions. Returns: -1 if v1 < v2, 0 if v1 === v2, 1 if v1 > v2
 */
export function compareVersions(v1: ChangelogEntry, v2: ChangelogEntry): number {
	return compareVersionStrings(changelogEntryVersion(v1), changelogEntryVersion(v2));
}

export function getEntriesInVersionRange(
	entries: ChangelogEntry[],
	fromExclusive: string,
	toInclusive: string,
): ChangelogEntry[] {
	return entries.filter(entry => {
		const version = changelogEntryVersion(entry);
		return compareVersionStrings(version, fromExclusive) > 0 && compareVersionStrings(version, toInclusive) <= 0;
	});
}

export function formatChangelogMarkdown(entries: ChangelogEntry[], options?: { reverse?: boolean }): string {
	const orderedEntries = options?.reverse ? [...entries].reverse() : entries;
	return orderedEntries.map(entry => entry.content).join("\n\n");
}

/**
 * Get entries newer than lastVersion
 */
export function getNewEntries(entries: ChangelogEntry[], lastVersion: string): ChangelogEntry[] {
	return entries.filter(entry => compareVersionStrings(changelogEntryVersion(entry), lastVersion) > 0);
}

// Re-export getChangelogPath from paths.ts for convenience
export { getChangelogPath } from "../config";

/**
 * Last omp version whose changelog the user has seen. Stored as a plain-text
 * marker file (`~/.omp/agent/last-changelog-version`) rather than in
 * `config.yml`, so version bumps never dirty user-tracked config files.
 */
export async function readLastChangelogVersion(agentDir?: string): Promise<string | undefined> {
	try {
		const value = (await Bun.file(getLastChangelogVersionPath(agentDir)).text()).trim();
		return value || undefined;
	} catch (error) {
		if (!isEnoent(error)) {
			logger.warn("Failed to read last-changelog-version marker", { error: String(error) });
		}
		return undefined;
	}
}

/** Persist the last-seen changelog version marker. Best-effort: failures are logged, never thrown. */
export async function writeLastChangelogVersion(version: string, agentDir?: string): Promise<void> {
	try {
		await Bun.write(getLastChangelogVersionPath(agentDir), version);
	} catch (error) {
		logger.warn("Failed to persist last-changelog-version marker", { error: String(error) });
	}
}
