import { afterEach, beforeEach, describe, expect, it, spyOn, vi } from "bun:test";
import { DapClient } from "@oh-my-pi/pi-coding-agent/dap/client";
import type { DapClientState, DapResolvedAdapter } from "@oh-my-pi/pi-coding-agent/dap/types";
import { ToolAbortError } from "@oh-my-pi/pi-coding-agent/tools/tool-errors";
import { ptree } from "@oh-my-pi/pi-utils";

const TEST_ADAPTER: DapResolvedAdapter = {
	name: "test-adapter",
	command: "test-adapter",
	args: [],
	resolvedCommand: "test-adapter",
	languages: [],
	fileTypes: [],
	rootMarkers: [],
	launchDefaults: {},
	attachDefaults: {},
	connectMode: "stdio",
	acceptsDirectoryProgram: false,
};

describe("DapClient sendRequest timeout and abort behavior", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("rejects request on timeout, removes the pending entry, and ignores late response without throwing", async () => {
		const exitedDeferred = Promise.withResolvers<void>();
		let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;

		const stdout = new ReadableStream<Uint8Array>({
			start(controller) {
				streamController = controller;
			},
		});

		const writeSink = {
			write: (data: string | Uint8Array) => {
				return typeof data === "string" ? data.length : data.byteLength;
			},
			flush: () => undefined,
		};

		const procState = {
			exitCode: null as number | null,
			exited: exitedDeferred.promise,
			peekStderr: () => "",
			kill: () => {
				procState.exitCode = 0;
				exitedDeferred.resolve();
				return true;
			},
			stdin: writeSink,
			stdout,
		};
		// Deliberate documented escape hatch: ptree.ChildProcess is nominally typed
		// via #private fields and cannot be structurally satisfied by a test fake.
		const proc = procState as unknown as DapClientState["proc"];

		spyOn(ptree, "spawn").mockReturnValue(proc);

		const client = await DapClient.spawn({
			adapter: TEST_ADAPTER,
			cwd: "/test",
		});

		// Send a request with a short timeout
		const sendPromise = client.sendRequest("test-command", {}, undefined, 10);

		// Advance timers to trigger the timeout
		vi.advanceTimersByTime(15);

		// The promise should be rejected
		await expect(sendPromise).rejects.toThrow("DAP request test-command timed out after 10ms");

		// Simulate a late response arriving via the stdout stream
		const response = {
			seq: 2,
			type: "response",
			request_seq: 1, // First requestSeq is 1
			success: true,
			command: "test-command",
			body: { ok: true },
		};
		const json = JSON.stringify(response);
		const payload = `Content-Length: ${Buffer.byteLength(json, "utf-8")}\r\n\r\n${json}`;

		streamController?.enqueue(new TextEncoder().encode(payload));

		// Yield to the microtask queue so the message reader loop can process the enqueued chunk
		await Promise.resolve();
		await Promise.resolve();

		// Clean up
		await client.dispose();
	});

	it("rejects request on AbortSignal abort, removes the pending entry, and ignores late response without throwing", async () => {
		const exitedDeferred = Promise.withResolvers<void>();
		let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;

		const stdout = new ReadableStream<Uint8Array>({
			start(controller) {
				streamController = controller;
			},
		});

		const writeSink = {
			write: (data: string | Uint8Array) => {
				return typeof data === "string" ? data.length : data.byteLength;
			},
			flush: () => undefined,
		};

		const procState = {
			exitCode: null as number | null,
			exited: exitedDeferred.promise,
			peekStderr: () => "",
			kill: () => {
				procState.exitCode = 0;
				exitedDeferred.resolve();
				return true;
			},
			stdin: writeSink,
			stdout,
		};
		// Deliberate documented escape hatch: ptree.ChildProcess is nominally typed
		// via #private fields and cannot be structurally satisfied by a test fake.
		const proc = procState as unknown as DapClientState["proc"];

		spyOn(ptree, "spawn").mockReturnValue(proc);

		const client = await DapClient.spawn({
			adapter: TEST_ADAPTER,
			cwd: "/test",
		});

		const abortController = new AbortController();
		const sendPromise = client.sendRequest("test-command", {}, abortController.signal, 1000);

		// Abort the request
		abortController.abort(new Error("Request aborted"));

		// The promise should be rejected immediately
		await expect(sendPromise).rejects.toThrow("Request aborted");

		// Simulate a late response arriving via the stdout stream
		const response = {
			seq: 2,
			type: "response",
			request_seq: 1, // First requestSeq is 1
			success: true,
			command: "test-command",
			body: { ok: true },
		};
		const json = JSON.stringify(response);
		const payload = `Content-Length: ${Buffer.byteLength(json, "utf-8")}\r\n\r\n${json}`;

		streamController?.enqueue(new TextEncoder().encode(payload));

		// Yield to the microtask queue so the message reader loop can process the enqueued chunk
		await Promise.resolve();
		await Promise.resolve();

		// Clean up
		await client.dispose();
	});

	it("rejects immediately if the AbortSignal is already aborted", async () => {
		const exitedDeferred = Promise.withResolvers<void>();
		const stdout = new ReadableStream<Uint8Array>();

		const writeSink = {
			write: (data: string | Uint8Array) => {
				return typeof data === "string" ? data.length : data.byteLength;
			},
			flush: () => undefined,
		};

		const procState = {
			exitCode: null as number | null,
			exited: exitedDeferred.promise,
			peekStderr: () => "",
			kill: () => {
				procState.exitCode = 0;
				exitedDeferred.resolve();
				return true;
			},
			stdin: writeSink,
			stdout,
		};
		// Deliberate documented escape hatch: ptree.ChildProcess is nominally typed
		// via #private fields and cannot be structurally satisfied by a test fake.
		const proc = procState as unknown as DapClientState["proc"];

		spyOn(ptree, "spawn").mockReturnValue(proc);

		const client = await DapClient.spawn({
			adapter: TEST_ADAPTER,
			cwd: "/test",
		});

		const abortController = new AbortController();
		abortController.abort(); // Default abort without reason

		const sendPromise = client.sendRequest("test-command", {}, abortController.signal, 1000);

		// Rejects with default DOMException (AbortError)
		await expect(sendPromise).rejects.toThrow("The operation was aborted.");

		// Clean up
		await client.dispose();
	});

	it("rejects immediately with ToolAbortError if the AbortSignal is already aborted with a non-Error reason", async () => {
		const exitedDeferred = Promise.withResolvers<void>();
		const stdout = new ReadableStream<Uint8Array>();

		const writeSink = {
			write: (data: string | Uint8Array) => {
				return typeof data === "string" ? data.length : data.byteLength;
			},
			flush: () => undefined,
		};

		const procState = {
			exitCode: null as number | null,
			exited: exitedDeferred.promise,
			peekStderr: () => "",
			kill: () => {
				procState.exitCode = 0;
				exitedDeferred.resolve();
				return true;
			},
			stdin: writeSink,
			stdout,
		};
		// Deliberate documented escape hatch: ptree.ChildProcess is nominally typed
		// via #private fields and cannot be structurally satisfied by a test fake.
		const proc = procState as unknown as DapClientState["proc"];

		spyOn(ptree, "spawn").mockReturnValue(proc);

		const client = await DapClient.spawn({
			adapter: TEST_ADAPTER,
			cwd: "/test",
		});

		const abortController = new AbortController();
		abortController.abort("not-an-error-reason");

		const sendPromise = client.sendRequest("test-command", {}, abortController.signal, 1000);

		// Rejects with default ToolAbortError
		await expect(sendPromise).rejects.toThrow(ToolAbortError);

		// Clean up
		await client.dispose();
	});
});
