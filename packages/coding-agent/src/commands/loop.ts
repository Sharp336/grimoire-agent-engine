import { Args, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { runLoopCli } from "../loop-engineering/cli";

export default class Loop extends Command {
	static description = "Initialize, check, and run OMP loop-engineering specs";

	static args = {
		action: Args.string({
			description: "init, check, status, or run",
			required: false,
			options: ["init", "check", "status", "run"],
			default: "status",
		}),
		target: Args.string({
			description: "Loop name or .loop.yaml path",
			required: false,
		}),
	};

	static flags = {
		dir: Flags.string({ description: "Project directory containing .omp/loops", default: process.cwd() }),
		pattern: Flags.string({ description: "Starter pattern for init (daily-triage or ci-sweeper)" }),
		force: Flags.boolean({ char: "f", description: "Overwrite existing starter files during init", default: false }),
		"dry-run": Flags.boolean({
			description: "Build the run prompt without calling the agent or verifier",
			default: false,
		}),
		json: Flags.boolean({ char: "j", description: "Emit machine-readable JSON", default: false }),
	};

	static examples = [
		"omp loop init daily-triage",
		"omp loop check daily-triage",
		"omp loop run daily-triage --dry-run",
		"omp loop status --json",
	];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Loop);
		await runLoopCli(args.action ?? "status", args.target, {
			cwd: flags.dir ?? process.cwd(),
			json: flags.json ?? false,
			force: flags.force ?? false,
			dryRun: flags["dry-run"] ?? false,
			pattern: flags.pattern,
		});
	}
}
