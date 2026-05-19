import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { DapClient } from "../src/dap/client";
import * as dapConfig from "../src/dap/config";
import type { ToolSession } from "../src/tools";
import { DebugTool } from "../src/tools/debug";
import { ToolError } from "../src/tools/tool-errors";

const tempDirs: string[] = [];

function createToolSession(cwd: string): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		settings: {
			get: () => true,
		} as unknown as ToolSession["settings"],
	};
}

afterEach(async () => {
	for (const dir of tempDirs.splice(0)) {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

const nativeAdapter = {
	name: "lldb-dap",
	command: "lldb-dap",
	args: [],
	resolvedCommand: "lldb-dap",
	languages: ["cpp"],
	fileTypes: [".cpp"],
	rootMarkers: [],
	launchDefaults: { stopOnEntry: true },
	attachDefaults: {},
	connectMode: "stdio" as const,
};

describe("DebugTool launch validation", () => {
	it("rejects a program that resolves to a directory before adapter selection", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-debug-directory-program-"));
		tempDirs.push(cwd);
		await fs.mkdir(path.join(cwd, "python"));
		const selectLaunchAdapterSpy = spyOn(dapConfig, "selectLaunchAdapter").mockReturnValue(nativeAdapter);
		const spawnSpy = spyOn(DapClient, "spawn");
		const tool = new DebugTool(createToolSession(cwd));
		let caught: unknown;
		try {
			await tool.execute("tool-call", {
				action: "launch",
				program: "python",
				cwd: ".",
				timeout: 1,
			});
		} catch (error) {
			caught = error;
		} finally {
			spawnSpy.mockRestore();
			selectLaunchAdapterSpy.mockRestore();
		}

		expect(caught).toBeInstanceOf(ToolError);
		expect(caught).toBeInstanceOf(Error);
		expect((caught as Error).message).toContain("program resolved to a directory");
		expect((caught as Error).message).toContain('adapter="debugpy"');
		expect(spawnSpy).not.toHaveBeenCalled();
	});

	it("allows directory programs for Delve debug launches", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-debug-dlv-directory-program-"));
		tempDirs.push(cwd);
		await fs.writeFile(path.join(cwd, "go.mod"), "module example.com/repro\n");
		const selectLaunchAdapterSpy = spyOn(dapConfig, "selectLaunchAdapter").mockReturnValue({
			...nativeAdapter,
			name: "dlv",
			command: "dlv",
			args: ["dap"],
			resolvedCommand: "dlv",
			languages: ["go"],
			fileTypes: [".go"],
			rootMarkers: ["go.mod", "go.sum"],
			launchDefaults: { mode: "debug" },
			attachDefaults: { mode: "local" },
			connectMode: "socket",
		});
		const spawnSpy = spyOn(DapClient, "spawn").mockImplementation(() => {
			throw new ToolError("adapter selected");
		});

		const tool = new DebugTool(createToolSession(cwd));
		let caught: unknown;
		try {
			await tool.execute("tool-call", {
				action: "launch",
				adapter: "dlv",
				program: ".",
				cwd: ".",
				timeout: 1,
			});
		} catch (error) {
			caught = error;
		} finally {
			spawnSpy.mockRestore();
			selectLaunchAdapterSpy.mockRestore();
		}

		expect(caught).toBeInstanceOf(ToolError);
		expect((caught as Error).message).toBe("adapter selected");
	});
});
