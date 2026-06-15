import * as path from "node:path";
import { DEFAULT_FILE_NAMES } from "./types";

export interface FindAgentsMdUpInput {
	startDir: string;
	rootDir: string;
	fileNames?: readonly string[];
}

export async function findAgentsMdUp(input: FindAgentsMdUpInput): Promise<string[]> {
	const fileNames = input.fileNames ?? DEFAULT_FILE_NAMES;
	const collected: string[] = [];
	let current = input.startDir;

	while (true) {
		const isRoot = current === input.rootDir;
		if (!isRoot) {
			const match = await findFirstExistingFile(current, fileNames);
			if (match !== undefined) collected.push(match);
		}

		if (isRoot) break;

		const parent = path.dirname(current);
		if (parent === current) break;
		if (!isWithinRoot(input.rootDir, parent)) break;
		current = parent;
	}

	return collected.reverse();
}

function isWithinRoot(rootDir: string, candidate: string): boolean {
	const relativePath = path.relative(rootDir, candidate);
	return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

async function findFirstExistingFile(directory: string, fileNames: readonly string[]): Promise<string | undefined> {
	for (const name of fileNames) {
		const candidate = path.join(directory, name);
		if (await Bun.file(candidate).exists()) return candidate;
	}

	return undefined;
}
