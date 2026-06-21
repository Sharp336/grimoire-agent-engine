import { resolveJsDebugServerPath } from "./resolution/js-debug-resolution";
import type { DapAdapterConfig } from "./types";

export function adapterRequiresServerPath(config: DapAdapterConfig): boolean {
	return Boolean(config.serverResolver || config.serverPathEnv || (config.serverPathCandidates?.length ?? 0) > 0);
}

export function resolveAdapterServerPath(
	config: DapAdapterConfig,
	resolvedAdapterCommand: string | null,
	cwd: string,
): string | null {
	if (config.serverResolver === "js-debug") {
		return resolveJsDebugServerPath(config, resolvedAdapterCommand, cwd);
	}
	return null;
}
