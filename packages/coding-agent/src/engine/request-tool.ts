import { type as arkType } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import { validateToolArguments } from "@oh-my-pi/pi-ai";
import requestDescription from "../prompts/tools/request.md" with { type: "text" };
import type { ToolSession } from "../tools";
import { validateRuntimeValue } from "./runtime-protocol";

const schema = arkType({ action: "'submit'", handling: "'blocking' | 'nonblocking'",
	operation: { toolName: "string", arguments: "object" } }).or({ action: "'read'", requestId: "string" })
	.or({ action: "'continue'", requestId: "string", expectedDecisionRevision: "number", expectedInputRevision: "number" });
export type EngineRequestInput = typeof schema.infer;
export interface EngineRequestDispatch {
	validate(name: string, args: object): Record<string, unknown>;
	execute(name: string, callId: string, args: Record<string, unknown>): Promise<AgentToolResult<unknown>>;
}
export interface EngineRequestController {
	invoke(callId: string, input: EngineRequestInput, dispatch: EngineRequestDispatch, signal?: AbortSignal): Promise<AgentToolResult<unknown>>;
}

export class EngineRequestPending extends Error {
	constructor(readonly requestId: string) { super("Protected operation is awaiting its request decision"); }
}

/** Only an Engine-installed controller can dispatch, through this session's existing allowed-tool registry. */
export class EngineRequestTool implements AgentTool<typeof schema, unknown> {
	readonly name = "request";
	readonly label = "Request";
	readonly description = requestDescription;
	readonly parameters = schema;
	readonly strict = true;
	constructor(readonly session: ToolSession) {}
	async execute(callId: string, input: EngineRequestInput, signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<unknown>, context?: AgentToolContext): Promise<AgentToolResult<unknown>> {
		validateRuntimeValue("requestToolInput", input);
		const controller = this.session.engineRequest;
		if (!this.session.engineMode || !controller) throw new Error("Request requires its managed Engine Attempt");
		const target = (name: string) => {
			if (name === "request" || !this.session.isToolActive?.(name)) throw new Error("Requested operation is not available to this Attempt");
			const tool = this.session.toolRegistry?.get(name);
			if (!tool) throw new Error("Requested operation is not registered in this session");
			return tool;
		};
		return controller.invoke(callId, input, {
			validate: (name, args) => validateToolArguments(target(name), { type: "toolCall", id: callId, name, arguments: args }) as Record<string, unknown>,
			execute: (name, originalCallId, args) => target(name).execute(originalCallId, args, signal, onUpdate, context),
		}, signal);
	}
}
