import { describe, expect, it, vi } from "bun:test";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";

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

describe("/model slash command", () => {
	it("opens the model setup picker for role and thinking assignment", async () => {
		const harness = createRuntime();

		const handled = await executeBuiltinSlashCommand("/model", harness.runtime);

		expect(handled).toBe(true);
		expect(harness.showModelSelector.mock.calls).toEqual([[]]);
		expect(harness.setText).toHaveBeenCalledWith("");
	});
});

const FAKE_MODELS = [
	{ provider: "anthropic", id: "claude-opus-4-5" },
	{ provider: "openai", id: "gpt-5.2" },
];

function createSwitchRuntime(options?: {
	roleThinkingLevel?: string;
	scopedModels?: ReadonlyArray<{ provider: string; id: string }>;
}) {
	const showModelSelector = vi.fn();
	const setText = vi.fn();
	const showStatus = vi.fn();
	const showError = vi.fn();
	const setModelTemporary = vi.fn();
	const resolveTemporaryModelThinkingLevel = vi.fn(() => options?.roleThinkingLevel);
	const invalidate = vi.fn();
	const updateEditorBorderColor = vi.fn();
	const getKeys = vi.fn(() => ["Alt+P"]);
	return {
		showModelSelector,
		setText,
		showStatus,
		showError,
		setModelTemporary,
		runtime: {
			ctx: {
				editor: { setText } as unknown as InteractiveModeContext["editor"],
				showModelSelector,
				showStatus,
				showError,
				updateEditorBorderColor,
				statusLine: { invalidate },
				keybindings: { getKeys },
				settings: undefined,
				session: {
					modelRegistry: {
						getAll: () => FAKE_MODELS,
						getAvailable: () => FAKE_MODELS,
					},
					scopedModels: (options?.scopedModels ?? []).map(model => ({ model })),
					setModelTemporary,
					resolveTemporaryModelThinkingLevel,
				},
			} as unknown as InteractiveModeContext,
		},
	};
}

describe("/switch slash command", () => {
	it("opens the temporary model selector (mirrors alt+p)", async () => {
		const harness = createRuntime();

		const handled = await executeBuiltinSlashCommand("/switch", harness.runtime);

		expect(handled).toBe(true);
		expect(harness.showModelSelector).toHaveBeenCalledWith({ temporaryOnly: true });
		expect(harness.setText).toHaveBeenCalledWith("");
	});

	it("switches directly to a named provider/id model without opening the picker", async () => {
		const harness = createSwitchRuntime();

		const handled = await executeBuiltinSlashCommand("/switch anthropic/claude-opus-4-5", harness.runtime);

		expect(handled).toBe(true);
		expect(harness.showModelSelector).not.toHaveBeenCalled();
		expect(harness.setModelTemporary).toHaveBeenCalledWith(FAKE_MODELS[0], undefined);
		expect(harness.showError).not.toHaveBeenCalled();
		expect(harness.showStatus.mock.calls[0][0]).toContain("Session-only model: anthropic/claude-opus-4-5");
	});

	it("resolves a bare model id against the authenticated set", async () => {
		const harness = createSwitchRuntime();

		const handled = await executeBuiltinSlashCommand("/switch gpt-5.2", harness.runtime);

		expect(handled).toBe(true);
		expect(harness.setModelTemporary).toHaveBeenCalledWith(FAKE_MODELS[1], undefined);
	});

	it("applies an explicit thinking suffix instead of the role-derived level", async () => {
		const harness = createSwitchRuntime({ roleThinkingLevel: "low" });

		const handled = await executeBuiltinSlashCommand("/switch anthropic/claude-opus-4-5:high", harness.runtime);

		expect(handled).toBe(true);
		expect(harness.setModelTemporary).toHaveBeenCalledWith(FAKE_MODELS[0], "high");
	});

	it("reports an unknown model without switching", async () => {
		const harness = createSwitchRuntime();

		const handled = await executeBuiltinSlashCommand("/switch nope/not-a-model", harness.runtime);

		expect(handled).toBe(true);
		expect(harness.setModelTemporary).not.toHaveBeenCalled();
		expect(harness.showStatus).not.toHaveBeenCalled();
		expect(harness.showError).toHaveBeenCalled();
	});

	it("rejects an out-of-scope model in a scoped session without switching", async () => {
		const harness = createSwitchRuntime({ scopedModels: [FAKE_MODELS[0]] });

		const handled = await executeBuiltinSlashCommand("/switch openai/gpt-5.2", harness.runtime);

		expect(handled).toBe(true);
		expect(harness.setModelTemporary).not.toHaveBeenCalled();
		expect(harness.showStatus).not.toHaveBeenCalled();
		expect(harness.showError.mock.calls[0][0]).toContain(
			'Model "openai/gpt-5.2" is outside this session\'s model scope (--models)',
		);
	});

	it("accepts an in-scope model in a scoped session", async () => {
		const harness = createSwitchRuntime({ scopedModels: [FAKE_MODELS[0]] });

		const handled = await executeBuiltinSlashCommand("/switch anthropic/claude-opus-4-5", harness.runtime);

		expect(handled).toBe(true);
		expect(harness.setModelTemporary).toHaveBeenCalledWith(FAKE_MODELS[0], undefined);
		expect(harness.showError).not.toHaveBeenCalled();
		expect(harness.showStatus.mock.calls[0][0]).toContain("Session-only model: anthropic/claude-opus-4-5");
	});
});
