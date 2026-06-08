import { afterEach, describe, expect, it, vi } from "bun:test";
import { type AppViewportScrollRegion, type Component, CURSOR_MARKER, type Focusable, TUI } from "@oh-my-pi/pi-tui";
import { VirtualTerminal } from "./virtual-terminal";

afterEach(() => {
	vi.restoreAllMocks();
});

class TranscriptComponent implements Component, AppViewportScrollRegion {
	#lines: string[];

	constructor(lines: string[]) {
		this.#lines = [...lines];
	}

	append(line: string): void {
		this.#lines.push(line);
	}

	invalidate(): void {
		// No cached state.
	}

	getAppViewportScrollRegionStart(): number | undefined {
		return 0;
	}

	getAppViewportScrollRegionEnd(): number | undefined {
		return this.#lines.length;
	}

	render(_width: number): string[] {
		return [...this.#lines];
	}
}

class StaticLines implements Component {
	constructor(private readonly lines: string[]) {}

	invalidate(): void {
		// No cached state.
	}

	render(_width: number): string[] {
		return [...this.lines];
	}
}

class WidthFill implements Component {
	invalidate(): void {
		// No cached state.
	}

	render(width: number): string[] {
		return ["A".repeat(width)];
	}
}

class CursorLine implements Component, Focusable {
	focused = false;

	invalidate(): void {
		// No cached state.
	}

	render(): string[] {
		return [`prompt>${this.focused ? CURSOR_MARKER : ""}`];
	}
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

async function flushRender(term: VirtualTerminal): Promise<void> {
	const nextTick = Promise.withResolvers<void>();
	process.nextTick(nextTick.resolve);
	await nextTick.promise;
	await Bun.sleep(1);
	await term.flush();
}

async function withEnv(name: string, value: string, run: () => Promise<void>): Promise<void> {
	const previous = Bun.env[name];
	Bun.env[name] = value;
	try {
		await run();
	} finally {
		if (previous === undefined) {
			delete Bun.env[name];
		} else {
			Bun.env[name] = previous;
		}
	}
}

function viewportContent(term: VirtualTerminal): string[] {
	return term.getViewport().map(line => line.replace(/[ \t]*[\u2800-\u28ff]?$/, "").trim());
}

function viewportScrollbarRows(term: VirtualTerminal): number[] {
	const rows: number[] = [];
	const viewport = term.getViewport();
	for (let row = 0; row < viewport.length; row++) {
		const code = viewport[row]?.trimEnd().codePointAt((viewport[row]?.trimEnd().length ?? 1) - 1) ?? 0;
		if (code >= 0x2800 && code <= 0x28ff) rows.push(row);
	}
	return rows;
}

describe("TUI app viewport backend", () => {
	it("keeps transcript app-scrolled and sticky chrome fixed without ED3 frames", async () => {
		await withEnv("PI_TUI_RENDER_BACKEND", "app-viewport", async () => {
			const term = new VirtualTerminal(40, 5);
			const writes = captureWrites(term);
			const transcript = new TranscriptComponent(Array.from({ length: 10 }, (_value, index) => `row-${index}`));
			const tui = new TUI(term);
			tui.addChild(transcript);
			tui.addChild(new StaticLines(["status", "editor"]));

			let stopped = false;
			try {
				tui.start();
				await flushRender(term);

				expect(writes.join("")).toContain("\x1b[?1049h");
				expect(writes.join("")).not.toContain("\x1b[3J");
				expect(viewportContent(term)).toEqual(["row-7", "row-8", "row-9", "status", "editor"]);
				expect(viewportScrollbarRows(term)).toEqual([2]);

				expect(writes.join("")).toContain("\x1b[?1000h\x1b[?1006h");
				term.sendInput("\x1b[<64;1;1M");
				await flushRender(term);
				expect(viewportContent(term)).toEqual(["row-4", "row-5", "row-6", "status", "editor"]);
				expect(viewportScrollbarRows(term)).toEqual([1, 2]);

				term.sendInput("\x1b[<65;1;1M");
				await flushRender(term);
				expect(viewportContent(term)).toEqual(["row-7", "row-8", "row-9", "status", "editor"]);
				expect(viewportScrollbarRows(term)).toEqual([2]);

				term.sendInput("\x1b[5~");
				await flushRender(term);
				expect(viewportContent(term)).toEqual(["row-4", "row-5", "row-6", "status", "editor"]);

				transcript.append("row-10");
				transcript.append("row-11");
				tui.requestRender(true);
				await flushRender(term);
				expect(viewportContent(term)).toEqual(["row-4", "row-5", "row-6", "status", "editor"]);

				term.sendInput("\x1b[6~");
				term.sendInput("\x1b[6~");
				await flushRender(term);
				expect(viewportContent(term)).toEqual(["row-9", "row-10", "row-11", "status", "editor"]);

				transcript.append("row-12");
				tui.requestRender(true);
				await flushRender(term);
				expect(viewportContent(term)).toEqual(["row-10", "row-11", "row-12", "status", "editor"]);

				expect(writes.join("")).not.toContain("\x1b[3J");

				tui.stop();
				stopped = true;
				expect(writes.join("")).toContain("\x1b[?1049l");
			} finally {
				if (!stopped) tui.stop();
			}
		});
	});

	it("does not duplicate sticky chrome when transcript is shorter than the viewport", async () => {
		await withEnv("PI_TUI_RENDER_BACKEND", "app-viewport", async () => {
			const term = new VirtualTerminal(40, 8);
			const transcript = new TranscriptComponent(["short"]);
			const tui = new TUI(term);
			tui.addChild(transcript);
			tui.addChild(new StaticLines(["status", "editor"]));

			try {
				tui.start();
				await flushRender(term);
				expect(viewportContent(term)).toEqual(["short", "", "", "", "", "", "status", "editor"]);
			} finally {
				tui.stop();
			}
		});
	});

	it("reserves one content column for the scrollbar", async () => {
		await withEnv("PI_TUI_RENDER_BACKEND", "app-viewport", async () => {
			const term = new VirtualTerminal(8, 3);
			const tui = new TUI(term);
			tui.addChild(new TranscriptComponent(["row-0", "row-1", "row-2", "row-3", "row-4"]));
			tui.addChild(new WidthFill());

			try {
				tui.start();
				await flushRender(term);
				expect(viewportContent(term)).toEqual(["row-3", "row-4", "AAAAAAA"]);
			} finally {
				tui.stop();
			}
		});
	});
	it("positions the hardware cursor in sticky chrome", async () => {
		await withEnv("PI_TUI_RENDER_BACKEND", "app-viewport", async () => {
			const term = new VirtualTerminal(40, 5);
			const writes = captureWrites(term);
			const tui = new TUI(term, true);
			const cursor = new CursorLine();
			tui.addChild(new TranscriptComponent(["row-0", "row-1", "row-2", "row-3"]));
			tui.addChild(cursor);
			tui.setFocus(cursor);

			try {
				tui.start();
				await flushRender(term);
				expect(viewportContent(term)).toEqual(["row-0", "row-1", "row-2", "row-3", "prompt>"]);
				expect(term.getCursor()).toEqual({ row: 4, col: 7 });
				expect(writes.join("")).toContain("\x1b[?25h");
			} finally {
				tui.stop();
			}
		});
	});

	it("stays on the native renderer unless the app viewport backend is requested", async () => {
		await withEnv("PI_TUI_RENDER_BACKEND", "", async () => {
			const term = new VirtualTerminal(40, 5);
			const writes = captureWrites(term);
			const tui = new TUI(term);
			tui.addChild(new StaticLines(["one", "two"]));

			try {
				tui.start();
				await flushRender(term);
				expect(writes.join("")).not.toContain("\x1b[?1049h");
			} finally {
				tui.stop();
			}
		});
	});
});
