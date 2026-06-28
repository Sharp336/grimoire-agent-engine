import { SKILL_PROMPT_MESSAGE_TYPE, type SkillPromptDetails } from "../session/messages";
import type { InteractiveModeContext } from "./types";

type SkillCommandHost = Pick<InteractiveModeContext, "skillCommands" | "session" | "showError">;

interface InvokeSkillCommandOptions {
	propagateErrors?: boolean;
}

type SkillPromptMessage = {
	customType: typeof SKILL_PROMPT_MESSAGE_TYPE;
	content: string;
	display: true;
	details: SkillPromptDetails;
	attribution: "user";
};

type SkillPromptOptions = {
	streamingBehavior: "steer" | "followUp";
	queueChipText: string;
};

export interface BuiltSkillCommandPrompt {
	message: SkillPromptMessage;
	options: SkillPromptOptions;
}

/** True iff `text` is `/skill:<name>` and `<name>` resolves in `ctx.skillCommands`. */
export function isKnownSkillCommand(ctx: SkillCommandHost, text: string): boolean {
	if (!text.startsWith("/skill:")) return false;
	const spaceIndex = text.indexOf(" ");
	const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
	return ctx.skillCommands?.has(commandName) ?? false;
}

/**
 * Parse `/skill:<name> [args]` and build the user-attributed skill-prompt
 * custom message. Returns null when `text` is not a registered `/skill:`
 * command, so callers can fall through to plain-text handling.
 */
export async function buildSkillCommandPrompt(
	ctx: SkillCommandHost,
	text: string,
	streamingBehavior: "steer" | "followUp",
): Promise<BuiltSkillCommandPrompt | null> {
	if (!text.startsWith("/skill:")) return null;
	const spaceIndex = text.indexOf(" ");
	const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
	const args = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1).trim();
	const skillPath = ctx.skillCommands?.get(commandName);
	if (!skillPath) return null;
	const content = await Bun.file(skillPath).text();
	const body = content.replace(/^---\n[\s\S]*?\n---\n/, "").trim();
	const metaLines = [`Skill: ${skillPath}`];
	if (args) {
		metaLines.push(`User: ${args}`);
	}
	const message = `${body}\n\n---\n\n${metaLines.join("\n")}`;
	const skillName = commandName.slice("skill:".length);
	const details: SkillPromptDetails = {
		name: skillName || commandName,
		path: skillPath,
		args: args || undefined,
		lineCount: body ? body.split("\n").length : 0,
	};
	return {
		message: {
			customType: SKILL_PROMPT_MESSAGE_TYPE,
			content: message,
			display: true,
			details,
			attribution: "user",
		},
		options: { streamingBehavior, queueChipText: text },
	};
}

/**
 * Parse `/skill:<name> [args]` and invoke it as a user-attributed skill-prompt
 * custom message. Returns false when `text` is not a known `/skill:` command,
 * so callers can fall through to plain-text handling.
 */
export async function invokeSkillCommandFromText(
	ctx: SkillCommandHost,
	text: string,
	streamingBehavior: "steer" | "followUp",
	options?: InvokeSkillCommandOptions,
): Promise<boolean> {
	if (!isKnownSkillCommand(ctx, text)) return false;
	try {
		const built = await buildSkillCommandPrompt(ctx, text, streamingBehavior);
		if (!built) return false;
		await ctx.session.promptCustomMessage(built.message, built.options);
	} catch (err) {
		if (options?.propagateErrors) {
			throw err;
		}
		ctx.showError(`Failed to load skill: ${err instanceof Error ? err.message : String(err)}`);
	}
	return true;
}
