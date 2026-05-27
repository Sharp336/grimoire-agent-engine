import { afterEach, describe, expect, it, vi } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { renderHtmlToText } from "@oh-my-pi/pi-coding-agent/tools/fetch";
import * as parallel from "@oh-my-pi/pi-coding-agent/web/parallel";
import { hookFetch } from "@oh-my-pi/pi-utils";

/**
 * Regression tests for #1449: a stalled remote reader request must not prevent
 * local fallback renderers (trafilatura/lynx/native) from running within the
 * overall reader-mode budget, and sequential remote stalls must not exceed it.
 */

/** Hang until the supplied AbortSignal fires; mirrors a stalled remote endpoint. */
function hangUntilAborted<T>(signal: AbortSignal | undefined | null): Promise<T> {
	const { promise, reject } = Promise.withResolvers<T>();
	if (!signal) return promise; // Defensive: caller did not wire one — never settles.
	const fail = () => reject(new DOMException("aborted", "AbortError"));
	if (signal.aborted) fail();
	else signal.addEventListener("abort", fail);
	return promise;
}

const SUBSTANTIVE_HTML = (() => {
	const paragraphs = Array.from(
		{ length: 6 },
		(_, i) =>
			`<p>Paragraph number ${i + 1} carries some real content for the article body so the native renderer has enough text to satisfy the length threshold.</p>`,
	).join("");
	return `<!doctype html><html><head><title>Example</title></head><body><article><h1>Example article</h1>${paragraphs}</article></body></html>`;
})();

describe("renderHtmlToText: remote stalls do not starve local fallbacks (#1449)", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("falls back to native renderer when jina hangs until aborted", async () => {
		const settings = Settings.isolated({ "providers.parallelFetch": false });

		using _hook = hookFetch((input, init, _next) => {
			if (String(input).startsWith("https://r.jina.ai/")) {
				return hangUntilAborted<Response>(init?.signal);
			}
			return new Response("", { status: 404 });
		});

		const started = Date.now();
		// `timeout: 2` keeps the overall budget tight — the test must complete
		// well within ~2s even though Jina would otherwise consume it whole.
		const result = await renderHtmlToText("https://example.com/article", SUBSTANTIVE_HTML, 2, settings, undefined, null);
		const elapsedMs = Date.now() - started;

		expect(result.ok).toBe(true);
		// Native always works. trafilatura/lynx may also win if installed.
		expect(["native", "trafilatura", "lynx"]).toContain(result.method);
		expect(elapsedMs).toBeLessThan(2_500);
	});

	it("re-throws when the user signal is aborted, not when sub-budget expires", async () => {
		const settings = Settings.isolated({ "providers.parallelFetch": false });

		using _hook = hookFetch((_input, init, _next) => hangUntilAborted<Response>(init?.signal));

		const controller = new AbortController();
		const pending = renderHtmlToText(
			"https://example.com/article",
			"<html><body><p>short</p></body></html>",
			30,
			settings,
			controller.signal,
			null,
		).catch(err => err as Error);

		controller.abort();
		const outcome = await pending;
		expect(outcome).toBeInstanceOf(Error);
		const err = outcome as Error;
		expect(err.name === "AbortError" || err.message.toLowerCase().includes("abort")).toBe(true);
	});

	it("sequential remote stalls (Parallel + Jina) stay within the overall reader-mode budget", async () => {
		// Reviewer concern from PR #1453: a stalled Parallel attempt followed
		// by a stalled Jina attempt must not each consume a fresh
		// `remoteBudgetMs`. The remote sub-signals are tied to `overallSignal`,
		// so the second remote attempt must abort as soon as the overall
		// budget is exhausted — total remote time ≤ overall budget.
		const settings = Settings.isolated({ "providers.parallelFetch": true });

		vi.spyOn(parallel, "findParallelApiKey").mockReturnValue("test-key");
		vi.spyOn(parallel, "extractWithParallel").mockImplementation(async (_urls, options, _storage) =>
			hangUntilAborted<parallel.ParallelExtractResult>(options.signal),
		);

		using _hook = hookFetch((input, init, _next) => {
			if (String(input).startsWith("https://r.jina.ai/")) {
				return hangUntilAborted<Response>(init?.signal);
			}
			return new Response("", { status: 404 });
		});

		const started = Date.now();
		// `timeout: 3` → overall budget = 3s, REMOTE_READER_MAX_MS = 10s.
		// Pre-fix: each remote attempt had a fresh 3s timer → ~6s total.
		// Post-fix: sub-signal combines `overallSignal` + 10s timer, so the
		// second attempt aborts immediately once the 3s overall budget hits.
		const result = await renderHtmlToText("https://example.com/article", SUBSTANTIVE_HTML, 3, settings, undefined, null);
		const elapsedMs = Date.now() - started;

		expect(result.ok).toBe(true);
		expect(["native", "trafilatura", "lynx"]).toContain(result.method);
		// Must stay under the overall budget plus a small native-render margin —
		// crucially well below `2 * timeout` (the pre-fix worst case).
		expect(elapsedMs).toBeLessThan(3_800);
	});
});
