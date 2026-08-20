import { beforeAll, describe, expect, it, mock } from "bun:test";
import { type Component, Container } from "@oh-my-pi/pi-tui";
import type { ExtensionWidgetOptions, WidgetPlacement } from "../src/extensibility/extensions";
import { ExtensionUiController } from "../src/modes/controllers/extension-ui-controller";
import { getThemeByName, setThemeInstance } from "../src/modes/theme/theme";

beforeAll(async () => {
	const dark = await getThemeByName("dark");
	if (!dark) throw new Error("Failed to load dark theme");
	setThemeInstance(dark);
});

class Probe implements Component {
	disposeCalls = 0;

	constructor(private readonly lines: readonly string[]) {}

	render(): readonly string[] {
		return this.lines;
	}

	dispose(): void {
		this.disposeCalls++;
	}
}

function createController() {
	const mounted: Array<{ component: Component | undefined; options: unknown }> = [];
	const setRightSidebar = mock((component: Component | undefined, options?: unknown) => {
		mounted.push({ component, options });
	});
	const requestRender = mock(() => {});
	const showError = mock((_message: string) => {});
	const hookWidgetContainerAbove = new Container();
	const hookWidgetContainerBelow = new Container();
	const ctx = {
		ui: { requestRender, setRightSidebar },
		hookWidgetContainerAbove,
		hookWidgetContainerBelow,
		showError,
	} as never;

	return {
		controller: new ExtensionUiController(ctx),
		hookWidgetContainerAbove,
		hookWidgetContainerBelow,
		mounted,
		requestRender,
		setRightSidebar,
		showError,
	};
}

const rightSidebarPlacement: WidgetPlacement = "rightSidebar";
const rightSidebarDefaults = {
	placement: rightSidebarPlacement,
} satisfies ExtensionWidgetOptions;

describe("ExtensionUiController rightSidebar widgets", () => {
	it("aggregates keyed widgets in stable order and resolves the strictest geometry", () => {
		const { controller, mounted } = createController();
		controller.setHookWidget("a", ["A"], {
			placement: "rightSidebar",
			width: 46,
			minWidth: 24,
			minMainWidth: 60,
		});
		controller.setHookWidget("b", ["B"], {
			placement: "rightSidebar",
			minWidth: 30,
			minMainWidth: 70,
		});

		expect(mounted.at(-1)?.options).toEqual({ width: 46, minWidth: 30, minMainWidth: 70 });
		const lines = mounted.at(-1)?.component?.render(45) ?? [];
		const aIndex = lines.findIndex(line => line.includes("A"));
		const bIndex = lines.findIndex(line => line.includes("B"));
		expect(aIndex).toBeGreaterThanOrEqual(0);
		expect(bIndex).toBeGreaterThanOrEqual(0);
		expect(aIndex).toBeLessThan(bIndex);
	});

	it("removes and disposes only the matching key, then unmounts the final key", () => {
		const { controller, mounted } = createController();
		const first = new Probe(["A"]);
		const second = new Probe(["B"]);
		controller.setHookWidget("a", () => first, rightSidebarDefaults);
		controller.setHookWidget("b", () => second, rightSidebarDefaults);

		controller.setHookWidget("a", undefined, rightSidebarDefaults);

		expect(first.disposeCalls).toBe(1);
		expect(second.disposeCalls).toBe(0);
		expect(
			mounted
				.at(-1)
				?.component?.render(43)
				.some(line => line.includes("B")),
		).toBe(true);

		controller.setHookWidget("b", undefined, rightSidebarDefaults);
		controller.setHookWidget("b", undefined, rightSidebarDefaults);

		expect(second.disposeCalls).toBe(1);
		expect(mounted.at(-1)?.component).toBeUndefined();
	});

	it("keeps component factories uncapped while retaining the string-array cap", () => {
		const { controller, mounted } = createController();
		const lines = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`);

		controller.setHookWidget("factory", () => new Probe(lines), rightSidebarDefaults);
		expect(mounted.at(-1)?.component?.render(80)).toHaveLength(12);

		controller.setHookWidget("factory", lines, rightSidebarDefaults);
		const rendered = mounted.at(-1)?.component?.render(80) ?? [];
		expect(rendered).toHaveLength(11);
		expect(rendered.at(-1)).toContain("widget truncated");
	});

	it("contains a throwing widget, removes it asynchronously, disposes once, and reports a sanitized error", async () => {
		const { controller, mounted, showError } = createController();
		const dispose = mock(() => {});
		controller.setHookWidget(
			"broken",
			() => ({
				render: () => {
					throw new Error("sensitive render detail");
				},
				dispose,
			}),
			rightSidebarDefaults,
		);

		expect(() => mounted.at(-1)?.component?.render(43)).not.toThrow();
		expect(dispose).not.toHaveBeenCalled();
		await Promise.resolve();

		expect(mounted.at(-1)?.component).toBeUndefined();
		expect(dispose).toHaveBeenCalledTimes(1);
		expect(showError).toHaveBeenCalledTimes(1);
		expect(showError).toHaveBeenCalledWith('Extension widget "broken" render failed');
	});

	it("does not let a stale render failure remove a replacement with the same key", async () => {
		const { controller, mounted, showError } = createController();
		const failedDispose = mock(() => {});
		const replacement = new Probe(["replacement"]);
		controller.setHookWidget(
			"shared",
			() => ({
				render: () => {
					throw new Error("stale failure");
				},
				dispose: failedDispose,
			}),
			rightSidebarDefaults,
		);
		mounted.at(-1)?.component?.render(43);

		controller.setHookWidget("shared", () => replacement, rightSidebarDefaults);
		await Promise.resolve();

		expect(failedDispose).toHaveBeenCalledTimes(1);
		expect(replacement.disposeCalls).toBe(0);
		expect(mounted.at(-1)?.component?.render(43)).toContain("replacement");
		expect(showError).not.toHaveBeenCalled();
	});

	it("fully cleans up every placement and unmounts the aggregate", () => {
		const { controller, hookWidgetContainerAbove, hookWidgetContainerBelow, mounted, setRightSidebar } =
			createController();
		const above = new Probe(["above"]);
		const below = new Probe(["below"]);
		const rightA = new Probe(["right A"]);
		const rightB = new Probe(["right B"]);
		controller.setHookWidget("above", () => above);
		controller.setHookWidget("below", () => below, { placement: "belowEditor" });
		controller.setHookWidget("right-a", () => rightA, rightSidebarDefaults);
		controller.setHookWidget("right-b", () => rightB, rightSidebarDefaults);

		controller.clearHookWidgets();
		controller.clearHookWidgets();

		expect(above.disposeCalls).toBe(1);
		expect(below.disposeCalls).toBe(1);
		expect(rightA.disposeCalls).toBe(1);
		expect(rightB.disposeCalls).toBe(1);
		expect(hookWidgetContainerAbove.children).toHaveLength(1);
		expect(hookWidgetContainerBelow.children).toHaveLength(0);
		expect(mounted.at(-1)?.component).toBeUndefined();
		expect(setRightSidebar).toHaveBeenLastCalledWith(undefined);
	});
});
