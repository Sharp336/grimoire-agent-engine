import { APP_NAME } from "@oh-my-pi/pi-utils";
import chalk from "chalk";
import type { PiCompatDoctorReport } from "../extensibility/pi-compat";
import { doctorPiCompatTarget, ensurePiCliShim, ensurePiHomeSymlinkBridge } from "../extensibility/pi-compat";
import { PluginManager } from "../extensibility/plugins";
import { theme } from "../modes/theme/theme";

export type PiAction = "doctor" | "install" | "shim" | "bridge";

export interface PiCommandArgs {
	action: PiAction;
	args: string[];
	flags: {
		json?: boolean;
		dryRun?: boolean;
		force?: boolean;
	};
}

export function formatPiDoctorReport(report: PiCompatDoctorReport): string {
	const lines: string[] = [];
	lines.push(`Package: ${report.packageName ?? report.spec}`);
	if (report.packagePath) lines.push(`Path: ${report.packagePath}`);
	lines.push(`Tier: ${report.tierLabel}`);
	lines.push(`Bridge: ${report.recommendedBridgeMode}`);
	lines.push("");
	for (const finding of report.findings) {
		const label = finding.status.toUpperCase();
		lines.push(`${label}: ${finding.message}`);
		if (finding.paths?.length) {
			for (const filePath of finding.paths.slice(0, 5)) {
				lines.push(`  - ${filePath}`);
			}
			if (finding.paths.length > 5) {
				lines.push(`  - ... ${finding.paths.length - 5} more`);
			}
		}
	}
	return lines.join("\n");
}

async function handleDoctor(args: string[], flags: PiCommandArgs["flags"]): Promise<void> {
	if (args.length === 0) {
		console.error(chalk.red(`Usage: ${APP_NAME} pi doctor <package-source> ...`));
		process.exit(1);
	}
	const reports = await Promise.all(args.map(spec => doctorPiCompatTarget(spec)));
	if (flags.json) {
		console.log(JSON.stringify(reports, null, 2));
		return;
	}
	for (let i = 0; i < reports.length; i++) {
		if (i > 0) console.log("");
		console.log(formatPiDoctorReport(reports[i]));
	}
}

async function handleInstall(args: string[], flags: PiCommandArgs["flags"]): Promise<void> {
	if (args.length === 0) {
		console.error(chalk.red(`Usage: ${APP_NAME} pi install <package-source> ...`));
		process.exit(1);
	}
	const manager = new PluginManager();
	const installed = [];
	for (const spec of args) {
		const plugin = await manager.install(spec, { dryRun: flags.dryRun, force: flags.force, compatPi: true });
		installed.push(plugin);
		if (!flags.json) {
			if (flags.dryRun) {
				console.log(chalk.dim(`[dry-run] Would install ${spec}`));
			} else {
				console.log(chalk.green(`${theme.status.success} Installed ${plugin.name}@${plugin.version}`));
			}
		}
	}
	if (flags.json) console.log(JSON.stringify(installed, null, 2));
}

async function handleShim(flags: PiCommandArgs["flags"]): Promise<void> {
	const shim = await ensurePiCliShim();
	if (flags.json) {
		console.log(JSON.stringify(shim, null, 2));
		return;
	}
	console.log(chalk.green(`${theme.status.success} Pi CLI shim: ${shim.shimPath}`));
	console.log(chalk.dim(`Add to scoped PATH only: ${shim.binDir}`));
}

async function handleBridge(args: string[], flags: PiCommandArgs["flags"]): Promise<void> {
	const mode = args[0] ?? "plan";
	if (mode !== "symlink" && mode !== "plan") {
		console.error(chalk.red(`Usage: ${APP_NAME} pi bridge [plan|symlink] [--dry-run]`));
		process.exit(1);
	}
	const plan = await ensurePiHomeSymlinkBridge({ dryRun: flags.dryRun || mode === "plan" });
	if (flags.json) {
		console.log(JSON.stringify(plan, null, 2));
		return;
	}
	const color = plan.mode === "refuse-existing" ? chalk.yellow : chalk.green;
	console.log(color(`${plan.mode}: ${plan.message}`));
}

export async function runPiCommand(cmd: PiCommandArgs): Promise<void> {
	switch (cmd.action) {
		case "doctor":
			await handleDoctor(cmd.args, cmd.flags);
			break;
		case "install":
			await handleInstall(cmd.args, cmd.flags);
			break;
		case "shim":
			await handleShim(cmd.flags);
			break;
		case "bridge":
			await handleBridge(cmd.args, cmd.flags);
			break;
	}
}
