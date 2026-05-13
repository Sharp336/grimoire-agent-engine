import { describe, expect, it } from "bun:test";
import type { Browser, CDPSession, Target } from "puppeteer-core";
import {
	configureUserAgentTargetsForTest,
	targetSupportsUserAgentOverrideForTest,
} from "../../src/tools/browser/launch";

type SentCommand = {
	method: string;
	params?: Record<string, unknown>;
};

class FakeSession {
	readonly commands: SentCommand[] = [];
	readonly #delayMs: number;

	constructor(delayMs = 0) {
		this.#delayMs = delayMs;
	}

	async send(method: string, params?: Record<string, unknown>): Promise<unknown> {
		this.commands.push({ method, params });
		if (this.#delayMs > 0) await Bun.sleep(this.#delayMs);
		return {};
	}

	on(): void {}

	connection(): { session: () => null } {
		return { session: () => null };
	}
}

class FakeTarget {
	readonly session: FakeSession;
	createCalls = 0;
	readonly #type: string;

	constructor(type: string, delayMs = 0) {
		this.#type = type;
		this.session = new FakeSession(delayMs);
	}

	type(): string {
		return this.#type;
	}

	async createCDPSession(): Promise<CDPSession> {
		this.createCalls++;
		return this.session as unknown as CDPSession;
	}
}

class FakeBrowser {
	readonly browserTarget = new FakeTarget("browser");
	readonly #targets: FakeTarget[];

	constructor(targets: FakeTarget[]) {
		this.#targets = targets;
	}

	target(): Target {
		return this.browserTarget as unknown as Target;
	}

	targets(): Target[] {
		return this.#targets as unknown as Target[];
	}
}

const override = {
	userAgent: "Mozilla/5.0 Chrome/142.0.0.0 Safari/537.36",
	acceptLanguage: "en-US,en",
	platform: "Win32",
	userAgentMetadata: {
		brands: [{ brand: "Chromium", version: "142" }],
		fullVersion: "142.0.0.0",
		platform: "Windows",
		platformVersion: "10.0.0",
		architecture: "x86",
		model: "",
		mobile: false,
	},
};

describe("browser stealth target setup", () => {
	it("skips non-page targets during existing target user-agent sweep", async () => {
		const page = new FakeTarget("page");
		const serviceWorker = new FakeTarget("service_worker");
		const other = new FakeTarget("other");
		const browser = new FakeBrowser([page, serviceWorker, other]);

		await configureUserAgentTargetsForTest(browser as unknown as Browser, { browserSession: null, override });

		expect(page.createCalls).toBe(1);
		expect(serviceWorker.createCalls).toBe(0);
		expect(other.createCalls).toBe(0);
	});

	it("does not wait indefinitely for a slow existing page target", async () => {
		const slowPage = new FakeTarget("page", 200);
		const browser = new FakeBrowser([slowPage]);
		const started = performance.now();

		await configureUserAgentTargetsForTest(browser as unknown as Browser, { browserSession: null, override }, 10);

		expect(performance.now() - started).toBeLessThan(100);
	});

	it("classifies only page-like targets as user-agent override targets", () => {
		expect(targetSupportsUserAgentOverrideForTest({ type: () => "page" } as unknown as Target)).toBe(true);
		expect(targetSupportsUserAgentOverrideForTest({ type: () => "webview" } as unknown as Target)).toBe(true);
		expect(targetSupportsUserAgentOverrideForTest({ type: () => "browser" } as unknown as Target)).toBe(false);
		expect(targetSupportsUserAgentOverrideForTest({ type: () => "service_worker" } as unknown as Target)).toBe(false);
		expect(targetSupportsUserAgentOverrideForTest({ type: () => "other" } as unknown as Target)).toBe(false);
	});
});
