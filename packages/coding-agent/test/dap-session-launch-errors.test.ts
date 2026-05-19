import { describe, expect, it, spyOn } from "bun:test";
import { DapClient } from "../src/dap/client";
import { DapSessionManager } from "../src/dap/session";
import type { DapResolvedAdapter } from "../src/dap/types";

const fakeAdapter: DapResolvedAdapter = {
	name: "fake-dap",
	command: "fake-dap",
	args: [],
	resolvedCommand: "fake-dap",
	languages: [],
	fileTypes: [],
	rootMarkers: [],
	launchDefaults: {},
	attachDefaults: {},
	connectMode: "stdio",
};

describe("DapSessionManager launch error reporting", () => {
	it("reports the launch failure when configurationDone fails before the launch response is awaited", async () => {
		const fakeClient = {
			adapter: fakeAdapter,
			cwd: process.cwd(),
			proc: {
				exited: Promise.resolve(0),
				exitCode: null,
			},
			initialize: async () => ({ supportsConfigurationDoneRequest: true }),
			sendRequest(command: string) {
				if (command === "launch") {
					return Bun.sleep(1).then(() => {
						throw new Error("'C:\\repo\\python' is not a valid executable");
					});
				}
				if (command === "configurationDone") throw new Error("DAP request configurationDone failed");
				return Promise.resolve({});
			},
			waitForEvent(event: string) {
				if (event === "initialized") return Promise.resolve({});
				return new Promise(() => {});
			},
			onEvent: () => () => {},
			onReverseRequest: () => () => {},
			isAlive: () => true,
			dispose: async () => {},
		};
		const spawnSpy = spyOn(DapClient, "spawn").mockResolvedValue(fakeClient as unknown as DapClient);
		try {
			const manager = new DapSessionManager();
			await expect(
				manager.launch(
					{
						adapter: fakeAdapter,
						program: "C:\\repo\\python",
						cwd: process.cwd(),
					},
					undefined,
					25,
				),
			).rejects.toThrow("not a valid executable");
		} finally {
			spawnSpy.mockRestore();
		}
	});
});
