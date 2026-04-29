/**
 * Regression test for #860: async LSP shutdown with completion gate.
 *
 * Verifies that after `shutdownAll()` resolves, every mock LSP client
 * process has had `proc.kill()` called — i.e. no child is orphaned.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import type { LspClient, PendingRequest } from "../types";
import { _injectClientForTest, _resetClientsForTest, shutdownAll } from "../client";

/**
 * Build a minimal mock LspClient whose `proc.kill` is a vi.fn spy.
 *
 * stdin is shaped as a Bun.FileSink (write + flush) so that
 * `writeMessage()` inside `sendRequest()` succeeds and the shutdown
 * request is actually written + a pending request registered.
 *
 * The caller can then deliberately resolve/reject the pending shutdown
 * request to control when `proc.kill()` fires.
 */
function createMockClient(name: string): {
	key: string;
	client: LspClient;
	killSpy: ReturnType<typeof vi.fn>;
	/** Resolves the next pending request (the shutdown request from sendRequest). */
	resolveShutdown: (value?: unknown) => void;
	/** Rejects the next pending request. */
	rejectShutdown: (err: Error) => void;
} {
	const killSpy = vi.fn();
	let capturedResolve!: (value?: unknown) => void;
	let capturedReject!: (err: Error) => void;

	// Bun.FileSink shape: write() returns bytes written, flush() returns Promise
	const stdin = {
		write: vi.fn().mockReturnValue(0),
		flush: vi.fn().mockResolvedValue(undefined),
		end: vi.fn(),
	} as unknown as Bun.FileSink;

	const proc = {
		kill: killSpy,
		stdin,
		exited: new Promise<void>(() => {}), // never resolves during test
		peekStderr: () => "",
		exitCode: null,
	} as unknown as LspClient["proc"];

	// Wrap pendingRequests.set to capture the shutdown request that
	// sendRequest registers, so the test can resolve it deliberately.
	const realPendingRequests = new Map<number, PendingRequest>();
	const pendingRequests = new Map<number, PendingRequest>();
	const originalSet = realPendingRequests.set.bind(realPendingRequests);
	pendingRequests.set = (id: number, req: PendingRequest) => {
		originalSet(id, req);
		// Capture the resolve/reject so the test controls timing
		capturedResolve = req.resolve;
		capturedReject = req.reject;
		return pendingRequests;
	};
	pendingRequests.get = realPendingRequests.get.bind(realPendingRequests);
	pendingRequests.has = realPendingRequests.has.bind(realPendingRequests);
	pendingRequests.delete = realPendingRequests.delete.bind(realPendingRequests);
	pendingRequests.clear = realPendingRequests.clear.bind(realPendingRequests);
	pendingRequests.values = realPendingRequests.values.bind(realPendingRequests);
	Object.defineProperty(pendingRequests, "size", { get: () => realPendingRequests.size });

	const client: LspClient = {
		name,
		cwd: "/tmp/test",
		config: { command: name, fileTypes: [".ts"], rootMarkers: [] },
		proc,
		requestId: 0,
		diagnostics: new Map(),
		diagnosticsVersion: 0,
		openFiles: new Map(),
		pendingRequests,
		messageBuffer: new Uint8Array(0),
		isReading: false,
		lastActivity: Date.now(),
		writeQueue: Promise.resolve(),
		activeProgressTokens: new Set(),
		projectLoaded: Promise.resolve(),
		resolveProjectLoaded: () => {},
	};

	const key = `${name}:/tmp/test`;
	return {
		key,
		client,
		killSpy,
		resolveShutdown: (value?: unknown) => capturedResolve(value),
		rejectShutdown: (err: Error) => capturedReject(err),
	};
}

describe("shutdownAll", () => {
	beforeEach(() => {
		_resetClientsForTest();
	});

	afterEach(() => {
		_resetClientsForTest();
	});

	it("kills all LSP client processes after shutdownAll resolves", async () => {
		const mock1 = createMockClient("clangd");
		const mock2 = createMockClient("rust-analyzer");
		const mock3 = createMockClient("typescript-language-server");

		_injectClientForTest(mock1.key, mock1.client);
		_injectClientForTest(mock2.key, mock2.client);
		_injectClientForTest(mock3.key, mock3.client);

		// Kick off shutdownAll — it sends shutdown requests then awaits allSettled.
		// Resolve each pending shutdown request to simulate the LSP servers responding.
		const shutdownPromise = shutdownAll();

		// Give microtasks time to register the pending requests
		await Bun.sleep(0);
		await Bun.sleep(0);

		// Simulate each LSP server responding to the shutdown request
		mock1.resolveShutdown(null);
		mock2.resolveShutdown(null);
		mock3.resolveShutdown(null);

		await shutdownPromise;

		// proc.kill() must have been called on every client
		expect(mock1.killSpy).toHaveBeenCalledTimes(1);
		expect(mock2.killSpy).toHaveBeenCalledTimes(1);
		expect(mock3.killSpy).toHaveBeenCalledTimes(1);
	});

	it("kills process even when the shutdown request is rejected", async () => {
		const mock = createMockClient("failing-server");
		_injectClientForTest(mock.key, mock.client);

		const shutdownPromise = shutdownAll();
		await Bun.sleep(0);
		await Bun.sleep(0);

		// Simulate the LSP server rejecting the shutdown request
		mock.rejectShutdown(new Error("server error"));

		await shutdownPromise;

		// proc.kill() is still called — the catch in the IIFE is best-effort
		expect(mock.killSpy).toHaveBeenCalledTimes(1);
	});

	it("rejects all pending requests before killing processes", async () => {
		const mock = createMockClient("clangd");
		const preExistingReject = vi.fn();
		// A pre-existing pending request (e.g. from a hover query) must be rejected
		// synchronously before the async shutdown IIFE runs.
		mock.client.pendingRequests.set(1, {
			resolve: vi.fn(),
			reject: preExistingReject,
			method: "textDocument/hover",
		});

		_injectClientForTest(mock.key, mock.client);

		const shutdownPromise = shutdownAll();
		await Bun.sleep(0);
		await Bun.sleep(0);

		// The pre-existing request was rejected with "LSP client shutdown"
		expect(preExistingReject).toHaveBeenCalledTimes(1);
		expect(preExistingReject.mock.calls[0][0]).toBeInstanceOf(Error);
		expect(preExistingReject.mock.calls[0][0].message).toBe("LSP client shutdown");

		// Resolve the shutdown request so the IIFE completes
		mock.resolveShutdown(null);
		await shutdownPromise;

		expect(mock.killSpy).toHaveBeenCalledTimes(1);
	});

	it("clears the clients map after shutdown", async () => {
		const mock = createMockClient("clangd");
		_injectClientForTest(mock.key, mock.client);

		const shutdownPromise = shutdownAll();
		await Bun.sleep(0);
		await Bun.sleep(0);
		mock.resolveShutdown(null);
		await shutdownPromise;

		// After shutdownAll, the map should be empty.
		// Inject a fresh client and verify getActiveClients returns only that one.
		const { getActiveClients } = await import("../client");
		const mock2 = createMockClient("clangd");
		_injectClientForTest(mock2.key, mock2.client);

		const active = getActiveClients();
		expect(active).toHaveLength(1);
		expect(active[0].name).toBe("clangd");
	});

	it("completes even with zero clients", async () => {
		// Should not throw or hang
		await shutdownAll();
	});

	it("completes when proc.kill throws", async () => {
		const mock = createMockClient("stubborn-server");
		mock.killSpy.mockImplementation(() => {
			throw new Error("kill failed");
		});
		_injectClientForTest(mock.key, mock.client);

		const shutdownPromise = shutdownAll();
		await Bun.sleep(0);
		await Bun.sleep(0);
		mock.resolveShutdown(null);

		// Promise.allSettled means the thrown error doesn't propagate
		await shutdownPromise;

		expect(mock.killSpy).toHaveBeenCalledTimes(1);
	});

	it("writes the shutdown request to stdin before killing", async () => {
		const mock = createMockClient("clangd");
		_injectClientForTest(mock.key, mock.client);

		const shutdownPromise = shutdownAll();
		await Bun.sleep(0);
		await Bun.sleep(0);

		// Verify that sendRequest actually wrote to stdin (the FileSink shape)
		const stdin = mock.client.proc.stdin as unknown as { write: ReturnType<typeof vi.fn>; flush: ReturnType<typeof vi.fn> };
		expect(stdin.write).toHaveBeenCalled();
		expect(stdin.flush).toHaveBeenCalled();

		mock.resolveShutdown(null);
		await shutdownPromise;
	});
});
