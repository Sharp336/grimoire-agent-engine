import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { getBundledModel } from "@oh-my-pi/pi-ai";
import type { PythonKernel as PythonKernelInstance } from "@oh-my-pi/pi-coding-agent/ipy/kernel";
import { Snowflake } from "@oh-my-pi/pi-utils";

const require = createRequire(import.meta.url);
const nativeBindings = require("../../natives/native/index.js") as Record<string, unknown> & {
	ChunkState?: { parse: (source: string, language?: string) => unknown };
	formatAnchor?: (name: string, checksum?: string, style?: string) => string;
	getDefaultTabWidth?: () => number;
	getIndentation?: (file?: string | null, projectDir?: string | null) => number;
	setDefaultTabWidth?: (width: number) => void;
	MacOSPowerAssertion?: { start: (options: { reason: string }) => { stop: () => void } };
};

vi.mock("@oh-my-pi/pi-natives", () => ({
	...nativeBindings,
	ChunkState: nativeBindings.ChunkState ?? {
		parse() {
			throw new Error("ChunkState.parse unavailable in test");
		},
	},
	formatAnchor:
		nativeBindings.formatAnchor ?? ((name: string, checksum?: string) => (checksum ? `${name}#${checksum}` : name)),
	getDefaultTabWidth: nativeBindings.getDefaultTabWidth ?? (() => 4),
	getIndentation: nativeBindings.getIndentation ?? (() => 4),
	setDefaultTabWidth: nativeBindings.setDefaultTabWidth ?? (() => {}),
	MacOSPowerAssertion: nativeBindings.MacOSPowerAssertion ?? { start: () => ({ stop: () => {} }) },
}));

const { Settings } = require("../src/config/settings") as typeof import("../src/config/settings");
const { disposeAllKernelSessions } = require("../src/ipy/executor") as typeof import("../src/ipy/executor");
const pythonKernel = require("../src/ipy/kernel") as typeof import("../src/ipy/kernel");

class FakeKernel {
	executeCalls: string[] = [];
	shutdownCalls = 0;
	alive = true;

	isAlive(): boolean {
		return this.alive;
	}

	async execute(code: string): Promise<{ status: "ok"; cancelled: false; timedOut: false; stdinRequested: false }> {
		this.executeCalls.push(code);
		return { status: "ok", cancelled: false, timedOut: false, stdinRequested: false };
	}

	async ping(): Promise<boolean> {
		return this.alive;
	}

	async shutdown(): Promise<void> {
		this.shutdownCalls += 1;
		this.alive = false;
	}
}

async function loadSessionModules(): Promise<{
	AgentSession: typeof import("../src/session/agent-session").AgentSession;
	SessionManager: typeof import("../src/session/session-manager").SessionManager;
}> {
	const [{ AgentSession }, { SessionManager }] = await Promise.all([
		import("../src/session/agent-session"),
		import("../src/session/session-manager"),
	]);
	return { AgentSession, SessionManager };
}

describe("AgentSession python cleanup", () => {
	const tempDirs: string[] = [];

	afterEach(async () => {
		vi.restoreAllMocks();
		await disposeAllKernelSessions();
		for (const tempDir of tempDirs.splice(0)) {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("does not tear down another session's retained kernel during dispose", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled model");

		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-agent-session-python-cleanup-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwd = path.join(tempDir, "project");
		fs.mkdirSync(cwd, { recursive: true });

		const kernel = new FakeKernel();
		vi.spyOn(pythonKernel, "checkPythonKernelAvailability").mockResolvedValue({ ok: true });
		const startSpy = vi
			.spyOn(pythonKernel.PythonKernel, "start")
			.mockResolvedValue(kernel as unknown as PythonKernelInstance);

		const { AgentSession, SessionManager } = await loadSessionModules();

		const createSession = () =>
			new AgentSession({
				agent: new Agent({
					getApiKey: () => "test-key",
					initialState: {
						model,
						systemPrompt: "test",
						tools: [],
					},
				}),
				modelRegistry: {} as never,
				sessionManager: SessionManager.inMemory(cwd),
				settings: Settings.isolated(),
			});

		const firstSession = createSession();
		const secondSession = createSession();
		let firstDisposed = false;

		try {
			await firstSession.executePython("print('first')");
			await secondSession.executePython("print('second')");

			expect(startSpy).toHaveBeenCalledTimes(1);
			expect(kernel.executeCalls).toEqual(["print('first')", "print('second')"]);

			await firstSession.dispose();
			firstDisposed = true;
			expect(kernel.shutdownCalls).toBe(0);

			await secondSession.executePython("print('third')");

			expect(startSpy).toHaveBeenCalledTimes(1);
			expect(kernel.executeCalls).toEqual(["print('first')", "print('second')", "print('third')"]);
		} finally {
			if (!firstDisposed) {
				await firstSession.dispose();
			}
			await secondSession.dispose();
		}

		expect(kernel.shutdownCalls).toBe(1);
	});
});
