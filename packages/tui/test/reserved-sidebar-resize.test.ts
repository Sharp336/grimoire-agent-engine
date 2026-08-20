import { afterEach, describe, expect, it } from "bun:test";
import { type Component, TUI, type ViewportTailProvider } from "@oh-my-pi/pi-tui";
import { createProcessTerminalRenderHarness, WidthProbe } from "./process-terminal-render-harness";
import { VirtualTerminal } from "./virtual-terminal";

const disposers: Array<() => void> = [];
afterEach(() => {
	for (const dispose of disposers.splice(0)) dispose();
});

class StaticSidebar implements Component {
	readonly widths: number[] = [];
	readonly inputs: string[] = [];
	invalidations = 0;
	line = "SIDEBAR";

	render(width: number): readonly string[] {
		this.widths.push(width);
		return [this.line];
	}

	handleInput(data: string): void {
		this.inputs.push(data);
	}

	invalidate(): void {
		this.invalidations++;
	}
}

const DIRECT_RESIZE_ENV: Record<string, string | undefined> = {
	TMUX: undefined,
	STY: undefined,
	ZELLIJ: undefined,
	HERDR_ENV: undefined,
	CMUX_WORKSPACE_ID: undefined,
	CMUX_SURFACE_ID: undefined,
	CMUX_REMOTE_TRANSPORT: undefined,
	TERM_PROGRAM: undefined,
	PI_TUI_RESIZE_IN_PLACE: "0",
};

async function withEnvPatch<T>(patch: Record<string, string | undefined>, run: () => T | Promise<T>): Promise<T> {
	const saved: Record<string, string | undefined> = {};
	for (const key in patch) {
		saved[key] = Bun.env[key];
		const value = patch[key];
		if (value === undefined) delete Bun.env[key];
		else Bun.env[key] = value;
	}
	try {
		return await run();
	} finally {
		for (const key in saved) {
			const value = saved[key];
			if (value === undefined) delete Bun.env[key];
			else Bun.env[key] = value;
		}
	}
}

class ContextTail implements Component, ViewportTailProvider {
	readonly maxRows: number[] = [];
	readonly rows = Array.from({ length: 30 }, (_, index) => `MAIN-${index}`);

	render(width: number): readonly string[] {
		return this.rows.map(line => line.slice(0, width));
	}

	renderViewportTail(width: number, maxRows: number): readonly string[] {
		this.maxRows.push(maxRows);
		return this.rows.slice(-maxRows).map(line => line.slice(0, width));
	}
}

class IndexedSidebar implements Component {
	render(): readonly string[] {
		return Array.from({ length: 30 }, (_, index) => `SIDE-${index}`);
	}
}

describe("reserved sidebar resize behavior", () => {
	it("hides below 92 columns and restores without remounting", async () => {
		const harness = createProcessTerminalRenderHarness(120, 20);
		disposers.push(() => harness.dispose());
		const side = new StaticSidebar();
		harness.tui.setRightSidebar(side, { width: 44, minWidth: 28, minMainWidth: 64 });
		await harness.settle();
		expect(harness.probe.last).toBe(76);
		expect(side.widths.at(-1)).toBe(43);

		await harness.osResize(91, 20);
		expect(harness.probe.last).toBe(91);
		expect(side.widths.at(-1)).toBe(43);

		await harness.osResize(92, 20);
		expect(harness.probe.last).toBe(64);
		expect(side.widths.at(-1)).toBe(27);
	});

	it("renders overlays above both main and sidebar and restores the sidebar", async () => {
		const terminal = new VirtualTerminal(120, 8);
		const tui = new TUI(terminal);
		const main = new WidthProbe();
		const side = new StaticSidebar();
		tui.addChild(main);
		tui.setRightSidebar(side, { width: 44, minWidth: 28, minMainWidth: 64 });
		tui.start();
		disposers.push(() => tui.stop());
		await terminal.waitForRender(() => terminal.getViewport().some(line => line.includes("SIDEBAR")));

		const overlay = tui.showOverlay({ render: () => ["MODAL"] }, { anchor: "top-right", width: 44 });
		await terminal.waitForRender(() => terminal.getViewport().some(line => line.includes("MODAL")));
		const coveredRow = terminal.getViewport().find(line => line.includes("MODAL"));
		expect(coveredRow).not.toContain("SIDEBAR");

		overlay.hide();
		await terminal.waitForRender(() => terminal.getViewport().some(line => line.includes("SIDEBAR")));
		expect(terminal.getViewport().some(line => line.includes("SIDEBAR"))).toBe(true);
	});

	it("keeps input focus on main content and invalidates the sidebar", async () => {
		const terminal = new VirtualTerminal(120, 8);
		const tui = new TUI(terminal);
		const mainInputs: string[] = [];
		const main: Component = {
			render: () => ["MAIN"],
			handleInput: data => mainInputs.push(data),
		};
		const side = new StaticSidebar();
		tui.addChild(main);
		tui.setFocus(main);
		tui.setRightSidebar(side, { width: 44, minWidth: 28, minMainWidth: 64 });
		tui.start();
		disposers.push(() => tui.stop());
		await terminal.waitForRender();
		terminal.sendInput("x");
		expect(mainInputs).toEqual(["x"]);
		expect(side.inputs).toEqual([]);
		tui.invalidate();
		expect(side.invalidations).toBe(1);
	});

	it("falls back to a full paint for sidebar-scoped render requests", async () => {
		const terminal = new VirtualTerminal(120, 8);
		const tui = new TUI(terminal);
		const side = new StaticSidebar();
		tui.addChild({ render: () => ["MAIN"] });
		tui.setRightSidebar(side, { width: 44, minWidth: 28, minMainWidth: 64 });
		tui.start();
		disposers.push(() => tui.stop());
		await terminal.waitForRender(() => terminal.getViewport().some(line => line.includes("SIDEBAR")));
		side.line = "UPDATED";
		tui.requestComponentRender(side);
		await terminal.waitForRender(() => terminal.getViewport().some(line => line.includes("UPDATED")));
		expect(terminal.getViewport().some(line => line.includes("UPDATED"))).toBe(true);
	});

	it("composes the resize sidebar onto visible rows without consuming context rows", async () => {
		await withEnvPatch(DIRECT_RESIZE_ENV, async () => {
			const terminal = new VirtualTerminal(120, 8, 100);
			const tui = new TUI(terminal);
			const main = new ContextTail();
			tui.addChild(main);
			tui.setRightSidebar(new IndexedSidebar(), { width: 44, minWidth: 28, minMainWidth: 64 });
			tui.start();
			disposers.push(() => tui.stop());
			await terminal.waitForRender(() => terminal.getViewport().some(line => line.includes("SIDE-7")));

			terminal.resize(119, 8);
			await terminal.flush();

			expect(tui.resizeViewportActive).toBe(true);
			expect(main.maxRows.at(-1)).toBeGreaterThan(8);
			const viewport = terminal.getViewport();
			expect(viewport[0]).toContain("SIDE-0");
			expect(viewport[7]).toContain("SIDE-7");
		});
	});
});
