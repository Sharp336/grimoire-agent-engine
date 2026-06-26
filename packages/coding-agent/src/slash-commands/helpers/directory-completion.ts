import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AutocompleteItem } from "@oh-my-pi/pi-tui";
import { getProjectDir } from "@oh-my-pi/pi-utils";

const MOVE_DIRECTORY_COMPLETION_LIMIT = 100;

function normalizeMoveCompletionPrefix(argumentPrefix: string): string {
	const unquoted = argumentPrefix.startsWith('"') ? argumentPrefix.slice(1).replace(/"$/, "") : argumentPrefix;
	if (unquoted === "~") return "~/";
	if (unquoted.startsWith("~") && !unquoted.startsWith("~/") && !unquoted.startsWith("~\\")) {
		return `~/${unquoted.slice(1)}`;
	}
	return unquoted;
}

function resolveMoveCompletionSearchDir(displayDirPrefix: string, cwd: string): string {
	if (displayDirPrefix.length === 0) return cwd;
	if (displayDirPrefix === "~/" || displayDirPrefix === "~\\") return os.homedir();
	if (displayDirPrefix.startsWith("~/") || displayDirPrefix.startsWith("~\\")) {
		return path.join(os.homedir(), displayDirPrefix.slice(2));
	}
	if (path.isAbsolute(displayDirPrefix) || path.win32.isAbsolute(displayDirPrefix)) {
		return displayDirPrefix;
	}
	return path.resolve(cwd, displayDirPrefix);
}

function moveCompletionScope(argumentPrefix: string): {
	searchDir: string;
	searchPrefix: string;
	displayDirPrefix: string;
} {
	const pathPrefix = normalizeMoveCompletionPrefix(argumentPrefix);
	const separatorIndex = Math.max(pathPrefix.lastIndexOf("/"), pathPrefix.lastIndexOf("\\"));
	const displayDirPrefix = separatorIndex === -1 ? "" : pathPrefix.slice(0, separatorIndex + 1);
	const searchPrefix = separatorIndex === -1 ? pathPrefix : pathPrefix.slice(separatorIndex + 1);
	return {
		searchDir: resolveMoveCompletionSearchDir(displayDirPrefix, getProjectDir()),
		searchPrefix,
		displayDirPrefix,
	};
}

async function isDirectoryEntry(searchDir: string, entry: Dirent): Promise<boolean> {
	if (entry.isDirectory()) return true;
	if (!entry.isSymbolicLink()) return false;
	try {
		return (await fs.stat(path.join(searchDir, entry.name))).isDirectory();
	} catch {
		return false;
	}
}

export async function getMoveDirectoryArgumentCompletions(argumentPrefix: string): Promise<AutocompleteItem[] | null> {
	if (argumentPrefix.includes("\n")) return null;
	const { searchDir, searchPrefix, displayDirPrefix } = moveCompletionScope(argumentPrefix);
	const lowerPrefix = searchPrefix.toLowerCase();
	let entries: Dirent[];
	try {
		entries = await fs.readdir(searchDir, { withFileTypes: true });
	} catch {
		return null;
	}

	const matches: AutocompleteItem[] = [];
	for (const entry of entries) {
		if (entry.name === ".git") continue;
		if (!entry.name.toLowerCase().startsWith(lowerPrefix)) continue;
		if (!(await isDirectoryEntry(searchDir, entry))) continue;
		matches.push({
			value: `${displayDirPrefix}${entry.name}/`,
			label: `${entry.name}/`,
			description: path.join(searchDir, entry.name),
		});
		if (matches.length >= MOVE_DIRECTORY_COMPLETION_LIMIT) break;
	}

	matches.sort((a, b) => a.label.localeCompare(b.label));
	return matches.length > 0 ? matches : null;
}
