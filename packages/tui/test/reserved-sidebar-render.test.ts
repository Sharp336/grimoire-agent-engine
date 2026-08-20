import { afterEach, describe, expect, it } from "bun:test";
import { type Component, TUI } from "@oh-my-pi/pi-tui";
import { VirtualTerminal } from "./virtual-terminal";

class WidthAndTextProbe implements Component {
	readonly widths: number[] = [];
	constructor(private readonly prefix: string, private readonly rows = 1) {}
	render(width: number): readonly string[] {
		this.widths.push(width);
		return Array.from({ length: this.rows }, (_, index) => `${this.prefix}-${index}`);
	}
	get lastWidth(): number | undefined {
		return this.widths.at(-1);
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

	it("restores full-width main rendering after unmount", async () => {
		const { terminal, tui, main } = await createMounted();
		tui.setRightSidebar(undefined);
		await terminal.waitForRender(() => main.lastWidth === 120);
		expect(main.lastWidth).toBe(120);
		expect(terminal.getViewport().some(line => line.includes("SIDE-"))).toBe(false);
	});
});
