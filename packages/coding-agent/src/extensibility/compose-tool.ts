import type { AgentTool, ToolLoadMode } from "@oh-my-pi/pi-agent-core";
import { defaultLoadModeForToolName } from "../tools/essential-tools";
import { wrapToolWithMetaNotice } from "../tools/output-meta";
import { customToolToDefinition } from "./custom-tools/definition";
import type { CustomTool, CustomToolContext } from "./custom-tools/types";
import type { ExtensionRunner } from "./extensions/runner";
import type { ToolDefinition } from "./extensions/types";
import { ExtensionToolWrapper, RegisteredToolAdapter } from "./extensions/wrapper";

/** Options shared by both composition entry points. */
interface ComposeOptions {
	/** Override the resolved load mode. */
	loadMode?: ToolLoadMode;
	/** When false, suppress the artifact:// spill meta-notice (Cursor bridge tools). */
	metaNotice?: boolean;
}

/**
 * The single tool-finishing path: output metadata (unless suppressed), then the
 * extension approval / event gate. The `new ExtensionToolWrapper` below is the
 * ONLY construction site in the codebase. A runner-less composition — some MCP
 * refresh paths supply no runner — has nothing to gate against, so it stops at
 * the meta-notice.
 */
function finishComposition(tool: AgentTool, runner: ExtensionRunner | undefined, metaNotice: boolean): AgentTool {
	const metaNoticed = metaNotice ? wrapToolWithMetaNotice(tool) : tool;
	return runner ? new ExtensionToolWrapper(metaNoticed, runner) : metaNoticed;
}

/**
 * Compose an already-built native {@link AgentTool}: no conversion, just the shared
 * finishing path (output metadata + approval/event gate). `metaNotice` defaults to
 * `true`; pass `{ metaNotice: false }` for consumers that cannot resolve
 * `artifact://` references (e.g. the Cursor exec bridge).
 */
export function composeAgentTool(tool: AgentTool, runner: ExtensionRunner, opts?: { metaNotice?: boolean }): AgentTool {
	return finishComposition(tool, runner, opts?.metaNotice ?? true);
}

/** Resolve load mode, adapt, and finish — the shared tail of both entry points. */
function composeDefinition(
	definition: ToolDefinition,
	runner: ExtensionRunner | undefined,
	opts: ComposeOptions | undefined,
): AgentTool {
	const loadMode = defaultLoadModeForToolName(definition.name, opts?.loadMode ?? definition.loadMode);
	const adapter = new RegisteredToolAdapter(
		{
			definition: definition.loadMode === loadMode ? definition : { ...definition, loadMode },
			extensionPath: "<composed>",
		},
		runner,
	);
	return finishComposition(adapter, runner, opts?.metaNotice ?? true);
}

/**
 * Compose a {@link CustomTool} into an {@link AgentTool}: convert once through
 * {@link customToolToDefinition}, then share the composition tail. `runner` may be
 * undefined for runner-less composition (the adapter carries the baked `getContext`
 * thunk for its execute context in that case). When `runner` is undefined AND no
 * `getContext` thunk is supplied, throws at composition time — a CustomTool's
 * callbacks need a context, and a silent empty-context crash at call time is worse.
 */
export function composeCustomTool(
	tool: CustomTool,
	runner: ExtensionRunner | undefined,
	opts?: ComposeOptions & { getContext?: () => CustomToolContext },
): AgentTool {
	if (!runner && !opts?.getContext) {
		throw new Error(
			`composeCustomTool("${tool.name}"): a runner or getContext thunk is required — ` +
				"a CustomTool's callbacks need a CustomToolContext",
		);
	}
	return composeDefinition(customToolToDefinition(tool, opts?.getContext), runner, opts);
}

/**
 * Compose a plain {@link ToolDefinition} into an {@link AgentTool}: no conversion,
 * since the definition already carries the ToolDefinition execute arg order
 * (`toolCallId, params, signal, onUpdate, ctx`).
 */
export function composeToolDefinition(
	definition: ToolDefinition,
	runner: ExtensionRunner | undefined,
	opts?: ComposeOptions,
): AgentTool {
	return composeDefinition(definition, runner, opts);
}
