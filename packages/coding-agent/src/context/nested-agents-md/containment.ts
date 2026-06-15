import { realpath } from "node:fs/promises";
import * as path from "node:path";

export interface ContainmentResult {
	canonicalPath: string;
	canonicalRoot: string;
}

export interface ResolveAndContainInput {
	filePath: string;
	rootDir: string;
}

export async function resolveAndContain(input: ResolveAndContainInput): Promise<ContainmentResult | undefined> {
	if (!input.filePath) return undefined;

	const resolvedPath = path.isAbsolute(input.filePath) ? input.filePath : path.resolve(input.rootDir, input.filePath);

	let canonicalRoot: string;
	let canonicalPath: string;
	try {
		canonicalRoot = await realpath(input.rootDir);
		canonicalPath = await realpath(resolvedPath);
	} catch {
		return undefined;
	}

	if (canonicalPath === canonicalRoot) return undefined;

	const rootBoundary = canonicalRoot.endsWith(path.sep) ? canonicalRoot : canonicalRoot + path.sep;
	if (!canonicalPath.startsWith(rootBoundary)) return undefined;

	return { canonicalPath, canonicalRoot };
}
