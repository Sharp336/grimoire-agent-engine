import { Args, CliUsageError, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { importHelp as commandHelp } from "../cli/command-help";
import {
	type PrimeImportCommandArgs,
	runPrimeImportCommand,
	serializePrimeImportReport,
} from "../cli/prime-import-cli";
import type { PrimeImportReport } from "../import/prime/types";

const JSON_SERIALIZATION_FAILURE_REPORT = {
	schemaVersion: 1,
	snapshotId: "serialization-failed",
	items: [],
	losses: [{ code: "destination-apply-failed", domain: "config", sourceRef: "output" }],
	partialApply: true,
} satisfies PrimeImportReport;
function writeJsonFailure(): void {
	try {
		process.stdout.write(serializePrimeImportReport(JSON_SERIALIZATION_FAILURE_REPORT));
	} catch {
		process.stdout.write(`${JSON.stringify(JSON_SERIALIZATION_FAILURE_REPORT)}\n`);
	}
}

export default class Import extends Command {
	static description = commandHelp.description;
	static examples = [
		"omp import prime --json",
		"omp import prime --source ~/.prime/agent --agent-dir ~/.omp/agent --apply",
	];

	static args = {
		kind: Args.string({ description: "Import source kind", required: true, options: ["prime"] }),
	};

	static flags = {
		source: Flags.string({ description: "Prime home to import" }),
		cwd: Flags.string({ description: "Project directory" }),
		"session-root": Flags.string({ description: "Prime session directory" }),
		"prime-cli-config": Flags.string({ description: "Prime CLI config file" }),
		"agent-dir": Flags.string({ description: "OMP agent directory" }),
		apply: Flags.boolean({ description: "Apply changes (default is dry-run)", default: false }),
		"config-only": Flags.boolean({
			description: "Import settings, compatible models, and credentials without skills, sessions, or artifacts",
			default: false,
		}),
		json: Flags.boolean({ description: "Output JSON", default: false }),
	};

	async run(): Promise<void> {
		const jsonRequested = this.argv.includes("--json");
		try {
			const parsed = await this.parse(Import);
			if (parsed.argv.length !== 1) throw new CliUsageError("Unexpected extra positional arguments");
			const args: PrimeImportCommandArgs = {
				source: parsed.flags.source,
				cwd: parsed.flags.cwd,
				sessionRoot: parsed.flags["session-root"],
				primeCliConfigPath: parsed.flags["prime-cli-config"],
				agentDir: parsed.flags["agent-dir"],
				apply: parsed.flags.apply,
				configOnly: parsed.flags["config-only"],
			};
			const result = await runPrimeImportCommand(args);
			if (parsed.flags.json) {
				try {
					process.stdout.write(serializePrimeImportReport(result.report));
				} catch {
					writeJsonFailure();
					process.exitCode = 1;
				}
				if (result.exitCode !== 0) process.exitCode = result.exitCode;
				return;
			}
			process.stdout.write(result.human);
			if (result.exitCode !== 0) process.exitCode = result.exitCode;
		} catch (error) {
			if (!jsonRequested) throw error;
			writeJsonFailure();
			process.exitCode = 1;
		}
	}
}
