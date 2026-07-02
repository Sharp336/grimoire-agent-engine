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

		// Set up an event listener to synchronize stream processing of the late response
		const eventPromise = client.waitForEvent("sync-event");

		// Send request 2
		const sendPromise2 = client.sendRequest("test-command-2", {}, undefined, 100);

		// Keep state in an object property so TypeScript does not narrow the
		// union away after the intermediate `.toBe("pending")` assertions.
		const promise2State = { value: "pending" as "pending" | "resolved" | "rejected" };
		let promise2Result: unknown;
		sendPromise2.then(
			val => {
				promise2State.value = "resolved";
				promise2Result = val;
			},
			err => {
				promise2State.value = "rejected";
				promise2Result = err;
			},
		);

		// Assert request 2 is pending initially
		expect(promise2State.value).toBe("pending");

		// Simulate a late response arriving via the stdout stream for request 1
		const response1 = {
			seq: 3,
			type: "response",
			request_seq: 1, // First requestSeq was 1
			success: true,
			command: "test-command",
			body: { ok: false },
		};
		const json1 = JSON.stringify(response1);
		const payload1 = `Content-Length: ${Buffer.byteLength(json1, "utf-8")}\r\n\r\n${json1}`;

		// Simulate a dummy event to serve as our observable processing signal
		const syncEvent = {
			seq: 4,
			type: "event",
			event: "sync-event",
			body: {},
		};
		const jsonEvent = JSON.stringify(syncEvent);
		const payloadEvent = `Content-Length: ${Buffer.byteLength(jsonEvent, "utf-8")}\r\n\r\n${jsonEvent}`;

		// Enqueue late response followed by the sync event
		streamController?.enqueue(new TextEncoder().encode(payload1 + payloadEvent));

		// Await the sync event to guarantee the late response was processed by the reader loop
		await eventPromise;

		// Assert the late response did not resolve/corrupt request 2
		expect(promise2State.value).toBe("pending");

		// Now simulate the response for request 2
		const response2 = {
			seq: 5,
			type: "response",
			request_seq: 2, // Second requestSeq is 2
			success: true,
			command: "test-command-2",
			body: { ok: true },
		};
		const json2 = JSON.stringify(response2);
		const payload2 = `Content-Length: ${Buffer.byteLength(json2, "utf-8")}\r\n\r\n${json2}`;

		streamController?.enqueue(new TextEncoder().encode(payload2));

		// Await the promise to resolve properly and propagate state changes
		const result2 = await sendPromise2;

		// Assert that request 2 resolves with the correct payload and nothing throws
		expect(promise2State.value).toBe("resolved");
		expect(result2).toEqual({ ok: true });
		expect(promise2Result).toEqual({ ok: true });

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
