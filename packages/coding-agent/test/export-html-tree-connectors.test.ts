import { describe, expect, it } from "bun:test";
import * as vm from "node:vm";
import { parseHTML } from "linkedom";
import { Marked } from "marked";

const [templateHtml, templateJs] = await Promise.all([
	Bun.file(new URL("../src/export/html/template.html", import.meta.url)).text(),
	Bun.file(new URL("../src/export/html/template.js", import.meta.url)).text(),
]);

/** Minimal shape of the linkedom elements this test reads; linkedom's query results are untyped. */
type TreeNodeElement = {
	getAttribute(name: string): string | null;
	querySelector(selector: string): { textContent: string | null } | null;
};

function renderTreePrefixes(entries: unknown[], leafId: string): Map<string, string> {
	const { document, window } = parseHTML(templateHtml);
	const session = {
		header: {
			type: "session",
			version: 3,
			id: "filtered-connectors",
			timestamp: "2026-01-01T00:00:00.000Z",
			cwd: "/tmp",
		},
		entries,
		leafId,
	};
	const sessionData = document.getElementById("session-data");
	if (!sessionData) throw new Error("Export template is missing session data");
	sessionData.textContent = Buffer.from(JSON.stringify(session)).toBase64();
	Object.defineProperty(window, "location", {
		value: new URL("https://example.test/export.html"),
		configurable: true,
	});
	Object.defineProperty(window, "matchMedia", {
		value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
		configurable: true,
	});
	// linkedom's HTMLSelectElement.value is getter-only; template.js assigns it
	// under 'use strict', which would throw. Shim a writable value like a browser.
	const themeSelect = document.getElementById("theme-select");
	if (themeSelect) {
		let themeValue = "auto";
		Object.defineProperty(themeSelect, "value", {
			get: () => themeValue,
			set: next => {
				themeValue = String(next);
			},
			configurable: true,
		});
	}
	vm.runInContext(
		templateJs,
		vm.createContext({
			window,
			document,
			marked: new Marked(),
			hljs: {
				getLanguage: () => false,
				highlight: () => ({ value: "" }),
				highlightAuto: () => ({ value: "" }),
			},
			URL,
			URLSearchParams,
			TextDecoder,
			Uint8Array,
			atob,
			navigator: { clipboard: null },
			localStorage: { getItem: () => null, setItem() {} },
			setTimeout: () => 0,
			clearTimeout() {},
		}),
	);

	return new Map(
		(Array.from(document.querySelectorAll(".tree-node")) as TreeNodeElement[]).map(node => [
			node.getAttribute("data-id") ?? "",
			node.querySelector(".tree-prefix")?.textContent ?? "",
		]),
	);
}

function assistantEntry(id: string, parentId: string | null, text: string, stopReason: "stop" | "aborted") {
	return {
		type: "message",
		id,
		parentId,
		timestamp: "2026-01-01T00:00:00.000Z",
		message: {
			role: "assistant",
			content: text ? [{ type: "text", text }] : [],
			stopReason,
			timestamp: 0,
		},
	};
}

describe("HTML export filtered tree connectors", () => {
	it("projects hidden branch heads before drawing visible sibling connectors", () => {
		const entries = [
			assistantEntry("root", null, "common parent", "stop"),
			{
				type: "message",
				id: "side",
				parentId: "root",
				timestamp: "2026-01-01T00:00:02.000Z",
				message: {
					role: "toolResult",
					toolCallId: "side-call",
					toolName: "hub",
					content: [{ type: "text", text: "side branch" }],
					isError: false,
					timestamp: 0,
				},
			},
			{
				type: "model_change",
				id: "active-head",
				parentId: "root",
				timestamp: "2026-01-01T00:00:03.000Z",
				model: "fixture/model",
				role: "temporary",
			},
			assistantEntry("aborted", "active-head", "", "aborted"),
		];

		const prefixes = renderTreePrefixes(entries, "aborted");
		expect(prefixes.get("active-head")).toBeUndefined();
		expect(prefixes.get("aborted")).toBe("├─ ");
		expect(prefixes.get("side")).toBe("└─ ");
	});
});
