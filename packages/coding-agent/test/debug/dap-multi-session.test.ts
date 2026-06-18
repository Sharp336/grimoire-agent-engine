import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as path from "node:path";
import { DapClient } from "@oh-my-pi/pi-coding-agent/dap/client";
import { DapSessionManager } from "@oh-my-pi/pi-coding-agent/dap/session";
import type {
	DapCapabilities,
	DapClientState,
	DapEventMessage,
	DapResolvedAdapter,
	DapSourceBreakpoint,
} from "@oh-my-pi/pi-coding-agent/dap/types";

const TEST_ADAPTER: DapResolvedAdapter = {
	name: "js-debug-adapter",
	command: "js-debug-adapter",
	args: [],
	resolvedCommand: "js-debug-adapter",
	languages: [],
	fileTypes: [],
	rootMarkers: [],
	launchDefaults: {},
	attachDefaults: {},
	connectMode: "tcp",
	acceptsDirectoryProgram: false,
};

type DapEventHandler = (body: unknown, event: DapEventMessage) => void | Promise<void>;
type DapReverseRequestHandler = (args: unknown) => unknown | Promise<unknown>;

interface SentDapRequest {
	command: string;
	args?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function getSourceBreakpoints(args: unknown): DapSourceBreakpoint[] {
	if (!isRecord(args) || !Array.isArray(args.breakpoints)) {
		return [];
	}
	return args.breakpoints.filter((breakpoint): breakpoint is DapSourceBreakpoint => {
		return isRecord(breakpoint) && typeof breakpoint.line === "number";
	});
}

class FakeDapClient {
	readonly proc: DapClientState["proc"];
	readonly #exited = Promise.withResolvers<void>();
	readonly #handlers = new Map<string, Set<DapEventHandler>>();
	readonly #reverseHandlers = new Map<string, DapReverseRequestHandler>();
	#alive = true;
	readonly stalledCommands = new Set<string>();
	readonly sentRequests: SentDapRequest[] = [];

	constructor(
		readonly adapter: DapResolvedAdapter,
		readonly cwd: string,
	) {
		this.proc = {
			exited: this.#exited.promise,
			exitCode: null,
			stdin: { write: () => 0, flush: () => undefined },
			stdout: new ReadableStream<Uint8Array>(),
			stderr: new ReadableStream<Uint8Array>(),
			peekStderr: () => "",
			kill: () => {
				this.#alive = false;
				this.#exited.resolve();
				return true;
			},
		} as unknown as DapClientState["proc"];
	}

	async initialize(): Promise<DapCapabilities> {
		void Bun.sleep(10).then(() => {
			this.#emit("initialized", {});
			this.#emit("stopped", { reason: "entry", threadId: 1 });
		});
		return { supportsConfigurationDoneRequest: true };
	}

	async sendRequest<TBody = unknown>(command: string, args?: unknown, signal?: AbortSignal): Promise<TBody> {
		this.sentRequests.push({ command, args });
		if (this.stalledCommands.has(command)) {
			const { promise, reject } = Promise.withResolvers<TBody>();
			const abort = () => reject(new Error("aborted"));
			if (signal?.aborted) {
				abort();
			} else {
				signal?.addEventListener("abort", abort, { once: true });
			}
			return await promise;
		}
		if (command === "setBreakpoints") {
			return {
				breakpoints: getSourceBreakpoints(args).map(breakpoint => ({
					verified: true,
					line: breakpoint.line,
				})),
			} as TBody;
		}
		if (command === "stackTrace") {
			return {
				stackFrames: [
					{
						id: 1,
						name: "main",
						line: 1,
						column: 1,
					},
				],
			} as TBody;
		}
		return {} as TBody;
	}

	waitForEvent(event: string): Promise<unknown> {
		const { promise, resolve } = Promise.withResolvers<unknown>();
		const unsubscribe = this.onEvent(event, body => {
			unsubscribe();
			resolve(body);
		});
		return promise;
	}

	onEvent(event: string, handler: DapEventHandler): () => void {
		let handlers = this.#handlers.get(event);
		if (!handlers) {
			handlers = new Set<DapEventHandler>();
			this.#handlers.set(event, handlers);
		}
		handlers.add(handler);
		return () => handlers?.delete(handler);
	}

	onReverseRequest(command: string, handler: DapReverseRequestHandler): () => void {
		this.#reverseHandlers.set(command, handler);
		return () => this.#reverseHandlers.delete(command);
	}

	async triggerReverseRequest(command: string, args: unknown): Promise<unknown> {
		const handler = this.#reverseHandlers.get(command);
		if (handler) {
			return await handler(args);
		}
		throw new Error(`No handler registered for reverse request: ${command}`);
	}

	emitEvent(event: string, body: unknown): void {
		this.#emit(event, body);
	}

	isAlive(): boolean {
		return this.#alive;
	}

	async dispose(): Promise<void> {
		this.#alive = false;
		this.#exited.resolve();
	}

	#emit(event: string, body: unknown): void {
		const message: DapEventMessage = { seq: 1, type: "event", event, body };
		for (const handler of this.#handlers.get(event) ?? []) {
			void handler(body, message);
		}
	}
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("DAP multi-session debugging", () => {
	it("spawns a child session when startDebugging is triggered", async () => {
		const manager = new DapSessionManager();

		const parentClient = new FakeDapClient(TEST_ADAPTER, process.cwd());
		const childClient = new FakeDapClient(TEST_ADAPTER, process.cwd());

		const parentClientWrapper = parentClient as unknown as DapClient;
		parentClientWrapper.port = 9999;

		const spawnSpy = spyOn(DapClient, "spawn").mockImplementation(async () => {
			return parentClientWrapper;
		});

		const connectSpy = spyOn(DapClient, "connect").mockImplementation(async () => {
			return childClient as unknown as DapClient;
		});

		const bpFile = path.resolve(process.cwd(), "src/main.ts");
		const bpResponse = await manager.setBreakpoint(bpFile, 42);
		expect(bpResponse.snapshot).toBeUndefined();
		expect(bpResponse.breakpoints.length).toBe(1);

		const parentSummary = await manager.launch({
			adapter: TEST_ADAPTER,
			program: "test.js",
			cwd: process.cwd(),
		});

		expect(parentSummary.id).toBe("debug-1");
		expect(manager.listSessions().length).toBe(1);

		expect(parentClient.sentRequests).toContainEqual(
			expect.objectContaining({
				command: "setBreakpoints",
			}),
		);

		const startDebuggingPromise = parentClient.triggerReverseRequest("startDebugging", {
			request: "attach",
			configuration: {
				type: "pwa-node",
				name: "child-worker",
				port: 9999,
				cwd: process.cwd(),
			},
		});

		await startDebuggingPromise;

		const sessions = manager.listSessions();
		expect(sessions.length).toBe(2);
		expect(sessions.map(s => s.id)).toContain("debug-2");

		const rootSummary = sessions.find(s => s.id === "debug-1");
		expect(rootSummary?.childSessionIds).toEqual(["debug-2"]);

		const childSummary = sessions.find(s => s.id === "debug-2");
		expect(childSummary?.parentSessionId).toBe("debug-1");

		expect(childClient.sentRequests).toContainEqual(
			expect.objectContaining({
				command: "setBreakpoints",
				args: expect.objectContaining({
					source: expect.objectContaining({ path: bpFile }),
					breakpoints: expect.arrayContaining([expect.objectContaining({ line: 42 })]),
				}),
			}),
		);

		expect(childClient.sentRequests).toContainEqual(
			expect.objectContaining({
				command: "configurationDone",
			}),
		);

		await manager.removeBreakpoint(bpFile, 42);

		expect(parentClient.sentRequests).toContainEqual(
			expect.objectContaining({
				command: "setBreakpoints",
				args: expect.objectContaining({
					source: expect.objectContaining({ path: bpFile }),
					breakpoints: [],
				}),
			}),
		);

		expect(childClient.sentRequests).toContainEqual(
			expect.objectContaining({
				command: "setBreakpoints",
				args: expect.objectContaining({
					source: expect.objectContaining({ path: bpFile }),
					breakpoints: [],
				}),
			}),
		);

		expect(spawnSpy).toHaveBeenCalledTimes(1);
		expect(connectSpy).toHaveBeenCalledTimes(1);

		await manager.terminate();

		expect(manager.listSessions().length).toBe(0);
		expect(parentClient.isAlive()).toBe(false);
		expect(childClient.isAlive()).toBe(false);
	});

	it("waits for a stopped child when continuing a threadless js-debug root", async () => {
		const manager = new DapSessionManager();

		const parentClient = new FakeDapClient(TEST_ADAPTER, process.cwd());
		const childClient = new FakeDapClient(TEST_ADAPTER, process.cwd());
		const parentClientWrapper = parentClient as unknown as DapClient;
		parentClientWrapper.port = 9999;

		spyOn(DapClient, "spawn").mockImplementation(async () => parentClientWrapper);
		spyOn(DapClient, "connect").mockImplementation(async () => childClient as unknown as DapClient);

		await manager.launch({
			adapter: TEST_ADAPTER,
			program: "test.js",
			cwd: process.cwd(),
		});

		const continuePromise = manager.continue(undefined, 1_000);
		await Promise.resolve();

		await parentClient.triggerReverseRequest("startDebugging", {
			request: "attach",
			configuration: {
				type: "pwa-node",
				name: "child-worker",
				__pendingTargetId: "target-1",
			},
		});

		const outcome = await continuePromise;

		expect(outcome.timedOut).toBe(false);
		expect(outcome.state).toBe("stopped");
		expect(outcome.snapshot.id).toBe("debug-2");
		expect(outcome.snapshot.stopReason).toBe("entry");
		expect(parentClient.sentRequests).not.toContainEqual(
			expect.objectContaining({
				command: "continue",
			}),
		);
		expect(childClient.sentRequests).toContainEqual(
			expect.objectContaining({
				command: "stackTrace",
			}),
		);
	});

	it("disposes the session tree when termination requests time out", async () => {
		const manager = new DapSessionManager();

		const parentClient = new FakeDapClient(TEST_ADAPTER, process.cwd());
		const childClient = new FakeDapClient(TEST_ADAPTER, process.cwd());
		const parentClientWrapper = parentClient as unknown as DapClient;
		parentClientWrapper.port = 9999;

		spyOn(DapClient, "spawn").mockImplementation(async () => parentClientWrapper);
		spyOn(DapClient, "connect").mockImplementation(async () => childClient as unknown as DapClient);

		await manager.launch({
			adapter: TEST_ADAPTER,
			program: "test.js",
			cwd: process.cwd(),
		});

		await parentClient.triggerReverseRequest("startDebugging", {
			request: "attach",
			configuration: {
				type: "pwa-node",
				name: "child-worker",
			},
		});

		parentClient.stalledCommands.add("disconnect");
		childClient.stalledCommands.add("disconnect");

		await manager.terminate(AbortSignal.timeout(5), 30_000);

		expect(manager.listSessions().length).toBe(0);
		expect(parentClient.isAlive()).toBe(false);
		expect(childClient.isAlive()).toBe(false);
	});

	it("removes all live instruction breakpoints for a reference when offset is omitted", async () => {
		const manager = new DapSessionManager();

		const parentClient = new FakeDapClient(TEST_ADAPTER, process.cwd());

		spyOn(DapClient, "spawn").mockImplementation(async () => parentClient as unknown as DapClient);

		await manager.launch({
			adapter: TEST_ADAPTER,
			program: "test.js",
			cwd: process.cwd(),
		});

		await manager.setInstructionBreakpoint("instruction-1", 4);
		await manager.setInstructionBreakpoint("instruction-1", 8);

		const removeResult = await manager.removeInstructionBreakpoint("instruction-1");

		expect(removeResult.breakpoints).toEqual([]);
		expect(
			parentClient.sentRequests.filter(request => request.command === "setInstructionBreakpoints").at(-1),
		).toEqual({
			command: "setInstructionBreakpoints",
			args: { breakpoints: [] },
		});

		await manager.terminate();
	});

	it("refreshes the root session timestamp when the active child is used", async () => {
		const manager = new DapSessionManager();

		const parentClient = new FakeDapClient(TEST_ADAPTER, process.cwd());
		const childClient = new FakeDapClient(TEST_ADAPTER, process.cwd());
		const parentClientWrapper = parentClient as unknown as DapClient;
		parentClientWrapper.port = 9999;

		spyOn(DapClient, "spawn").mockImplementation(async () => parentClientWrapper);
		spyOn(DapClient, "connect").mockImplementation(async () => childClient as unknown as DapClient);

		await manager.launch({
			adapter: TEST_ADAPTER,
			program: "test.js",
			cwd: process.cwd(),
		});

		await parentClient.triggerReverseRequest("startDebugging", {
			request: "attach",
			configuration: {
				type: "pwa-node",
				name: "child-worker",
			},
		});

		const rootBefore = manager.listSessions().find(session => session.id === "debug-1")?.lastUsedAt;
		if (rootBefore === undefined) {
			throw new Error("Expected root debug session to exist");
		}

		await Bun.sleep(20);
		manager.getOutput();

		const rootAfter = manager.listSessions().find(session => session.id === "debug-1")?.lastUsedAt;
		if (rootAfter === undefined) {
			throw new Error("Expected root debug session to exist");
		}
		expect(Date.parse(rootAfter)).toBeGreaterThan(Date.parse(rootBefore));

		await manager.terminate();
	});

	it("skips closed child sessions during global breakpoint sync", async () => {
		const manager = new DapSessionManager();

		const parentClient = new FakeDapClient(TEST_ADAPTER, process.cwd());
		const childClient = new FakeDapClient(TEST_ADAPTER, process.cwd());
		const parentClientWrapper = parentClient as unknown as DapClient;
		parentClientWrapper.port = 9999;

		spyOn(DapClient, "spawn").mockImplementation(async () => parentClientWrapper);
		spyOn(DapClient, "connect").mockImplementation(async () => childClient as unknown as DapClient);

		await manager.launch({
			adapter: TEST_ADAPTER,
			program: "test.js",
			cwd: process.cwd(),
		});

		await parentClient.triggerReverseRequest("startDebugging", {
			request: "attach",
			configuration: {
				type: "pwa-node",
				name: "child-worker",
			},
		});

		const childRequestCount = childClient.sentRequests.length;
		const parentRequestCount = parentClient.sentRequests.length;

		await childClient.dispose();

		await manager.setBreakpoint(path.resolve(process.cwd(), "src/worker.ts"), 12);
		await manager.setFunctionBreakpoint("workerMain");
		await manager.setInstructionBreakpoint("instruction-1", 4);
		await manager.setDataBreakpoint("data-1");

		expect(childClient.sentRequests.length).toBe(childRequestCount);
		expect(manager.listSessions().map(session => session.id)).toEqual(["debug-1"]);
		expect(parentClient.sentRequests.slice(parentRequestCount).map(request => request.command)).toEqual([
			"setBreakpoints",
			"setFunctionBreakpoints",
			"setInstructionBreakpoints",
			"setDataBreakpoints",
		]);

		await manager.terminate();
	});

	it("blocks new top-level launches when the active child has terminated but its root is alive", async () => {
		const manager = new DapSessionManager();

		const parentClient = new FakeDapClient(TEST_ADAPTER, process.cwd());
		const childClient = new FakeDapClient(TEST_ADAPTER, process.cwd());
		const parentClientWrapper = parentClient as unknown as DapClient;
		parentClientWrapper.port = 9999;

		const spawnSpy = spyOn(DapClient, "spawn").mockImplementation(async () => parentClientWrapper);
		spyOn(DapClient, "connect").mockImplementation(async () => childClient as unknown as DapClient);

		await manager.launch({
			adapter: TEST_ADAPTER,
			program: "test.js",
			cwd: process.cwd(),
		});

		await parentClient.triggerReverseRequest("startDebugging", {
			request: "attach",
			configuration: {
				type: "pwa-node",
				name: "child-worker",
			},
		});

		childClient.emitEvent("terminated", {});

		await expect(
			manager.launch({
				adapter: TEST_ADAPTER,
				program: "other.js",
				cwd: process.cwd(),
			}),
		).rejects.toThrow("Debug session debug-1 is still active. Terminate it before launching another.");

		expect(spawnSpy).toHaveBeenCalledTimes(1);

		await manager.terminate();
		expect(manager.listSessions().length).toBe(0);
	});
});
