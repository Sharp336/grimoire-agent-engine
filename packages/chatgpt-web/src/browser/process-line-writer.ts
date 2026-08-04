import type { Writable } from "node:stream";
import type { ChatGptWebErrorClass } from "../provider/types";
import { isChatGptWebErrorClass } from "../runtime/logging";

export const PROCESS_LINE_MAX_UTF8_BYTES = 4_096;
export const PROCESS_LINE_MAX_LINES = 4;
export const PROCESS_STDERR_MAX_BYTES = 4_096;

export type ProcessLineStatus =
	| { readonly type: "startup" }
	| { readonly type: "ready" }
	| { readonly type: "error"; readonly errorClass: ChatGptWebErrorClass }
	| { readonly type: "eof"; readonly normal: true; readonly exitCode: 0 }
	| {
			readonly type: "eof";
			readonly normal: false;
			readonly errorClass: ChatGptWebErrorClass;
			readonly exitCode?: number;
	  };

export type ProcessLineFailureReason =
	| "invalid_status"
	| "invalid_sequence"
	| "invalid_chunk"
	| "line_too_large"
	| "line_limit"
	| "malformed_utf8"
	| "malformed_json"
	| "stream_unavailable"
	| "abnormal_eof"
	| "exit_mismatch";

export interface ProcessLineFailure {
	readonly errorClass: "malformed_browser_output";
	readonly reason: ProcessLineFailureReason;
}

export interface ProcessLineWriter {
	write(status: ProcessLineStatus): boolean;
	close(): void;
}

export interface ProcessLineParser {
	push(chunk: Uint8Array): boolean;
	end(exitCode?: number | null): void;
}

export interface ProcessLineParserOptions {
	onStatus(status: ProcessLineStatus): void;
	onFailure?(failure: ProcessLineFailure): void;
}

export interface ProcessStderrSummary {
	readonly byteCount: number;
	readonly truncated: boolean;
}

export interface BoundedProcessStderrCapture {
	append(chunk: Uint8Array): boolean;
	finish(): ProcessStderrSummary;
}

type ProcessPhase = "initial" | "startup" | "ready" | "error" | "eof" | "failed";
type ProtocolRecord = Record<string, unknown>;

const MAX_EXIT_CODE = 0xffff_ffff;
const PROTOCOL_FIELDS: Record<string, true> = {
	type: true,
	errorClass: true,
	normal: true,
	exitCode: true,
};
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });

function isExitCode(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= MAX_EXIT_CODE;
}

function readDataProperty(record: ProtocolRecord, key: string): { present: false } | { present: true; value: unknown } {
	let descriptor: PropertyDescriptor | undefined;
	try {
		descriptor = Object.getOwnPropertyDescriptor(record, key);
	} catch {
		return { present: false };
	}
	if (!descriptor?.enumerable || !("value" in descriptor)) return { present: false };
	return { present: true, value: descriptor.value };
}

function isProtocolRecord(input: unknown): input is ProtocolRecord {
	if (typeof input !== "object" || input === null || Array.isArray(input)) return false;
	try {
		const prototype = Object.getPrototypeOf(input);
		return prototype === Object.prototype || prototype === null;
	} catch {
		return false;
	}
}

function normalizeProcessLineStatus(input: unknown): ProcessLineStatus | null {
	if (!isProtocolRecord(input)) return null;

	const record = input;
	let keys: (string | symbol)[];
	try {
		keys = Reflect.ownKeys(record);
	} catch {
		return null;
	}
	if (keys.length === 0 || keys.length > 4) return null;
	for (const key of keys) {
		if (typeof key !== "string" || !Object.hasOwn(PROTOCOL_FIELDS, key)) return null;
	}

	const typeProperty = readDataProperty(record, "type");
	if (!typeProperty.present || typeof typeProperty.value !== "string") return null;
	if (typeProperty.value === "startup") return keys.length === 1 ? Object.freeze({ type: "startup" }) : null;
	if (typeProperty.value === "ready") return keys.length === 1 ? Object.freeze({ type: "ready" }) : null;
	if (typeProperty.value === "error") {
		const errorClassProperty = readDataProperty(record, "errorClass");
		if (keys.length !== 2 || !errorClassProperty.present || !isChatGptWebErrorClass(errorClassProperty.value))
			return null;
		return Object.freeze({ type: "error", errorClass: errorClassProperty.value });
	}
	if (typeProperty.value !== "eof") return null;

	const normalProperty = readDataProperty(record, "normal");
	const exitCodeProperty = readDataProperty(record, "exitCode");
	if (!normalProperty.present || typeof normalProperty.value !== "boolean") return null;
	if (normalProperty.value) {
		if (keys.length !== 3 || !exitCodeProperty.present || exitCodeProperty.value !== 0) return null;
		return Object.freeze({ type: "eof", normal: true, exitCode: 0 });
	}

	const errorClassProperty = readDataProperty(record, "errorClass");
	if (!errorClassProperty.present || !isChatGptWebErrorClass(errorClassProperty.value)) return null;
	if (keys.length === 3 && !exitCodeProperty.present)
		return Object.freeze({ type: "eof", normal: false, errorClass: errorClassProperty.value });
	if (keys.length !== 4 || !exitCodeProperty.present || !isExitCode(exitCodeProperty.value)) return null;
	return Object.freeze({
		type: "eof",
		normal: false,
		errorClass: errorClassProperty.value,
		exitCode: exitCodeProperty.value,
	});
}

function nextPhase(phase: ProcessPhase, status: ProcessLineStatus): ProcessPhase | null {
	if (phase === "initial") return status.type === "startup" ? "startup" : null;
	if (phase === "startup") {
		if (status.type === "ready") return "ready";
		if (status.type === "error") return "error";
		return status.type === "eof" ? "eof" : null;
	}
	if (phase === "ready") {
		if (status.type === "error") return "error";
		return status.type === "eof" ? "eof" : null;
	}
	if (phase === "error") return status.type === "eof" ? "eof" : null;
	return null;
}

function safelyCallFailure(
	callback: ((failure: ProcessLineFailure) => void) | undefined,
	reason: ProcessLineFailureReason,
): void {
	if (!callback) return;
	try {
		callback(Object.freeze({ errorClass: "malformed_browser_output", reason }));
	} catch {
		// Callers cannot make raw callback failures part of the child-process protocol.
	}
}

export function createProcessLineWriter(
	stream: Writable,
	onFailure?: (failure: ProcessLineFailure) => void,
): ProcessLineWriter {
	let active = true;
	let phase: ProcessPhase = "initial";
	let lineCount = 0;

	const fail = (reason: ProcessLineFailureReason): void => {
		if (!active) return;
		active = false;
		phase = "failed";
		safelyCallFailure(onFailure, reason);
	};

	stream.on("error", () => fail("stream_unavailable"));

	return Object.freeze({
		write(status: ProcessLineStatus): boolean {
			if (!active || phase === "eof") return false;
			if (stream.destroyed || stream.writableEnded) {
				fail("stream_unavailable");
				return false;
			}
			const normalized = normalizeProcessLineStatus(status);
			if (!normalized) {
				fail("invalid_status");
				return false;
			}
			const followingPhase = nextPhase(phase, normalized);
			if (!followingPhase) {
				fail("invalid_sequence");
				return false;
			}
			if (lineCount >= PROCESS_LINE_MAX_LINES) {
				fail("line_limit");
				return false;
			}

			const encoded = textEncoder.encode(`${JSON.stringify(normalized)}\n`);
			if (encoded.byteLength - 1 > PROCESS_LINE_MAX_UTF8_BYTES) {
				fail("line_too_large");
				return false;
			}
			phase = followingPhase;
			lineCount++;
			try {
				stream.write(encoded, error => {
					if (error) fail("stream_unavailable");
				});
				return true;
			} catch {
				fail("stream_unavailable");
				return false;
			}
		},
		close(): void {
			active = false;
		},
	});
}

export function createProcessLineParser(options: ProcessLineParserOptions): ProcessLineParser {
	const pending = new Uint8Array(PROCESS_LINE_MAX_UTF8_BYTES);
	let pendingLength = 0;
	let lineCount = 0;
	let phase: ProcessPhase = "initial";
	let ended = false;
	let reportedEof: Extract<ProcessLineStatus, { type: "eof" }> | null = null;
	let reportedErrorClass: ChatGptWebErrorClass | null = null;

	const emitStatus = (status: ProcessLineStatus): void => {
		try {
			options.onStatus(status);
		} catch {
			// Status consumers cannot inject raw callback failures into parser state.
		}
	};
	const fail = (reason: ProcessLineFailureReason): void => {
		if (phase === "failed") return;
		phase = "failed";
		reportedEof = null;
		reportedErrorClass = null;
		safelyCallFailure(options.onFailure, reason);
		emitStatus(Object.freeze({ type: "error", errorClass: "malformed_browser_output" }));
	};
	const emitAbnormalEof = (exitCode: number | null, errorClass: ChatGptWebErrorClass): void => {
		const status: Extract<ProcessLineStatus, { type: "eof"; normal: false }> =
			exitCode === null
				? { type: "eof", normal: false, errorClass }
				: { type: "eof", normal: false, errorClass, exitCode };
		emitStatus(Object.freeze(status));
	};
	const acceptLine = (): boolean => {
		if (lineCount >= PROCESS_LINE_MAX_LINES) {
			fail("line_limit");
			return false;
		}
		lineCount++;

		let text: string;
		try {
			text = textDecoder.decode(pending.subarray(0, pendingLength));
		} catch {
			fail("malformed_utf8");
			return false;
		} finally {
			pending.fill(0, 0, pendingLength);
			pendingLength = 0;
		}

		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch {
			fail("malformed_json");
			return false;
		}
		const status = normalizeProcessLineStatus(parsed);
		parsed = null;
		text = "";
		if (!status) {
			fail("invalid_status");
			return false;
		}
		const followingPhase = nextPhase(phase, status);
		if (!followingPhase) {
			fail("invalid_sequence");
			return false;
		}
		phase = followingPhase;
		if (status.type === "error") reportedErrorClass = status.errorClass;
		if (status.type === "eof") reportedEof = status;
		else emitStatus(status);
		return true;
	};

	return Object.freeze({
		push(chunk: Uint8Array): boolean {
			if (ended || phase === "failed") return false;
			if (!(chunk instanceof Uint8Array) || !ArrayBuffer.isView(chunk)) {
				fail("invalid_chunk");
				return false;
			}
			if (phase === "eof") {
				fail("invalid_sequence");
				return false;
			}
			for (let index = 0; index < chunk.byteLength; index++) {
				const byte = chunk[index];
				if (byte === 0x0a) {
					if (pendingLength === 0) {
						fail("malformed_json");
						return false;
					}
					if (!acceptLine()) return false;
					continue;
				}
				if (pendingLength >= PROCESS_LINE_MAX_UTF8_BYTES) {
					fail("line_too_large");
					return false;
				}
				pending[pendingLength++] = byte;
			}
			return true;
		},
		end(exitCode: number | null = null): void {
			if (ended) return;
			ended = true;
			let safeExitCode = exitCode;
			if (safeExitCode !== null && !isExitCode(safeExitCode)) {
				safeExitCode = null;
				fail("exit_mismatch");
			}
			if (pendingLength !== 0) fail("malformed_json");

			if (reportedEof) {
				const exitMatches =
					safeExitCode === null
						? !reportedEof.normal && reportedEof.exitCode === undefined
						: reportedEof.exitCode === safeExitCode;
				if (exitMatches) {
					emitStatus(reportedEof);
					return;
				}
				fail("exit_mismatch");
			}

			if (phase !== "failed") {
				safelyCallFailure(options.onFailure, "abnormal_eof");
				emitStatus(Object.freeze({ type: "error", errorClass: "malformed_browser_output" }));
			}
			emitAbnormalEof(safeExitCode, reportedErrorClass ?? "malformed_browser_output");
		},
	});
}

export function createBoundedProcessStderrCapture(): BoundedProcessStderrCapture {
	const captured = new Uint8Array(PROCESS_STDERR_MAX_BYTES);
	let capturedLength = 0;
	let truncated = false;
	let finished: ProcessStderrSummary | null = null;

	return Object.freeze({
		append(chunk: Uint8Array): boolean {
			if (finished || !(chunk instanceof Uint8Array) || !ArrayBuffer.isView(chunk)) return false;
			const remaining = PROCESS_STDERR_MAX_BYTES - capturedLength;
			const acceptedLength = Math.min(remaining, chunk.byteLength);
			if (acceptedLength > 0) {
				captured.set(chunk.subarray(0, acceptedLength), capturedLength);
				capturedLength += acceptedLength;
			}
			if (acceptedLength !== chunk.byteLength) truncated = true;
			return true;
		},
		finish(): ProcessStderrSummary {
			if (finished) return finished;
			finished = Object.freeze({ byteCount: capturedLength, truncated });
			captured.fill(0);
			return finished;
		},
	});
}
