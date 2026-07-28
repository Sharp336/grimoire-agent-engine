import { afterEach, describe, expect, it } from "bun:test";
import type { ExtensionContext, ExtensionAPI, ToolDefinition } from "../extensibility/extensions/types";
import type { Page } from "puppeteer-core";
import { SecretBroker } from "../secrets/broker/broker";
import {
	createBrowserWithSecretTool,
	fillBrokerPageSecret,
	getBrokerBrowserPage,
	getBrowserSecretTaint,
	releaseBrokerBrowser,
	resetBrowserSecretTaintForTest,
	typeSecretIntoPage,
	type FillablePage,
} from "../secrets/broker/browser-with-secret-tool";
import { createSecretBrokerExtension } from "../secrets/broker/secret-broker-extension";
import { scrubOutput } from "../secrets/broker/scrub-output";
import type { SecretHandle, SecretValue } from "../secrets/broker/types";

/**
 * Task C1 — `browser_with_secret` tool.
 *
 * Two layers:
 *   - Unit (mock page): the handler core (`fillBrokerPageSecret`) + the pure
 *     `typeSecretIntoPage` wrapper are exercised with a fake page that records
 *     `type` args. No real browser is launched. Asserts: type called with the
 *     selector + resolved value; the taint set contains the value after a
 *     successful type; the return envelope never carries the value; scrubOutput
 *     on the serialized envelope strips the value.
 *   - Integration (real headless, the C0 substrate): the tool is registered
 *     via the secret-broker extension factory; a stub provider resolves a fake
 *     value; `execute` types it into a `data:` URL password input; the field
 *     value is read back via `$eval`; the tool return has `charCount` but not
 *     the value; `getBrowserSecretTaint()` contains the value.
 *
 * Fail-closed (R2): only fake values are used — `fake-test-value-not-a-real-secret`.
 */

/** The fake value the stub provider resolves to. Never a real credential. */
const FAKE_VALUE = "fake-test-value-not-a-real-secret";

/** Real handle used by both layers — points at the stub provider. */
const HANDLE: SecretHandle = { provider: "ephemeral", itemId: "c1-unit", field: "password" };

/** Minimal broker stub: only `resolveHandle` is exercised by the unit test. */
function brokerStubResolve(value: string): SecretBroker {
	const resolve = async (): Promise<SecretValue> => ({ handle: HANDLE, value });
	return { resolveHandle: resolve } as unknown as SecretBroker;
}

/** A recorded `page.type(selector, text, options)` invocation. */
interface TypeCall {
	selector: string;
	text: string;
	options?: { delay?: number };
}

/** A recorded `page.goto(url, options)` invocation. */
interface GotoCall {
	url: string;
	options?: { waitUntil?: string; timeout?: number };
}

/** A recording fake page implementing the {@link FillablePage} contract. */
function recordingPage(url = "https://broker.test/current"): {
	page: FillablePage;
	typeCalls: TypeCall[];
	gotoCalls: GotoCall[];
} {
	const typeCalls: TypeCall[] = [];
	const gotoCalls: GotoCall[] = [];
	const page: FillablePage = {
		async type(selector, text, options) {
			typeCalls.push({ selector, text, options });
		},
		url: () => url,
		async goto(targetUrl, options) {
			gotoCalls.push({ url: targetUrl, options });
			return null;
		},
	};
	return { page, typeCalls, gotoCalls };
}

/** Capture-only ExtensionAPI for asserting what the factory registered. */
function captureApi(): {
	api: ExtensionAPI;
	registeredTools: ToolDefinition[];
} {
	const registeredTools: ToolDefinition[] = [];
	const api = {
		registerTool(tool: ToolDefinition) {
			registeredTools.push(tool);
		},
		registerCommand() {
			/* no-op — these tests exercise tool registration + execute, not commands */
		},
		on() {
			/* no-op event bus — unit tests exercise tool registration, not event wiring */
		},
	} as unknown as ExtensionAPI;
	return { api, registeredTools };
}

// Unit layer — fake page, no real browser
// ──────────────────────────────────────────────────────────────────────────────

describe("Task C1 unit: typeSecretIntoPage delegates to page.type with delay capped at 200ms", () => {
	it("calls page.type with the selector + value and the default 50ms delay", async () => {
		const { page, typeCalls } = recordingPage();
		await typeSecretIntoPage(page, "#pw", FAKE_VALUE);
		expect(typeCalls).toHaveLength(1);
		expect(typeCalls[0]?.selector).toBe("#pw");
		expect(typeCalls[0]?.text).toBe(FAKE_VALUE);
		expect(typeCalls[0]?.options?.delay).toBe(50);
	});

	it("caps an over-large delayMs at 200ms", async () => {
		const { page, typeCalls } = recordingPage();
		await typeSecretIntoPage(page, "#pw", FAKE_VALUE, 999);
		expect(typeCalls[0]?.options?.delay).toBe(200);
	});

	it("returns the page url, selector, and value charCount (NOT the value)", async () => {
		const { page } = recordingPage("https://broker.test/post-fill");
		const out = await typeSecretIntoPage(page, "#pw", FAKE_VALUE, 25);
		expect(out.url).toBe("https://broker.test/post-fill");
		expect(out.selector).toBe("#pw");
		expect(out.charCount).toBe(FAKE_VALUE.length);
		// `value` is returned so the caller can push it to the taint set; it
		// must NOT leak into the tool_result envelope (the handler builds the
		// envelope without it — see fillBrokerPageSecret).
		expect(out.value).toBe(FAKE_VALUE);
	});
});

describe("Task C1 unit: fillBrokerPageSecret drives resolve → type → taint → scrub", () => {
	afterEach(() => resetBrowserSecretTaintForTest());

	it("calls page.type with the resolved value + selector and pushes the value to the taint set", async () => {
		const broker = brokerStubResolve(FAKE_VALUE);
		const taint = new Set<string>();
		const { page, typeCalls } = recordingPage();

		const result = await fillBrokerPageSecret(page, { handle: HANDLE, selector: "#pw" }, broker, taint);

		// type called with selector + resolved value
		expect(typeCalls).toHaveLength(1);
		expect(typeCalls[0]?.selector).toBe("#pw");
		expect(typeCalls[0]?.text).toBe(FAKE_VALUE);

		// taint set contains value after
		expect(taint.has(FAKE_VALUE)).toBe(true);

		// return envelope carries metadata only — never the value
		expect(result.ok).toBe(true);
		expect(result.selector).toBe("#pw");
		expect(result.charCount).toBe(FAKE_VALUE.length);
		expect(result.url).toBe("https://broker.test/current");
		expect(JSON.stringify(result)).not.toContain(FAKE_VALUE);
	});

	it("navigates when params.url is provided, then types", async () => {
		const broker = brokerStubResolve(FAKE_VALUE);
		const taint = new Set<string>();
		const { page, typeCalls, gotoCalls } = recordingPage();

		await fillBrokerPageSecret(
			page,
			{ handle: HANDLE, selector: "#pw", url: "data:text/html,<input id='pw'>" },
			broker,
			taint,
		);

		expect(gotoCalls).toHaveLength(1);
		expect(gotoCalls[0]?.url).toBe("data:text/html,<input id='pw'>");
		expect(gotoCalls[0]?.options?.waitUntil).toBe("domcontentloaded");
		expect(typeCalls).toHaveLength(1);
	});

	it("forwards delayMs (capped) to page.type", async () => {
		const broker = brokerStubResolve(FAKE_VALUE);
		const taint = new Set<string>();
		const { page, typeCalls } = recordingPage();

		await fillBrokerPageSecret(page, { handle: HANDLE, selector: "#pw", delayMs: 150 }, broker, taint);

		expect(typeCalls[0]?.options?.delay).toBe(150);
	});

	it("scrubOutput on the serialized result strips the value — defense in depth", async () => {
		const broker = brokerStubResolve(FAKE_VALUE);
		const taint = new Set<string>();
		const { page } = recordingPage();

		const result = await fillBrokerPageSecret(page, { handle: HANDLE, selector: "#pw" }, broker, taint);

		const serialized = JSON.stringify(result);
		// Even though we never baked the value in, run scrubOutput anyway — a
		// future refactor that leaks the value into the envelope must be
		// caught by this guard.
		const scrubbed = scrubOutput(serialized, [FAKE_VALUE]);
		expect(scrubbed).not.toContain(FAKE_VALUE);
		// And the unscrubbed serialization also doesn't contain the value,
		// because the envelope is constructed without it.
		expect(serialized).not.toContain(FAKE_VALUE);
	});
});

describe("Task C1 unit: createBrowserWithSecretTool produces a valid ToolDefinition", () => {
	it("has the correct name, approval tier, label, and a defined parameter schema", () => {
		const tool = createBrowserWithSecretTool(brokerStubResolve(FAKE_VALUE));
		expect(tool.name).toBe("browser_with_secret");
		expect(tool.label).toBe("Browser with Secret");
		expect(tool.approval).toBe("exec");
		expect(tool.parameters).toBeDefined();
		expect(tool.description.length).toBeGreaterThan(0);
	});

	it("the description tells the agent the value is never returned", () => {
		const tool = createBrowserWithSecretTool(brokerStubResolve(FAKE_VALUE));
		expect(tool.description).toMatch(/isolated|never/i);
		expect(tool.description.toLowerCase()).toContain("secret");
	});
});

//──────────────────────────────────────────────────────────────────────────────
// Registration wiring — extension factory registers the tool
// ──────────────────────────────────────────────────────────────────────────────

describe("Task C1 wiring: secret-broker extension registers browser_with_secret alongside the existing two tools", () => {
	it("registers browser_with_secret with the exec approval tier", () => {
		const broker = new SecretBroker();
		const { api, registeredTools } = captureApi();
		createSecretBrokerExtension(broker)(api);
		const tool = registeredTools.find(t => t.name === "browser_with_secret");
		expect(tool).toBeDefined();
		expect(tool?.approval).toBe("exec");
	});
});

// Integration layer — real headless Chromium via the C0 registry substrate
// ──────────────────────────────────────────────────────────────────────────────

/** Mock provider following broker-wiring.test.ts's stub-provider pattern. */
class StubProvider {
	readonly name = "ephemeral";
	readonly #value: string;
	constructor(value: string) {
		this.#value = value;
	}
	async resolve(handle: SecretHandle): Promise<SecretValue> {
		return { handle, value: this.#value };
	}
	async isAvailable(): Promise<boolean> {
		return true;
	}
}

describe("Task C1 integration: browser_with_secret types a resolved value into a real broker-owned page", () => {
	afterEach(async () => {
		// Release the broker-owned browser so the headless Chromium does not
		// leak past this test file. The session_shutdown handler does the
		// same in a live session.
		await releaseBrokerBrowser();
		resetBrowserSecretTaintForTest();
	});

	it("fills a password input and returns charCount without the value", async () => {
		const broker = new SecretBroker();
		broker.registerProvider(new StubProvider(FAKE_VALUE) as unknown as Parameters<typeof broker.registerProvider>[0]);

		// Register the tool through the extension factory so the wiring
		// matches production.
		const { api, registeredTools } = captureApi();
		createSecretBrokerExtension(broker)(api);
		const tool = registeredTools.find(t => t.name === "browser_with_secret");
		if (!tool) throw new Error("browser_with_secret not registered");

		const url = "data:text/html,<html><body><input id='pw' type='password'></body></html>";
		const signal = AbortSignal.timeout(120_000);

		const result = await tool.execute(
			"call-c1-int",
			{ handle: HANDLE, selector: "#pw", url },
			signal,
			undefined,
			{} as ExtensionContext,
		);

		// Parse the JSON envelope from the text content block.
		expect(Array.isArray(result.content)).toBe(true);
		expect(result.content).toHaveLength(1);
		expect(result.content[0]?.type).toBe("text");
		const block = result.content[0] as { type: string; text?: string };
		if (typeof block.text !== "string") throw new Error("expected text content block");
		const blob = block.text;
		const parsed = JSON.parse(blob) as { ok: boolean; url: string; selector: string; charCount: number };

		// Return has charCount but NOT the value.
		expect(parsed.ok).toBe(true);
		expect(parsed.charCount).toBe(FAKE_VALUE.length);
		expect(parsed.selector).toBe("#pw");
		expect(blob).not.toContain(FAKE_VALUE);

		// Read the field value back through the SAME broker-owned page the
		// tool just typed into, via `$eval`. (The agent's `browser` tool
		// cannot do this — different page in a different browser context.)
		const page: Page = await getBrokerBrowserPage(signal);
		const observed = await page.$eval("#pw", el => {
			const input = el as unknown as { value: string };
			return input.value;
		});
		expect(observed).toBe(FAKE_VALUE);

		// The taint set carries the value for C1b's tool_result scrubbing.
		expect(getBrowserSecretTaint().has(FAKE_VALUE)).toBe(true);
	}, 180_000);
});
