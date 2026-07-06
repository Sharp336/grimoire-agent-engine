/**
 * Launch the coding agent with Nikoflow phase gates active.
 */
import { APP_NAME } from "@oh-my-pi/pi-utils";
import { Args, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { parseArgs } from "../cli/args";
import { normalizeNikoflowCommandArgs } from "../cli/nikoflow-command";
import { runRootCommand } from "../main";
import { prepareAcpTerminalAuthArgs } from "../modes/acp/terminal-auth";
import { NIKOFLOW_DEPTHS } from "../nikoflow/state";

export default class Nikoflow extends Command {
	static description = "Launch the agent with Nikoflow phase-gated mode enabled";
	static strict = false;
	static args = {
		messages: Args.string({
			description: "Depth and messages to send (prefix files with @)",
			required: false,
			multiple: true,
		}),
	};
	static flags = {
		depth: Flags.string({ description: "Nikoflow depth", options: [...NIKOFLOW_DEPTHS] }),
		batch: Flags.boolean({ description: "Run Nikoflow gates autonomously through advisor review" }),
		exec: Flags.string({ description: "Executor model (maps to modelRoles.default)" }),
		architect: Flags.string({ description: "Architect model (maps to modelRoles.plan)" }),
		qa: Flags.string({ description: "QA model (maps to modelRoles.advisor)" }),
	};
	static examples = [
		`${APP_NAME} nikoflow "fix this bug"`,
		`${APP_NAME} nikoflow:tactical "fix a typo"`,
		`${APP_NAME} nikoflow deep --exec gpt-5.3-codex-spark --architect gpt-5.5 "design the change"`,
	];

	async run(): Promise<void> {
		const { args } = prepareAcpTerminalAuthArgs(this.argv);
		const normalized = normalizeNikoflowCommandArgs(args);
		if ("error" in normalized) {
			process.stderr.write(`${normalized.error}\n`);
			process.exit(2);
		}

		const rawArgs = [
			"--nikoflow-depth",
			normalized.depth,
			...(normalized.autonomous ? ["--nikoflow-batch"] : []),
			...normalized.argv,
		];
		const parsed = parseArgs(rawArgs);
		await runRootCommand(parsed, rawArgs);
	}
}
