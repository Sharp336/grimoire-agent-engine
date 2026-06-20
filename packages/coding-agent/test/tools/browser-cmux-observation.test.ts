import { describe, expect, it } from "bun:test";
import { cmuxSelectorSpec, cmuxSnapshotToObservation, mapWaitUntil, serializeEval } from "@oh-my-pi/pi-coding-agent/tools/browser";

describe("cmux browser observation mapping", () => {
	it("maps refs in numeric order with viewport, scroll, url, and title", () => {
		const observation = cmuxSnapshotToObservation(
			{
				refs: {
					e2: { role: "link", name: "Home" },
					e1: { role: "button" },
					bad: { role: "ignored", name: "Ignored" },
				},
				page: { url: "https://x/", title: "X" },
			},
			{ width: 800, height: 600 },
			{
				innerWidth: 800,
				innerHeight: 600,
				dpr: 2,
				scrollX: 10,
				scrollY: 20,
				scrollWidth: 1200,
				scrollHeight: 1800,
			},
		);

		expect(observation.url).toBe("https://x/");
		expect(observation.title).toBe("X");
		expect(observation.viewport).toEqual({ width: 800, height: 600 });
		expect(observation.scroll).toEqual({
			x: 10,
			y: 20,
			width: 800,
			height: 600,
			scrollWidth: 1200,
			scrollHeight: 1800,
		});
		expect(observation.elements).toEqual([
			{ id: "e1", role: "button", name: undefined, states: [] },
			{ id: "e2", role: "link", name: "Home", states: [] },
		]);
	});

	it("prefers top-level url and title when present", () => {
		const observation = cmuxSnapshotToObservation(
			{
				url: "https://top/",
				title: "Top",
				page: { url: "https://page/", title: "Page" },
			},
			{ width: 1, height: 2 },
			{
				innerWidth: 1,
				innerHeight: 2,
				dpr: 1,
				scrollX: 0,
				scrollY: 0,
				scrollWidth: 1,
				scrollHeight: 2,
			},
		);

		expect(observation.url).toBe("https://top/");
		expect(observation.title).toBe("Top");
	});
});

describe("cmux browser RPC helpers", () => {
	it("serializes eval strings and functions", () => {
		const makePair: (a: unknown, b: unknown) => unknown[] = (a, b) => [a, b];

		expect(serializeEval("document.title", [])).toBe("document.title");
		expect(serializeEval(makePair, [1, 2])).toBe("((a, b) => [a, b])(1,2)");
	});

	it("maps waitUntil values to cmux load states", () => {
		expect(mapWaitUntil("domcontentloaded")).toBe("interactive");
		expect(mapWaitUntil("load")).toBe("complete");
		expect(mapWaitUntil("networkidle0")).toBe("complete");
		expect(mapWaitUntil("networkidle2")).toBe("complete");
		expect(mapWaitUntil(undefined)).toBe("complete");
	});
});

describe("cmux selector spec", () => {
	it("parses role=ROLE[name] into a role-aware aria spec (carries both role and name)", () => {
		expect(cmuxSelectorSpec('role=button[name="Save"]')).toEqual({
			kind: "aria",
			value: "Save",
			raw: 'role=button[name="Save"]',
			role: "button",
			name: "Save",
		});
	});

	it("parses a bare role= as a role-only aria spec instead of an invalid CSS selector", () => {
		const spec = cmuxSelectorSpec("role=button");
		expect(spec.kind).toBe("aria");
		expect(spec.role).toBe("button");
		expect(spec.name).toBeUndefined();
	});

	it("maps aria/NAME to an accessible-name match with no role constraint", () => {
		expect(cmuxSelectorSpec("aria/Sign in")).toEqual({
			kind: "aria",
			value: "Sign in",
			raw: "aria/Sign in",
			name: "Sign in",
		});
	});

	it("translates Playwright text= and xpath= engines to query handlers", () => {
		expect(cmuxSelectorSpec("text=Continue")).toMatchObject({ kind: "text", value: "Continue" });
		expect(cmuxSelectorSpec("xpath=//button")).toMatchObject({ kind: "xpath", value: "//button" });
	});

	it("parses aria-ref ids with and without the @ prefix", () => {
		expect(cmuxSelectorSpec("e2")).toEqual({ kind: "ref", value: "e2", raw: "e2", ref: "@e2" });
		expect(cmuxSelectorSpec("@e2")).toEqual({ kind: "ref", value: "e2", raw: "@e2", ref: "@e2" });
	});

	it("normalizes legacy p- prefixes", () => {
		expect(cmuxSelectorSpec("p-aria/Save")).toMatchObject({ kind: "aria", value: "Save" });
		expect(cmuxSelectorSpec("p-text/Hi")).toMatchObject({ kind: "text", value: "Hi" });
	});

	it("leaves CSS selectors (including attribute selectors with =) as css", () => {
		expect(cmuxSelectorSpec('input[name="q"]')).toEqual({
			kind: "css",
			value: 'input[name="q"]',
			raw: 'input[name="q"]',
		});
	});
});
