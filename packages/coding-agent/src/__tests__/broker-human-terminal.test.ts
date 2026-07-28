import { describe, expect, it } from "bun:test";
import type { ExtensionUIContext } from "../extensibility/extensions/types";
import type { Theme } from "../modes/theme/theme";
import type { TUI } from "@oh-my-pi/pi-tui";
import {
	HumanTerminalOverlayComponent,
	runHumanTerminal,
} from "../secrets/broker/human-terminal";
import { SecretBroker } from "../secrets/broker/broker";

/** Minimal theme stub: fg returns the text, borders are plain chars. */
const stubTheme = {
	fg: (_role: string, text: string) => text,
} as unknown as Theme;

describe("Phase D Task D1: human-only terminal", () => {
	it("runHumanTerminal: PTY output reaches the overlay ONLY; the agent gets exit metadata only", async () => {
		let capturedComponent: HumanTerminalOverlayComponent | undefined;

		const fakeTui = {
			terminal: { rows: 24, columns: 80 },
			requestRender: () => {},
		} as unknown as TUI;

		const fakeUi = {
			custom: async <T,>(
				factory: (
					tui: TUI,
					theme: Theme,
					kb: unknown,
					done: (result: T) => void,
				) => HumanTerminalOverlayComponent,
			): Promise<T> => {
				return new Promise<T>(resolvePromise => {
					const component = factory(fakeTui, stubTheme, undefined, result =>
						resolvePromise(result),
					);
					capturedComponent = component;
				});
			},
		} as unknown as ExtensionUIContext;

		const result = await runHumanTerminal({
			ui: fakeUi,
			command: "printf human-only-output-4242",
			timeoutMs: 10_000,
		});

		// 1. The agent receives exit metadata ONLY — no output text.
		expect(result.exitCode).toBe(0);
		expect(JSON.stringify(result)).not.toContain("human-only-output-4242");

		// 2. The overlay DID receive the output (the human sees it).
		expect(capturedComponent).toBeDefined();
		const lines = capturedComponent!.visibleLines(10).join("\n");
		expect(lines).toContain("human-only-output-4242");
	}, 30_000);

	it("runHumanTerminal fails closed when there is no interactive UI", async () => {
		await expect(
			runHumanTerminal({ ui: undefined, command: "true" }),
		).rejects.toThrow(/interactive UI/);
	});

	it("overlay render includes the human-only marker and output lines", async () => {
		const { Terminal } = await import("@xterm/headless");
		const component = new HumanTerminalOverlayComponent(
			"bw unlock",
			stubTheme,
			new Terminal({ cols: 60, rows: 8, allowProposedApi: true }),
		);
		component.appendOutput("master password prompt text\n");
		await component.flush();
		const rendered = component.render(60).join("\n");
		expect(rendered).toContain("human-only terminal");
		expect(rendered).toContain("master password prompt text");
		component.dispose();
	});

	it("keystrokes route to the PTY (operator input path), not to any agent channel", async () => {
		let capturedComponent: HumanTerminalOverlayComponent | undefined;
		const fakeTui = {
			terminal: { rows: 24, columns: 80 },
			requestRender: () => {},
		} as unknown as TUI;
		const fakeUi = {
			custom: async <T,>(
				factory: (tui: TUI, theme: Theme, kb: unknown, done: (result: T) => void) => HumanTerminalOverlayComponent,
			): Promise<T> => {
				return new Promise<T>(resolvePromise => {
					const component = factory(fakeTui, stubTheme, undefined, result =>
						resolvePromise(result),
					);
					capturedComponent = component;
				});
			},
		} as unknown as ExtensionUIContext;

		// `read` waits for one line of stdin; the "human" types it via handleInput.
		const promise = runHumanTerminal({
			ui: fakeUi,
			command: "read ANSWER && printf got-%s $ANSWER",
			timeoutMs: 10_000,
		});
		// Give the PTY a moment to start, then type as the operator would.
		await new Promise(resolve => setTimeout(resolve, 500));
		capturedComponent?.handleInput("typed-by-human\n");
		const result = await promise;

		expect(result.exitCode).toBe(0);
		const lines = capturedComponent!.visibleLines(10).join("\n");
		expect(lines).toContain("got-typed-by-human");
		expect(JSON.stringify(result)).not.toContain("got-typed-by-human");
	}, 30_000);
});
