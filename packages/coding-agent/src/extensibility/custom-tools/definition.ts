/**
 * Custom-tool → extension `ToolDefinition` conversion.
 *
 * Leaf module: the single place a SDK- or MCP-supplied {@link CustomTool} becomes
 * an extension {@link ToolDefinition}. It imports neither `sdk.ts` nor
 * `compose-tool.ts`, so both the SDK and the composition pipeline depend on it
 * without forming a cycle.
 */
import type { Component } from "@oh-my-pi/pi-tui";
import { defaultLoadModeForToolName } from "../../tools/essential-tools";
import type { ExtensionContext, ToolDefinition, ToolExecuteExtensionContext } from "../extensions/types";
import type { CustomTool, CustomToolContext } from "./types";

const EMPTY_ROWS: readonly string[] = [];
/**
 * Non-undefined `renderResult` fallback. A defined render method that returns an
 * empty component keeps the tool on the custom-renderer path with rendered (blank)
 * output, instead of the `undefined`-return case that silently discards result text.
 */
const EMPTY_COMPONENT: Component = { render: () => EMPTY_ROWS };

/** Narrow an {@link ExtensionContext} to the subset a custom tool's callbacks see. */
export function createCustomToolContext(ctx: ExtensionContext): CustomToolContext {
	return {
		sessionManager: ctx.sessionManager,
		modelRegistry: ctx.modelRegistry,
		model: ctx.model,
		isIdle: ctx.isIdle,
		hasQueuedMessages: ctx.hasPendingMessages,
		abort: ctx.abort,
		localProtocolOptions: ctx.localProtocolOptions,
	};
}

/**
 * Resolve the {@link CustomToolContext} for a callback, in precedence order:
 * 1. the original caller's `AgentToolContext` carried on the execute context, so
 *    a tool that re-registers a built-in keeps the caller's already-granted state;
 * 2. an explicit context thunk (runner-less MCP refresh supplies one);
 * 3. a narrow projection of the extension context.
 */
function resolveCustomToolContext(
	ctx: ExtensionContext,
	getContext: (() => CustomToolContext) | undefined,
): CustomToolContext {
	return (ctx as ToolExecuteExtensionContext).callerToolContext ?? getContext?.() ?? createCustomToolContext(ctx);
}

export function customToolToDefinition(tool: CustomTool, getContext?: () => CustomToolContext): ToolDefinition {
	const mergeCallAndResult =
		"mergeCallAndResult" in tool && typeof tool.mergeCallAndResult === "boolean"
			? tool.mergeCallAndResult
			: undefined;
	const definition: ToolDefinition & { mergeCallAndResult?: boolean } = {
		name: tool.name,
		label: tool.label,
		description: tool.description,
		parameters: tool.parameters,
		hidden: tool.hidden,
		loadMode: defaultLoadModeForToolName(tool.name, tool.loadMode),
		deferrable: tool.deferrable,
		approval: typeof tool.approval === "function" ? tool.approval.bind(tool) : tool.approval,
		formatApprovalDetails:
			typeof tool.formatApprovalDetails === "function"
				? tool.formatApprovalDetails.bind(tool)
				: tool.formatApprovalDetails,
		// Preserved through RegisteredToolAdapter so MCP-backed tools' explicit
		// `strict: false` (#4336/#4340) survives the custom-tool → definition bridge.
		strict: tool.strict,
		mcpServerName: tool.mcpServerName,
		mcpToolName: tool.mcpToolName,
		mergeCallAndResult,
		execute: (toolCallId, params, signal, onUpdate, ctx) =>
			tool.execute(toolCallId, params, onUpdate, resolveCustomToolContext(ctx, getContext), signal),
		onSession: tool.onSession
			? (event, ctx) => tool.onSession?.(event, resolveCustomToolContext(ctx, getContext))
			: undefined,
		renderCall: typeof tool.renderCall === "function" ? tool.renderCall.bind(tool) : tool.renderCall,
		renderResult: tool.renderResult
			? (result, options, theme, args): Component => {
					const component = tool.renderResult?.(
						result,
						{ expanded: options.expanded, isPartial: options.isPartial, spinnerFrame: options.spinnerFrame },
						theme,
						args,
					);
					return component ?? EMPTY_COMPONENT;
				}
			: undefined,
	};
	return definition;
}
