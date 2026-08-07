import * as os from "node:os";
import type { InteractiveModeContext } from "../modes/types";

export interface CollabDisplayNameContext {
	settings: Pick<InteractiveModeContext["settings"], "get">;
}

/** Display name for this process's user in collab sessions. */
export function collabDisplayName(ctx: CollabDisplayNameContext): string {
	const configured = (ctx.settings.get("collab.displayName") ?? "").trim();
	if (configured) return configured;
	try {
		return os.userInfo().username;
	} catch {
		return "anonymous";
	}
}
