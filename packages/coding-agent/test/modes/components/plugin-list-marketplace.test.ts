import { beforeAll, describe, expect, it } from "bun:test";
import type { InstalledPluginSummary } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/marketplace/types";
import type { InstalledPlugin } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/types";
import { PluginListComponent, type PluginListEntry } from "@oh-my-pi/pi-coding-agent/modes/components/plugin-settings";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";

beforeAll(async () => {
	await initTheme();
});

function render(component: PluginListComponent, width = 200): string {
	return component
		.render(width)
		.map(line => Bun.stripANSI(line))
		.join("\n");
}

function npmEntry(name: string): PluginListEntry {
	const plugin: InstalledPlugin = {
		name,
		version: "1.0.0",
		path: `/fake/${name}`,
		manifest: { version: "1.0.0" },
		enabledFeatures: null,
		enabled: true,
	};
	return { kind: "npm", plugin };
}

function marketplaceEntry(id: string, opts: { enabled?: boolean; shadowed?: boolean } = {}): PluginListEntry {
	const summary: InstalledPluginSummary = {
		id,
		scope: "user",
		entries: [
			{
				scope: "user",
				installPath: `/fake/cache/${id}`,
				version: "1.2.3",
				installedAt: "2026-06-04T10:00:00Z",
				lastUpdated: "2026-06-04T10:00:00Z",
				enabled: opts.enabled,
			},
		],
		...(opts.shadowed ? { shadowedBy: "project" as const } : {}),
	};
	return { kind: "marketplace", plugin: summary };
}

describe("PluginListComponent — marketplace integration", () => {
	it("empty state mentions both npm and marketplace install paths", () => {
		const component = new PluginListComponent([], {
			onPluginSelect: () => {},
			onCancel: () => {},
		});

		const rendered = render(component);
		expect(rendered).toContain("No plugins installed");
		expect(rendered).toContain("omp plugin install <package>");
		expect(rendered).toContain("omp plugin install <name>@<marketplace>");
	});

	it("renders npm and marketplace entries with a distinguishing marketplace badge", () => {
		const component = new PluginListComponent([npmEntry("eslint-plugin"), marketplaceEntry("hyperpowers")], {
			onPluginSelect: () => {},
			onCancel: () => {},
		});

		const rendered = render(component);
		expect(rendered).toContain("eslint-plugin");
		expect(rendered).toContain("hyperpowers");
		// Marketplace entries carry the [mkt] badge; npm entries do not.
		expect(rendered).toContain("[mkt]");
		// And carry the scope tag from the registry summary.
		expect(rendered).toContain("[user]");
	});

	it("flags marketplace entries shadowed by a project-scoped install", () => {
		const component = new PluginListComponent([marketplaceEntry("shared@m", { shadowed: true })], {
			onPluginSelect: () => {},
			onCancel: () => {},
		});

		const rendered = render(component);
		// SelectList truncates the label so we check for the prefix substring.
		expect(rendered).toContain("(shado");
	});

	it("routes selection callback by entry kind", () => {
		const selected: PluginListEntry[] = [];
		const component = new PluginListComponent([npmEntry("npm-a"), marketplaceEntry("mkt-b")], {
			onPluginSelect: entry => selected.push(entry),
			onCancel: () => {},
		});

		// Submit on the first entry (npm).
		component.handleInput("\n");
		expect(selected).toHaveLength(1);
		expect(selected[0].kind).toBe("npm");

		// Move down to the marketplace entry and submit.
		component.handleInput("\x1b[B"); // down arrow
		component.handleInput("\n");
		expect(selected).toHaveLength(2);
		expect(selected[1].kind).toBe("marketplace");
		if (selected[1].kind === "marketplace") {
			expect(selected[1].plugin.id).toBe("mkt-b");
		}
	});
});
