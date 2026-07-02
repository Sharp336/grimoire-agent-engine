import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import type { ClientBridge, ClientBridgeTerminalHandle } from "@oh-my-pi/pi-coding-agent/session/client-bridge";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { BashTool } from "@oh-my-pi/pi-coding-agent/tools/bash";

function makeSession(bridge: ClientBridge): ToolSession {
	return {
		cwd: "/tmp",
		hasUI: false,
		skills: [],
		getSessionFile: () => null,
		settings: {
			get(key: string) {
				if (key === "async.enabled") return false;
				if (key === "bash.autoBackground.enabled") return false;
				if (key === "bash.autoBackground.thresholdMs") return 60_000;
				if (key === "bashInterceptor.enabled") return false;
				if (key === "astGrep.enabled") return false;
				if (key === "astEdit.enabled") return false;
				if (key === "grep.enabled") return false;
				if (key === "glob.enabled") return false;
				return undefined;
			},
			getBashInterceptorRules() {
				return [];
			},
		},
		getClientBridge: () => bridge,
	} as unknown as ToolSession;
}

afterEach(() => {
	mock.restore();
});

describe("BashTool ACP terminal routing", () => {
	it("routes through bridge, emits terminalId update, and releases the handle", async () => {
		const stubText = "hello from terminal\n";

		const handle: ClientBridgeTerminalHandle = {
			terminalId: "term-xyz",
			waitForExit: async () => ({ exitCode: 0, signal: null }),
			currentOutput: async () => ({ output: stubText, truncated: false }),
			kill: async () => {},
			release: async () => {},
		};

		const bridge: ClientBridge = {
			capabilities: { terminal: true },
			createTerminal: async () => handle,
		};

		const createSpy = spyOn(bridge, "createTerminal");
		const releaseSpy = spyOn(handle, "release");

		const updates: Array<{ details?: { terminalId?: string } }> = [];

		const tool = new BashTool(makeSession(bridge));
		const result = await tool.execute("call-1", { command: "echo hi" }, undefined, update => {
			updates.push(update as { details?: { terminalId?: string } });
		});

		// createTerminal must be called with the expanded command
		expect(createSpy).toHaveBeenCalledTimes(1);
		const params = createSpy.mock.calls[0]![0];
		expect(params.command).toBe("echo hi");

		// The first onUpdate must carry the terminalId so the editor can embed it
		expect(updates.length).toBeGreaterThanOrEqual(1);
		expect(updates[0]!.details?.terminalId).toBe("term-xyz");

		// The final result text must contain the stub output
		const text = result.content.find(c => c.type === "text");
		expect(text?.text).toContain("hello from terminal");

		// The result details must carry terminalId for the ACP event mapper
		expect(result.details?.terminalId).toBe("term-xyz");

		// The handle must always be released
		expect(releaseSpy).toHaveBeenCalledTimes(1);
	});

	it("does not allocate a client terminal when the signal is already aborted before createTerminal", async () => {
		const handle: ClientBridgeTerminalHandle = {
			terminalId: "term-should-not-create",
			waitForExit: async () => ({ exitCode: 0, signal: null }),
			currentOutput: async () => ({ output: "should not be reached", truncated: false }),
			kill: async () => {},
			release: async () => {},
		};
		const bridge: ClientBridge = {
			capabilities: { terminal: true },
			createTerminal: async () => handle,
		};
		const createSpy = spyOn(bridge, "createTerminal");

		const controller = new AbortController();
		controller.abort();

		const tool = new BashTool(makeSession(bridge));

		await expect(tool.execute("call-pre-abort", { command: "echo hi" }, controller.signal)).rejects.toThrow(
			/Command aborted/,
		);

		expect(createSpy).toHaveBeenCalledTimes(0);
	});

	it("resolves using the last polled output when final output retrieval fails", async () => {
		const pendingExit = Promise.withResolvers<{ exitCode: number | null; signal: string | null }>();
		let currentOutputCalls = 0;
		const handle: ClientBridgeTerminalHandle = {
			terminalId: "term-output-failure",
			waitForExit: async () => pendingExit.promise,
			currentOutput: async () => {
				currentOutputCalls++;
				if (currentOutputCalls === 1) {
					// first poll loop iteration
					setTimeout(() => pendingExit.resolve({ exitCode: 0, signal: null }), 0);
					return { output: "polled text", truncated: false };
				}
				throw new Error("client output unavailable");
			},
			kill: async () => {},
			release: async () => {},
		};
		const bridge: ClientBridge = {
			capabilities: { terminal: true },
			createTerminal: async () => handle,
		};
		const releaseSpy = spyOn(handle, "release");

		const tool = new BashTool(makeSession(bridge));

		const result = await tool.execute("call-output-failure", { command: "echo hi" });

		const text = result.content.find(c => c.type === "text");
		expect(text?.text).toContain("polled text"); // proves fallback
		expect(result.isError).toBeUndefined();
		expect(releaseSpy).toHaveBeenCalledTimes(1);
	});

	it("releases the client terminal when waiting for exit fails", async () => {
		const handle: ClientBridgeTerminalHandle = {
			terminalId: "term-exit-failure",
			waitForExit: async () => {
				throw new Error("client wait unavailable");
			},
			currentOutput: async () => ({ output: "", truncated: false }),
			kill: async () => {},
			release: async () => {},
		};
		const bridge: ClientBridge = {
			capabilities: { terminal: true },
			createTerminal: async () => handle,
		};
		const releaseSpy = spyOn(handle, "release");

		const tool = new BashTool(makeSession(bridge));

		await expect(tool.execute("call-exit-failure", { command: "echo hi" })).rejects.toThrow(
			/client wait unavailable/,
		);
		expect(releaseSpy).toHaveBeenCalledTimes(1);
	});

	it("kills and releases the client terminal when the caller aborts", async () => {
		const pendingExit = Promise.withResolvers<{ exitCode: number | null; signal: string | null }>();
		const controller = new AbortController();

		const handle: ClientBridgeTerminalHandle = {
			terminalId: "term-abort",
			waitForExit: async () => pendingExit.promise,
			currentOutput: async () => {
				// Trigger abort during the poll loop, ensuring handle is assigned
				controller.abort();
				return { output: "partial", truncated: false };
			},
			kill: async () => {},
			release: async () => {},
		};
		const bridge: ClientBridge = {
			capabilities: { terminal: true },
			createTerminal: async () => handle,
		};
		const killSpy = spyOn(handle, "kill");
		const releaseSpy = spyOn(handle, "release");

		const tool = new BashTool(makeSession(bridge));

		const executePromise = tool.execute("call-abort", { command: "sleep 60" }, controller.signal);

		await expect(executePromise).rejects.toThrow(/Command aborted/);
		expect(killSpy).toHaveBeenCalledTimes(1);
		expect(releaseSpy).toHaveBeenCalledTimes(1);
	});

	it("kills and releases the client terminal when the command times out", async () => {
		const sleepSpy = spyOn(Bun, "sleep");
		let resolveTimeout!: () => void;
		const fakeTimeoutPromise = new Promise<void>(resolve => {
			resolveTimeout = resolve;
		});

		sleepSpy.mockImplementation(ms => {
			if (ms === 1000 && sleepSpy.mock.calls.length === 1) {
				return fakeTimeoutPromise;
			}
			return Promise.resolve();
		});

		const pendingExit = Promise.withResolvers<{ exitCode: number | null; signal: string | null }>();
		let killCalls = 0;
		let currentOutputAfterKill = 0;

		const handle: ClientBridgeTerminalHandle = {
			terminalId: "term-timeout",
			waitForExit: async () => pendingExit.promise,
			currentOutput: async () => {
				// Trigger the timeout during the first poll
				if (killCalls === 0) {
					resolveTimeout();
				} else {
					currentOutputAfterKill++;
				}
				return { output: "timeout output", truncated: false };
			},
			kill: async () => {
				killCalls++;
			},
			release: async () => {},
		};
		const bridge: ClientBridge = {
			capabilities: { terminal: true },
			createTerminal: async () => handle,
		};
		const killSpy = spyOn(handle, "kill");
		const releaseSpy = spyOn(handle, "release");

		const tool = new BashTool(makeSession(bridge));
		const executePromise = tool.execute("call-timeout", { command: "sleep 60", timeout: 1 });

		await expect(executePromise).rejects.toThrow(/Command timed out after 1 seconds/);

		expect(killSpy).toHaveBeenCalledTimes(1);
		expect(releaseSpy).toHaveBeenCalledTimes(1);
		expect(currentOutputAfterKill).toBeGreaterThan(0);
	});
});
