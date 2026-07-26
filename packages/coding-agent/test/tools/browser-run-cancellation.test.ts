import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { CmuxTab, runCmuxCode } from "@oh-my-pi/pi-coding-agent/tools/browser/cmux/cmux-tab";
import type { CmuxSocketClient } from "@oh-my-pi/pi-coding-agent/tools/browser/cmux/socket-client";
import type { SessionSnapshot } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-protocol";
import { postmortem } from "@oh-my-pi/pi-utils";
import { JsRuntime, type RuntimeHooks } from "../../src/eval/js/shared/runtime";
import {
	attachCodexBrowserToAgent,
	type CodexBrowserAdapter,
	type CodexBrowserOperation,
} from "../../src/tools/browser/codex-facade";
import { bindBrowserRunFacade, markHandled, waitForBrowserRun } from "../../src/tools/browser/run-cancellation";
import { ToolAbortError } from "../../src/tools/tool-errors";

async function collectUnhandledRejections(action: () => void | Promise<void>): Promise<unknown[]> {
	const reasons: unknown[] = [];
	const onUnhandled = (reason: unknown) => reasons.push(reason);
	process.on("unhandledRejection", onUnhandled);
	try {
		await action();
		await Promise.resolve();
		await Promise.resolve();
		vi.advanceTimersByTime(0);
		await Promise.resolve();
		return reasons;
	} finally {
		process.off("unhandledRejection", onUnhandled);
	}
}
function makeSession(cwd: string): ToolSession {
	return {
		cwd,
		hasUI: false,
		settings: { get: () => undefined },
		getSessionFile: () => null,
	} as unknown as ToolSession;
}

describe("browser run cancellation", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("returns the same promise while preserving awaited rejection", async () => {
		const rejection = new Error("browser run ended");
		const promise = Promise.reject(rejection);

		const handled = markHandled(promise);

		expect(handled).toBe(promise);
		await expect(handled).rejects.toBe(rejection);
	});

	it("resolves run-scoped wait when the run is not aborted", async () => {
		const controller = new AbortController();

		const wait = waitForBrowserRun(25, controller.signal);
		vi.advanceTimersByTime(25);

		await expect(wait).resolves.toBeUndefined();
	});

	it("rejects run-scoped wait when the run aborts mid-sleep", async () => {
		const controller = new AbortController();
		const wait = waitForBrowserRun(1000, controller.signal);

		controller.abort(new Error("browser run ended"));

		await expect(wait).rejects.toThrow("browser run ended");
	});

	it("resolves wait(predicate) with the first truthy value", async () => {
		vi.useRealTimers();
		const controller = new AbortController();
		let calls = 0;

		const wait = waitForBrowserRun(() => (++calls >= 3 ? "ready" : null), controller.signal, { interval: 10 });

		await expect(wait).resolves.toBe("ready");
		expect(calls).toBe(3);
	});

	it("fails wait(predicate) with a named timeout error instead of stalling", async () => {
		vi.useRealTimers();
		const controller = new AbortController();

		const wait = waitForBrowserRun(() => false, controller.signal, { timeout: 50, interval: 10 });

		await expect(wait).rejects.toThrow("wait(predicate) timed out after 50ms");
	});

	it("rejects wait(predicate) when the run aborts mid-poll", async () => {
		vi.useRealTimers();
		const controller = new AbortController();

		const wait = waitForBrowserRun(() => false, controller.signal, { timeout: 5000 });
		controller.abort(new Error("browser run ended"));

		await expect(wait).rejects.toThrow("browser run ended");
	});

	it("rejects wait() input that is neither milliseconds nor a predicate", async () => {
		const controller = new AbortController();

		await expect(waitForBrowserRun("soon" as never, controller.signal)).rejects.toThrow(
			"wait(...) expects milliseconds (number) or a predicate function to poll",
		);
	});

	it("does not emit unhandledRejection for an unawaited wait aborted by run teardown", async () => {
		const controller = new AbortController();

		const reasons = await collectUnhandledRejections(async () => {
			void waitForBrowserRun(1000, controller.signal);
			controller.abort(postmortem.markExpectedCleanupError(new Error("browser run ended")));
		});

		expect(reasons).toEqual([]);
	});

	it("does not emit unhandledRejection when an unawaited facade method settles after abort", async () => {
		const controller = new AbortController();
		const deferred = Promise.withResolvers<string>();
		const facade = bindBrowserRunFacade(
			{
				readTitle(): Promise<string> {
					return deferred.promise;
				},
			},
			controller.signal,
		);

		const reasons = await collectUnhandledRejections(async () => {
			void facade.readTitle();
			controller.abort(postmortem.markExpectedCleanupError(new Error("browser run ended")));
			deferred.resolve("late title");
		});

		expect(reasons).toEqual([]);
	});

	it("handles unawaited methods on facade objects resolved from promises", async () => {
		const controller = new AbortController();
		const deferred = Promise.withResolvers<void>();
		const tabTarget = {
			goto(): Promise<void> {
				return deferred.promise;
			},
		};
		const facade = bindBrowserRunFacade(
			{
				async selected() {
					return tabTarget;
				},
			},
			controller.signal,
		);
		expect(await facade.selected()).toBe(await facade.selected());

		const reasons = await collectUnhandledRejections(async () => {
			const tab = await facade.selected();
			void tab.goto();
			controller.abort(postmortem.markExpectedCleanupError(new Error("browser run ended")));
			deferred.reject(controller.signal.reason);
		});

		expect(reasons).toEqual([]);
	});

	it("rejects awaited facade method calls that settle after abort", async () => {
		const controller = new AbortController();
		const deferred = Promise.withResolvers<string>();
		const facade = bindBrowserRunFacade(
			{
				readTitle(): Promise<string> {
					return deferred.promise;
				},
			},
			controller.signal,
		);

		const pending = facade.readTitle();
		controller.abort(new Error("browser run ended"));
		deferred.resolve("late title");

		await expect(pending).rejects.toBeInstanceOf(ToolAbortError);
	});

	it("handles unawaited attached facade rejection while preserving awaited teardown rejection", async () => {
		const controller = new AbortController();
		const teardownError = postmortem.markExpectedCleanupError(new Error("browser run ended"));
		const adapter: CodexBrowserAdapter = {
			currentTabId: "1",
			invoke<T>(_operation: CodexBrowserOperation): Promise<T> {
				const deferred = Promise.withResolvers<T>();
				const rejectOnAbort = () => deferred.reject(controller.signal.reason);
				controller.signal.addEventListener("abort", rejectOnAbort, { once: true });
				if (controller.signal.aborted) rejectOnAbort();
				return deferred.promise;
			},
		};
		const attached = attachCodexBrowserToAgent({}, adapter);

		const reasons = await collectUnhandledRejections(async () => {
			void attached.browser.nameSession("unawaited");
			const awaited = attached.browser.nameSession("awaited");
			controller.abort(teardownError);
			await expect(awaited).rejects.toBe(teardownError);
		});

		expect(reasons).toEqual([]);
	});

	it("aborts run-scoped wait() before a stale continuation can mutate the tab", async () => {
		const runtime = new JsRuntime({ initialCwd: process.cwd(), sessionId: "browser-run-cancellation-test" });
		const timeoutSignal = AbortSignal.timeout(20);
		const runAc = new AbortController();
		const signal = AbortSignal.any([timeoutSignal, runAc.signal]);
		const state: { lateNavigation?: string; displays: string[] } = { displays: [] };
		const { promise: cancelRejection, reject } = Promise.withResolvers<never>();
		const hooks: RuntimeHooks = {
			onText: chunk => state.displays.push(chunk),
			onDisplay: output => state.displays.push(JSON.stringify(output)),
			callTool: async () => undefined,
		};
		timeoutSignal.addEventListener("abort", () => reject(new Error("Browser code execution timed out after 20ms")), {
			once: true,
		});
		runtime.setRunScope({
			wait: (ms: number): Promise<unknown> => waitForBrowserRun(ms, signal),
			tab: bindBrowserRunFacade(
				{
					goto: async (url: string): Promise<void> => {
						state.lateNavigation = url;
					},
				},
				signal,
			),
		});

		const run = Promise.race([
			runtime.run(
				'try { await wait(60); } catch {} await tab.goto("https://late.example"); display("late display");',
				"browser-run-cancellation-test.js",
				hooks,
			),
			cancelRejection,
		]);
		vi.advanceTimersByTime(20);
		await expect(run).rejects.toThrow("Browser code execution timed out after 20ms");
		runAc.abort(new Error("Browser run ended"));
		vi.advanceTimersByTime(100);
		await Promise.resolve();
		await Promise.resolve();

		expect(state.lateNavigation).toBeUndefined();
		expect(state.displays).toEqual([]);
	});
	it("aborts fire-and-forget cmux navigation before adapter cleanup can be undone", async () => {
		const navigateEntered = Promise.withResolvers<void>();
		const releaseNavigation = Promise.withResolvers<void>();
		const cleanupEntered = Promise.withResolvers<void>();
		const releaseCleanup = Promise.withResolvers<void>();
		const navigationSettled = Promise.withResolvers<void>();
		const controlKey = Symbol.for("omp.browser-run-cancellation.cmux-navigation");
		const globals = globalThis as unknown as Record<PropertyKey, unknown>;
		globals[controlKey] = navigationSettled;
		let cleanupStarted = false;
		let observerReinstalls = 0;
		const client = {
			request: async (method: string, params: Record<string, unknown>) => {
				if (method === "browser.navigate") {
					navigateEntered.resolve();
					await releaseNavigation.promise;
					return { url: params.url };
				}
				if (method === "browser.url.get") return { url: "https://before.example" };
				if (method === "browser.wait") return {};
				if (method !== "browser.eval") throw new Error(`Unexpected cmux request: ${method}`);
				const script = typeof params.script === "string" ? params.script : "";
				if (script.includes("delete globalThis.__ompCodexBrowserState")) {
					cleanupStarted = true;
					cleanupEntered.resolve();
					await releaseCleanup.promise;
					return { value: true };
				}
				if (script.includes("Browser adapter page observer is owned by another run")) {
					if (cleanupStarted) {
						observerReinstalls++;
					}
					return { value: 0 };
				}
				if (script.includes("document.title")) return { value: "Before" };
				return { value: true };
			},
		} as unknown as CmuxSocketClient;
		const snapshot: SessionSnapshot = { cwd: process.cwd() };
		const tab = new CmuxTab({ client, surfaceId: "abort-before-cleanup" });
		const run = runCmuxCode(tab, {
			code: `const control = globalThis[Symbol.for("omp.browser-run-cancellation.cmux-navigation")];
				const selected = await agent.browser.tabs.selected();
				void selected.goto("https://late.example").then(control.resolve, control.resolve);
				return "run complete";`,
			timeoutMs: 5_000,
			session: makeSession(snapshot.cwd),
			snapshot,
		});

		try {
			await navigateEntered.promise;
			await cleanupEntered.promise;
			releaseNavigation.resolve();
			await navigationSettled.promise;
			releaseCleanup.resolve();

			await expect(run).resolves.toMatchObject({ returnValue: "run complete" });
			expect(observerReinstalls).toBe(0);
		} finally {
			releaseNavigation.resolve();
			releaseCleanup.resolve();
			await run.catch(() => undefined);
			tab.ensureRuntime(snapshot).dispose();
			delete globals[controlKey];
		}
	});
});
