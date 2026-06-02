import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { type Component, TUI } from "@oh-my-pi/pi-tui";
import { VirtualTerminal } from "./virtual-terminal";

// Regression test for https://github.com/can1357/oh-my-pi/issues/1682
// (the POSIX counterpart of #1635).
//
// #1635 fixed the "scroll up while streaming -> viewport snaps to the top of
// scrollback" yank for Windows Terminal by routing its viewport probe to
// `undefined`. On POSIX the probe is *already* `undefined`, but the eager native
// scrollback rebuild enabled for unknown POSIX viewports (commit 5f543b957) opts
// streaming-time mutations back into the destructive `historyRebuild` intent,
// which emits `\x1b[2J\x1b[H\x1b[3J`. On terminals that reset the viewport to the
// TOP of scrollback on ED3 (`\x1b[3J`) — WezTerm, kitty, ghostty, alacritty —
// that yanks a scrolled-up reader to the top instead of snapping to the tail.
//
// Fix: `isNativeScrollbackClearHostile()` gates the eager-flag promotion in
// `#doRender`, so on those terminals streaming offscreen edits defer to a
// non-destructive viewport repaint + dirty mark, and the destructive rebuild is
// held until the next checkpoint (`refreshNativeScrollbackIfDirty` on prompt
// submit) where the editor keystroke has already pinned the terminal to the
// bottom.
class LineList implements Component {
	#lines: string[];
	constructor(lines: string[]) {
		this.#lines = [...lines];
	}
	invalidate(): void {}
	render(width: number): string[] {
		return this.#lines.map(l => l.slice(0, width));
	}
	setLines(lines: string[]): void {
		this.#lines = [...lines];
	}
}

async function settle(term: VirtualTerminal): Promise<void> {
	await new Promise<void>(r => process.nextTick(r));
	await new Promise<void>(r => setTimeout(r, 20));
	await term.flush();
}

function capture(term: VirtualTerminal): string[] {
	const writes: string[] = [];
	const realWrite = term.write.bind(term);
	(term as unknown as { write: (s: string) => void }).write = (data: string) => {
		writes.push(data);
		realWrite(data);
	};
	return writes;
}

function overrideProbe(term: VirtualTerminal, answer: boolean | undefined): void {
	(term as unknown as { isNativeViewportAtBottom: () => boolean | undefined }).isNativeViewportAtBottom = () => answer;
}

const ERASE_SCROLLBACK = /\x1b\[3J/g;

// Terminal-identifying / multiplexer env that would change the routing under test.
const ENV_KEYS = [
	"WEZTERM_PANE",
	"KITTY_WINDOW_ID",
	"GHOSTTY_RESOURCES_DIR",
	"ALACRITTY_WINDOW_ID",
	"ALACRITTY_SOCKET",
	"TMUX",
	"STY",
	"ZELLIJ",
	"TERMUX_VERSION",
] as const;

describe("issue #1635 (POSIX): eager rebuild must not yank ED3-reset terminals", () => {
	let savedEnv: Record<string, string | undefined>;
	let savedPlatform: PropertyDescriptor | undefined;

	beforeEach(() => {
		savedEnv = {};
		for (const k of ENV_KEYS) {
			savedEnv[k] = Bun.env[k];
			delete Bun.env[k];
		}
		// Pin a POSIX platform so the scenario is deterministic on any CI host.
		savedPlatform = Object.getOwnPropertyDescriptor(process, "platform");
		Object.defineProperty(process, "platform", { value: "linux", configurable: true });
	});

	afterEach(() => {
		for (const k of ENV_KEYS) {
			if (savedEnv[k] === undefined) delete Bun.env[k];
			else Bun.env[k] = savedEnv[k];
		}
		if (savedPlatform) Object.defineProperty(process, "platform", savedPlatform);
	});

	// Drives the streaming shape: an offscreen structural mutation while the eager
	// rebuild flag is set (the coding-agent sets it for every streaming event).
	async function streamMutation(term: VirtualTerminal): Promise<{ tui: TUI; writes: string[] }> {
		overrideProbe(term, undefined);
		const tui = new TUI(term);
		const component = new LineList(Array.from({ length: 80 }, (_, i) => `init-${i}`));
		tui.addChild(component);
		tui.start();
		await settle(term);
		const writes = capture(term);
		tui.setEagerNativeScrollbackRebuild(true); // foreground tool / assistant streaming
		component.setLines(Array.from({ length: 20 }, (_, i) => `shrunk-${i}`));
		tui.requestRender();
		await settle(term);
		return { tui, writes };
	}

	it("WezTerm (WEZTERM_PANE): streaming rebuild must not emit \\x1b[3J", async () => {
		Bun.env.WEZTERM_PANE = "0";
		const term = new VirtualTerminal(100, 24);
		const { tui, writes } = await streamMutation(term);
		try {
			expect(writes.join("").match(ERASE_SCROLLBACK)).toBeNull();
		} finally {
			tui.stop();
		}
	});

	it("kitty (KITTY_WINDOW_ID): streaming rebuild must not emit \\x1b[3J", async () => {
		Bun.env.KITTY_WINDOW_ID = "1";
		const term = new VirtualTerminal(100, 24);
		const { tui, writes } = await streamMutation(term);
		try {
			expect(writes.join("").match(ERASE_SCROLLBACK)).toBeNull();
		} finally {
			tui.stop();
		}
	});

	// Control: a POSIX terminal NOT known to reset-to-top keeps the intentional
	// eager rebuild (commit 5f543b957) — proves the gate, not a blanket disable,
	// is what suppresses the sequence on hostile terminals.
	it("non-hostile POSIX control: streaming rebuild still emits \\x1b[3J", async () => {
		const term = new VirtualTerminal(100, 24);
		const { tui, writes } = await streamMutation(term);
		try {
			expect(writes.join("").match(ERASE_SCROLLBACK)).not.toBeNull();
		} finally {
			tui.stop();
		}
	});

	// The deferral is not silent data loss: at the next checkpoint (prompt submit,
	// where scroll_to_bottom_on_input has pinned the viewport to the tail) the
	// dirty scrollback is reconciled with the destructive rebuild.
	it("WezTerm: deferred scrollback is reconciled at the checkpoint", async () => {
		Bun.env.WEZTERM_PANE = "0";
		const term = new VirtualTerminal(100, 24);
		const { tui, writes } = await streamMutation(term);
		try {
			expect(writes.join("").match(ERASE_SCROLLBACK)).toBeNull();
			const checkpointStart = writes.length;
			const rebuilt = tui.refreshNativeScrollbackIfDirty({ allowUnknownViewport: true });
			await settle(term);
			expect(rebuilt).toBe(true);
			expect(writes.slice(checkpointStart).join("").match(ERASE_SCROLLBACK)).not.toBeNull();
		} finally {
			tui.stop();
		}
	});
});
