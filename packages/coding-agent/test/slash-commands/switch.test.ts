import { beforeAll, describe, expect, it, type Mock, vi } from "bun:test";
import type { CompactionOutcome } from "@oh-my-pi/pi-agent-core/compaction";
import { Effort, type Model } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { SelectorController } from "@oh-my-pi/pi-coding-agent/modes/controllers/selector-controller";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import type { ConfiguredThinkingLevel } from "@oh-my-pi/pi-coding-agent/thinking";

beforeAll(async () => {
	await initTheme();
});

function createRuntime() {
	const showModelSelector = vi.fn();
	const setText = vi.fn();
	return {
		showModelSelector,
		setText,
		runtime: {
			ctx: {
				editor: { setText } as unknown as InteractiveModeContext["editor"],
				showModelSelector,
			} as unknown as InteractiveModeContext,
		},
	};
}
interface InputComponent {
	handleInput(data: string): void;
}

function modelOrThrow(id: string): Model {
	const model = getBundledModel("anthropic", id);
	if (!model) throw new Error(`Expected bundled model anthropic/${id}`);
	return model;
}

function createSessionSwitchHarness(model: Model, fallback: ConfiguredThinkingLevel | undefined, contextTokens = 0) {
	const applicationStarted = Promise.withResolvers<void>();
	const releaseApplication = Promise.withResolvers<void>();
	const focusRestored = Promise.withResolvers<void>();
	const errorShown = Promise.withResolvers<void>();
	const showError = vi.fn((_message: string) => errorShown.resolve());
	const editor = {};
	const activeDialog = { handleInput: vi.fn() };
	const overlays: Array<{ component: InputComponent; hide: Mock<() => void> }> = [];
	let focused: InputComponent | undefined;
	const setModelTemporary = vi.fn(async (_model: Model, _thinkingLevel?: ConfiguredThinkingLevel) => {
		applicationStarted.resolve();
		await releaseApplication.promise;
	});
	const handleCompactCommand = vi.fn(
		async (
			_instructions?: string,
			_mode?: unknown,
			_beforeFlush?: (outcome: CompactionOutcome) => void | Promise<void>,
		): Promise<CompactionOutcome> => "ok",
	);
	const ctx = {
		editor,
		editorContainer: { children: [activeDialog] },
		settings: Settings.isolated({}),
		keybindings: { getKeys: () => [] },
		session: {
			model,
			scopedModels: [{ model }],
			modelRegistry: {},
			getContextUsage: () => ({ tokens: contextTokens }),
			getRoleModelCycle: () => undefined,
			resolveTemporaryModelThinkingLevel: () => fallback,
			setModelTemporary,
		},
		statusLine: { invalidate: vi.fn() },
		updateEditorBorderColor: vi.fn(),
		showStatus: vi.fn(),
		showError,
		handleCompactCommand,
		ui: {
			terminal: { rows: 40 },
			showOverlay: vi.fn((component: InputComponent) => {
				const overlay = { component, hide: vi.fn() };
				overlays.push(overlay);
				return { hide: overlay.hide, setHidden: vi.fn(), isHidden: () => false };
			}),
			setFocus: vi.fn((component: InputComponent) => {
				focused = component;
				if (component === activeDialog) focusRestored.resolve();
			}),
			requestRender: vi.fn(),
		},
	} as unknown as InteractiveModeContext;
	return {
		activeDialog,
		applicationStarted: applicationStarted.promise,
		controller: new SelectorController(ctx),
		errorShown: errorShown.promise,
		failApplication: (error: Error) => releaseApplication.reject(error),
		focusRestored: focusRestored.promise,
		focused: () => focused,
		handleCompactCommand,
		overlays,
		releaseApplication: () => releaseApplication.resolve(),
		setModelTemporary,
		showError,
	};
}

describe("/model slash command", () => {
	it("opens the model setup picker for role and thinking assignment", async () => {
		const harness = createRuntime();

		const handled = await executeBuiltinSlashCommand("/model", harness.runtime);

		expect(handled).toBe(true);
		expect(harness.showModelSelector.mock.calls).toEqual([[]]);
		expect(harness.setText).toHaveBeenCalledWith("");
	});
});

describe("/switch slash command", () => {
	it("opens the temporary model selector (mirrors alt+p)", async () => {
		const harness = createRuntime();

		const handled = await executeBuiltinSlashCommand("/switch", harness.runtime);

		expect(handled).toBe(true);
		expect(harness.showModelSelector).toHaveBeenCalledWith({ temporaryOnly: true });
		expect(harness.setText).toHaveBeenCalledWith("");
	});
});

describe("session-only model application", () => {
	it("keeps the picker or effort strip focused until model application settles", async () => {
		for (const [model, fallback, usesStrip] of [
			[modelOrThrow("claude-3-5-sonnet-20241022"), Effort.Low, false],
			[modelOrThrow("claude-sonnet-4-5"), Effort.High, true],
		] as const) {
			const harness = createSessionSwitchHarness(model, fallback);
			harness.controller.showModelSelector({ temporaryOnly: true });
			harness.overlays[0]!.component.handleInput("\r");

			const activeOverlay = harness.overlays[usesStrip ? 1 : 0]!;
			if (usesStrip) activeOverlay.component.handleInput("\r");
			await harness.applicationStarted;

			activeOverlay.component.handleInput("\r");
			expect(harness.focused()).toBe(activeOverlay.component);
			expect(activeOverlay.hide).not.toHaveBeenCalled();
			expect(harness.setModelTemporary).toHaveBeenCalledTimes(1);
			expect(harness.setModelTemporary).toHaveBeenCalledWith(model, fallback);

			harness.releaseApplication();
			await harness.focusRestored;
			expect(activeOverlay.hide).toHaveBeenCalledTimes(1);
			expect(harness.focused()).toBe(harness.activeDialog);
		}
	});

	it("restores the active dialog and reports a model application error once", async () => {
		for (const [model, fallback, usesStrip] of [
			[modelOrThrow("claude-3-5-sonnet-20241022"), Effort.Low, false],
			[modelOrThrow("claude-sonnet-4-5"), Effort.High, true],
		] as const) {
			const harness = createSessionSwitchHarness(model, fallback);
			const error = new Error("metadata refresh failed");
			harness.controller.showModelSelector({ temporaryOnly: true });
			harness.overlays[0]!.component.handleInput("\r");

			const activeOverlay = harness.overlays[usesStrip ? 1 : 0]!;
			if (usesStrip) activeOverlay.component.handleInput("\r");
			await harness.applicationStarted;
			harness.failApplication(error);
			await harness.errorShown;

			expect(harness.showError).toHaveBeenCalledTimes(1);
			expect(harness.showError).toHaveBeenCalledWith(error.message);
			expect(activeOverlay.hide).toHaveBeenCalledTimes(1);
			expect(harness.focused()).toBe(harness.activeDialog);
		}
	});

	it("chooses effort before over-context compaction and switches in its pre-flush hook", async () => {
		const model = modelOrThrow("claude-sonnet-4-5");
		const contextWindow = model.contextWindow;
		if (contextWindow === null) throw new Error("Expected a finite context window");
		const harness = createSessionSwitchHarness(model, Effort.High, contextWindow + 1);
		const events: string[] = [];
		const compactionFinished = Promise.withResolvers<void>();
		harness.releaseApplication();
		harness.setModelTemporary.mockImplementationOnce(async () => {
			events.push("switch");
		});
		harness.handleCompactCommand.mockImplementationOnce(async (_instructions, _mode, beforeFlush) => {
			events.push("compact");
			expect(harness.setModelTemporary).not.toHaveBeenCalled();
			await beforeFlush?.("ok");
			events.push("flush");
			compactionFinished.resolve();
			return "ok";
		});

		harness.controller.showModelSelector({ temporaryOnly: true });
		harness.overlays[0]!.component.handleInput("\r");
		harness.overlays[1]!.component.handleInput("\r");
		await compactionFinished.promise;

		expect(events).toEqual(["compact", "switch", "flush"]);
		expect(harness.setModelTemporary).toHaveBeenCalledTimes(1);
		expect(harness.setModelTemporary).toHaveBeenCalledWith(model, Effort.High);
	});
});
