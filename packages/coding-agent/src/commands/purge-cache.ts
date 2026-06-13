/**
 * Clear cached model data: the model-metadata cache by default, and
 * (with `--all`) the downloaded local model weight caches as well.
 */
import { Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { runPurgeCacheCommand } from "../cli/purge-cache-cli";

export default class PurgeCache extends Command {
	static description =
		"Clear cached model data (model-metadata cache by default; --all also removes downloaded weights)";

	static flags = {
		all: Flags.boolean({
			description: "Also delete downloaded local model weights (fastembed, tiny-models, gpu)",
			default: false,
		}),
		provider: Flags.string({ description: "Only purge the metadata cache for this provider id" }),
		json: Flags.boolean({ default: false }),
	};

	static examples = [
		"<%= config.bin %> purge-cache",
		"<%= config.bin %> purge-cache --all",
		"<%= config.bin %> purge-cache --provider openrouter",
	];

	async run(): Promise<void> {
		const { flags } = await this.parse(PurgeCache);
		await runPurgeCacheCommand(flags);
	}
}
