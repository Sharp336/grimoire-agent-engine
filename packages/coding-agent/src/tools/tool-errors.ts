import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";

/**
 * Standardized error types for tool execution.
 *
 * Tools should throw these instead of returning error text.
 * The agent loop catches and renders them appropriately.
 */

export interface ToolTimeoutMeta {
	durationSeconds: number;
	durationMs: number;
	toolName?: string;
}

export interface ToolErrorDetails {
	error: string;
	errorType?: "tool" | "abort" | "timeout";
	timeout?: ToolTimeoutMeta;
	[key: string]: unknown;
}

/**
 * Base error for tool execution failures.
 * Override render() for custom LLM-facing formatting.
 */
export class ToolError extends Error {
	constructor(
		message: string,
		readonly context?: Record<string, unknown>,
		readonly details?: Record<string, unknown>,
	) {
		super(message);
		this.name = "ToolError";
	}

	/** Render error for LLM consumption. Override for custom formatting. */
	render(): string {
		return this.message;
	}
}

/**
 * Error thrown when a tool operation exceeds its timeout.
 */
export class ToolTimeoutError extends ToolError {
	constructor(message: string, timeout: Omit<ToolTimeoutMeta, "durationMs"> & { durationMs?: number }) {
		super(message, undefined, {
			errorType: "timeout",
			timeout: {
				...timeout,
				durationMs: timeout.durationMs ?? timeout.durationSeconds * 1000,
			},
		});
		this.name = "ToolTimeoutError";
	}
}

/**
 * Error thrown when a tool operation is aborted (e.g., via AbortSignal).
 */
export class ToolAbortError extends Error {
	static readonly MESSAGE = "Operation aborted";

	constructor(message: string = ToolAbortError.MESSAGE) {
		super(message);
		this.name = "ToolAbortError";
	}
}

/**
 * Throw ToolAbortError if the signal is aborted.
 * Use this instead of signal?.throwIfAborted() to get consistent error types.
 */
export function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) {
		const reason = signal.reason instanceof Error ? signal.reason : undefined;
		throw reason instanceof ToolAbortError ? reason : new ToolAbortError();
	}
}

/**
 * Render an error for LLM consumption.
 * Handles ToolError.render() and falls back to message/string.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function getNamedToolErrorType(errorName: string | undefined): ToolErrorDetails["errorType"] | undefined {
	if (errorName === "ToolAbortError") return "abort";
	if (errorName === "ToolTimeoutError") return "timeout";
	if (errorName === "ToolError") return "tool";
	return undefined;
}

export function renderError(e: unknown): string {
	if (e instanceof ToolError) {
		return e.render();
	}
	if (isRecord(e) && typeof e.render === "function") {
		const rendered = e.render();
		return typeof rendered === "string" ? rendered : String(rendered);
	}
	if (e instanceof Error) {
		return e.message;
	}
	return String(e);
}

function buildToolErrorDetails(error: unknown, message: string): ToolErrorDetails {
	const errorDetails = isRecord(error) && isRecord(error.details) ? error.details : undefined;
	const errorName = isRecord(error) && typeof error.name === "string" ? error.name : undefined;
	const namedErrorType = getNamedToolErrorType(errorName);
	if (error instanceof ToolError) {
		const details: ToolErrorDetails = { ...(error.details ?? {}), error: message };
		details.errorType ??= "tool";
		return details;
	}
	if (error instanceof ToolAbortError) {
		return {
			...(errorDetails ?? {}),
			error: message,
			errorType: "abort",
		};
	}
	if (errorDetails || namedErrorType) {
		const details: ToolErrorDetails = { ...(errorDetails ?? {}), error: message };
		if (namedErrorType) details.errorType ??= namedErrorType;
		return details;
	}
	return { error: message };
}

export function toolErrorToResult(error: unknown): AgentToolResult<ToolErrorDetails> {
	const message = renderError(error);
	return {
		content: [{ type: "text", text: message }],
		details: buildToolErrorDetails(error, message),
	};
}
