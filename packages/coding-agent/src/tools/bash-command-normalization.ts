import { applyBashFixups } from "./bash-command-fixup";

export interface BashCommandParts {
	command: string;
	cwd?: string;
}

export interface BashPolicyCommandOptions {
	stripTrailingHeadTail?: boolean;
}

const LEADING_CD_PATTERN = /^cd[ \t]+((?:[^&\\\n\r]|\\.)+?)[ \t]*&&[ \t]*/;

export function normalizeLeadingCd({ command, cwd }: BashCommandParts): BashCommandParts {
	if (cwd) return { command, cwd };

	const cdMatch = command.match(LEADING_CD_PATTERN);
	if (!cdMatch) return { command, cwd };

	return {
		cwd: cdMatch[1].trim().replace(/^["']|["']$/g, ""),
		command: command.slice(cdMatch[0].length),
	};
}

export function getBashPolicyCommands(
	{ command, cwd }: BashCommandParts,
	options: BashPolicyCommandOptions = {},
): readonly string[] {
	const executableCommand = options.stripTrailingHeadTail === false ? command : applyBashFixups(command).command;
	const normalized = normalizeLeadingCd({ command: executableCommand, cwd });
	if (normalized.command === command) return [command];
	return [command, normalized.command];
}
