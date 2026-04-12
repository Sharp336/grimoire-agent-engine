/**
 * Flow hook executor.
 *
 * Hooks are hardcoded tool invocations the runtime performs automatically
 * at frame lifecycle boundaries. They do NOT go through the model — they
 * are side effects injected by the flow author to offload repetitive work
 * (load rule files, run a build, etc.).
 *
 * Given a list of `HookCall` and a minimal context (the tool table), the
 * executor iterates the hooks in order, looks up each tool by name, and
 * calls its `execute(toolCallId, args)`. Results are appended to an output
 * channel (the caller decides where — typically the current frame's
 * pocketMessages).
 *
 * On error, the executor invokes the node's `onError` hook list (if any)
 * and rethrows so the interpreter can surface the failure.
 */

import type { AgentMessage, AgentTool } from "@oh-my-pi/pi-agent-core";
import type { HookCall } from "./flow-types";

export interface HookExecutorContext {
	tools: readonly AgentTool<any>[];
	/** Called once per hook result. The sink chooses how to persist. */
	appendMessage: (message: AgentMessage) => void;
}

function nextHookCallId(): string {
	return `hook_${crypto.randomUUID().slice(0, 8)}`;
}

function hookResultToMessage(toolName: string, result: unknown): AgentMessage {
	const text = typeof result === "string" ? result : JSON.stringify(result ?? null);
	return {
		role: "developer",
		content: [{ type: "text", text: `[hook ${toolName}] ${text}` }],
		timestamp: Date.now(),
	} as AgentMessage;
}

export async function runHooks(
	hooks: readonly HookCall[] | undefined,
	ctx: HookExecutorContext,
	onError?: readonly HookCall[],
): Promise<void> {
	if (!hooks || hooks.length === 0) return;
	for (const hook of hooks) {
		const tool = ctx.tools.find(t => t.name === hook.tool);
		if (!tool) {
			const msg = hookResultToMessage(hook.tool, `(skipped: tool not found)`);
			ctx.appendMessage(msg);
			continue;
		}
		try {
			const id = nextHookCallId();
			const result = await tool.execute(id, (hook.args ?? {}) as any);
			let rendered = "";
			if (result && typeof result === "object" && "content" in result && Array.isArray((result as any).content)) {
				for (const block of (result as any).content as Array<Record<string, unknown>>) {
					if (block && block.type === "text" && typeof block.text === "string") rendered += block.text;
				}
			}
			ctx.appendMessage(hookResultToMessage(hook.tool, rendered));
		} catch (e) {
			ctx.appendMessage(hookResultToMessage(hook.tool, `(error: ${e instanceof Error ? e.message : String(e)})`));
			if (onError && onError.length > 0) {
				// Run the onError list but don't recurse its own errors.
				await runHooks(onError, ctx);
			}
			throw e;
		}
	}
}
