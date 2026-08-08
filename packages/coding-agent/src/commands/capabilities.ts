import { Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { capabilitiesHelp as commandHelp } from "../cli/command-help";
import { resolvePromptGateCapability } from "../prompt-gate/capability";

export default class Capabilities extends Command {
	static description = commandHelp.description;
	static flags = {
		json: Flags.boolean({ description: "Output machine-readable JSON", required: true }),
	};

	async run(): Promise<void> {
		await this.parse(Capabilities);
		process.stdout.write(`${JSON.stringify(resolvePromptGateCapability())}\n`);
	}
}
