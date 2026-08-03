import { describe, expect, test } from "bun:test";
import { Writable } from "node:stream";
import {
	createBoundedProcessStderrCapture,
	createProcessLineParser,
	createProcessLineWriter,
	PROCESS_LINE_MAX_LINES,
	PROCESS_LINE_MAX_UTF8_BYTES,
	PROCESS_STDERR_MAX_BYTES,
	type ProcessLineFailure,
	type ProcessLineStatus,
} from "../src/browser/process-line-writer";
import { type ChatGptWebDiagnostic, createStructuredDiagnostic, createStructuredLogger } from "../src/runtime/logging";

const SECRET_CANARY = "Q7vN3kP9xL2mR8tW5cF1hJ6sD4zB0yUe_SECRET_CANARY";
const DOM_CANARY = "DOM_a8K4pQ2zN7wT9mV3xR6cL1fH5jS0dYbE";
const CHILD_CANARY = "CHILD_f9R2vK7mP4xN8tQ1zW6cJ3hL5sD0yUaB";
const HASH = "a".repeat(64);
const encoder = new TextEncoder();

function capturedText(values: readonly unknown[]): string {
	return JSON.stringify(values);
}

function encodedLines(...statuses: readonly ProcessLineStatus[]): Uint8Array {
	return encoder.encode(`${statuses.map(status => JSON.stringify(status)).join("\n")}\n`);
}

describe("structured logging allowlist", () => {
	test("emits only closed, bounded fields and returns the same safe diagnostic shape", () => {
		const sink: ChatGptWebDiagnostic[] = [];
		const logger = createStructuredLogger(diagnostic => sink.push(diagnostic));
		const input: ChatGptWebDiagnostic = {
			stage: "health",
			durationMs: 1_234,
			count: 5,
			exitCode: 17,
			errorClass: "browser_unavailable",
			executableHash: HASH,
			modelRouteHash: HASH,
			protocolHash: HASH,
		};

		expect(logger.log(input)).toBe(true);
		expect(sink).toEqual([input]);
		expect(Object.isFrozen(sink[0])).toBe(true);
		expect(logger.diagnostic(input)).toEqual(input);
		expect(createStructuredDiagnostic(input)).toEqual(input);
	});

	test("rejects forbidden and unknown fields before reading their values", () => {
		const sink: ChatGptWebDiagnostic[] = [];
		const logger = createStructuredLogger(diagnostic => sink.push(diagnostic));
		const forbiddenFields = [
			"message",
			"exception",
			"domText",
			"prompt",
			"connectorPayload",
			"header",
			"queryUrl",
			"cookie",
			"profilePath",
			"rawChildLine",
		] as const;

		for (const field of forbiddenFields) {
			expect(logger.log({ stage: "health", [field]: `${SECRET_CANARY}:${DOM_CANARY}:${CHILD_CANARY}` })).toBe(false);
		}
		expect(logger.log({ stage: "health", [SECRET_CANARY]: SECRET_CANARY })).toBe(false);
		expect(logger.log({ stage: "health", error: new Error(SECRET_CANARY) })).toBe(false);
		expect(sink).toEqual([]);
		expect(capturedText(sink)).not.toContain(SECRET_CANARY);
		expect(capturedText(sink)).not.toContain(DOM_CANARY);
		expect(capturedText(sink)).not.toContain(CHILD_CANARY);
	});

	test("rejects accessors, proxies, invalid enums, malformed hashes, and out-of-bounds numbers", () => {
		const sink: ChatGptWebDiagnostic[] = [];
		const logger = createStructuredLogger(diagnostic => sink.push(diagnostic));
		let getterCalled = false;
		const accessorInput = {
			stage: "health",
			get count(): number {
				getterCalled = true;
				throw new Error(SECRET_CANARY);
			},
		};
		const proxyInput = new Proxy(
			{},
			{
				getPrototypeOf() {
					throw new Error(SECRET_CANARY);
				},
			},
		);
		const invalidInputs: unknown[] = [
			accessorInput,
			proxyInput,
			{ stage: SECRET_CANARY },
			{ stage: "health", errorClass: SECRET_CANARY },
			{ stage: "health", durationMs: -1 },
			{ stage: "health", durationMs: 86_400_001 },
			{ stage: "health", durationMs: 0.5 },
			{ stage: "health", count: 1_000_001 },
			{ stage: "health", count: Number.NaN },
			{ stage: "health", exitCode: 0x1_0000_0000 },
			{ stage: "health", executableHash: SECRET_CANARY },
			{ stage: "health", executableHash: "A".repeat(64) },
		];

		for (const input of invalidInputs) {
			expect(logger.log(input)).toBe(false);
			expect(logger.diagnostic(input)).toBeNull();
		}
		expect(getterCalled).toBe(false);
		expect(sink).toEqual([]);
	});

	test("contains sink exceptions without returning their raw messages", () => {
		const logger = createStructuredLogger(() => {
			throw new Error(SECRET_CANARY);
		});

		expect(logger.log({ stage: "shutdown", errorClass: "internal" })).toBe(false);
	});
});

describe("bounded child-process line protocol", () => {
	test("writes and parses the typed startup, ready, and normal EOF sequence", () => {
		const written: Uint8Array[] = [];
		const writerFailures: ProcessLineFailure[] = [];
		const output = new Writable({
			write(chunk, _encoding, callback) {
				written.push(Uint8Array.from(chunk));
				callback();
			},
		});
		const writer = createProcessLineWriter(output, failure => writerFailures.push(failure));
		expect(writer.write({ type: "startup" })).toBe(true);
		expect(writer.write({ type: "ready" })).toBe(true);
		expect(writer.write({ type: "eof", normal: true, exitCode: 0 })).toBe(true);
		expect(writer.write({ type: "ready" })).toBe(false);
		writer.close();

		const statuses: ProcessLineStatus[] = [];
		const parserFailures: ProcessLineFailure[] = [];
		const parser = createProcessLineParser({
			onStatus: status => statuses.push(status),
			onFailure: failure => parserFailures.push(failure),
		});
		for (const chunk of written) expect(parser.push(chunk)).toBe(true);
		parser.end(0);

		expect(writerFailures).toEqual([]);
		expect(parserFailures).toEqual([]);
		expect(statuses).toEqual([{ type: "startup" }, { type: "ready" }, { type: "eof", normal: true, exitCode: 0 }]);
		expect(capturedText([written.map(chunk => new TextDecoder().decode(chunk)), statuses])).not.toContain(
			CHILD_CANARY,
		);
	});

	test("writes and parses closed error and abnormal EOF states", () => {
		const statuses: ProcessLineStatus[] = [];
		const failures: ProcessLineFailure[] = [];
		const parser = createProcessLineParser({
			onStatus: status => statuses.push(status),
			onFailure: failure => failures.push(failure),
		});
		const input = encodedLines(
			{ type: "startup" },
			{ type: "error", errorClass: "login_required" },
			{ type: "eof", normal: false, errorClass: "login_required", exitCode: 9 },
		);

		expect(parser.push(input)).toBe(true);
		parser.end(9);
		expect(failures).toEqual([]);
		expect(statuses).toEqual([
			{ type: "startup" },
			{ type: "error", errorClass: "login_required" },
			{ type: "eof", normal: false, errorClass: "login_required", exitCode: 9 },
		]);
	});

	test("rejects raw fields without serializing them to the child stream or failure sink", () => {
		const written: Uint8Array[] = [];
		const failures: ProcessLineFailure[] = [];
		const output = new Writable({
			write(chunk, _encoding, callback) {
				written.push(Uint8Array.from(chunk));
				callback();
			},
		});
		const writer = createProcessLineWriter(output, failure => failures.push(failure));
		const forbiddenStatus = { type: "startup", rawChildLine: `${CHILD_CANARY}:${SECRET_CANARY}` };

		expect(writer.write(forbiddenStatus as unknown as ProcessLineStatus)).toBe(false);
		expect(written).toEqual([]);
		expect(failures).toEqual([{ errorClass: "malformed_browser_output", reason: "invalid_status" }]);
		expect(capturedText([written, failures])).not.toContain(CHILD_CANARY);
		expect(capturedText([written, failures])).not.toContain(SECRET_CANARY);
	});

	test("maps raw stream exceptions to a closed failure", async () => {
		const failures: ProcessLineFailure[] = [];
		const output = new Writable({
			write(_chunk, _encoding, callback) {
				callback(new Error(CHILD_CANARY));
			},
		});
		const writer = createProcessLineWriter(output, failure => failures.push(failure));

		expect(writer.write({ type: "startup" })).toBe(true);
		const { promise, resolve } = Promise.withResolvers<void>();
		setImmediate(resolve);
		await promise;
		expect(failures).toEqual([{ errorClass: "malformed_browser_output", reason: "stream_unavailable" }]);
		expect(capturedText(failures)).not.toContain(CHILD_CANARY);
	});

	test("fails closed on malformed, oversized, invalid UTF-8, and invalid chunks", () => {
		const captured: unknown[] = [];
		const cases: unknown[] = [
			encoder.encode(`${JSON.stringify({ type: "startup", rawChildLine: CHILD_CANARY })}\n`),
			encoder.encode(`${CHILD_CANARY.repeat(Math.ceil((PROCESS_LINE_MAX_UTF8_BYTES + 1) / CHILD_CANARY.length))}\n`),
			Uint8Array.from([0xc3, 0x28, 0x0a]),
			CHILD_CANARY,
		];
		const expectedReasons = ["invalid_status", "line_too_large", "malformed_utf8", "invalid_chunk"] as const;

		for (let index = 0; index < cases.length; index++) {
			const statuses: ProcessLineStatus[] = [];
			const failures: ProcessLineFailure[] = [];
			const parser = createProcessLineParser({
				onStatus: status => statuses.push(status),
				onFailure: failure => failures.push(failure),
			});
			const untrustedChunk = cases[index] as Uint8Array;
			expect(parser.push(untrustedChunk)).toBe(false);
			parser.end(7);
			expect(failures[0]?.reason).toBe(expectedReasons[index]);
			expect(statuses).toEqual([
				{ type: "error", errorClass: "malformed_browser_output" },
				{ type: "eof", normal: false, errorClass: "malformed_browser_output", exitCode: 7 },
			]);
			captured.push(statuses, failures);
		}
		expect(capturedText(captured)).not.toContain(CHILD_CANARY);
	});

	test("enforces the hard line limit before parsing any trailing child line", () => {
		const statuses: ProcessLineStatus[] = [];
		const failures: ProcessLineFailure[] = [];
		const parser = createProcessLineParser({
			onStatus: status => statuses.push(status),
			onFailure: failure => failures.push(failure),
		});
		const validMaximum = encodedLines(
			{ type: "startup" },
			{ type: "ready" },
			{ type: "error", errorClass: "internal" },
			{ type: "eof", normal: false, errorClass: "internal", exitCode: 2 },
		);
		const trailingCanary = encoder.encode(`${JSON.stringify({ type: CHILD_CANARY })}\n`);
		const combined = new Uint8Array(validMaximum.byteLength + trailingCanary.byteLength);
		combined.set(validMaximum);
		combined.set(trailingCanary, validMaximum.byteLength);

		expect(PROCESS_LINE_MAX_LINES).toBe(4);
		expect(parser.push(combined)).toBe(false);
		parser.end(2);
		expect(failures[0]?.reason).toBe("line_limit");
		expect(capturedText([statuses, failures])).not.toContain(CHILD_CANARY);
	});

	test("reports missing or mismatched protocol EOF explicitly", () => {
		const missingStatuses: ProcessLineStatus[] = [];
		const missingFailures: ProcessLineFailure[] = [];
		const missing = createProcessLineParser({
			onStatus: status => missingStatuses.push(status),
			onFailure: failure => missingFailures.push(failure),
		});
		expect(missing.push(encodedLines({ type: "startup" }, { type: "ready" }))).toBe(true);
		missing.end(17);
		expect(missingFailures).toEqual([{ errorClass: "malformed_browser_output", reason: "abnormal_eof" }]);
		expect(missingStatuses.at(-1)).toEqual({
			type: "eof",
			normal: false,
			errorClass: "malformed_browser_output",
			exitCode: 17,
		});

		const mismatchStatuses: ProcessLineStatus[] = [];
		const mismatchFailures: ProcessLineFailure[] = [];
		const mismatch = createProcessLineParser({
			onStatus: status => mismatchStatuses.push(status),
			onFailure: failure => mismatchFailures.push(failure),
		});
		expect(
			mismatch.push(
				encodedLines({ type: "startup" }, { type: "ready" }, { type: "eof", normal: true, exitCode: 0 }),
			),
		).toBe(true);
		mismatch.end(9);
		expect(mismatchFailures).toEqual([{ errorClass: "malformed_browser_output", reason: "exit_mismatch" }]);
		expect(mismatchStatuses.at(-1)).toEqual({
			type: "eof",
			normal: false,
			errorClass: "malformed_browser_output",
			exitCode: 9,
		});
	});

	test("bounds stderr, destroys raw bytes, and exposes only bounded metadata", () => {
		const capture = createBoundedProcessStderrCapture();
		const rawStderr = encoder.encode(`${CHILD_CANARY}:${SECRET_CANARY}`.repeat(256));
		expect(capture.append(rawStderr)).toBe(true);
		const summary = capture.finish();

		expect(summary.byteCount).toBe(PROCESS_STDERR_MAX_BYTES);
		expect(summary.truncated).toBe(true);
		expect(capture.append(encoder.encode(CHILD_CANARY))).toBe(false);
		expect(capture.finish()).toBe(summary);
		expect(capturedText([summary])).not.toContain(CHILD_CANARY);
		expect(capturedText([summary])).not.toContain(SECRET_CANARY);

		const diagnostics: ChatGptWebDiagnostic[] = [];
		const logger = createStructuredLogger(diagnostic => diagnostics.push(diagnostic));
		expect(logger.log({ stage: "shutdown", count: summary.byteCount, errorClass: "internal" })).toBe(true);
		expect(capturedText(diagnostics)).not.toContain(CHILD_CANARY);
		expect(capturedText(diagnostics)).not.toContain(SECRET_CANARY);
	});
});
