import { executeBash } from "../exec/bash-executor";
import { MONITOR_INPUT_MAX_BYTES, type MonitorEventChannel } from "./events";

export const MONITOR_SOURCE_ABORT_TIMEOUT = "monitor-timeout";
export const MONITOR_SOURCE_ABORT_FLOOD = "monitor-flood";
export const MONITOR_SOURCE_ABORT_OVERSIZED_INPUT = "monitor-oversized-input";

export type MonitorSourceAbortReason =
	| typeof MONITOR_SOURCE_ABORT_TIMEOUT
	| typeof MONITOR_SOURCE_ABORT_FLOOD
	| typeof MONITOR_SOURCE_ABORT_OVERSIZED_INPUT;

export type MonitorSourceFailureReason = "timeout" | "abnormal-exit" | "oversized-input" | "flood" | "invalid-source";

export type MonitorSourceResult =
	| { status: "completed"; summary: string }
	| { status: "cancelled"; summary: string }
	| { status: "failed"; reason: MonitorSourceFailureReason; summary: string };

interface MonitorSourceBaseOptions {
	signal: AbortSignal;
	sourceController: AbortController;
	channel: MonitorEventChannel;
	timeoutMs: number;
}

export interface CommandMonitorOptions extends MonitorSourceBaseOptions {
	command: string;
	cwd: string;
	sessionKey: string;
}

export interface WebSocketMonitorOptions extends MonitorSourceBaseOptions {
	url: string;
	protocols?: string[];
}

const WEBSOCKET_PROTOCOL_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

function resultForAbort(signal: AbortSignal, sourceSignal: AbortSignal): MonitorSourceResult {
	if (signal.aborted) return { status: "cancelled", summary: "Monitor cancelled." };
	switch (sourceSignal.reason) {
		case MONITOR_SOURCE_ABORT_TIMEOUT:
			return { status: "failed", reason: "timeout", summary: "Monitor timed out." };
		case MONITOR_SOURCE_ABORT_FLOOD:
			return {
				status: "failed",
				reason: "flood",
				summary: "Monitor stopped after sustained event volume; narrow the source filter and try again.",
			};
		case MONITOR_SOURCE_ABORT_OVERSIZED_INPUT:
			return {
				status: "failed",
				reason: "oversized-input",
				summary: `Monitor input exceeded the ${MONITOR_INPUT_MAX_BYTES}-byte logical line/frame limit.`,
			};
		default:
			return { status: "cancelled", summary: "Monitor cancelled." };
	}
}

function armSourceTimeout(controller: AbortController, timeoutMs: number): NodeJS.Timeout | undefined {
	if (timeoutMs <= 0) return undefined;
	const timer = setTimeout(() => controller.abort(MONITOR_SOURCE_ABORT_TIMEOUT), timeoutMs);
	timer.unref?.();
	return timer;
}

export async function runCommandMonitor(options: CommandMonitorOptions): Promise<MonitorSourceResult> {
	const combinedSignal = AbortSignal.any([options.signal, options.sourceController.signal]);
	let outcome: MonitorSourceResult;
	try {
		const result = await executeBash(options.command, {
			cwd: options.cwd,
			sessionKey: options.sessionKey,
			timeout: options.timeoutMs,
			signal: combinedSignal,
			terminateBackgroundProcessesOnExit: true,
			onChunk: chunk => options.channel.pushChunk(chunk),
		});
		if (combinedSignal.aborted || result.terminationReason === "cancelled") {
			outcome = resultForAbort(options.signal, options.sourceController.signal);
		} else if (result.terminationReason === "timeout") {
			outcome = { status: "failed", reason: "timeout", summary: "Monitor timed out." };
		} else if (result.exitCode === 0) {
			outcome = { status: "completed", summary: "Command monitor exited normally (code 0)." };
		} else {
			outcome = {
				status: "failed",
				reason: "abnormal-exit",
				summary:
					result.exitCode === undefined
						? "Command monitor ended without an exit status."
						: `Command monitor exited with code ${result.exitCode}.`,
			};
		}
	} catch (error) {
		outcome = combinedSignal.aborted
			? resultForAbort(options.signal, options.sourceController.signal)
			: {
					status: "failed",
					reason: "abnormal-exit",
					summary: `Command monitor failed: ${error instanceof Error ? error.message : String(error)}`,
				};
	}
	await options.channel.close({
		flush: outcome.status === "completed" || (outcome.status === "failed" && outcome.reason === "abnormal-exit"),
	});
	return outcome;
}

function validateWebSocketOptions(urlText: string, protocols: string[] | undefined): URL | string {
	let url: URL;
	try {
		url = new URL(urlText);
	} catch {
		return "WebSocket monitor URL is invalid.";
	}
	if (url.protocol !== "ws:" && url.protocol !== "wss:") return "WebSocket monitor URL must use ws:// or wss://.";
	if (url.username || url.password) return "WebSocket monitor URL must not contain embedded credentials.";
	if (url.hash) return "WebSocket monitor URL must not contain a fragment.";
	if (protocols) {
		const seen = new Set<string>();
		for (const protocol of protocols) {
			if (!WEBSOCKET_PROTOCOL_TOKEN.test(protocol))
				return `Invalid WebSocket protocol token: ${protocol || "(empty)"}`;
			if (seen.has(protocol)) return `Duplicate WebSocket protocol token: ${protocol}`;
			seen.add(protocol);
		}
	}
	return url;
}

function binaryFrameSize(data: unknown): number | undefined {
	if (data instanceof ArrayBuffer) return data.byteLength;
	if (ArrayBuffer.isView(data)) return data.byteLength;
	if (data instanceof Blob) return data.size;
	return undefined;
}

export async function runWebSocketMonitor(options: WebSocketMonitorOptions): Promise<MonitorSourceResult> {
	const validated = validateWebSocketOptions(options.url, options.protocols);
	if (typeof validated === "string") {
		await options.channel.close({ flush: false });
		return { status: "failed", reason: "invalid-source", summary: validated };
	}

	const timeoutTimer = armSourceTimeout(options.sourceController, options.timeoutMs);
	const combinedSignal = AbortSignal.any([options.signal, options.sourceController.signal]);
	let socket: WebSocket;
	try {
		socket = new WebSocket(validated.href, options.protocols);
		socket.binaryType = "arraybuffer";
	} catch (error) {
		clearTimeout(timeoutTimer);
		await options.channel.close({ flush: false });
		return {
			status: "failed",
			reason: "invalid-source",
			summary: `WebSocket monitor could not start: ${error instanceof Error ? error.message : String(error)}`,
		};
	}

	const settled = Promise.withResolvers<MonitorSourceResult>();
	let finished = false;
	const finish = (result: MonitorSourceResult): void => {
		if (finished) return;
		finished = true;
		settled.resolve(result);
	};
	const terminateSocket = (): void => {
		if (socket.readyState === WebSocket.CLOSED) return;
		try {
			socket.terminate();
		} catch (error) {
			if (Number(socket.readyState) !== WebSocket.CLOSED) throw error;
		}
	};
	const onAbort = (): void => {
		finish(resultForAbort(options.signal, options.sourceController.signal));
		terminateSocket();
	};
	const onMessage = (event: MessageEvent<unknown>): void => {
		if (typeof event.data === "string") {
			if (Buffer.byteLength(event.data, "utf8") > MONITOR_INPUT_MAX_BYTES) {
				options.sourceController.abort(MONITOR_SOURCE_ABORT_OVERSIZED_INPUT);
				return;
			}
			options.channel.pushFrame(event.data);
			return;
		}
		const size = binaryFrameSize(event.data);
		if (size === undefined) {
			finish({
				status: "failed",
				reason: "abnormal-exit",
				summary: "WebSocket monitor received an unknown frame type.",
			});
			return;
		}
		if (size > MONITOR_INPUT_MAX_BYTES) {
			options.sourceController.abort(MONITOR_SOURCE_ABORT_OVERSIZED_INPUT);
			return;
		}
		options.channel.pushFrame(`[binary frame, ${size} bytes]`);
	};
	const onError = (): void => {
		finish({ status: "failed", reason: "abnormal-exit", summary: "WebSocket monitor connection failed." });
	};
	const onClose = (event: CloseEvent): void => {
		if (event.code === 1000) {
			finish({ status: "completed", summary: "WebSocket monitor closed normally (code 1000)." });
			return;
		}
		finish({
			status: "failed",
			reason: "abnormal-exit",
			summary: `WebSocket monitor closed abnormally (code ${event.code}).`,
		});
	};

	socket.addEventListener("message", onMessage);
	socket.addEventListener("error", onError);
	socket.addEventListener("close", onClose);
	combinedSignal.addEventListener("abort", onAbort, { once: true });
	if (combinedSignal.aborted) onAbort();

	const outcome = await settled.promise;
	clearTimeout(timeoutTimer);
	combinedSignal.removeEventListener("abort", onAbort);
	socket.removeEventListener("message", onMessage);
	socket.removeEventListener("error", onError);
	socket.removeEventListener("close", onClose);
	terminateSocket();
	await options.channel.close({
		flush: outcome.status === "completed" || (outcome.status === "failed" && outcome.reason === "abnormal-exit"),
	});
	return outcome;
}
