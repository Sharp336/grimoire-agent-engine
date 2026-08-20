import { afterEach, describe, expect, it } from "bun:test";
import { type Component, TUI } from "@oh-my-pi/pi-tui";
import { StressRenderScheduler } from "./render-stress-scheduler";
import { VirtualTerminal } from "./virtual-terminal";

class WidthAndTextProbe implements Component {
	readonly widths: number[] = [];
	constructor(
		private readonly prefix: string,
		private readonly rows = 1,
	) {}
	render(width: number): readonly string[] {
		this.widths.push(width);
		return Array.from({ length: this.rows }, (_, index) => `${this.prefix}-${index}`);
	}
	get lastWidth(): number | undefined {
		return this.widths.at(-1);
	}
}

class MutableWidthAndTextProbe implements Component {
	readonly widths: number[] = [];

	constructor(public text: string) {}

	render(width: number): readonly string[] {
		this.widths.push(width);
		return [this.text];
	}
}

class MutableLinesProbe implements Component {
	constructor(readonly lines: string[]) {}

	render(): readonly string[] {
		return this.lines;
	}
}

class RenderCountingTUI extends TUI {
	renders = 0;

	override render(width: number): readonly string[] {
		this.renders++;
		return super.render(width);
	}
}

const active: Array<{ tui: TUI; terminal: VirtualTerminal }> = [];
afterEach(() => {
	for (const entry of active.splice(0)) entry.tui.stop();
});

async function createMounted(rows = 8) {
	const terminal = new VirtualTerminal(120, rows, 100);
	const tui = new TUI(terminal);
	const main = new WidthAndTextProbe("MAIN", rows + 8);
	const side = new WidthAndTextProbe("SIDE", rows);
	tui.addChild(main);
	tui.setRightSidebar(side, { width: 44, minWidth: 28, minMainWidth: 64 });
	tui.start();
	active.push({ tui, terminal });
	await terminal.waitForRender(() => terminal.getViewport().some(line => line.includes("SIDE-")));
	return { terminal, tui, main, side };
}

describe("TUI reserved right sidebar", () => {
	it("preserves default initial-paint scrollback semantics", async () => {
		const terminal = new VirtualTerminal(120, 8, 100);
		const writes: string[] = [];
		const write = terminal.write.bind(terminal);
		terminal.write = data => {
			writes.push(data);
			write(data);
		};
		const tui = new TUI(terminal);
		const main = new WidthAndTextProbe("MAIN");
		tui.addChild(main);
		tui.start();
		active.push({ tui, terminal });
		await terminal.waitForRender(() => main.lastWidth === 120);
		expect(writes.join("")).not.toContain("\x1b[3J");
	});

	it("preserves existing history when the sidebar mounts before start", async () => {
		const terminal = new VirtualTerminal(120, 4, 100);
		terminal.write("EXISTING-HISTORY\r\nA\r\nB\r\nC\r\nD");
		expect(terminal.getScrollBuffer().some(line => line.includes("EXISTING-HISTORY"))).toBe(true);
		const writes: string[] = [];
		const write = terminal.write.bind(terminal);
		terminal.write = data => {
			writes.push(data);
			write(data);
		};
		const tui = new TUI(terminal);
		tui.addChild(new WidthAndTextProbe("MAIN"));
		tui.setRightSidebar(new WidthAndTextProbe("SIDE", 4), { width: 44, minWidth: 28, minMainWidth: 64 });
		tui.start();
		active.push({ tui, terminal });
		await terminal.waitForRender(() => terminal.getViewport().some(line => line.includes("SIDE-")));
		expect(writes.join("")).not.toContain("\x1b[3J");
		expect(terminal.getScrollBuffer().some(line => line.includes("EXISTING-HISTORY"))).toBe(true);
	});

	it("uses an ordinary render for same-geometry sidebar updates without clearing history", async () => {
		const terminal = new VirtualTerminal(120, 4, 100);
		terminal.write("EXISTING-HISTORY\r\nA\r\nB\r\nC\r\nD");
		const writes: string[] = [];
		const write = terminal.write.bind(terminal);
		terminal.write = data => {
			writes.push(data);
			write(data);
		};
		const tui = new TUI(terminal);
		tui.addChild(new WidthAndTextProbe("MAIN", 4));
		tui.setRightSidebar(new WidthAndTextProbe("OLD-SIDE", 4), {
			width: 44,
			minWidth: 28,
			minMainWidth: 64,
		});
		tui.start();
		active.push({ tui, terminal });
		await terminal.waitForRender(() => terminal.getViewport().some(line => line.includes("OLD-SIDE")));
		writes.length = 0;

		tui.setRightSidebar(new WidthAndTextProbe("NEW-SIDE", 4), {
			width: 44,
			minWidth: 28,
			minMainWidth: 64,
		});
		await terminal.waitForRender(() => terminal.getViewport().some(line => line.includes("NEW-SIDE")));

		expect(writes.join("")).not.toContain("\x1b[3J");
		expect(terminal.getScrollBuffer().some(line => line.includes("EXISTING-HISTORY"))).toBe(true);
	});

	it("still reflows with a destructive replay when sidebar geometry changes", async () => {
		const { terminal, tui, main } = await createMounted(4);
		const writes: string[] = [];
		const write = terminal.write.bind(terminal);
		terminal.write = data => {
			writes.push(data);
			write(data);
		};

		tui.setRightSidebar(new WidthAndTextProbe("NARROW-SIDE", 4), {
			width: 36,
			minWidth: 28,
			minMainWidth: 64,
		});
		await terminal.waitForRender(() => main.lastWidth === 84);

		expect(writes.join("")).toContain("\x1b[3J");
		expect(main.lastWidth).toBe(84);
	});

	it("keeps component-scoped composition on the allocated main width", async () => {
		const terminal = new VirtualTerminal(120, 8, 100);
		const scheduler = new StressRenderScheduler();
		const tui = new TUI(terminal, undefined, { renderScheduler: scheduler });
		const transcript = new WidthAndTextProbe("TRANSCRIPT");
		const spinner = new MutableWidthAndTextProbe("SPIN-0");
		tui.addChild(transcript);
		tui.addChild(spinner);
		tui.setRightSidebar(new WidthAndTextProbe("SIDE", 8), { width: 44, minWidth: 28, minMainWidth: 64 });
		tui.start();
		active.push({ tui, terminal });
		await scheduler.drain(terminal);
		const transcriptRenders = transcript.widths.length;

		spinner.text = "SPIN-1";
		tui.requestComponentRender(spinner);
		await scheduler.drain(terminal);

		expect(transcript.widths.length).toBe(transcriptRenders);
		expect(terminal.getViewport().some(line => line.includes("SPIN-1") && line.includes("SIDE-1"))).toBe(true);
	});

	it("keeps direct writes enabled on the allocated main width", async () => {
		const terminal = new VirtualTerminal(120, 8, 100);
		const scheduler = new StressRenderScheduler();
		const tui = new RenderCountingTUI(terminal, undefined, { renderScheduler: scheduler });
		const transcript = new WidthAndTextProbe("TRANSCRIPT");
		const spinner = new MutableWidthAndTextProbe("SPIN-0");
		tui.addChild(transcript);
		tui.addChild(spinner);
		tui.setRightSidebar(new WidthAndTextProbe("SIDE", 8), { width: 44, minWidth: 28, minMainWidth: 64 });
		tui.start();
		active.push({ tui, terminal });
		await scheduler.drain(terminal);
		const transcriptRenders = transcript.widths.length;
		const tuiRenders = tui.renders;

		spinner.text = "SPIN-1";
		tui.requestDirectWrite(spinner);
		await scheduler.drain(terminal);

		expect(transcript.widths.length).toBe(transcriptRenders);
		expect(tui.renders).toBe(tuiRenders);
		expect(terminal.getViewport().some(line => line.includes("SPIN-1") && line.includes("SIDE-1"))).toBe(true);
	});

	it("renders main and sidebar at their allocated widths", async () => {
		const { terminal, main, side } = await createMounted();
		expect(main.lastWidth).toBe(76);
		expect(side.lastWidth).toBe(43);
		expect(terminal.getViewport().some(line => line.includes("MAIN-") && line.includes("SIDE-"))).toBe(true);
	});

	it("keeps sidebar text out of native scrollback", async () => {
		const { terminal } = await createMounted(5);
		const { baseY } = terminal.getBufferPosition();
		const history = terminal.getScrollBuffer().slice(0, baseY);
		expect(baseY).toBeGreaterThan(0);
		expect(history.some(line => line.includes("SIDE-"))).toBe(false);
	});

	it("keeps the scroll-append fast path with a visible sidebar", async () => {
		const terminal = new VirtualTerminal(120, 5, 100);
		const writes: string[] = [];
		const write = terminal.write.bind(terminal);
		terminal.write = data => {
			writes.push(data);
			write(data);
		};
		const tui = new TUI(terminal);
		const main = new MutableLinesProbe(Array.from({ length: 8 }, (_, index) => `MAIN-${index}`));
		tui.addChild(main);
		tui.setRightSidebar({ render: () => ["SIDEBAR"] }, { width: 44, minWidth: 28, minMainWidth: 64 });
		tui.start();
		active.push({ tui, terminal });
		await terminal.waitForRender(() => terminal.getViewport().some(line => line.includes("MAIN-7")));
		const redraws = tui.fullRedraws;
		writes.length = 0;

		main.lines.push("MAIN-8");
		tui.requestRender();
		await terminal.waitForRender(() => terminal.getViewport().some(line => line.includes("MAIN-8")));

		const output = writes.join("");
		const rewrittenMainRows = new Set([...output.matchAll(/MAIN-\d+/g)].map(match => match[0]));
		expect(tui.fullRedraws).toBe(redraws);
		expect(rewrittenMainRows.size).toBeLessThan(5);
		const { baseY } = terminal.getBufferPosition();
		expect(terminal.getScrollBuffer().slice(0, baseY).some(line => line.includes("SIDEBAR"))).toBe(false);
	});

	it("does not erase a full-width sidebar suffix during scroll-append diffs", async () => {
		const terminal = new VirtualTerminal(120, 5, 100);
		const writes: string[] = [];
		const write = terminal.write.bind(terminal);
		terminal.write = data => {
			writes.push(data);
			write(data);
		};
		const tui = new TUI(terminal);
		const main = new MutableLinesProbe(Array.from({ length: 8 }, (_, index) => `MAIN-${index}`));
		tui.addChild(main);
		tui.setRightSidebar(
			{
				render: width =>
					Array.from({ length: 5 }, (_, index) => `${"s".repeat(width - 1)}${index}`),
			},
			{ width: 44, minWidth: 28, minMainWidth: 64 },
		);
		tui.start();
		active.push({ tui, terminal });
		await terminal.waitForRender(() => terminal.getViewport().some(line => line.includes("MAIN-7")));
		writes.length = 0;

		main.lines.push("MAIN-8");
		tui.requestRender();
		await terminal.waitForRender(() => terminal.getViewport().some(line => line.includes("MAIN-8")));

		expect(writes.join("")).not.toContain(`0\x1b[0m\x1b]8;;\x07\x1b[K`);
		const baseline = terminal.getViewport();
		expect(baseline[0]?.endsWith("0")).toBe(true);
		writes.length = 0;

		tui.requestRender();
		await terminal.waitForRender();
		expect(terminal.getViewport()).toEqual(baseline);
	});

	it("clears stale suffix cells when combining-heavy width is uncertain", async () => {
		const terminal = new VirtualTerminal(120, 5, 100);
		const tui = new TUI(terminal);
		const main = new MutableLinesProbe(Array.from({ length: 8 }, (_, index) => `MAIN-${index}`));
		tui.addChild(main);
		tui.setRightSidebar(
			{
				render: width => [
					"a\u064e".repeat(Math.ceil(width / 2)),
					"L".repeat(width),
					...Array.from({ length: 3 }, (_, index) => `short-${index}`),
				],
			},
			{ width: 44, minWidth: 28, minMainWidth: 64 },
		);
		tui.start();
		active.push({ tui, terminal });
		await terminal.waitForRender(() => terminal.getViewport().some(line => line.includes("MAIN-7")));

		main.lines.push("MAIN-8");
		tui.requestRender();
		await terminal.waitForRender(() => terminal.getViewport().some(line => line.includes("MAIN-8")));

		const baseline = terminal.getViewport();
		const firstSuffix = baseline[0]?.slice(76) ?? "";
		expect(firstSuffix).toContain("a");
		expect(firstSuffix).not.toContain("L");

		tui.requestRender();
		await terminal.waitForRender();
		expect(terminal.getViewport()).toEqual(baseline);
	});

	it("isolates main SGR and OSC 8 state before padding, separator, and sidebar", async () => {
		const terminal = new VirtualTerminal(120, 4, 100);
		const writes: string[] = [];
		const write = terminal.write.bind(terminal);
		terminal.write = data => {
			writes.push(data);
			write(data);
		};
		const tui = new TUI(terminal);
		tui.addChild({
			render: () => ["\x1b[31;41m\x1b]8;;https://example.test\x07MAIN"],
		});
		tui.setRightSidebar({ render: () => ["SIDEBAR"] }, { width: 44, minWidth: 28, minMainWidth: 64 });
		tui.start();
		active.push({ tui, terminal });
		await terminal.waitForRender(() => terminal.getViewport()[0]?.includes("SIDEBAR") ?? false);

		expect(writes.join("")).toContain("MAIN\x1b[0m\x1b]8;;\x07");
		expect(terminal.getViewportRowForegroundColumns(0)).toEqual([0, 1, 2, 3]);
		expect(terminal.getViewportRowBackgroundColumns(0)).toEqual([0, 1, 2, 3]);
		expect(terminal.getViewportRowHyperlinkColumns(0).some(column => column >= 76)).toBe(false);
	});

	it("restores full-width main rendering after unmount", async () => {
		const { terminal, tui, main } = await createMounted();
		tui.setRightSidebar(undefined);
		await terminal.waitForRender(() => main.lastWidth === 120);
		expect(main.lastWidth).toBe(120);
		expect(terminal.getViewport().some(line => line.includes("SIDE-"))).toBe(false);
	});
});
