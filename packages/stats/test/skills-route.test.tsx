import { afterEach, describe, expect, it, vi } from "bun:test";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { buildSkillInvocationSeries, SkillsRoute } from "../src/client/routes/SkillsRoute";
import type { SkillDashboardStats } from "../src/shared-types";


type FetchInput = string | URL | Request;
type FetchInit = RequestInit | BunFetchRequestInit;

const originalGlobals = new Map<string, PropertyDescriptor | undefined>();
let root: Root | null = null;

function installGlobal(name: string, value: unknown): void {
	originalGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
	Object.defineProperty(globalThis, name, { configurable: true, value, writable: true });
}

function restoreGlobals(): void {
	for (const [name, descriptor] of originalGlobals) {
		if (descriptor) Object.defineProperty(globalThis, name, descriptor);
		else Reflect.deleteProperty(globalThis, name);
	}
	originalGlobals.clear();
}

afterEach(async () => {
	const activeRoot = root;
	if (activeRoot) {
		await act(async () => {
			activeRoot.unmount();
		});
		root = null;
	}
	vi.restoreAllMocks();
	restoreGlobals();
});

const dashboard: SkillDashboardStats = {
	bySkill: [
		{
			skill: "review",
			calls: 2,
			errors: 0,
			argsChars: 0,
			resultChars: 0,
			totalTokensShare: 100,
			outputTokensShare: 20,
			costShare: 0.009,
			lastUsed: Date.parse("2026-06-24T10:05:00.000Z"),
		},
	],
	bySkillModel: [
		{
			skill: "review",
			model: "gpt-5.4",
			provider: "openai",
			calls: 2,
			errors: 0,
			argsChars: 0,
			resultChars: 0,
			totalTokensShare: 100,
			outputTokensShare: 20,
			costShare: 0.009,
			lastUsed: Date.parse("2026-06-24T10:05:00.000Z"),
		},
	],
	series: [],
};

const collisionSkills = [
	["Other", 10],
	["alpha", 9],
	["beta", 8],
	["gamma", 7],
	["delta", 6],
	["epsilon", 5],
	["zeta", 4],
] as const;

const collisionDashboard: SkillDashboardStats = {
	...dashboard,
	bySkill: collisionSkills.map(([skill, calls]) => ({
		...dashboard.bySkill[0],
		skill,
		calls,
	})),
	series: collisionSkills.map(([skill, calls]) => ({
		timestamp: Date.parse("2026-06-24T10:00:00.000Z"),
		skill,
		calls,
		errors: 0,
	})),
};

describe("SkillsRoute", () => {
	it("fetches the selected range and renders average invocation cost", async () => {
		const domWindow = parseHTML('<html><body><div id="root"></div></body></html>').window;
		installGlobal("window", domWindow);
		installGlobal("document", domWindow.document);
		installGlobal("navigator", domWindow.navigator);

		installGlobal("Node", domWindow.Node);
		installGlobal("Element", domWindow.Element);
		installGlobal("HTMLElement", domWindow.HTMLElement);
		installGlobal("HTMLIFrameElement", domWindow.HTMLIFrameElement);
		installGlobal("SVGElement", domWindow.SVGElement);
		installGlobal("IS_REACT_ACT_ENVIRONMENT", true);

		const requestedUrls: string[] = [];
		const fetchStub = Object.assign(
			async (input: FetchInput, _init?: FetchInit) => {
				requestedUrls.push(input instanceof Request ? input.url : input.toString());
				return Response.json(dashboard);
			},
			{ preconnect: globalThis.fetch.preconnect },
		);
		vi.spyOn(globalThis, "fetch").mockImplementation(fetchStub);

		const container = domWindow.document.getElementById("root");
		if (!container) throw new Error("Expected test root");
		root = createRoot(container as unknown as Element);

		await act(async () => {
			root?.render(<SkillsRoute active range="24h" refreshTrigger={0} />);
		});
		expect(requestedUrls).toEqual(["/api/stats/skills?range=24h"]);
		expect(domWindow.document.body.textContent).toContain("Avg Cost / Invocation");
		expect(domWindow.document.body.textContent).toContain("Avg Cost / Inv.");
		expect(domWindow.document.body.textContent).toContain("$0.0045");

		await act(async () => {
			root?.render(<SkillsRoute active range="7d" refreshTrigger={0} />);
		});
		expect(requestedUrls).toEqual(["/api/stats/skills?range=24h", "/api/stats/skills?range=7d"]);
	});

	it("keeps a real Other skill separate from the overflow series", () => {
		const chartSeries = buildSkillInvocationSeries(collisionDashboard.series);
		const bucket = chartSeries.buckets[0];
		if (bucket === undefined) throw new Error("Expected a chart bucket");
		const datasets = chartSeries.skills.map(skill => ({
			label: typeof skill === "symbol" ? "Other" : skill,
			data: [chartSeries.data.get(bucket)?.get(skill) ?? 0],
		}));

		expect(datasets).toEqual([
			{ label: "Other", data: [10] },
			{ label: "alpha", data: [9] },
			{ label: "beta", data: [8] },
			{ label: "gamma", data: [7] },
			{ label: "delta", data: [6] },
			{ label: "epsilon", data: [5] },
			{ label: "Other", data: [4] },
		]);
		expect(datasets.reduce((total, dataset) => total + dataset.data[0], 0)).toBe(
			collisionDashboard.series.reduce((total, point) => total + point.calls, 0),
		);
		expect(datasets.filter(dataset => dataset.label === "Other").map(dataset => dataset.data)).toEqual([[10], [4]]);
	});
});
