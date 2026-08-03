import { describe, expect, test } from "bun:test";
import {
	applyDisabledExtensionsToState,
	applyExtensionEnabledToState,
} from "@oh-my-pi/pi-coding-agent/modes/components/extensions/state-manager";
import type { DashboardState, Extension } from "@oh-my-pi/pi-coding-agent/modes/components/extensions/types";

function extension(overrides: Partial<Extension> & Pick<Extension, "id">): Extension {
	return {
		kind: "skill",
		name: overrides.id.replace(/^skill:/, ""),
		displayName: overrides.id.replace(/^skill:/, ""),
		path: `/tmp/${overrides.id}`,
		source: { provider: "native", providerName: "Native", level: "native" },
		state: "active",
		raw: {},
		...overrides,
	};
}

function dashboardState(extensions: Extension[], selected: Extension | null = extensions[0] ?? null): DashboardState {
	return {
		tabs: [{ id: "all", label: "ALL", enabled: true, count: extensions.length }],
		activeTabIndex: 0,
		extensions,
		tabFiltered: extensions,
		searchFiltered: extensions,
		searchQuery: "",
		listIndex: 0,
		scrollOffset: 0,
		selected,
	};
}

describe("applyDisabledExtensionsToState", () => {
	test("immediately applies item-disabled state to every visible dashboard slice", () => {
		const selected = extension({ id: "skill:alpha" });
		const state = dashboardState([selected, extension({ id: "skill:beta" })], selected);

		const next = applyDisabledExtensionsToState(state, ["skill:alpha"]);

		expect(next.extensions[0]).toMatchObject({
			id: "skill:alpha",
			state: "disabled",
			disabledReason: "item-disabled",
		});
		expect(next.tabFiltered[0]).toMatchObject({
			id: "skill:alpha",
			state: "disabled",
			disabledReason: "item-disabled",
		});
		expect(next.searchFiltered[0]).toMatchObject({
			id: "skill:alpha",
			state: "disabled",
			disabledReason: "item-disabled",
		});
		expect(next.selected).toMatchObject({ id: "skill:alpha", state: "disabled", disabledReason: "item-disabled" });
		expect(next.extensions[1]).toMatchObject({ id: "skill:beta", state: "active" });
	});

	test("restores a previously item-disabled shadowed extension as shadowed", () => {
		const shadowed = extension({
			id: "skill:shadowed",
			state: "disabled",
			disabledReason: "item-disabled",
			shadowedBy: "skill:shadowing",
		});
		const state = dashboardState([shadowed], shadowed);

		const next = applyDisabledExtensionsToState(state, []);

		expect(next.extensions[0]).toMatchObject({
			id: "skill:shadowed",
			state: "shadowed",
			disabledReason: "shadowed",
			shadowedBy: "skill:shadowing",
		});
		expect(next.selected).toMatchObject({ id: "skill:shadowed", state: "shadowed", disabledReason: "shadowed" });
	});
});

describe("applyExtensionEnabledToState", () => {
	test("keeps a pending plugin state consistent across refreshed dashboard slices", () => {
		const plugin = extension({
			id: "plugin:rapid",
			kind: "plugin",
			state: "disabled",
			disabledReason: "item-disabled",
		});
		const next = applyExtensionEnabledToState(dashboardState([plugin], plugin), plugin.id, true);

		for (const projected of [next.extensions[0], next.tabFiltered[0], next.searchFiltered[0], next.selected]) {
			expect(projected).toMatchObject({ id: plugin.id, state: "active" });
			expect(projected?.disabledReason).toBeUndefined();
		}
	});
});
