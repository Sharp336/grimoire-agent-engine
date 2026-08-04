import type { AgentTool, ToolLoadMode } from "@oh-my-pi/pi-agent-core";
import { defaultLoadModeForToolName } from "../tools/essential-tools";
import { wrapToolWithMetaNotice } from "../tools/output-meta";
import { customToolToDefinition, isCustomTool } from "./custom-tools/definition";
import type { CustomTool, CustomToolContext } from "./custom-tools/types";
import type { ExtensionRunner } from "./extensions/runner";
import type { ToolDefinition } from "./extensions/types";
import { ExtensionToolWrapper, RegisteredToolAdapter } from "./extensions/wrapper";

/**
 * The single tool-finishing path: output metadata, then the extension approval /
 * event gate. The `new ExtensionToolWrapper` below is the ONLY construction site
 * in the codebase (enforced by an ast-grep gate). A runner-less composition — some
 * MCP refresh paths supply no runner — has nothing to gate against, so it stops at
 * the meta-notice.
 */
function finishComposition(tool: AgentTool, runner: ExtensionRunner | undefined): AgentTool {
	const metaNoticed = wrapToolWithMetaNotice(tool);
	return runner ? new ExtensionToolWrapper(metaNoticed, runner) : metaNoticed;
}

/**
 * Compose an already-built native {@link AgentTool}: no conversion, just the shared
 * finishing path (output metadata + approval/event gate).
 */
export function composeAgentTool(tool: AgentTool, runner: ExtensionRunner): AgentTool {
	return finishComposition(tool, runner);
}

/**
 * Compose a {@link CustomTool} or {@link ToolDefinition} into an {@link AgentTool}:
 * resolve load mode, convert once through {@link customToolToDefinition}, adapt via
 * {@link RegisteredToolAdapter}, then share the finishing path. `runner` may be
 * undefined for runner-less composition (the adapter carries the baked `getContext`
 * thunk for its execute context in that case).
 */
export function composeCustomTool(
	source: CustomTool | ToolDefinition,
	runner: ExtensionRunner | undefined,
	opts?: { loadMode?: ToolLoadMode; getContext?: () => CustomToolContext },
): AgentTool {
	const definition = isCustomTool(source) ? customToolToDefinition(source, opts?.getContext) : source;
	const loadMode = defaultLoadModeForToolName(definition.name, opts?.loadMode ?? definition.loadMode);
	const adapter = new RegisteredToolAdapter(
		{
			definition: definition.loadMode === loadMode ? definition : { ...definition, loadMode },
			extensionPath: "<composed>",
		},
		runner,
	);
	return finishComposition(adapter, runner);
}
