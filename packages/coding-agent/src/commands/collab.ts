/**
 * List active local Collab host sessions.
 */
import { Args, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { runCollabListCommand } from "../cli/collab-cli";

export default class Collab extends Command {
	static description =
		"List active local Collab host sessions.\n\n" +
		"By default each row prints the write-capable browser URL: anyone who obtains it " +
		"can prompt and control the host agent, so treat the output (and anything you " +
		"redirect it into) as secret. Use --view for view-only URLs.";

	static args = {
		action: Args.string({
			description: "list (default)",
			required: false,
			options: ["list"],
			default: "list",
		}),
	};

	static flags = {
		view: Flags.boolean({
			description: "Print view-only URLs instead of write-capable URLs (same hosts, weaker capability)",
			default: false,
		}),
		json: Flags.boolean({ char: "j", description: "Emit deterministic machine-readable JSON", default: false }),
	};

	static examples = ["omp collab list", "omp collab list --view", "omp collab list --json"];

	async run(): Promise<void> {
		const { flags } = await this.parse(Collab);
		await runCollabListCommand({ view: flags.view ?? false, json: flags.json ?? false });
	}
}
