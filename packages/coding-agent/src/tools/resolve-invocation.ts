import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { ToolError } from "./tool-errors";

/** The resolve tool's stable result payload, shared by queued and standing handlers. */
export interface ResolveToolDetails {
	action: "apply" | "discard";
	reason: string;
	extra?: Record<string, unknown>;
	sourceToolName?: string;
	label?: string;
	sourceResultDetails?: unknown;
}

/** Runtime-safe structural form of the resolve tool input. */
export interface ResolveInvocationParams {
	action: "apply" | "discard";
	reason: string;
	extra?: Record<string, unknown>;
}

export interface ResolveInvocationOptions {
	sourceToolName: string;
	label: string;
	apply(reason: string, extra?: Record<string, unknown>): Promise<AgentToolResult<unknown>>;
	reject?(reason: string, extra?: Record<string, unknown>): Promise<AgentToolResult<unknown> | undefined>;
	/** Invoked synchronously when `apply()` throws, before the error is rethrown. */
	onApplyError?(error: unknown): void;
}

/**
 * Shared invocation runner used by queued and standing resolve handlers. This
 * module deliberately has no rendering or TUI dependency so headless mode
 * controllers can use the real resolve protocol without loading the renderer.
 */
export async function runResolveInvocation(
	params: ResolveInvocationParams,
	options: ResolveInvocationOptions,
): Promise<AgentToolResult<ResolveToolDetails>> {
	const baseDetails: ResolveToolDetails = {
		action: params.action,
		reason: params.reason,
		sourceToolName: options.sourceToolName,
		label: options.label,
		...(params.extra != null ? { extra: params.extra } : {}),
	};
	if (params.action === "apply") {
		let result: AgentToolResult<unknown>;
		try {
			result = await options.apply(params.reason, params.extra);
		} catch (error) {
			try {
				options.onApplyError?.(error);
			} catch {
				// Requeue hooks must not mask the original apply failure.
			}
			if (error instanceof ToolError) throw error;
			const message = error instanceof Error ? error.message : String(error);
			throw new ToolError(`Apply failed: ${message}`);
		}
		return {
			...result,
			details: {
				...baseDetails,
				...(result.details != null ? { sourceResultDetails: result.details } : {}),
			},
		};
	}
	if (params.action === "discard" && options.reject != null) {
		const result = await options.reject(params.reason, params.extra);
		if (result != null) {
			return {
				...result,
				details: {
					...baseDetails,
					...(result.details != null ? { sourceResultDetails: result.details } : {}),
				},
			};
		}
	}
	return {
		content: [{ type: "text" as const, text: `Discarded: ${options.label}. Reason: ${params.reason}` }],
		details: baseDetails,
	};
}
