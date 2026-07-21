import { afterEach, describe, expect, it, vi } from "bun:test";
import {
	type Component,
	isPreserveScrollbackEnabled,
	setPreserveScrollback,
	setTerminalScreenToScrollback,
	TERMINAL,
	TUI,
} from "@oh-my-pi/pi-tui";
import { VirtualTerminal } from "./virtual-terminal";

class MutableLinesComponent implements Component {
	#lines: string[];

	constructor(lines: string[]) {
		this.#lines = [...lines];
	}

	setLines(lines: string[]): void {
		this.#lines = [...lines];
	}

	invalidate(): void {}

	render(width: number): string[] {
		return this.#lines.map(line => line.slice(0, width));
	}
}

function rows(prefix: string, count: number): string[] {
	return Array.from({ length: count }, (_v, i) => `${prefix}${i}`);
}

async function settle(term: VirtualTerminal): Promise<void> {
	// Drain the scheduler's setImmediate hop, let the throttled render fire,
	// then flush the virtual terminal (same cadence as render-regressions).
	const immediate = Promise.withResolvers<void>();
	setImmediate(immediate.resolve);
	await immediate.promise;
	await Bun.sleep(1);
	await term.flush();
}

function captureWrites(term: VirtualTerminal): string[] {
	const writes: string[] = [];
	const realWrite = term.write.bind(term);
	vi.spyOn(term, "write").mockImplementation((data: string) => {
		writes.push(data);
		realWrite(data);
	});
	return writes;
}

function visible(term: VirtualTerminal): string[] {
	return term.getViewport().map(line => line.trimEnd());
}

async function withEnvPatch<T>(patch: Record<string, string | undefined>, run: () => T | Promise<T>): Promise<T> {
	const saved: Record<string, string | undefined> = {};
	for (const key in patch) {
		saved[key] = Bun.env[key];
		const value = patch[key];
		if (value === undefined) {
			delete Bun.env[key];
		} else {
			Bun.env[key] = value;
		}
	}
	try {
		return await run();
	} finally {
		for (const key in saved) {
			const value = saved[key];
			if (value === undefined) {
				delete Bun.env[key];
			} else {
				Bun.env[key] = value;
			}
		}
	}
}

const DIRECT_TERMINAL_ENV = { TMUX: undefined, STY: undefined, ZELLIJ: undefined, TERM: "xterm-256color" } as const;

describe("preserve scrollback", () => {
	afterEach(() => {
		setPreserveScrollback(false);
		vi.restoreAllMocks();
	});

	it("degrades a clearScrollback full paint to a non-destructive repaint when preservation is active", async () => {
		await withEnvPatch({ ...DIRECT_TERMINAL_ENV }, async () => {
			const savedScreenToScrollback = TERMINAL.supportsScreenToScrollback;
			setTerminalScreenToScrollback(false);
			setPreserveScrollback(true);
			expect(isPreserveScrollbackEnabled()).toBe(true);
			const term = new VirtualTerminal(24, 4);
			const tui = new TUI(term);
			const component = new MutableLinesComponent(rows("old-session-", 6));
			tui.addChild(component);
			const writes = captureWrites(term);

			try {
				tui.start();
				await settle(term);
				writes.length = 0;
				component.setLines(rows("resumed-", 5));

				// Session replacement gesture: the caller still requests a
				// destructive replace; only the history erase must be skipped.
				tui.requestRender(true, { clearScrollback: true });
				await settle(term);

				const out = writes.join("");
				expect(out).not.toContain("\x1b[3J");
				// The repaint still happens, via the non-destructive branch.
				expect(out).toContain("\x1b[2J\x1b[H");
				expect(visible(term)).toEqual(["resumed-1", "resumed-2", "resumed-3", "resumed-4"]);
			} finally {
				tui.stop();
				setTerminalScreenToScrollback(savedScreenToScrollback);
			}
		});
	});

	it("keeps the destructive ED3 replace when preservation is inactive", async () => {
		await withEnvPatch({ ...DIRECT_TERMINAL_ENV }, async () => {
			const savedScreenToScrollback = TERMINAL.supportsScreenToScrollback;
			setTerminalScreenToScrollback(false);
			setPreserveScrollback(false);
			const term = new VirtualTerminal(24, 4);
			const tui = new TUI(term);
			const component = new MutableLinesComponent(rows("old-session-", 6));
			tui.addChild(component);
			const writes = captureWrites(term);

			try {
				tui.start();
				await settle(term);
				writes.length = 0;
				component.setLines(rows("resumed-", 5));

				tui.requestRender(true, { clearScrollback: true });
				await settle(term);

				const out = writes.join("");
				expect(out).toContain("\x1b[H\x1b[3J");
				expect(visible(term)).toEqual(["resumed-1", "resumed-2", "resumed-3", "resumed-4"]);
			} finally {
				tui.stop();
				setTerminalScreenToScrollback(savedScreenToScrollback);
			}
		});
	});
});
