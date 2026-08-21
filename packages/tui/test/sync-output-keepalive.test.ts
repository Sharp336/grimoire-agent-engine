import { afterEach, describe, expect, it, vi } from "bun:test";
import { type Component, TUI } from "@oh-my-pi/pi-tui";
import { VirtualTerminal } from "./virtual-terminal";

class LongFrame implements Component {
	readonly #lines = Array.from({ length: 200 }, (_value, index) => `row-${index}`);

	invalidate(): void {}

	render(): readonly string[] {
		return this.#lines;
	}
}

const savedSync = Bun.env.PI_TUI_SYNC_OUTPUT;

afterEach(() => {
	if (savedSync === undefined) delete Bun.env.PI_TUI_SYNC_OUTPUT;
	else Bun.env.PI_TUI_SYNC_OUTPUT = savedSync;
	vi.restoreAllMocks();
});

describe("long synchronized full paints", () => {
	it("refreshes DEC 2026 before a terminal synchronization timeout can expose replay rows", async () => {
		Bun.env.PI_TUI_SYNC_OUTPUT = "1";
		const term = new VirtualTerminal(40, 10, 1_000);
		const writes: string[] = [];
		const realWrite = term.write.bind(term);
		vi.spyOn(term, "write").mockImplementation((data: string) => {
			writes.push(data);
			realWrite(data);
		});
		const tui = new TUI(term);
		tui.addChild(new LongFrame());

		try {
			tui.start();
			await term.waitForRender();
			const paint = writes.find(write => write.includes("row-199"));
			expect(paint).toBeDefined();
			expect(paint?.match(/\x1b\[\?2026h/g)?.length).toBeGreaterThanOrEqual(4);
			expect(paint?.match(/\x1b\[\?2026l/g)?.length).toBe(1);
		} finally {
			tui.stop();
		}
	});
});
