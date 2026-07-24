import { afterEach, describe, expect, test, vi } from "bun:test";
import type { KeybindingsManager } from "@oh-my-pi/pi-coding-agent/config/keybindings";
import type {
	ExtensionUIContext,
	ExtensionUiComponent,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { type Theme, theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { OutputSink } from "@oh-my-pi/pi-coding-agent/session/streaming-output";
import { runInteractiveBashPty } from "@oh-my-pi/pi-coding-agent/tools/bash-interactive";
import { type PtyRunResult, PtySession } from "@oh-my-pi/pi-natives";
import type { TUI } from "@oh-my-pi/pi-tui";

// The interactive PTY overlay finalizes on a detached task: it flushes the
// terminal, dumps the sink, and settles `ui.custom` via `done`. If the flush or
// dump throws, the old code left `done` uncalled, so the overlay hung forever.
// The completion-union contract routes success/error through `done` and rethrows
// the error after the overlay resolves. These tests pin that contract.

interface CustomCapture {
	completion?: unknown;
}

function makeFakeUi(capture: CustomCapture): ExtensionUIContext {
	const ui = {
		custom: <T>(
			factory: (
				tui: TUI,
				uiTheme: Theme,
				keybindings: KeybindingsManager,
				done: (result: T) => void,
			) => ExtensionUiComponent | Promise<ExtensionUiComponent>,
			_options?: { overlay?: boolean },
		): Promise<T> =>
			new Promise<T>(resolve => {
				const fakeTui = {
					terminal: { rows: 24, columns: 80 },
					requestRender: () => {},
				} as TUI;
				const done = (result: T): void => {
					capture.completion = result;
					resolve(result);
				};
				// The factory is synchronous here; it wires the PtySession whose
				// (mocked) start resolves and drives finalize.
				void factory(fakeTui, theme, {} as KeybindingsManager, done);
			}),
	} as ExtensionUIContext;
	return ui;
}

function completionOk(value: unknown): boolean | undefined {
	if (value && typeof value === "object" && "ok" in value) {
		const ok = value.ok;
		return typeof ok === "boolean" ? ok : undefined;
	}
	return undefined;
}

describe("runInteractiveBashPty overlay settlement", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	test("a final dump failure settles ui.custom with an error outcome and rejects the caller", async () => {
		vi.spyOn(PtySession.prototype, "start").mockImplementation(
			async (): Promise<PtyRunResult> => ({ exitCode: 0, cancelled: false, timedOut: false }),
		);
		const dumpError = new Error("dump-fail");
		vi.spyOn(OutputSink.prototype, "dump").mockRejectedValue(dumpError);

		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown): void => {
			unhandled.push(reason);
		};
		process.on("unhandledRejection", onUnhandled);
		try {
			const capture: CustomCapture = {};
			const ui = makeFakeUi(capture);

			await expect(runInteractiveBashPty(ui, { command: "echo hi", cwd: process.cwd() })).rejects.toThrow(
				"dump-fail",
			);

			// The overlay settled with an error outcome instead of hanging.
			expect(completionOk(capture.completion)).toBe(false);
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}

		// Let any stray microtasks flush, then assert the finalizer left no
		// unhandled rejection behind.
		await Promise.resolve();
		expect(unhandled).toEqual([]);
	});

	test("a successful run settles ui.custom with a result outcome and resolves the caller", async () => {
		vi.spyOn(PtySession.prototype, "start").mockImplementation(
			async (): Promise<PtyRunResult> => ({ exitCode: 0, cancelled: false, timedOut: false }),
		);

		const capture: CustomCapture = {};
		const ui = makeFakeUi(capture);

		const result = await runInteractiveBashPty(ui, { command: "echo hi", cwd: process.cwd() });

		expect(completionOk(capture.completion)).toBe(true);
		expect(result.exitCode).toBe(0);
		expect(result.cancelled).toBe(false);
		expect(result.timedOut).toBe(false);
	});
});
