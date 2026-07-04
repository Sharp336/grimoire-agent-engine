import { getProjectDir } from "@oh-my-pi/pi-utils";
import { Args, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { createDefaultWorkspaceCliService, runWorkspaceCommand } from "../cli/workspace-cli";
import { Settings } from "../config/settings";
import type { WorkspaceAction, WorkspaceCommandArgs, WorkspaceStatus } from "../cli/workspace-cli";

const ACTIONS: WorkspaceAction[] = ["list", "status", "discard", "cleanup", "publish"];

export default class Workspace extends Command {
	static description = "Inspect and manage registered OMP workspaces";
	static aliases = ["ws"];

	static args = {
		action: Args.string({
			description: "Workspace action",
			required: false,
			options: ACTIONS,
			default: "list",
		}),
		id: Args.string({
			description: "Workspace id for status, discard, or publish",
			required: false,
		}),
	};

	static flags = {
		json: Flags.boolean({ char: "j", description: "Output JSON", default: false }),
		"dry-run": Flags.boolean({ char: "n", description: "Show cleanup targets without discarding", default: false }),
		requester: Flags.string({ description: "Agent id requesting discard, cleanup, or publish" }),
		status: Flags.string({
			description: "Cleanupable status (repeatable or comma-separated; default: idle,parked)",
			multiple: true,
		}),
		branch: Flags.string({ description: "Explicit branch name for publish" }),
	};

	static examples = [
		"omp workspace list --json",
		"omp ws status <workspace-id>",
		"omp workspace cleanup --status idle --status parked",
		"omp workspace publish <workspace-id> --branch workspace/review",
	];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Workspace);
		const action = (args.action ?? "list") as WorkspaceAction;
		const cmd: WorkspaceCommandArgs = {
			action,
			id: args.id,
			requesterAgentId: flags.requester,
			statuses: normalizeStatuses(flags.status),
			dryRun: flags["dry-run"] ?? false,
			json: flags.json ?? false,
			contract: flags.branch ? { kind: "branch", branchName: flags.branch } : undefined,
		};

		await Settings.init({ cwd: getProjectDir() });
		await runWorkspaceCommand(cmd, { service: createDefaultWorkspaceCliService() });
	}
}

function normalizeStatuses(value: string | string[] | undefined): WorkspaceStatus[] | undefined {
	if (!value) return undefined;
	const raw = Array.isArray(value) ? value : [value];
	const statuses = raw.flatMap(entry => entry.split(",").map(part => part.trim())).filter(Boolean);
	return statuses.length > 0 ? statuses : undefined;
}
