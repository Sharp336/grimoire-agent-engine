import { z } from "zod/v4";
import type { Page } from "puppeteer-core";
import type { ToolDefinition } from "../../extensibility/extensions/types";
import { applyStealthPatches, applyViewport } from "../../tools/browser/launch";
import { acquireBrowser, holdBrowser, releaseBrowser, type PuppeteerBrowserHandle } from "../../tools/browser/registry";
import type { SecretBroker } from "./broker";
import { scrubOutput } from "./scrub-output";
import type { SecretHandle } from "./types";

/**
 * Task C1 — the `browser_with_secret` extension tool + its broker-owned
 * browser-session manager.
 *
 * Architectural decision (2026-07-19): the broker does NOT type into the
 * agent's `browser`-tool tab. The agent's tab is driven through a worker
 * thread that exposes only a `runInTab(name, { code })` JS-eval surface — the
 * main process has no direct Puppeteer `Page` handle on it. Forcing credential
 * fill through that path would couple the broker to `ToolSession` internals
 * AND re-introduce a same-page DOM readback hole.
 *
 * Instead the broker lazily acquires its OWN headless browser + page via the
 * shared `tools/browser/registry` (the C0 substrate), reuses it across calls
 * within the session, and types directly via `page.type(selector, value)`.
 * The agent's `browser` tool cannot see or read back from this page at all —
 * it is a different page in a different browser context the agent has no
 * handle to.
 *
 * The DOM-readback hole (C1b) still applies to the agent's OWN browser-tool
 * outputs on OTHER pages (e.g. a site that echoes the password on a
 * confirmation page the agent then inspects). C1b consumes the taint set
 * exported here to scrub those outputs.
 */

/** Default per-keystroke delay — human-like typing cadence. */
const DEFAULT_DELAY_MS = 50;

/** Hard cap on per-keystroke delay. Anything higher just slows the fill. */
const MAX_DELAY_MS = 200;

/** `page.goto` timeout. Generous because some cred pages are slow. */
const PAGE_GOTO_TIMEOUT_MS = 30_000;

/**
 * The narrowest Puppeteer `Page` surface this module drives. Real `Page`
 * satisfies it; the unit test constructs a fake that records calls without a
 * real browser. Exposed so the unit test can name the contract.
 */
export interface FillablePage {
	type(selector: string, text: string, options?: { delay?: number }): Promise<void>;
	url(): string;
	goto(url: string, options?: { waitUntil?: "load" | "domcontentloaded"; timeout?: number }): Promise<unknown>;
}

// ─── Pure wrapper around page.type — unit-tested with a fake page ─────────────

/**
 * Type a secret value into the page's selector, char-by-char via
 * `Input.dispatchKeyEvent` (Puppeteer's `page.type`). Returns the page's URL
 * at fill time, the selector echoed back, the value's char count, and the
 * value itself (so the caller can push it to the taint set without re-
 * resolving the handle). The char count and URL are the only fields the
 * handler bakes into the tool_result envelope.
 *
 * Pure delegation — extracted so the unit test can verify the call shape with
 * a fake page that records its arguments.
 */
export async function typeSecretIntoPage<P extends FillablePage>(
	page: P,
	selector: string,
	value: string,
	delayMs?: number,
): Promise<{ url: string; selector: string; charCount: number; value: string }> {
	const delay = Math.min(MAX_DELAY_MS, delayMs ?? DEFAULT_DELAY_MS);
	await page.type(selector, value, { delay });
	return { url: page.url(), selector, charCount: value.length, value };
}

// ─── Broker-owned browser-session manager ─────────────────────────────────────

interface BrokerBrowser {
	handle: PuppeteerBrowserHandle;
	page: Page;
}

let brokerBrowser: BrokerBrowser | undefined;

/**
 * Read-only view of resolved secret values typed into broker-owned pages.
 * The handler pushes each resolved value AFTER a successful type so C1b's
 * tool_result scrubbing hook can redact those values from any future DOM
 * readback the agent captures on OTHER pages (the broker-owned page itself
 * is unreachable from the agent's browser tool).
 */
const browserSecretTaint = new Set<string>();

export function getBrowserSecretTaint(): ReadonlySet<string> {
	return browserSecretTaint;
}

/** Reset the taint set. Exported for tests so each case starts clean. */
export function resetBrowserSecretTaintForTest(): void {
	browserSecretTaint.clear();
}

/**
 * Lazily acquire (or reuse) the broker-owned headless browser + page. The
 * browser is acquired ONCE per session via the shared registry; the page is
 * cached at module scope so subsequent tool calls type into the same page.
 * The agent's `browser` tool cannot reach this page — it lives in a separate
 * Puppeteer browser the agent has no handle to.
 *
 * C1 ships headless-only. For supervised rotation (C3), the acquire kind
 * becomes `{ kind: "connected", cdpUrl: <operator's Chrome> }` so the
 * operator can watch the credential page directly in their own browser; that
 * wiring is deferred to C3.
 */
export async function getBrokerBrowserPage(signal: AbortSignal): Promise<Page> {
	if (brokerBrowser) return brokerBrowser.page;
	const handle = await acquireBrowser({ kind: "headless", headless: true }, { cwd: process.cwd(), signal });
	if (!("browser" in handle)) {
		await releaseBrowser(handle, { kill: true });
		throw new Error("Broker browser acquisition returned a non-Puppeteer browser");
	}
	holdBrowser(handle);
	const page = await handle.browser.newPage();
	await applyViewport(page);
	await applyStealthPatches(handle.browser, page, handle.stealth);
	brokerBrowser = { handle, page };
	return page;
}

/**
 * Release the broker-owned browser. Wire on `session_shutdown` so the headless
 * Chromium does not leak past session end. Safe to call when nothing is held.
 */
export async function releaseBrokerBrowser(): Promise<void> {
	const current = brokerBrowser;
	brokerBrowser = undefined;
	if (!current) return;
	await current.page.close().catch(() => undefined);
	await releaseBrowser(current.handle, { kill: true });
}

// ─── Handler core — testable with a fake page + mock broker ───────────────────

export interface BrowserWithSecretParams {
	handle: SecretHandle;
	selector: string;
	/** Navigate to this URL before filling. Omit to fill on the current page. */
	url?: string;
	/** Per-keystroke delay in ms (default 50, capped at 200). */
	delayMs?: number;
}

export interface BrowserWithSecretResult {
	ok: true;
	url: string;
	selector: string;
	charCount: number;
}

/**
 * Resolve the handle, type the value into the given page, push the value into
 * the taint set, and return ONLY safe metadata. Extracted from the tool's
 * `execute` so the unit test can drive it with a fake page and a stub broker;
 * the real handler passes the broker-owned page from {@link getBrokerBrowserPage}.
 *
 * Fail-closed (R2): `broker.resolveHandle` throws on unknown provider or any
 * resolution failure — the error propagates to the agent as the tool's error
 * text, never as a raw value.
 */
export async function fillBrokerPageSecret(
	page: FillablePage,
	params: BrowserWithSecretParams,
	broker: SecretBroker,
	taint: Set<string>,
): Promise<BrowserWithSecretResult> {
	const { value } = await broker.resolveHandle(params.handle);

	if (params.url) {
		await page.goto(params.url, { waitUntil: "domcontentloaded", timeout: PAGE_GOTO_TIMEOUT_MS });
	}

	const typed = await typeSecretIntoPage(page, params.selector, value, params.delayMs);

	taint.add(value);

	return { ok: true, url: typed.url, selector: typed.selector, charCount: typed.charCount };
}

// ─── Tool definition ──────────────────────────────────────────────────────────

const browserWithSecretParams = z.object({
	handle: z.object({
		provider: z.string().describe("Vault provider: bitwarden, infisical, ephemeral"),
		itemId: z.string().describe("Item ID in the provider's namespace"),
		field: z.string().optional().describe("Field name (password, username, totp)"),
	}),
	selector: z.string().describe("CSS selector for the input to fill"),
	url: z.string().optional().describe("Navigate to this URL before filling (omit to fill on the current broker page)"),
	delayMs: z.number().optional().describe("Per-keystroke delay in ms (default 50, capped at 200)"),
});

/**
 * Build the `browser_with_secret` tool bound to a {@link SecretBroker} and the
 * broker-owned browser session. Registered by the secret-broker extension
 * alongside `run_with_secret` and `run_with_chain`.
 *
 * The broker resolves the handle, types the resolved value into a broker-owned
 * page (isolated from the agent's `browser` tool), and returns ONLY the page
 * URL, selector, and char count — never the value. The resolved value is
 * pushed to the taint set so C1b's tool_result scrubbing can redact it from
 * any future DOM readback the agent captures on other pages.
 */
export function createBrowserWithSecretTool(broker: SecretBroker): ToolDefinition<typeof browserWithSecretParams> {
	return {
		name: "browser_with_secret",
		label: "Browser with Secret",
		description:
			"Resolve a vault handle and type the resolved value into an input on a broker-owned browser page. " +
			"The page is isolated from the agent's browser tool — the agent cannot read it back. Returns only " +
			"the page URL, selector, and char count — the secret value is never returned. Use for credential " +
			"rotation flows where the broker fills a password field the agent must never see.",
		parameters: browserWithSecretParams,
		approval: "exec",
		async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
			const page = await getBrokerBrowserPage(signal ?? AbortSignal.timeout(PAGE_GOTO_TIMEOUT_MS));
			const result = await fillBrokerPageSecret(page, params, broker, browserSecretTaint);
			// Belt-and-suspenders: scrub the serialized envelope of every
			// known tainted value before returning. The envelope is built
			// without the value, but a future refactor that leaks it (e.g.
			// into an error field) is caught here.
			const text = scrubOutput(JSON.stringify(result, null, 2), [...getBrowserSecretTaint()]);
			return { content: [{ type: "text" as const, text }] };
		},
	};
}
