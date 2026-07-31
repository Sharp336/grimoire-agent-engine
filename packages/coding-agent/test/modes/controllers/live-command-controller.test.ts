import { afterEach, describe, expect, it, vi } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { LiveSessionController } from "@oh-my-pi/pi-coding-agent/live/controller";
import type { LiveTransportOptions } from "@oh-my-pi/pi-coding-agent/live/transport";
import { LiveVisualizer } from "@oh-my-pi/pi-coding-agent/live/visualizer";
import { LiveCommandController } from "@oh-my-pi/pi-coding-agent/modes/controllers/live-command-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";

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
	};
	const focused: unknown[] = [];
	const mounted: unknown[] = [];
	const refocused = Promise.withResolvers<void>();
	const ctx = {
		settings: Settings.isolated({ "live.language": "sv", "live.voice": "vale" }),
		keybindings: { getKeys: vi.fn(() => ["ctrl+l"]) },
		session: {},
		extractAssistantText: vi.fn(() => ""),
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

async function captureTransportOptions(language: unknown): Promise<LiveTransportOptions> {
	const settings = Settings.isolated({ "live.language": language, "live.voice": "vale" });
	const connectFailure = new Error("stop after transport construction");
	let receivedOptions: LiveTransportOptions | undefined;
	const session = {
		modelRegistry: { authStorage: {} },
		sessionId: "test-live-session",
	} as unknown as AgentSession;
	const controller = new LiveSessionController(
		{
			session,
			callbacks: {
				onPhase: vi.fn(),
				onLevels: vi.fn(),
				onTranscript: vi.fn(),
				onTerminal: vi.fn(),
			},
			extractAssistantText: vi.fn(() => ""),
			language: settings.get("live.language"),
			voice: settings.get("live.voice"),
		},
		options => {
			receivedOptions = options;
			return {
				connect: () => Promise.reject(connectFailure),
				send: () => Promise.resolve(),
				close: () => Promise.resolve(),
				setMuted: () => Promise.resolve(),
				pushAudio: () => {},
			};
		},
	);

	await expect(controller.start()).rejects.toBe(connectFailure);
	if (!receivedOptions) throw new Error("Live session did not construct a transport");
	return receivedOptions;
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("LiveCommandController", () => {
	it("forwards the selected live preferences across the session boundary", async () => {
		const { ctx } = createContext();
		let receivedLanguage: string | undefined;
		let receivedVoice: string | undefined;
		const controller = new LiveCommandController(ctx, options => {
			receivedLanguage = options.language;
			receivedVoice = options.voice;
			const session = new LiveSessionController(options);
			vi.spyOn(session, "start").mockResolvedValue();
			vi.spyOn(session, "stop").mockResolvedValue();
			return session;
		});

		try {
			await controller.handleCommand();
			expect(receivedLanguage).toBe("sv");
			expect(receivedVoice).toBe("vale");
		} finally {
			await controller.stop();
		}
	});

	it("passes selected language policy into the realtime transport", async () => {
		const options = await captureTransportOptions("sv");

		expect(options.voice).toBe("vale");
		expect(options.instructions).toContain("Swedish is the session-default response language");
		expect(options.instructions).toContain("requested language becomes current until another explicit request");
		expect(options.instructions).not.toContain("first substantive utterance");
	});

	it("falls back stale language settings before constructing the realtime transport", async () => {
		const options = await captureTransportOptions("stale-language");

		expect(options.voice).toBe("vale");
		expect(options.instructions).toContain("Before the first substantive utterance");
		expect(options.instructions).toContain("If no language is identifiable");
		expect(options.instructions).toContain("requested language becomes current until another explicit request");
		expect(options.instructions).not.toContain("is the session-default response language");
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
});
