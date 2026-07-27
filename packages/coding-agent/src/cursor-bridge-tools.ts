/**
 * Per-call tools the Cursor exec bridge needs but the model-facing registry
 * cannot supply.
 *
 * Both bridge callsites — the primary session and the advisor roster — build
 * the same instances, and both must apply the session's approval wrapper. A
 * raw tool here silently escapes the gate every registry call goes through, so
 * the construction lives in one place rather than being repeated per callsite.
 */

import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import type { ExtensionRunner } from "./extensibility/extensions";
import { ExtensionToolWrapper } from "./extensibility/extensions";
import type { GrepToolOptions, Tool, ToolSession } from "./tools";
import { GrepTool } from "./tools";

/**
 * Build the bridge's `createGrepTool` factory for one tool session.
 *
 * A `pi_grep` frame carries its own context width and total match cap. Neither
 * is expressible in the model-facing `grep` schema — context comes from
 * `grep.contextBefore`/`grep.contextAfter`, fixed when the shared instance is
 * constructed — so honoring them needs a fresh tool per call.
 *
 * The result is wrapped exactly like a registry tool: the approval gate runs on
 * every call site, and a per-call instance is no exception.
 */
export function createBridgeGrepFactory(
	session: ToolSession,
	extensionRunner: ExtensionRunner,
): (options: GrepToolOptions) => AgentTool {
	return options => {
		const grepTool: Tool = new GrepTool(session, options);
		return new ExtensionToolWrapper(grepTool, extensionRunner);
	};
}
