import { handleWorktreeAcp } from "./helpers/worktree";
import type { SlashCommandSpec } from "./types";

export const BUILTIN_WORKTREE_SLASH_COMMANDS: ReadonlyArray<SlashCommandSpec> = [
	{
		name: "worktree",
		description: "List, create, and remove agent-managed git worktrees",
		acpDescription: "Manage agent-managed git worktrees",
		inlineHint: "[<subcommand>]",
		subcommands: [
			{ name: "list", description: "List worktrees for the current repo", usage: "[--all]" },
			{ name: "create", description: "Create a worktree from a branch or base", usage: "<branch> [base]" },
			{ name: "remove", description: "Remove a worktree", usage: "<path|branch> [--force]" },
		],
		allowArgs: true,
		handle: handleWorktreeAcp,
	},
];
