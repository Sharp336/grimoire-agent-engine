/**
 * `omp doctor` — surface the state of the launchd auto-update job in a
 * one-screen, Korean-first format. The actual work is done by the launchd
 * job at `~/.omp/patches/update-and-patch.sh`, which writes
 * `~/.omp/state/auto-update.json` after every cycle. This command only
 * reads that file and translates it for the user.
 *
 * No network IO, no git mutation, no side effects. Safe to run any time.
 */
import { Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { runDoctorCommand } from "../cli/doctor-cli";
import { initTheme } from "../modes/theme/theme";

export default class Doctor extends Command {
	static description = "Show the status of the OMP auto-update job and tell you the one safe action to take";

	static flags = {
		json: Flags.boolean({ description: "Emit the raw state JSON instead of a friendly report", default: false }),
	};

	async run(): Promise<void> {
		const { flags } = await this.parse(Doctor);
		await initTheme();
		await runDoctorCommand({ json: flags.json });
	}
}
