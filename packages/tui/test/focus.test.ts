import { describe, expect, it } from "bun:test";
import { type Component, parseFocusEvent, TUI } from "@oh-my-pi/pi-tui";
import { VirtualTerminal } from "./virtual-terminal";

class InputProbe implements Component {
	constructor(private readonly events: string[]) {}

	invalidate(): void {}

	render(_width: number): readonly string[] {
		return ["probe"];
	}

	handleInput(data: string): void {
		this.events.push(data);
	}
}

describe("terminal focus tracking", () => {
	it("decodes CSI ?1004 focus reports exactly", () => {
		// CONTRACT: ESC[I is focus-in, ESC[O is focus-out, and the decoder is an
		// exact-prefix match — anything else is not a focus report, and trailing
		// bytes after the report are returned for downstream handling.
		expect(parseFocusEvent("\x1b[I")).toEqual({ focused: true, rest: "" });
		expect(parseFocusEvent("\x1b[Oabc")).toEqual({ focused: false, rest: "abc" });
		expect(parseFocusEvent("x\x1b[I")).toBeNull();
		expect(parseFocusEvent("\x1b[i")).toBeNull();
	});

	it("dispatches focus reports to subscribers and consumes them", () => {
		// CONTRACT: a focus report never reaches key handling — subscribers fire
		// and the sequence is swallowed (no key event on the focused component).
		const term = new VirtualTerminal(80, 8);
		const tui = new TUI(term);
		const events: string[] = [];
		const probe = new InputProbe(events);
		tui.addChild(probe);
		tui.setFocus(probe);
		const focusEvents: boolean[] = [];
		tui.onTerminalFocus(focused => focusEvents.push(focused));
		try {
			tui.start();
			term.sendInput("\x1b[I");
			expect(focusEvents).toEqual([true]);
			expect(events).toEqual([]);

			term.sendInput("\x1b[O");
			expect(focusEvents).toEqual([true, false]);
			expect(events).toEqual([]);
		} finally {
			tui.stop();
		}
	});

	it("passes non-focus remainder through to key handling and honors unsubscribe", () => {
		// CONTRACT: ESC[I followed by real input (`a`) still delivers `a` to the
		// focused component, and onTerminalFocus's returned unsubscribe stops
		// further dispatch.
		const term = new VirtualTerminal(80, 8);
		const tui = new TUI(term);
		const events: string[] = [];
		const probe = new InputProbe(events);
		tui.addChild(probe);
		tui.setFocus(probe);
		const focusEvents: boolean[] = [];
		const unsubscribe = tui.onTerminalFocus(focused => focusEvents.push(focused));
		try {
			tui.start();
			term.sendInput("\x1b[Ia");
			expect(focusEvents).toEqual([true]);
			expect(events).toEqual(["a"]);

			unsubscribe();
			term.sendInput("\x1b[I");
			expect(focusEvents).toEqual([true]);
			expect(events).toEqual(["a"]);
		} finally {
			tui.stop();
		}
	});

	it("dispatches consecutive batched focus reports in order", () => {
		// CONTRACT: a chunk carrying several focus reports (e.g. focus-out then
		// focus-in) dispatches every report in order; only the first non-focus
		// remainder reaches listeners/key handling.
		const term = new VirtualTerminal(80, 8);
		const tui = new TUI(term);
		const events: string[] = [];
		const probe = new InputProbe(events);
		tui.addChild(probe);
		tui.setFocus(probe);
		const focusEvents: boolean[] = [];
		tui.onTerminalFocus(focused => focusEvents.push(focused));
		try {
			tui.start();
			term.sendInput("\x1b[O\x1b[I");
			expect(focusEvents).toEqual([false, true]);
			expect(events).toEqual([]);

			term.sendInput("\x1b[I\x1b[Ia");
			expect(focusEvents).toEqual([false, true, true, true]);
			expect(events).toEqual(["a"]);
		} finally {
			tui.stop();
		}
	});

	it("strips a coalesced focus report before listeners so pastes stay intact", () => {
		// CONTRACT: ESC[I + an OSC 5522 clipboard packet arriving in one chunk
		// must reach the paste controller whole — focus parsing runs before the
		// listener loop, so the packet is not orphaned into key handling.
		const term = new VirtualTerminal(80, 8);
		const tui = new TUI(term);
		const events: string[] = [];
		const probe = new InputProbe(events);
		tui.addChild(probe);
		tui.setFocus(probe);
		const focusEvents: boolean[] = [];
		tui.onTerminalFocus(focused => focusEvents.push(focused));
		const pasted: string[] = [];
		tui.addInputListener(data => {
			if (!data.startsWith("\x1b]52;c;")) return undefined;
			pasted.push(data);
			return { consume: true };
		});
		try {
			tui.start();
			term.sendInput("\x1b[I\x1b]52;c;dGVzdA==\x07");
			expect(focusEvents).toEqual([true]);
			expect(pasted).toEqual(["\x1b]52;c;dGVzdA==\x07"]);
			expect(events).toEqual([]);
		} finally {
			tui.stop();
		}
	});
});
