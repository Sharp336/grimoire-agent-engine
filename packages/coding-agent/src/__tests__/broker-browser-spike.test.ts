// Task C0 spike — Phase C substrate proof (see docs/superpowers/plans/2026-07-18-remaining-tasks.md).
// Proves that code OUTSIDE the browser tool (eventually an extension-registered tool,
// C1's `browser_with_secret`) can acquire a Puppeteer browser handle via the shared
// `tools/browser/registry` and drive a page — acquire → newPage → applyViewport →
// applyStealthPatches → goto → type → $eval. No source files modified; this is the
// derisking spike that confirms the registry's public API is consumable as-is.

import { describe, expect, it } from "bun:test";
import type { Page } from "puppeteer-core";
import { applyStealthPatches, applyViewport } from "../tools/browser/launch";
import { acquireBrowser, holdBrowser, releaseBrowser } from "../tools/browser/registry";

/**
 * Minimal shape for the DOM input element read back inside a puppeteer `$eval`
 * callback. The project tsconfig (`lib: ["ES2024", "DOM.AsyncIterable"]`) omits
 * the full DOM lib, so `HTMLInputElement` is not in scope; this named interface
 * is the one-field contract the assertion actually relies on.
 */
interface InputWithValue {
	value: string;
}

describe("Task C0 spike — extension access to native browser registry", () => {
	it("acquires a headless browser, types into a password field, and reads the value back", async () => {
		const signal = AbortSignal.timeout(120_000);
		const handle = await acquireBrowser({ kind: "headless", headless: true }, { cwd: process.cwd(), signal });

		// The registry can return non-Puppeteer handles (e.g. cmux); a headless
		// acquire must yield a Puppeteer handle with a `.browser`.
		expect("browser" in handle).toBe(true);
		if (!("browser" in handle)) {
			await releaseBrowser(handle, { kill: true });
			throw new Error("headless acquire returned a non-Puppeteer handle");
		}

		holdBrowser(handle);

		let page: Page | undefined;
		try {
			page = await handle.browser.newPage();
			await applyViewport(page);
			await applyStealthPatches(handle.browser, page, handle.stealth);

			await page.goto("data:text/html,<html><body><input id='pw' type='password'></body></html>", {
				waitUntil: "domcontentloaded",
			});

			// Char-by-char typing — the exact mechanism C1's `browser_with_secret`
			// will use to drive credential input without exposing the value as a
			// single assignment string in tool output.
			const TEST_VALUE = "fake-test-value-not-a-real-secret";
			await page.type("#pw", TEST_VALUE);

			// puppeteer-core types the callback arg as its own `Element`; the runtime
			// node is an HTMLInputElement, so narrow through `unknown` to the named
			// one-field contract above before reading `.value`.
			const observed = await page.$eval("#pw", el => {
				const input = el as unknown as InputWithValue;
				return input.value;
			});
			expect(observed).toBe(TEST_VALUE);
		} finally {
			await page?.close().catch(() => undefined);
			await releaseBrowser(handle, { kill: true });
		}
	}, 180_000);
});
