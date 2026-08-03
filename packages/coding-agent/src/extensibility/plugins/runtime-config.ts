import { isEnoent } from "@oh-my-pi/pi-utils";
import type { PluginRuntimeConfig } from "./types";

/** Normalizes persisted plugin runtime config across legacy lockfile shapes. */
export function normalizePluginRuntimeConfig(config: Partial<PluginRuntimeConfig>): PluginRuntimeConfig {
	return {
		plugins: config.plugins ?? {},
		settings: config.settings ?? {},
	};
}

/**
 * Strict read of `omp-plugins.lock.json`.
 *
 * Missing files (`ENOENT`) resolve to an empty normalized config. Malformed JSON
 * and other read failures are rethrown — matching production plugin loader
 * behavior. Callers that need lossy fallback (e.g. PluginManager list/install)
 * must catch separately; doctor should call this helper directly.
 */
export async function readPluginRuntimeConfig(lockPath: string): Promise<PluginRuntimeConfig> {
	try {
		return normalizePluginRuntimeConfig(await Bun.file(lockPath).json());
	} catch (err) {
		if (isEnoent(err)) return normalizePluginRuntimeConfig({});
		throw err;
	}
}
