import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { isRecord } from "@oh-my-pi/pi-utils";
import type { RegisteredTool, ToolRenderResultOptions } from "../../extensibility/extensions";
import { type SemanticRenderResult, validateSemanticContent } from "../../session/semantic-content";
import type { SessionJsonValue } from "../../session/session-host";
import { isRpcJsonValue } from "./rpc-command-registry";
import type { RpcSemanticRenderRegistration } from "./rpc-semantic-rendering";

export type RpcSemanticToolEvent =
	| {
			type: "tool_execution_start";
			toolCallId: string;
			toolName: string;
			args: Record<string, unknown>;
	  }
	| {
			type: "tool_execution_update";
			toolCallId: string;
			toolName: string;
			args: Record<string, unknown>;
			partialResult: AgentToolResult<unknown>;
	  }
	| {
			type: "tool_execution_end";
			toolCallId: string;
			toolName: string;
			result: AgentToolResult<unknown>;
			isError?: boolean;
	  };

type SemanticCallRenderer = (args: Record<string, unknown>, options: ToolRenderResultOptions) => SemanticRenderResult;
type SemanticResultRenderer = (
	result: AgentToolResult<unknown>,
	options: ToolRenderResultOptions,
	args?: Record<string, unknown>,
) => SemanticRenderResult;

function registeredTool(toolName: string, tools: readonly RegisteredTool[]): RegisteredTool | undefined {
	return tools.find(tool => tool.definition.name === toolName);
}

function customProjection(
	event: RpcSemanticToolEvent,
	tool: RegisteredTool | undefined,
): SemanticRenderResult | undefined {
	try {
		let rendered: SemanticRenderResult | undefined;
		if (event.type === "tool_execution_start" && tool?.definition.renderCallSemantic) {
			const renderer = tool.definition.renderCallSemantic as SemanticCallRenderer;
			rendered = renderer(event.args, { expanded: false, isPartial: false });
		} else if (event.type === "tool_execution_update" && tool?.definition.renderResultSemantic) {
			const renderer = tool.definition.renderResultSemantic as SemanticResultRenderer;
			rendered = renderer(event.partialResult, { expanded: false, isPartial: true }, event.args);
		} else if (event.type === "tool_execution_end" && tool?.definition.renderResultSemantic) {
			const renderer = tool.definition.renderResultSemantic as SemanticResultRenderer;
			rendered = renderer(event.result, { expanded: false, isPartial: false });
		}
		if (!rendered) return undefined;
		const validation = validateSemanticContent(rendered.content);
		return validation.ok ? { ...rendered, content: validation.content } : undefined;
	} catch {
		return undefined;
	}
}

function fallbackResult(event: RpcSemanticToolEvent): SessionJsonValue | undefined {
	if (event.type === "tool_execution_start") return undefined;
	const details = event.type === "tool_execution_update" ? event.partialResult.details : event.result.details;
	return isRpcJsonValue(details) ? (details as SessionJsonValue) : undefined;
}

function fallbackProjection(event: RpcSemanticToolEvent, tool: RegisteredTool | undefined): SemanticRenderResult {
	const label = tool?.definition.label || event.toolName;
	const state =
		event.type === "tool_execution_start" || event.type === "tool_execution_update"
			? "running"
			: event.isError
				? "failed"
				: "completed";
	const args = event.type === "tool_execution_end" ? undefined : event.args;
	const argumentsValue = isRecord(args) && isRpcJsonValue(args) ? (args as SessionJsonValue) : undefined;
	const result = fallbackResult(event);
	return {
		content: {
			version: 1,
			fallback: { format: "plain", text: `${label} ${state}` },
			blocks: [
				{
					kind: "tool",
					toolCallId: event.toolCallId,
					toolName: event.toolName,
					state,
					...(argumentsValue === undefined ? {} : { arguments: argumentsValue }),
					...(result === undefined ? {} : { result }),
				},
			],
		},
	};
}

/** Projects extension tool events without invoking or replacing existing terminal renderers. */
export function projectRpcToolSemantic(
	event: RpcSemanticToolEvent,
	tools: readonly RegisteredTool[],
): RpcSemanticRenderRegistration {
	const tool = registeredTool(event.toolName, tools);
	const rendered = customProjection(event, tool) ?? fallbackProjection(event, tool);
	return {
		source: { kind: "tool", toolCallId: event.toolCallId, toolName: event.toolName },
		...rendered,
	};
}
