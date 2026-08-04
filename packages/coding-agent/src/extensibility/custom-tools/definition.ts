/**
 * Custom-tool → extension `ToolDefinition` conversion.
 *
 * Leaf module: the single place a SDK- or MCP-supplied {@link CustomTool} becomes
 * an extension {@link ToolDefinition}. It imports neither `sdk.ts` nor
 * `compose-tool.ts`, so both the SDK and the composition pipeline depend on it
 * without forming a cycle.
 */

import type { TSchema } from "@oh-my-pi/pi-ai";
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

export function customToolToDefinition<TParams extends TSchema, TDetails>(
	tool: CustomTool<TParams, TDetails>,
	getContext?: () => CustomToolContext,
): ToolDefinition<TParams, TDetails> {
	// Fields a class-based CustomTool can expose through getters (settings- or
	// state-dependent) are forwarded lazily so they stay live after composition —
	// matching the liveness the removed CustomToolAdapter provided via
	// applyToolProxy. That covers the metadata (name, label, description,
	// parameters, hidden, deferrable, strict, mcpServerName, mcpToolName,
	// mergeCallAndResult) AND the approval pair: the gate re-reads
	// `approval`/`formatApprovalDetails` on every call, so a getter that
	// tightens from `allow` to `prompt`/`deny` must take effect instead of
	// running against a value frozen at conversion time. Function values are
	// bound to the tool on each access so class methods keep their receiver.
	//
	// loadMode is deliberately eager: it is a RESOLVED value —
	// defaultLoadModeForToolName normalizes it at composition time — not a
	// passthrough of the tool's own field. execute/onSession/renderResult are
	// closures that read `tool`'s live methods on each invocation; renderCall
	// is bound once at conversion (display-only, no gate depends on it).
	const definition: ToolDefinition<TParams, TDetails> & { mergeCallAndResult?: boolean } = {
		get name() {
			return tool.name;
		},
		get label() {
			return tool.label;
		},
		get description() {
			return tool.description;
		},
		get parameters() {
			return tool.parameters;
		},
		get hidden() {
			return tool.hidden;
		},
		loadMode: defaultLoadModeForToolName(tool.name, tool.loadMode),
		get deferrable() {
			return tool.deferrable;
		},
		get approval() {
			const approval = tool.approval;
			return typeof approval === "function" ? approval.bind(tool) : approval;
		},
		get formatApprovalDetails() {
			const formatApprovalDetails = tool.formatApprovalDetails;
			return typeof formatApprovalDetails === "function" ? formatApprovalDetails.bind(tool) : formatApprovalDetails;
		},
		// Preserved through RegisteredToolAdapter so MCP-backed tools' explicit
		// `strict: false` (#4336/#4340) survives the custom-tool → definition bridge.
		get strict() {
			return tool.strict;
		},
		get mcpServerName() {
			return tool.mcpServerName;
		},
		get mcpToolName() {
			return tool.mcpToolName;
		},
		get mergeCallAndResult() {
			return "mergeCallAndResult" in tool && typeof tool.mergeCallAndResult === "boolean"
				? tool.mergeCallAndResult
				: undefined;
		},
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
