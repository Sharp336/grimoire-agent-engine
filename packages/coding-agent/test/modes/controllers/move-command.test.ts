import { beforeAll, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { CommandController } from "@oh-my-pi/pi-coding-agent/modes/controllers/command-controller";
import { getThemeByName, setThemeInstance } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";

function createMoveContext(sourceDir: string, settingsFlush?: () => Promise<void>) {
	const state = { cwd: sourceDir, movedTo: undefined as string | undefined };
	const present = vi.fn();
	const disposeSideConversation = vi.fn(async () => {});
	const applyCwdChange = vi.fn(async (cwd: string) => {
		expect(state.cwd).toBe(cwd);
	});
	const moveSession = vi.fn(async (cwd: string) => {
		state.cwd = cwd;
		state.movedTo = cwd;
	});

	const ctx = {
		session: { isStreaming: false, moveSession },
		sessionManager: {
			getCwd: () => state.cwd,
			dropSession: vi.fn(async () => {}),
		},
		settings: {
			flush: vi.fn(settingsFlush ?? (async () => {})),
		},
		disposeSideConversation,
		showHookCustom: vi.fn(),
		showHookConfirm: vi.fn(),
		showError: vi.fn(),
		showWarning: vi.fn(),
		applyCwdChange,
		updateEditorBorderColor: vi.fn(),
		reloadTodos: vi.fn(async () => {}),
		ui: { requestRender: vi.fn() },
		present,
	} as unknown as InteractiveModeContext;
	return { ctx, state, present, disposeSideConversation, moveSession };
}

describe("CommandController /move", () => {
	beforeAll(async () => {
		const theme = await getThemeByName("dark");
		if (!theme) throw new Error("Expected dark theme");
		setThemeInstance(theme);
	});

	it("relocates the active session before re-scoping cwd-derived state", async () => {
		const sourceDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-move-source-"));
		const targetDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-move-target-"));
		try {
			const { ctx, state, present, disposeSideConversation, moveSession } = createMoveContext(sourceDir);
			const controller = new CommandController(ctx);

			await controller.handleMoveCommand(targetDir);

			expect(state.movedTo).toBe(targetDir);
			expect(disposeSideConversation).toHaveBeenCalledTimes(1);
			expect(disposeSideConversation.mock.invocationCallOrder[0]).toBeLessThan(
				moveSession.mock.invocationCallOrder[0],
			);
			expect(ctx.sessionManager.dropSession).not.toHaveBeenCalled();
			expect(ctx.applyCwdChange).toHaveBeenCalledWith(targetDir);
			expect(ctx.updateEditorBorderColor).toHaveBeenCalled();
			expect(ctx.reloadTodos).toHaveBeenCalled();
			expect(ctx.ui.requestRender).toHaveBeenCalledWith();
			expect(present).toHaveBeenCalled();
			expect(ctx.showError).not.toHaveBeenCalled();
		} finally {
			await fs.rm(sourceDir, { recursive: true, force: true });
			await fs.rm(targetDir, { recursive: true, force: true });
		}
	});

	it("aborts /move when pending settings flush fails, leaving cwd untouched", async () => {
		const sourceDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-move-source-"));
		const targetDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-move-target-"));
		try {
			const { ctx, state, disposeSideConversation, moveSession } = createMoveContext(sourceDir, async () => {
				throw new Error("disk full");
			});
			const controller = new CommandController(ctx);

			await controller.handleMoveCommand(targetDir);

			expect(ctx.showError).toHaveBeenCalledWith(expect.stringContaining("disk full"));
			expect(disposeSideConversation).not.toHaveBeenCalled();
			expect(moveSession).not.toHaveBeenCalled();
			expect(ctx.applyCwdChange).not.toHaveBeenCalled();
			expect(state.movedTo).toBeUndefined();
			expect(state.cwd).toBe(sourceDir);
		} finally {
			await fs.rm(sourceDir, { recursive: true, force: true });
			await fs.rm(targetDir, { recursive: true, force: true });
		}
	});
});

function createSwitchContext(sourceDir: string, newSession: (options?: unknown) => Promise<boolean>) {
	const base = createMoveContext(sourceDir);
	const session = {
		isStreaming: false,
		isCompacting: false,
		moveSession: base.moveSession,
		newSession,
	};
	const sessionManager = {
		getCwd: () => sourceDir,
		getSessionName: () => undefined,
		getSessionFile: () => path.join(sourceDir, "session.jsonl"),
		dropSession: vi.fn(async () => {}),
	};
	const statusLine = { invalidate: vi.fn(), resetActiveTime: vi.fn() };
	// Object.assign keeps the existing harness context type while overriding the
	// members the new-session flow touches (no re-cast needed).
	Object.assign(base.ctx, {
		session,
		sessionManager,
		statusLine,
		clearTransientSessionUi: vi.fn(),
		resetObserverRegistry: vi.fn(),
		resetTranscript: vi.fn(),
	});
	return { ...base, newSession };
}

describe("CommandController /clear and /drop side disposal", () => {
	beforeAll(async () => {
		const theme = await getThemeByName("dark");
		if (!theme) throw new Error("Expected dark theme");
		setThemeInstance(theme);
	});

	it("does not dispose the side when the session switch is cancelled", async () => {
		const sourceDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-switch-source-"));
		try {
			const newSession = vi.fn(async () => false);
			const { ctx, disposeSideConversation } = createSwitchContext(sourceDir, newSession);
			const controller = new CommandController(ctx);

			await controller.handleClearCommand();

			expect(newSession).toHaveBeenCalledTimes(1);
			expect(disposeSideConversation).not.toHaveBeenCalled();
		} finally {
			await fs.rm(sourceDir, { recursive: true, force: true });
		}
	});

	it("disposes the side only after a successful session switch", async () => {
		const sourceDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-switch-source-"));
		try {
			const entered = Promise.withResolvers<void>();
			const gate = Promise.withResolvers<boolean>();
			const newSession = vi.fn(() => {
				entered.resolve();
				return gate.promise;
			});
			const { ctx, disposeSideConversation } = createSwitchContext(sourceDir, newSession);
			const controller = new CommandController(ctx);

			const drop = controller.handleDropCommand();
			await entered.promise;
			expect(newSession).toHaveBeenCalledTimes(1);
			// Not disposed while the switch outcome is pending.
			expect(disposeSideConversation).not.toHaveBeenCalled();

			gate.resolve(true);
			await drop;

			expect(disposeSideConversation).toHaveBeenCalledTimes(1);
		} finally {
			await fs.rm(sourceDir, { recursive: true, force: true });
		}
	});
});
