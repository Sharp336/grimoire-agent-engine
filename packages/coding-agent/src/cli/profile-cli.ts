import chalk from "@oh-my-pi/pi-utils/chalk";
import { shortenPath } from "../tools/render-utils";
import {
	bindProfileToFolder,
	listProfileBindings,
	type ProfileBinding,
	resolveProfileBinding,
	unbindProfileFromFolder,
} from "./profile-bindings";
import { getExplicitProfileSelection } from "./profile-selection";

export type ProfileAction = "bind" | "list" | "list-bindings" | "show" | "unbind";

export interface ProfileCommandOptions {
	action: ProfileAction;
	profile?: string;
	path?: string;
	json: boolean;
}

function bindingLabel(binding: ProfileBinding): string {
	const base = shortenPath(binding.path);
	return binding.subpath ? `${base} (${binding.subpath})` : base;
}

export async function runProfileCommand(options: ProfileCommandOptions): Promise<void> {
	if (options.action === "bind") {
		if (!options.profile) throw new Error("Usage: omp profile bind <profile> [path]");
		const binding = await bindProfileToFolder(options.profile, options.path);
		if (options.json) {
			console.log(JSON.stringify(binding, null, 2));
			return;
		}
		console.log(`Bound ${chalk.cyan(bindingLabel(binding))} to profile ${chalk.green(binding.profile)}.`);
		return;
	}

	if (options.action === "unbind") {
		const removed = await unbindProfileFromFolder(options.path);
		if (options.json) {
			console.log(JSON.stringify({ removed }, null, 2));
			return;
		}
		if (!removed) {
			console.log(chalk.dim("This folder has no profile binding."));
			return;
		}
		console.log(
			`Removed the ${chalk.green(removed.profile)} profile binding for ${chalk.cyan(bindingLabel(removed))}.`,
		);
		return;
	}

	if (options.action === "show") {
		const explicit = getExplicitProfileSelection();
		const resolved = explicit ? null : await resolveProfileBinding(options.path);
		const profile = explicit?.profile ?? resolved?.binding.profile ?? "default";
		const selectedBy = explicit?.source ?? (resolved ? "folder-binding" : "default");
		if (options.json) {
			console.log(
				JSON.stringify({ profile, selectedBy, ...(resolved ? { binding: resolved.binding } : {}) }, null, 2),
			);
			return;
		}
		console.log(`Profile: ${chalk.green(profile)}`);
		console.log(`Selected by: ${selectedBy === "folder-binding" ? "folder binding" : selectedBy}`);
		if (resolved) console.log(`Folder: ${bindingLabel(resolved.binding)}`);
		return;
	}

	const bindings = await listProfileBindings();
	if (options.json) {
		console.log(JSON.stringify(bindings, null, 2));
		return;
	}
	if (bindings.length === 0) {
		console.log(chalk.dim("No folder profile bindings."));
		return;
	}
	for (const binding of bindings) {
		console.log(`${chalk.green(binding.profile)}  ${bindingLabel(binding)}`);
	}
}
