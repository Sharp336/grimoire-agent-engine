import { runQuickCommit } from "../../../../commit/quick";
import { Settings } from "../../../../config/settings";
import type { HookCommandContext } from "../../../hooks/types";
import type { CustomCommand } from "../../types";

export class SessionCommitCommand implements CustomCommand {
	name = "commit";
	description = "Create fast, structured commits from staged changes";

	async execute(_args: string[], ctx: HookCommandContext): Promise<string | undefined> {
		try {
			// A custom command can be invoked while the agent is still streaming
			// (e.g. queued input); staging/planning against files an in-flight
			// edit/write tool call is still mutating would commit a half-written
			// change. Wait for the turn to go idle before touching Git.
			await ctx.waitForIdle();
			// `ctx.cwd` reflects the currently active session and stays correct
			// across `/resume`/`switchSession()`, unlike a cwd captured once when
			// custom commands are loaded.
			await runQuickCommit(ctx.cwd, ctx, Settings.instance);
		} catch (error) {
			ctx.ui.setStatus("commit", undefined);
			ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
		}
		return undefined;
	}
}
