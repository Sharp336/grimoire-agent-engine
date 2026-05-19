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

function collectUnhandledRejections(): { errors: unknown[]; dispose(): void } {
	const errors: unknown[] = [];
	const handler = (error: unknown) => {
		errors.push(error);
	};
	process.on("unhandledRejection", handler);
	return {
		errors,
		dispose() {
			process.off("unhandledRejection", handler);
		},
	};
}

function rejectAfter(delayMs: number, message: string): Promise<never> {
	return Bun.sleep(delayMs).then(() => {
		throw new Error(message);
	});
}

describe("DapSessionManager failed launch cleanup", () => {
	it("does not leave the initial stop outcome race unhandled when configurationDone fails", async () => {
		const fakeClient = {
			adapter: fakeAdapter,
			cwd: process.cwd(),
			proc: {
				exited: Promise.resolve(0),
				exitCode: null,
			},
			initialize: async () => ({ supportsConfigurationDoneRequest: true }),
			sendRequest(command: string) {
				if (command === "launch") return new Promise(() => {});
				if (command === "configurationDone") throw new Error("DAP request configurationDone failed");
				return Promise.resolve({});
			},
			waitForEvent(event: string) {
				if (event === "initialized") return Promise.resolve({});
				return rejectAfter(5, `DAP event ${event} timed out after 5ms`);
			},
			onEvent: () => () => {},
			onReverseRequest: () => () => {},
			isAlive: () => true,
			dispose: async () => {},
		};
		const spawnSpy = spyOn(DapClient, "spawn").mockResolvedValue(fakeClient as unknown as DapClient);
		const unhandled = collectUnhandledRejections();
		try {
			const manager = new DapSessionManager();
			await expect(
				manager.launch(
					{
						adapter: fakeAdapter,
						program: "fake-program",
						cwd: process.cwd(),
					},
					undefined,
					25,
				),
			).rejects.toThrow("DAP request configurationDone failed");

			await Bun.sleep(25);

			expect(unhandled.errors).toEqual([]);
		} finally {
			unhandled.dispose();
			spawnSpy.mockRestore();
		}
	});
});
