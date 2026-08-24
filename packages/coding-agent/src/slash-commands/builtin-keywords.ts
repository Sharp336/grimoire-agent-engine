import type { SlashCommandSpec } from "./types";

function keywordPrompt(keyword: string, args: string): string {
	return [keyword, args].filter(Boolean).join(" ");
}

export const BUILTIN_KEYWORD_SLASH_COMMANDS: ReadonlyArray<SlashCommandSpec> = [
	{
		name: "ultrathink",
		description: "Deep reasoning (mirrors magic keyword ultrathink)",
		icon: "loop",
		inlineHint: "[prompt]",
		allowArgs: true,
		handle: command => ({ prompt: keywordPrompt("ultrathink", command.args) }),
		handleTui: (command, runtime) => {
			runtime.ctx.editor.setText("");
			return { prompt: keywordPrompt("ultrathink", command.args) };
		},
	},
	{
		name: "orchestrate",
		description: "Fan out via task subagents (mirrors magic keyword orchestrate)",
		icon: "action",
		inlineHint: "[prompt]",
		allowArgs: true,
		handle: command => ({ prompt: keywordPrompt("orchestrate", command.args) }),
		handleTui: (command, runtime) => {
			runtime.ctx.editor.setText("");
			return { prompt: keywordPrompt("orchestrate", command.args) };
		},
	},
	{
		name: "workflowz",
		description: "Deterministic eval multi-agent workflow (mirrors magic keyword workflowz)",
		icon: "plan",
		inlineHint: "[prompt]",
		allowArgs: true,
		handle: command => ({ prompt: keywordPrompt("workflowz", command.args) }),
		handleTui: (command, runtime) => {
			runtime.ctx.editor.setText("");
			return { prompt: keywordPrompt("workflowz", command.args) };
		},
	},
	{
		name: "parallel",
		aliases: ["parallelize"],
		description: "Delegate via task subagents (mirrors system-prompt parallel/parallelize rule)",
		icon: "agents",
		inlineHint: "[prompt]",
		allowArgs: true,
		handle: command => ({ prompt: keywordPrompt(command.name, command.args) }),
		handleTui: (command, runtime) => {
			runtime.ctx.editor.setText("");
			return { prompt: keywordPrompt(command.name, command.args) };
		},
	},
];
