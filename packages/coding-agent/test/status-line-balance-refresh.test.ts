/**
 * Contract for the DeepSeek balance segment's background refresh
 * (`StatusLineComponent.refreshBalanceInBackground`).
 *
 * The status line redraws on every agent event, so the refresh must be
 * self-deduplicating: exactly one request to `api.deepseek.com/user/balance`
 * may be in flight at a time. `#balanceTimer` only covers the window between
 * arming and firing — it is nulled inside the callback, while the request then
 * runs for up to 3s with `#balanceFetchedAt` still 0. Without the
 * `#balanceInFlight` latch every redraw inside that window re-armed the timer
 * and fired another authenticated request.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { StatusLineComponent } from "@oh-my-pi/pi-coding-agent/modes/components/status-line";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";

async function flushMicrotasks(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

interface TestModel {
	contextWindow: number;
	provider: string;
	baseUrl: string;
}

function setActiveModelForTest(session: AgentSession, model: TestModel): void {
	// AgentSession exposes model changes through setModel(), but these unit tests
	// need a synchronous switch while a controlled promise remains pending.
	const mutable = session as unknown as { model: TestModel; state: { model: TestModel } };
	mutable.model = model;
	mutable.state.model = model;
}

function makeDeepSeekSession(
	options: { baseUrl?: string; getApiKey?: () => Promise<string | undefined>; authGeneration?: () => number } = {},
): AgentSession {
	const messages: unknown[] = [];
	const model = {
		contextWindow: 200_000,
		provider: "deepseek",
		baseUrl: options.baseUrl ?? "",
	};
	return {
		sessionId: "session-1",
		messages,
		state: { messages, model },
		model,
		isStreaming: false,
		isFastModeActive: () => false,
		modelRegistry: {
			getApiKey: options.getApiKey ?? (async () => "sk-test"),
			authStorage: {
				getGeneration: options.authGeneration ?? (() => 1),
				getOAuthAccountIdentity: () => undefined,
			},
		},
		sessionManager: {
			getUsageStatistics: () => ({
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				orchestrationInput: 0,
				orchestrationOutput: 0,
				orchestrationCacheRead: 0,
				premiumRequests: 0,
				cost: 0,
			}),
			getSessionName: () => "test",
		},
		getAsyncJobSnapshot: () => ({ running: [] }),
		getContextUsage: () => undefined,
		contextUsageRevision: 0,
	} as unknown as AgentSession;
}

/** One render pass: arm the refresh, let the 0ms timer fire, drain microtasks. */
async function render(component: StatusLineComponent): Promise<void> {
	component.refreshBalanceInBackground();
	vi.advanceTimersByTime(0);
	await flushMicrotasks();
}

describe("StatusLineComponent balance refresh", () => {
	let fetchCalls = 0;
	let pending: PromiseWithResolvers<Response>;

	beforeEach(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
		await initTheme();
		vi.useFakeTimers();
		fetchCalls = 0;
		pending = Promise.withResolvers<Response>();
		vi.spyOn(globalThis, "fetch").mockImplementation(((input: unknown) => {
			expect(String(input)).toBe("https://api.deepseek.com/user/balance");
			fetchCalls++;
			return pending.promise;
		}) as typeof fetch);
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		resetSettingsForTest();
	});

	it("keeps a single balance request in flight across redraws", async () => {
		const component = new StatusLineComponent(makeDeepSeekSession());

		await render(component);
		expect(fetchCalls).toBe(1);

		// The request has not resolved: the timer is already null and
		// #balanceFetchedAt is still 0, so only the in-flight latch can hold.
		for (let i = 0; i < 5; i++) await render(component);
		expect(fetchCalls).toBe(1);
	});

	it("refreshes again once the in-flight request settles and the TTL expires", async () => {
		const component = new StatusLineComponent(makeDeepSeekSession());

		await render(component);
		expect(fetchCalls).toBe(1);

		pending.resolve(
			new Response(JSON.stringify({ balance_infos: [{ total_balance: "42.00", currency: "CNY" }] }), {
				headers: { "content-type": "application/json" },
			}),
		);
		await flushMicrotasks();

		// Fresh cache: redraws stay quiet until the 5-min TTL lapses.
		await render(component);
		expect(fetchCalls).toBe(1);

		pending = Promise.withResolvers<Response>();
		vi.advanceTimersByTime(5 * 60_000 + 1);
		await render(component);
		expect(fetchCalls).toBe(2);
	});

	it("does not resolve or send a custom gateway key to DeepSeek's public endpoint", async () => {
		const getApiKey = vi.fn(async () => "gateway-secret");
		const component = new StatusLineComponent(
			makeDeepSeekSession({ baseUrl: "https://deepseek.internal.example/v1", getApiKey }),
		);

		await render(component);

		expect(getApiKey).not.toHaveBeenCalled();
		expect(fetchCalls).toBe(0);
	});

	it("allows the built-in DeepSeek model whose baseUrl is empty", async () => {
		const getApiKey = vi.fn(async () => "sk-test");
		const component = new StatusLineComponent(makeDeepSeekSession({ getApiKey }));

		await render(component);

		expect(getApiKey).toHaveBeenCalledTimes(1);
		expect(fetchCalls).toBe(1);
	});

	it("allows the explicit first-party DeepSeek API host", async () => {
		const getApiKey = vi.fn(async () => "sk-test");
		const component = new StatusLineComponent(
			makeDeepSeekSession({ baseUrl: "https://api.deepseek.com/v1", getApiKey }),
		);

		await render(component);

		expect(getApiKey).toHaveBeenCalledTimes(1);
		expect(fetchCalls).toBe(1);
	});

	it("rejects a gateway whose hostname only contains the DeepSeek marker", async () => {
		const getApiKey = vi.fn(async () => "gateway-secret");
		const component = new StatusLineComponent(
			makeDeepSeekSession({ baseUrl: "https://api.deepseek.com.gateway.example/v1", getApiKey }),
		);

		await render(component);

		expect(getApiKey).not.toHaveBeenCalled();
		expect(fetchCalls).toBe(0);
	});
	it("does not fetch during rendering when the balance segment is absent", async () => {
		const getApiKey = vi.fn(async () => "sk-test");
		const component = new StatusLineComponent(makeDeepSeekSession({ getApiKey }));

		component.updateSettings({ preset: "custom", leftSegments: ["model"], rightSegments: [] });
		component.getTopBorder(120);
		vi.advanceTimersByTime(0);
		await flushMicrotasks();

		expect(getApiKey).not.toHaveBeenCalled();
		expect(fetchCalls).toBe(0);

		component.updateSettings({ preset: "custom", leftSegments: ["balance"], rightSegments: [] });
		component.getTopBorder(120);
		vi.advanceTimersByTime(0);
		await flushMicrotasks();

		expect(getApiKey).toHaveBeenCalledTimes(1);
		expect(fetchCalls).toBe(1);
	});

	it("clears a fresh cached balance immediately when the provider changes", async () => {
		const session = makeDeepSeekSession();
		const component = new StatusLineComponent(session);

		await render(component);
		pending.resolve(new Response(JSON.stringify({ balance_infos: [{ total_balance: "42.00", currency: "CNY" }] })));
		await flushMicrotasks();
		component.updateSettings({ preset: "custom", leftSegments: ["balance"], rightSegments: [] });
		expect(component.getTopBorder(120).content).toContain("42.00");

		const otherModel = { contextWindow: 200_000, provider: "openai", baseUrl: "" };
		setActiveModelForTest(session, otherModel);

		expect(component.getTopBorder(120).content).not.toContain("42.00");
	});

	it("discards an old DeepSeek response that resolves after a model switch", async () => {
		const session = makeDeepSeekSession();
		const component = new StatusLineComponent(session);

		await render(component);
		const otherModel = { contextWindow: 200_000, provider: "openai", baseUrl: "" };
		setActiveModelForTest(session, otherModel);
		component.refreshBalanceInBackground();

		pending.resolve(new Response(JSON.stringify({ balance_infos: [{ total_balance: "42.00", currency: "CNY" }] })));
		await flushMicrotasks();

		const nextDeepSeek = { contextWindow: 200_000, provider: "deepseek", baseUrl: "" };
		setActiveModelForTest(session, nextDeepSeek);
		pending = Promise.withResolvers<Response>();
		component.updateSettings({ preset: "custom", leftSegments: ["balance"], rightSegments: [] });

		expect(component.getTopBorder(120).content).not.toContain("42.00");
	});

	it("can refresh again after a provider switch cancels an armed timer", async () => {
		const session = makeDeepSeekSession();
		const component = new StatusLineComponent(session);

		component.refreshBalanceInBackground();
		const otherModel = { contextWindow: 200_000, provider: "openai", baseUrl: "" };
		setActiveModelForTest(session, otherModel);
		component.refreshBalanceInBackground();

		const nextDeepSeek = { contextWindow: 200_000, provider: "deepseek", baseUrl: "" };
		setActiveModelForTest(session, nextDeepSeek);
		component.refreshBalanceInBackground();
		vi.advanceTimersByTime(0);
		await flushMicrotasks();

		expect(fetchCalls).toBe(1);
	});

	it("clears a fresh cached balance when switching between DeepSeek models", async () => {
		const session = makeDeepSeekSession();
		const component = new StatusLineComponent(session);

		await render(component);
		pending.resolve(new Response(JSON.stringify({ balance_infos: [{ total_balance: "42.00", currency: "CNY" }] })));
		await flushMicrotasks();
		component.updateSettings({ preset: "custom", leftSegments: ["balance"], rightSegments: [] });
		expect(component.getTopBorder(120).content).toContain("42.00");

		const nextDeepSeek = { contextWindow: 200_000, provider: "deepseek", baseUrl: "" };
		setActiveModelForTest(session, nextDeepSeek);
		pending = Promise.withResolvers<Response>();

		expect(component.getTopBorder(120).content).not.toContain("42.00");
	});

	it("repaints once the fetched balance lands", async () => {
		const component = new StatusLineComponent(makeDeepSeekSession());
		const repaint = vi.fn();
		component.watchBranch(repaint);
		const before = repaint.mock.calls.length;

		await render(component);
		pending.resolve(new Response(JSON.stringify({ balance_infos: [{ total_balance: "42.00", currency: "CNY" }] })));
		await flushMicrotasks();

		// The fetch is async. Without this notification a quiet session shows an
		// empty segment until an unrelated event rebuilds the top border.
		expect(repaint.mock.calls.length).toBeGreaterThan(before);
	});

	it("does not repaint when the balance is unchanged", async () => {
		const component = new StatusLineComponent(makeDeepSeekSession());
		const body = JSON.stringify({ balance_infos: [{ total_balance: "42.00", currency: "CNY" }] });

		await render(component);
		pending.resolve(new Response(body));
		await flushMicrotasks();

		const repaint = vi.fn();
		component.watchBranch(repaint);
		const before = repaint.mock.calls.length;

		// Force a second fetch past the TTL and return the identical figure.
		vi.advanceTimersByTime(10 * 60_000);
		pending = Promise.withResolvers<Response>();
		await render(component);
		pending.resolve(new Response(body));
		await flushMicrotasks();

		expect(repaint.mock.calls.length).toBe(before);
	});

	it("colours the balance without emitting a full SGR reset", async () => {
		const component = new StatusLineComponent(makeDeepSeekSession());

		await render(component);
		pending.resolve(new Response(JSON.stringify({ balance_infos: [{ total_balance: "42.00", currency: "CNY" }] })));
		await flushMicrotasks();
		component.updateSettings({ preset: "custom", leftSegments: ["balance"], rightSegments: [] });

		const content = component.getTopBorder(120).content;
		expect(content).toContain("42.00");
		// `#buildStatusLine` emits its own `\x1b[0m` when the segment group ends,
		// so scope the check to the segment: everything the balance itself writes
		// must appear before that wrapper reset, and must close with a
		// foreground-only `\x1b[39m`. A segment-local full reset would clear the
		// status line's background for everything that follows, and would land
		// the amount in a slice with no `\x1b[39m` in it.
		const fromGlyph = content.slice(content.indexOf("💳"));
		const segmentText = fromGlyph.slice(0, fromGlyph.indexOf("\x1b[0m"));
		expect(segmentText).toContain("42.00");
		expect(segmentText).toContain("\x1b[39m");
	});

	it("re-fetches inside the TTL when the credential changes under the same model", async () => {
		let generation = 1;
		const session = makeDeepSeekSession({ authGeneration: () => generation });
		const component = new StatusLineComponent(session);

		await render(component);
		pending.resolve(new Response(JSON.stringify({ balance_infos: [{ total_balance: "42.00", currency: "CNY" }] })));
		await flushMicrotasks();
		component.updateSettings({ preset: "custom", leftSegments: ["balance"], rightSegments: [] });
		expect(component.getTopBorder(120).content).toContain("42.00");
		expect(fetchCalls).toBe(1);

		// `/login deepseek` stores a key AuthStorage then prefers over the env
		// one. The Model object is untouched and the TTL is still fresh, so the
		// generation bump is the only thing that can retire the old account's
		// figure.
		generation = 2;
		pending = Promise.withResolvers<Response>();
		await render(component);

		expect(component.getTopBorder(120).content).not.toContain("42.00");
		expect(fetchCalls).toBe(2);

		pending.resolve(new Response(JSON.stringify({ balance_infos: [{ total_balance: "7.00", currency: "CNY" }] })));
		await flushMicrotasks();
		expect(component.getTopBorder(120).content).toContain("7.00");
	});

	it("discards a balance whose credential changed while the request was in flight", async () => {
		let generation = 1;
		const session = makeDeepSeekSession({ authGeneration: () => generation });
		const component = new StatusLineComponent(session);
		component.updateSettings({ preset: "custom", leftSegments: ["balance"], rightSegments: [] });

		await render(component);
		expect(fetchCalls).toBe(1);

		generation = 2;
		pending.resolve(new Response(JSON.stringify({ balance_infos: [{ total_balance: "42.00", currency: "CNY" }] })));
		await flushMicrotasks();

		// The figure belongs to the previous account: it must never render, and
		// #balanceFetchedAt must stay unstamped so the TTL cannot swallow the
		// re-fetch on the next redraw.
		expect(component.getTopBorder(120).content).not.toContain("42.00");
		pending = Promise.withResolvers<Response>();
		await render(component);
		expect(fetchCalls).toBe(2);
	});
});
