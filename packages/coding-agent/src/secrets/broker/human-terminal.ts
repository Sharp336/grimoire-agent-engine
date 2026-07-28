import { type PtyRunResult, PtySession } from "@oh-my-pi/pi-natives";
import { z } from "zod/v4";
import type { Component } from "@oh-my-pi/pi-tui";
import type * as XtermModule from "@xterm/headless";
import type { Theme } from "../../modes/theme/theme";
import type { ExtensionUIContext } from "../../extensibility/extensions/types";
import type { SecretBroker } from "./broker";
import type { SecretHandle } from "./types";


/**
 * Phase D Task D1 — human-only terminal (F9).
 *
 * A terminal whose output reaches the OPERATOR's TUI but NEVER the agent's
 * context. The agent requests "prompt the human via a terminal"; the human
 * types into it (master passwords, OTPs, interactive unlocks); the value
 * goes straight to the process — bypassing the model entirely.
 *
 * The seam (scout-verified, zero core changes): `ctx.ui.custom(factory,
 * { overlay: true })` — the overlay component renders to the TUI only;
 * the agent receives only what we pass to `done()`. There is NO
 * OutputSink in this module: PTY bytes never enter the agent stream.
 */

// ─── Lazy xterm ctor (same pattern as bash-interactive) ─────────────────────

let xtermTerminalCtor: typeof XtermModule.Terminal | undefined;

async function loadXtermTerminal(): Promise<typeof XtermModule.Terminal> {
	if (!xtermTerminalCtor) {
		const mod = (await import("@xterm/headless")) as typeof XtermModule & {
			default?: typeof XtermModule;
		};
		xtermTerminalCtor = (mod.default ?? mod).Terminal;
	}
	return xtermTerminalCtor;
}

// ─── Overlay component (TUI-visible; agent-invisible) ───────────────────────

const MAX_SCROLL_LINES = 2000;

export class HumanTerminalOverlayComponent implements Component {
	readonly #terminal: XtermModule.Terminal;
	readonly #title: string;
	readonly #theme: Theme;
	#status = "running";
	#writeQueue: Promise<void> = Promise.resolve();
	#session: PtySession | undefined;
	#onInput: ((data: string) => void) | undefined;

	constructor(title: string, theme: Theme, terminal: XtermModule.Terminal) {
		this.#title = title;
		this.#theme = theme;
		this.#terminal = terminal;
	}

	setSession(session: PtySession, onInput: (data: string) => void): void {
		this.#session = session;
		this.#onInput = onInput;
	}
	appendOutput(chunk: string): void {
		// xterm write() parses asynchronously — queue so flush() can await
		// the buffer actually containing everything before the final render.
		this.#writeQueue = this.#writeQueue.then(
			() => new Promise<void>(resolve => this.#terminal.write(chunk, resolve)),
		);
	}

	/** Await all queued writes landing in the xterm buffer. */
	async flush(): Promise<void> {
		await this.#writeQueue;
	}
	setComplete(exitCode: number | undefined): void {
		this.#status = exitCode === undefined ? "exited" : `exited (code ${exitCode})`;
	}

	handleInput(data: string): void {
		if (this.#session && this.#onInput) this.#onInput(data);
	}

	/** Last N visible lines from the xterm buffer (test-visible + render). */
	visibleLines(maxLines: number): string[] {
		const buffer = this.#terminal.buffer.active;
		const lines: string[] = [];
		for (let i = 0; i < buffer.length && lines.length < maxLines; i++) {
			const line = buffer.getLine(i);
			if (!line) continue;
			const text = line.translateToString(true);
			if (text.length > 0) lines.push(text);
		}
		return lines;
	}
	render(width: number): readonly string[] {
		const innerWidth = Math.max(10, width - 2);
		const header = ` ${this.#title} — human-only terminal (output never reaches the agent)`;
		const footer = ` ${this.#status} — Esc/Ctrl+C to kill`;
		const lines = this.visibleLines(this.#terminal.rows);
		const pad = (text: string) => {
			const visible = text.replace(/\x1b\[[0-9;]*m/g, "");
			const extra = innerWidth - visible.length;
			return extra > 0 ? text + " ".repeat(extra) : text;
		};
		const border = this.#theme.fg("border", "─".repeat(innerWidth));
		const boxLine = (line: string) => `│${pad(line.slice(0, innerWidth))}│`;
		return [
			`┌${border}┐`,
			boxLine(header),
			...lines.map(boxLine),
			boxLine(footer),
			`└${border}┘`,
		];
	}

	invalidate(): void {}

	dispose(): void {
		this.#terminal.dispose();
	}
}

// ─── Runner ─────────────────────────────────────────────────────────────────

export interface HumanTerminalResult {
	exitCode: number | undefined;
	cancelled: boolean;
	timedOut: boolean;
}

export interface RunHumanTerminalOptions {
	/** Extension UI context (interactive mode). The tool fails closed without it. */
	ui: ExtensionUIContext | undefined;
	command: string;
	args?: string[];
	cwd?: string;
	env?: Record<string, string>;
	timeoutMs?: number;
	signal?: AbortSignal;
	/** Overlay title shown to the operator. */
	title?: string;
}

/**
 * Run a command in a human-only terminal. The agent receives ONLY the exit
 * metadata — PTY output renders to the operator's overlay and nothing else.
 * Fails closed when there is no interactive UI (print/RPC mode).
 */
export async function runHumanTerminal(opts: RunHumanTerminalOptions): Promise<HumanTerminalResult> {
	if (!opts.ui) {
		throw new Error(
			"human_terminal requires an interactive UI — the operator must be present. " +
				"This command cannot run in print/RPC mode (that is the point of a human-only terminal).",
		);
	}
	const XtermTerminal = await loadXtermTerminal();
	const title = opts.title ?? opts.command;
	return opts.ui.custom<HumanTerminalResult>((tui, theme, _keybindings, done) => {
		const session = new PtySession();
		const cols = Math.max(20, tui.terminal.columns - 2);
		const rows = Math.max(5, Math.min(tui.terminal.rows - 4, 24));
		const component = new HumanTerminalOverlayComponent(
			title,
			theme,
			new XtermTerminal({ cols, rows, scrollback: MAX_SCROLL_LINES, allowProposedApi: true }),
		);
		let finished = false;
				const finalize = (run: PtyRunResult) => {
			if (finished) return;
			finished = true;
			void (async () => {
				await component.flush();
				component.setComplete(run.exitCode);
				tui.requestRender();
				// done() is the ONLY channel to the agent — exit metadata, no output.
				done({ exitCode: run.exitCode, cancelled: run.cancelled, timedOut: run.timedOut });
			})();
		};
		component.setSession(session, data => {
			try {
				session.write(data);
			} catch {
				// ignore writes after the command exits
			}
		});
		const argv = [opts.command, ...(opts.args ?? [])];
		void session
			.start(
				{
					command: argv.join(" "),
					cwd: opts.cwd ?? process.cwd(),
					timeoutMs: opts.timeoutMs,
					env: { TERM: "xterm-256color", ...opts.env },
					signal: opts.signal,
					cols,
					rows,
				},
				(err, chunk) => {
					if (finished || err || !chunk) return;
					component.appendOutput(chunk);
					tui.requestRender();
				},
			)
			.then(finalize)
			.catch(() => {
				finalize({ exitCode: undefined, cancelled: false, timedOut: false });
			});
		return component;
	}, { overlay: true });
}

// ─── Tool definition ────────────────────────────────────────────────────────

import type { ToolDefinition } from "../../extensibility/extensions/types";

const humanTerminalParams = z.object({
	command: z.string().describe("The interactive command to run (e.g. 'bw unlock', 'ssh-add', 'op signin')"),
	args: z.array(z.string()).optional().describe("Command arguments"),
	handle: z
		.object({
			provider: z.string(),
			itemId: z.string(),
			field: z.string().optional(),
		})
		.optional()
		.describe("Optional vault handle — the broker injects the resolved secret into the process env"),
	envKey: z.string().optional().describe("Env var name for the injected secret (required when handle is set)"),
	timeoutMs: z.number().optional().describe("Timeout in ms"),
	title: z.string().optional().describe("Overlay title shown to the operator"),
});

export function createHumanTerminalTool(broker: SecretBroker): ToolDefinition<typeof humanTerminalParams> {
	return {
		name: "human_terminal",
		label: "Human-Only Terminal",
		description:
			"Run an interactive command in a terminal ONLY the operator can see. The PTY output NEVER " +
			"enters your context — use it for interactive secret entry (bw unlock, ssh-add, op signin, " +
			"passphrase prompts). Returns only the exit metadata (exitCode/cancelled/timedOut). " +
			"Optionally injects a vault secret into the process env broker-side (handle + envKey).",
		parameters: humanTerminalParams,
		approval: "exec",
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const env: Record<string, string> = {};
			if (params.handle) {
				if (!params.envKey) {
					return {
						content: [
							{
								type: "text" as const,
								text: "human_terminal: envKey is required when a handle is given (fail-closed).",
							},
						],
						isError: true,
					};
				}
				const resolved = await broker.resolveHandle(params.handle as SecretHandle);
				env[params.envKey] = resolved.value;
			}
			const ui = (ctx as { ui?: ExtensionUIContext } | undefined)?.ui;
			try {
				const result = await runHumanTerminal({
					ui,
					command: params.command,
					args: params.args,
					env,
					timeoutMs: params.timeoutMs,
					signal,
					title: params.title,
				});
				// The envelope is exit metadata only — no PTY output by construction,
				// so nothing here can carry a secret value.
				return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
			} catch (err) {
				return {
					content: [
						{
							type: "text" as const,
							text: `human_terminal: ${err instanceof Error ? err.message : String(err)}`,
						},
					],
					isError: true,
				};
			}
		},
	};
}
