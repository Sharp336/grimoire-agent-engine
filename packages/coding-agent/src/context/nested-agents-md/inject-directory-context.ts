import * as path from "node:path";
import { resolveAndContain } from "./containment";
import { InjectionFileReadError } from "./errors";
import { findAgentsMdUp } from "./find-agents-md-up";
import { formatDirectoryContext } from "./format";
import type { InjectionCache } from "./injection-cache";
import { truncateBytes } from "./truncate";
import {
	DEFAULT_FILE_NAMES,
	DEFAULT_MAX_BYTES_PER_FILE,
	DEFAULT_MAX_BYTES_PER_READ,
	type InjectedFileInfo,
	type InjectionConfig,
	type InjectionFileError,
	type InjectionResult,
} from "./types";

export interface InjectDirectoryContextInput {
	filePath: string;
	rootDir: string;
	cache: InjectionCache;
	sessionKey: string;
	config?: Partial<InjectionConfig>;
}

export async function injectDirectoryContext(input: InjectDirectoryContextInput): Promise<InjectionResult> {
	const config = resolveConfig(input.config);
	const contained = await resolveAndContain({
		filePath: input.filePath,
		rootDir: input.rootDir,
	});
	if (contained === undefined) return { injectedText: "", injectedFiles: [], errors: [] };

	const candidates = await findAgentsMdUp({
		startDir: path.dirname(contained.canonicalPath),
		rootDir: contained.canonicalRoot,
		fileNames: config.fileNames,
	});

	const injectedFiles: InjectedFileInfo[] = [];
	const errors: InjectionFileError[] = [];
	let injectedText = "";
	let bytesBudget = config.maxBytesPerRead;

	for (const agentsPath of candidates) {
		const agentsDir = path.dirname(agentsPath);
		if (input.cache.hasInjected(input.sessionKey, agentsDir)) continue;
		if (bytesBudget <= 0) break;

		let content: string;
		try {
			content = await Bun.file(agentsPath).text();
		} catch (error) {
			errors.push({
				path: agentsPath,
				error: new InjectionFileReadError(agentsPath, error),
			});
			continue;
		}

		const perFileCap = Math.min(config.maxBytesPerFile, bytesBudget);
		const truncated = truncateBytes(content, perFileCap);

		injectedFiles.push({
			absolutePath: agentsPath,
			directory: agentsDir,
			truncated: truncated.truncated,
			originalBytes: truncated.originalBytes,
			injectedBytes: truncated.resultBytes,
		});

		injectedText += formatDirectoryContext({
			absolutePath: agentsPath,
			content: truncated.result,
			truncated: truncated.truncated,
		});
		input.cache.markInjected(input.sessionKey, agentsDir);
		bytesBudget -= truncated.resultBytes;
	}

	return { injectedText, injectedFiles, errors };
}

function resolveConfig(partial: Partial<InjectionConfig> | undefined): InjectionConfig {
	return {
		fileNames: partial?.fileNames ?? DEFAULT_FILE_NAMES,
		maxBytesPerFile: partial?.maxBytesPerFile ?? DEFAULT_MAX_BYTES_PER_FILE,
		maxBytesPerRead: partial?.maxBytesPerRead ?? DEFAULT_MAX_BYTES_PER_READ,
	};
}
