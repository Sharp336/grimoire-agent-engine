/**
 * Integration test: `/move <dir>` must call `MCPManager.setCwd` so connected
 * servers learn about the new working directory.
 *
 * Contract under test (single observable wiring):
 *  - On a successful move, `mcpManager.setCwd` is called with the resolved
 *    absolute path.
 *  - When `ctx.mcpManager` is undefined, the handler does not crash.
 *  - When the target is invalid (not a directory), `setCwd` is NOT called.
 *  - When the agent is streaming, the move is rejected before `setCwd`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { CommandController } from "@oh-my-pi/pi-coding-agent/modes/controllers/command-controller";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import * as utils from "@oh-my-pi/pi-utils";

interface HarnessOptions {
	/** Whether `session.isStreaming` should report true (default: false). */
	streaming?: boolean;
	/** Whether `ctx.mcpManager` should be present (default: true). */
	withMcpManager?: boolean;
}

interface MoveTestHarness {
	tmpRoot: string;
	cwdA: string;
	cwdB: string;
	setCwdCalls: string[];
	moveToCalls: string[];
	errors: string[];
	warnings: string[];
	ctx: InteractiveModeContext;
}

/**
 * Build a minimal `InteractiveModeContext` stub for `handleMoveCommand`.
 *
 * `InteractiveModeContext` declares ~80 fields/methods; this test exercises
 * roughly a dozen. The single `as unknown as InteractiveModeContext` cast at
 * the bottom is the test-boundary acknowledgement: "this stub is intentionally
 * incomplete for the function under test." Spreads or per-test overrides are
 * avoided in favour of options on this factory so the cast appears exactly
 * once in the file.
 */
async function makeHarness(opts: HarnessOptions = {}): Promise<MoveTestHarness> {
	const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-move-cmd-"));
	const cwdA = path.join(tmpRoot, "cwd-a");
	const cwdB = path.join(tmpRoot, "cwd-b");
	await fsp.mkdir(cwdA, { recursive: true });
	await fsp.mkdir(cwdB, { recursive: true });

	const setCwdCalls: string[] = [];
	const moveToCalls: string[] = [];
	const errors: string[] = [];
	const warnings: string[] = [];

	const stub = {
		session: { isStreaming: opts.streaming ?? false },
		sessionManager: {
			getCwd: () => cwdA,
			flush: async () => undefined,
			moveTo: async (target: string) => {
				moveToCalls.push(target);
			},
		},
		mcpManager:
			opts.withMcpManager === false
				? undefined
				: {
						setCwd: (newCwd: string) => {
							setCwdCalls.push(newCwd);
						},
					},
		showError: (msg: string) => errors.push(msg),
		showWarning: (msg: string) => warnings.push(msg),
		showStatus: () => undefined,
		refreshSlashCommandState: async () => undefined,
		statusLine: { invalidate: () => undefined },
		updateEditorTopBorder: () => undefined,
		chatContainer: { addChild: () => undefined },
		ui: { requestRender: () => undefined },
	};

	return {
		tmpRoot,
		cwdA,
		cwdB,
		setCwdCalls,
		moveToCalls,
		errors,
		warnings,
		ctx: stub as unknown as InteractiveModeContext,
	};
}

describe("CommandController.handleMoveCommand → mcpManager.setCwd", () => {
	const trackedHarnesses: MoveTestHarness[] = [];

	async function setup(opts: HarnessOptions = {}): Promise<MoveTestHarness> {
		const harness = await makeHarness(opts);
		trackedHarnesses.push(harness);
		return harness;
	}

	beforeEach(async () => {
		// Theme module is module-global; initialize once so the success path that
		// renders "Session moved to ..." via theme.fg(...) does not throw.
		await initTheme();
		// Stub setProjectDir so it does not chdir the test process.
		vi.spyOn(utils, "setProjectDir").mockImplementation(() => undefined);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		for (const harness of trackedHarnesses.splice(0)) {
			await fsp.rm(harness.tmpRoot, { recursive: true, force: true });
		}
	});

	it("invokes mcpManager.setCwd with the resolved target path on success", async () => {
		const harness = await setup();
		const controller = new CommandController(harness.ctx);

		await controller.handleMoveCommand(harness.cwdB);

		expect(harness.errors).toEqual([]);
		expect(harness.moveToCalls).toEqual([harness.cwdB]);
		expect(harness.setCwdCalls).toEqual([harness.cwdB]);
	});

	it("does not crash when ctx.mcpManager is undefined", async () => {
		const harness = await setup({ withMcpManager: false });
		const controller = new CommandController(harness.ctx);

		await controller.handleMoveCommand(harness.cwdB);

		expect(harness.errors).toEqual([]);
		// moveTo still ran via the harness's sessionManager.
		expect(harness.moveToCalls).toEqual([harness.cwdB]);
		// No mcpManager → no recorded setCwd calls.
		expect(harness.setCwdCalls).toEqual([]);
	});

	it("does NOT call mcpManager.setCwd when the target path is invalid (not a directory)", async () => {
		const harness = await setup();
		const filePath = path.join(harness.tmpRoot, "not-a-dir.txt");
		fs.writeFileSync(filePath, "x");

		const controller = new CommandController(harness.ctx);
		await controller.handleMoveCommand(filePath);

		expect(harness.errors.length).toBe(1);
		expect(harness.moveToCalls).toEqual([]);
		expect(harness.setCwdCalls).toEqual([]);
	});

	it("does NOT call mcpManager.setCwd when the target path does not exist", async () => {
		const harness = await setup();
		const missing = path.join(harness.tmpRoot, "does-not-exist");

		const controller = new CommandController(harness.ctx);
		await controller.handleMoveCommand(missing);

		expect(harness.errors.length).toBe(1);
		expect(harness.moveToCalls).toEqual([]);
		expect(harness.setCwdCalls).toEqual([]);
	});

	it("does NOT call mcpManager.setCwd when the agent is currently streaming", async () => {
		const harness = await setup({ streaming: true });
		const controller = new CommandController(harness.ctx);

		await controller.handleMoveCommand(harness.cwdB);

		expect(harness.warnings.length).toBe(1);
		expect(harness.moveToCalls).toEqual([]);
		expect(harness.setCwdCalls).toEqual([]);
	});
});
