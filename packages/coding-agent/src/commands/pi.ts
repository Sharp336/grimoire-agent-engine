import { Args, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { type PiAction, type PiCommandArgs, runPiCommand } from "../cli/pi-cli";
import { initTheme } from "../modes/theme/theme";

const ACTIONS: PiAction[] = ["doctor", "install", "shim", "bridge"];

export default class Pi extends Command {
	static description = "Pi compatibility tools";

	static args = {
		action: Args.string({
			description: "Pi compatibility action",
			required: false,
			options: ACTIONS,
		}),
		targets: Args.string({
			description: "Package sources or bridge mode",
			required: false,
			multiple: true,
		}),
	};

	static flags = {
		json: Flags.boolean({ description: "Output JSON" }),
		"dry-run": Flags.boolean({ description: "Show actions without applying changes" }),
		force: Flags.boolean({ description: "Force install" }),
	};

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Pi);
		const action = (args.action ?? "doctor") as PiAction;
		const targets = Array.isArray(args.targets) ? args.targets : args.targets ? [args.targets] : [];
		const cmd: PiCommandArgs = {
			action,
			args: targets,
			flags: {
				json: flags.json,
				dryRun: flags["dry-run"],
				force: flags.force,
			},
		};
		await initTheme();
		await runPiCommand(cmd);
	}
}
