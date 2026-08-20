/**
 * Check for and install updates.
 */

import { Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { updateHelp as commandHelp } from "../cli/command-help";
import * as pluginCli from "../cli/plugin-cli";
import * as updateCli from "../cli/update-cli";
import { initTheme } from "../modes/theme/theme";

export default class Update extends Command {
	static description = commandHelp.description;
	static flags = {
		force: Flags.boolean({ char: "f", description: "Force update", default: false }),
		check: Flags.boolean({ char: "c", description: "Check for updates without installing", default: false }),
		plugins: Flags.boolean({ char: "l", description: "Update installed plugins", default: false }),
		registry: Flags.string({
			char: "r",
			description: `npm registry to check and install from (default: $${updateCli.REGISTRY_ENV_VAR} or the official registry)`,
		}),
	};

	static examples = [
		"omp update",
		"omp update --check",
		"# Behind a mirror that proxies npm (Artifactory, Nexus, Verdaccio, …)\n  omp update --registry=https://nexus.corp/repository/npm-group/",
		"# Same, for every invocation\n  export OMP_UPDATE_REGISTRY=https://nexus.corp/repository/npm-group/",
		"# If GitHub rate-limits release metadata, set GITHUB_TOKEN or GH_TOKEN\n  GITHUB_TOKEN=... omp update",
	];

	async run(): Promise<void> {
		const { flags } = await this.parse(Update);
		await initTheme();
		if (flags.plugins) {
			await pluginCli.runPluginCommand({ action: "upgrade", args: [], flags: {} });
		} else {
			await updateCli.runUpdateCommand({ force: flags.force, check: flags.check, registry: flags.registry });
		}
	}
}
