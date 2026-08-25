import { Args, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { profileHelp as commandHelp } from "../cli/command-help";
import { type ProfileAction, runProfileCommand } from "../cli/profile-cli";

const ACTIONS: ProfileAction[] = ["bind", "unbind", "show", "list", "list-bindings"];

export default class Profile extends Command {
	static description = commandHelp.description;

	static args = {
		action: Args.string({
			description: "bind, unbind, show, or list",
			required: false,
			options: ACTIONS,
			default: "show",
		}),
		value: Args.string({
			description: "Profile name for bind; folder path for other actions",
			required: false,
		}),
		path: Args.string({
			description: "Folder path for bind",
			required: false,
		}),
	};

	static flags = {
		json: Flags.boolean({ char: "j", description: "Emit machine-readable JSON", default: false }),
	};

	static examples = [
		"omp profile bind work",
		"omp profile bind work <path>",
		"omp profile show",
		"omp profile unbind",
		"omp profile list",
	];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Profile);
		const action = args.action as ProfileAction;
		const isList = action === "list" || action === "list-bindings";
		if ((action !== "bind" && args.path !== undefined) || (isList && args.value !== undefined)) {
			throw new Error(`Too many arguments for omp profile ${action}`);
		}
		await runProfileCommand({
			action,
			profile: action === "bind" ? args.value : undefined,
			path: action === "bind" ? args.path : args.value,
			json: flags.json ?? false,
		});
	}
}
