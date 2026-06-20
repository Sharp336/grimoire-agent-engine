import { describe, expect, test } from "bun:test";
import { pickElectronTarget } from "@oh-my-pi/pi-coding-agent/tools/browser/attach";
import { normalizeConnectedCdpUrl } from "@oh-my-pi/pi-coding-agent/tools/browser/registry";
import type { Browser, BrowserContext, Page } from "patchright";

interface FakePageOptions {
	url: string;
	title: string;
}

function fakePage(options: FakePageOptions): Page {
	return {
		url: () => options.url,
		title: async () => options.title,
	} as unknown as Page;
}

function fakeBrowser(pages: Page[]): Browser {
	const ctx: BrowserContext = { pages: () => pages } as unknown as BrowserContext;
	return {
		contexts: () => [ctx],
	} as unknown as Browser;
}

describe("pickElectronTarget", () => {
	test("returns the first page when no matcher is given", async () => {
		const page = fakePage({ url: "https://example.com/", title: "Example" });
		const browser = fakeBrowser([page]);

		await expect(pickElectronTarget(browser)).resolves.toBe(page);
	});

	test("matches by URL substring", async () => {
		const google = fakePage({ url: "https://www.google.com/", title: "Google" });
		const example = fakePage({ url: "https://example.com/", title: "Example" });
		const browser = fakeBrowser([google, example]);

		await expect(pickElectronTarget(browser, "google")).resolves.toBe(google);
	});

	test("matches by title substring", async () => {
		const page = fakePage({ url: "https://example.com/", title: "My App Dashboard" });
		const browser = fakeBrowser([page]);

		await expect(pickElectronTarget(browser, "dashboard")).resolves.toBe(page);
	});

	test("reports available pages when the matcher misses", async () => {
		const page = fakePage({ url: "https://example.com/", title: "Example" });
		const browser = fakeBrowser([page]);

		await expect(pickElectronTarget(browser, "missing")).rejects.toThrow(
			'No page target matched "missing". Available pages:\n- Example  https://example.com/',
		);
	});

	test("throws when no pages are available", async () => {
		const browser = fakeBrowser([]);

		await expect(pickElectronTarget(browser)).rejects.toThrow("No page targets available on the attached browser");
	});

	test("rejects websocket cdp_url values with an actionable diagnostic", () => {
		expect(() => normalizeConnectedCdpUrl("ws://127.0.0.1:9222/devtools/browser/id")).toThrow(
			"browser app.cdp_url must be the HTTP CDP discovery endpoint",
		);
		expect(normalizeConnectedCdpUrl("http://127.0.0.1:9222/")).toBe("http://127.0.0.1:9222");
	});
});
