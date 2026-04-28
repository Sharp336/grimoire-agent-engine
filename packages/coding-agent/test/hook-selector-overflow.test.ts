import { beforeAll, describe, expect, it } from "bun:test";
import { HookSelectorComponent } from "@oh-my-pi/pi-coding-agent/modes/components/hook-selector";
import { getThemeByName, setThemeInstance } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { visibleWidth } from "@oh-my-pi/pi-tui";

beforeAll(async () => {
	const theme = await getThemeByName("dark");
	if (!theme) {
		throw new Error("Failed to load dark theme for tests");
	}
	setThemeInstance(theme);
});
describe("HookSelectorComponent", () => {
	it("keeps outlined options within render width", () => {
		const options = [
			"aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;b",
			"bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;a",
			"a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b",
		];
		const component = new HookSelectorComponent(
			"Which pattern do you prefer?",
			options,
			() => {},
			() => {},
			{ outline: true, initialIndex: 0 },
		);

		const width = 80;
		const lines = component.render(width);
		for (const line of lines) {
			expect(visibleWidth(Bun.stripANSI(line))).toBeLessThanOrEqual(width);
		}
	});

	it("renders selected option preview without overflow in stacked layout", () => {
		const options = [
			"Short option",
			"This is a very long option with multiple wrapped segments and a distinct tail marker tail-token-XYZ so the preview can show content beyond the list truncation boundary.",
		];
		const component = new HookSelectorComponent("Choose one", options, () => {}, () => {}, { initialIndex: 1 });
		const width = 80;
		const lines = component.render(width);
		const plain = lines.map(line => Bun.stripANSI(line));

		expect(plain.some(line => line.includes("Preview"))).toBe(true);
		expect(plain.some(line => line.includes("tail-token-XYZ"))).toBe(true);
		for (const line of lines) {
			expect(visibleWidth(Bun.stripANSI(line))).toBeLessThanOrEqual(width);
		}
	});

	it("renders selected option preview without overflow in split layout", () => {
		const options = [
			"Short option",
			"This is a very long option with multiple wrapped segments and a distinct tail marker tail-token-SPLIT so the split preview can show readable content.",
		];
		const component = new HookSelectorComponent("Choose one", options, () => {}, () => {}, { initialIndex: 1 });
		const width = 120;
		const lines = component.render(width);
		const plain = lines.map(line => Bun.stripANSI(line));

		expect(plain.some(line => line.includes("Preview"))).toBe(true);
		expect(plain.some(line => line.includes("tail-token-SPLIT"))).toBe(true);
		for (const line of lines) {
			expect(visibleWidth(Bun.stripANSI(line))).toBeLessThanOrEqual(width);
		}
	});
	it("preserves selector key behaviors with preview enabled", () => {
		const selected: string[] = [];
		let cancelled = 0;
		let left = 0;
		let right = 0;
		const options = ["first option", "second option with additional text"];
		const component = new HookSelectorComponent(
			"Choose one",
			options,
			option => selected.push(option),
			() => {
				cancelled++;
			},
			{
				initialIndex: 0,
				onLeft: () => {
					left++;
				},
				onRight: () => {
					right++;
				},
			},
		);

		component.handleInput("j");
		component.handleInput("\n");
		component.handleInput("\x1b[D");
		component.handleInput("\x1b[C");
		component.handleInput("\x1b");

		expect(selected).toEqual(["second option with additional text"]);
		expect(left).toBe(1);
		expect(right).toBe(1);
		expect(cancelled).toBe(1);
	});
});