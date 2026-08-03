/**
 * Diagnose the local omp install and repair on-disk databases.
 */
import { Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { type DoctorCommandArgs, runDoctorCommand } from "../cli/doctor-cli";
import { initTheme } from "../modes/theme/theme";

export default class Doctor extends Command {
	static description = "Diagnose the omp install and repair on-disk databases";

	static flags = {
		json: Flags.boolean({ description: "Output JSON" }),
		fix: Flags.boolean({ description: "Repair and optimize databases (default is read-only)" }),
		"agent-dir": Flags.string({ description: "Restrict checks to this agent directory" }),
	};

	async run(): Promise<void> {
		const { flags } = await this.parse(Doctor);
		const cmd: DoctorCommandArgs = {
			flags: { json: flags.json, fix: flags.fix, agentDir: flags["agent-dir"] },
		};
		await initTheme();
		const report = await runDoctorCommand(cmd);
		if (report.overallStatus === "error") process.exitCode = 1;
	}
}
