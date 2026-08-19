import { describe, expect, it } from "bun:test";
import { type Component, TUI } from "@oh-my-pi/pi-tui";
import { VirtualTerminal } from "./virtual-terminal";

class RenderProbe implements Component {
	constructor(private readonly events: string[]) {}

	render(): string[] {
		this.events.push("render");
		return [];
	}
}

describe("TUI start listeners", () => {
	it("fires registered hooks on initial start and restart", () => {
		const tui = new TUI(new VirtualTerminal(80, 24));
		let starts = 0;
		tui.addStartListener(() => {
			starts++;
		});

		try {
			tui.start();
			expect(starts).toBe(1);

			tui.stop();
			tui.start();
			expect(starts).toBe(2);
		} finally {
			tui.stop();
		}
	});

	it("runs start hooks before the initial render", async () => {
		const events: string[] = [];
		const tui = new TUI(new VirtualTerminal(80, 24));
		tui.addChild(new RenderProbe(events));
		tui.addStartListener(() => {
			events.push("start");
		});

		try {
			tui.start();
			await Bun.sleep(50);
			expect(events[0]).toBe("start");
			expect(events).toContain("render");
		} finally {
			tui.stop();
		}
	});
});
