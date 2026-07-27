/**
 * Check for and install updates.
 */
import { Command, Flags } from "@oh-my-pi/pi-utils/cli";
import * as pluginCli from "../cli/plugin-cli";
import * as updateCli from "../cli/update-cli";
import { initTheme } from "../modes/theme/theme";

export default class Update extends Command {
	static description = "Check for and install updates";

	static flags = {
		force: Flags.boolean({ char: "f", description: "Force update", default: false }),
		check: Flags.boolean({ char: "c", description: "Check for updates without installing", default: false }),
		plugins: Flags.boolean({ char: "l", description: "Update installed plugins", default: false }),
		json: Flags.boolean({ description: "Output update check as JSON (implies --check)", default: false }),
	};

	static examples = [
		"omp update",
		"omp update --check --json",
		"omp update --check",
		"# If GitHub rate-limits release metadata, set GITHUB_TOKEN or GH_TOKEN\n  GITHUB_TOKEN=... omp update",
	];

	async run(): Promise<void> {
		const { flags } = await this.parse(Update);
		if (flags.json) {
			const incompatibleFlag = flags.plugins ? "--plugins" : flags.force ? "--force" : undefined;
			if (incompatibleFlag) {
				process.stdout.write(
					`${JSON.stringify(updateCli.createUpdateCheckError(`--json cannot be used with ${incompatibleFlag}`), null, 2)}\n`,
				);
				process.exitCode = 1;
				return;
			}
			await updateCli.runUpdateCommand({ force: false, check: true, json: true });
			return;
		}

		await initTheme();
		if (flags.plugins) {
			await pluginCli.runPluginCommand({ action: "upgrade", args: [], flags: {} });
		} else {
			await updateCli.runUpdateCommand({ force: flags.force, check: flags.check, json: false });
		}
	}
}
