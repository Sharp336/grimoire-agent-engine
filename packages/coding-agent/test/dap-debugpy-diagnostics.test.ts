import { describe, expect, it, spyOn } from "bun:test";
import { DapClient } from "../src/dap/client";
import { DapSessionManager } from "../src/dap/session";
import type { DapResolvedAdapter } from "../src/dap/types";

const debugpyAdapter: DapResolvedAdapter = {
	name: "debugpy",
	command: "python",
	args: ["-m", "debugpy.adapter"],
	resolvedCommand: "python",
	languages: ["python"],
	fileTypes: [".py"],
	rootMarkers: [],
	launchDefaults: {},
	attachDefaults: {},
	connectMode: "stdio",
};

describe("DapClient debugpy startup diagnostics", () => {
	it("adds an install hint when the debugpy adapter module is missing", async () => {
		const fakeClient = {
			adapter: debugpyAdapter,
			cwd: process.cwd(),
			proc: {
				exited: Promise.resolve(1),
				exitCode: 1,
				peekStderr: () =>
					"C:\\Python312\\python.exe: Error while finding module specification for 'debugpy.adapter' (ModuleNotFoundError: No module named 'debugpy')",
			},
			initialize: async () => {
				throw new Error(
					"DAP adapter exited (code 1): C:\\Python312\\python.exe: Error while finding module specification for 'debugpy.adapter' (ModuleNotFoundError: No module named 'debugpy')",
				);
			},
			onEvent: () => () => {},
			onReverseRequest: () => () => {},
			dispose: async () => {},
		};
		const spawnSpy = spyOn(DapClient, "spawn").mockResolvedValue(fakeClient as unknown as DapClient);
		try {
			const manager = new DapSessionManager();
			let caught: unknown;
			try {
				await manager.launch(
					{
						adapter: debugpyAdapter,
						program: "script.py",
						cwd: process.cwd(),
					},
					undefined,
					25,
				);
			} catch (error) {
				caught = error;
			}
			expect(caught).toBeInstanceOf(Error);
			const message = (caught as Error).message;
			expect(message).toContain("python -m pip install debugpy");
			expect(message.match(/python -m pip install debugpy/g)).toHaveLength(1);
		} finally {
			spawnSpy.mockRestore();
		}
	});
});
