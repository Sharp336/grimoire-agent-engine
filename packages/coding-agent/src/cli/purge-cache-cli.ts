/**
 * purge-cache CLI command handler.
 *
 * Handles `omp purge-cache` — clears the catalog model-metadata cache (the
 * SQLite provider/model list at `~/.omp/agent/models.db`, re-fetched cheaply
 * on the next run). With `--all`, also removes the downloaded local model
 * weight caches (fastembed, tiny-models, gpu). `--provider <id>` scopes the
 * metadata purge to a single provider.
 */
import * as fs from "node:fs/promises";
import { clearModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { getFastembedCacheDir, getGpuCachePath, getTinyModelsCacheDir } from "@oh-my-pi/pi-utils";
import chalk from "chalk";

export async function runPurgeCacheCommand({
	all,
	provider,
	json,
}: {
	all: boolean;
	provider?: string;
	json: boolean;
}): Promise<void> {
	const rows = clearModelCache(undefined, provider);

	if (all) {
		// `force: true` already swallows ENOENT, so missing cache dirs are a no-op.
		const weightCaches = [getFastembedCacheDir(), getTinyModelsCacheDir(), getGpuCachePath()];
		await Promise.all(weightCaches.map(dir => fs.rm(dir, { recursive: true, force: true })));
	}

	if (json) {
		process.stdout.write(`${JSON.stringify({ rows, clearedWeights: all })}\n`);
		return;
	}

	const scope = provider ? ` for provider "${provider}"` : "";
	process.stdout.write(chalk.green(`Cleared ${rows} model-cache row(s)${scope}.\n`));
	if (all) {
		process.stdout.write(chalk.green("Removed downloaded weight caches (fastembed, tiny-models, gpu).\n"));
	}
}
