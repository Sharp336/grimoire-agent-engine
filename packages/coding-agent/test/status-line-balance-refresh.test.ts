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

function makeDeepSeekSession(): AgentSession {
	const messages: unknown[] = [];
	const model = { contextWindow: 200_000, provider: "deepseek" };
	return {
		sessionId: "session-1",
		messages,
		state: { messages, model },
		model,
		isStreaming: false,
		modelRegistry: { getApiKey: async () => "sk-test" },
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
});
