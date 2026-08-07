import { afterEach, describe, expect, it, vi } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { LiveSessionController, type LiveTranscript } from "@oh-my-pi/pi-coding-agent/live/controller";
import { LiveVisualizer } from "@oh-my-pi/pi-coding-agent/live/visualizer";
import { AssistantMessageComponent } from "@oh-my-pi/pi-coding-agent/modes/components/assistant-message";
import { LiveCommandController } from "@oh-my-pi/pi-coding-agent/modes/controllers/live-command-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";

/** Fake InteractiveModeContext plus typed capture channels for focus/mount traffic. */
interface ContextHarness {
	ctx: InteractiveModeContext;
	/** The editor stub the controller must restore after live mode ends. */
	editor: unknown;
	/** Every component handed to `ui.setFocus`, in order. */
	focused: unknown[];
	/** Every component handed to `editorContainer.addChild`, in order. */
	mounted: unknown[];
	/** Resolves when `ui.setFocus` sees the original editor again. */
	editorRefocused: Promise<void>;
}

function createContext(): ContextHarness {
	const editor = {
		getUseTerminalCursor: vi.fn(() => true),
		setUseTerminalCursor: vi.fn(),
		setText: vi.fn(),
	};
	const focused: unknown[] = [];
	const mounted: unknown[] = [];
	const refocused = Promise.withResolvers<void>();
	const ctx = {
		settings: Settings.isolated({
			"providers.voiceOrder": ["grok", "codex"],
			"live.codexVoice": "vale",
			"live.grokVoice": "leo",
		}),
		keybindings: { getKeys: vi.fn(() => ["ctrl+l"]) },
		session: {},
		extractAssistantText: vi.fn(() => ""),
		handleLiveCommand: vi.fn(async () => {}),
		effectiveHideThinkingBlock: false,
		viewSession: {},
		proseOnlyThinking: false,
		hideToolActivity: false,
		toolOutputExpanded: false,
		editor,
		editorContainer: {
			clear: vi.fn(),
			addChild: vi.fn((component: unknown) => {
				mounted.push(component);
			}),
		},
		ui: {
			getShowHardwareCursor: vi.fn(() => true),
			setShowHardwareCursor: vi.fn(),
			setFocus: vi.fn((component: unknown) => {
				focused.push(component);
				if (component === editor) refocused.resolve();
			}),
			requestRender: vi.fn(),
			requestComponentRender: vi.fn(),
		},
		showError: vi.fn(),
		chatContainer: { children: [] },
		present: vi.fn(),
	} as unknown as InteractiveModeContext;
	return { ctx, editor, focused, mounted, editorRefocused: refocused.promise };
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("LiveCommandController", () => {
	it("forwards provider ranking, override, and provider-owned voice settings", async () => {
		const { ctx } = createContext();
		let receivedProvider: string | undefined;
		let receivedOrder: readonly string[] | undefined;
		let receivedCodexVoice: string | undefined;
		let receivedGrokVoice: string | undefined;
		const controller = new LiveCommandController(ctx, options => {
			receivedProvider = options.provider;
			receivedOrder = options.providerOrder;
			receivedCodexVoice = options.providerConfigs?.codex?.voice;
			receivedGrokVoice = options.providerConfigs?.grok?.voice;
			const session = new LiveSessionController(options);
			vi.spyOn(session, "start").mockResolvedValue();
			vi.spyOn(session, "stop").mockResolvedValue();
			return session;
		});

		try {
			await controller.handleCommand("codex");
			expect(receivedProvider).toBe("codex");
			expect(receivedOrder).toEqual(["grok", "codex"]);
			expect(receivedCodexVoice).toBe("vale");
			expect(receivedGrokVoice).toBe("leo");
		} finally {
			await controller.stop();
		}
	});

	it("labels Grok transcript messages with the effective provider and model", async () => {
		const { ctx } = createContext();
		const updateContent = vi.spyOn(AssistantMessageComponent.prototype, "updateContent").mockImplementation(() => {});
		let emitTranscript: ((transcript: LiveTranscript | undefined) => void) | undefined;
		const controller = new LiveCommandController(ctx, options => {
			emitTranscript = options.callbacks.onTranscript;
			const session = new LiveSessionController(options);
			vi.spyOn(session, "start").mockResolvedValue();
			vi.spyOn(session, "stop").mockResolvedValue();
			return session;
		});

		try {
			await controller.handleCommand("grok");
			if (!emitTranscript) throw new Error("expected transcript callback");
			emitTranscript({
				role: "assistant",
				turn: 1,
				text: "Hello",
				final: false,
				identity: {
					voiceProvider: "grok",
					api: "openai-completions",
					provider: "xai",
					model: "grok-voice-think-fast-2.0",
				},
			});
			expect(updateContent).toHaveBeenCalledWith(
				expect.objectContaining({
					api: "openai-completions",
					provider: "xai",
					model: "grok-voice-think-fast-2.0",
				}),
				{ transient: true },
			);
		} finally {
			await controller.stop();
		}
	});

	it("stops the session and restores the editor when the live-toggle chord hits the focused visualizer", async () => {
		const { ctx, editor, focused, mounted, editorRefocused } = createContext();
		const stop = vi.fn(async () => {});
		const controller = new LiveCommandController(ctx, options => {
			const session = new LiveSessionController(options);
			vi.spyOn(session, "start").mockResolvedValue();
			vi.spyOn(session, "stop").mockImplementation(stop);
			return session;
		});

		await controller.handleCommand();
		expect(controller.active).toBe(true);

		// The controller replaces and focuses the editor with the visualizer;
		// Ctrl+L must end the call from there, not just from the editor.
		const visualizer = focused[0];
		if (!(visualizer instanceof LiveVisualizer)) {
			throw new Error("expected the controller to focus a LiveVisualizer");
		}
		visualizer.handleInput("\x0c"); // Ctrl+L — the keypress alone must drive teardown
		await editorRefocused;

		expect(stop).toHaveBeenCalled();
		expect(mounted.at(-1)).toBe(editor);
		expect(focused.at(-1)).toBe(editor);
		// `active` stays true until #finish's fire-and-forget settling promise
		// clears; drain microtasks deterministically instead of sleeping.
		for (let i = 0; controller.active && i < 20; i++) await Promise.resolve();
		expect(controller.active).toBe(false);
	});

	it("maps /live provider arguments and rejects unknown providers", async () => {
		const { ctx } = createContext();

		expect(await executeBuiltinSlashCommand("/live grok", { ctx })).toBe(true);
		expect(ctx.handleLiveCommand).toHaveBeenLastCalledWith("grok");

		expect(await executeBuiltinSlashCommand("/live codex", { ctx })).toBe(true);
		expect(ctx.handleLiveCommand).toHaveBeenLastCalledWith("codex");

		expect(await executeBuiltinSlashCommand("/live unknown", { ctx })).toBe(true);
		expect(ctx.handleLiveCommand).toHaveBeenCalledTimes(2);
		expect(ctx.showError).toHaveBeenCalledWith("Usage: /live [grok|codex]");
	});
});
