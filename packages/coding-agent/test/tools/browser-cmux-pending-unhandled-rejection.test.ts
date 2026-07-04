/**
 * Regression test: a cmux-backend `browser.run` call that is still in flight
 * when its tab is torn down (e.g. a sibling `browser({action:"close",
 * all:true})`, or the tab's own idle/session-scoped reap) must not crash the
 * whole process with an unhandled promise rejection.
 *
 * Root cause: `runInTabWithSnapshot` always creates a `{promise, resolve,
 * reject}` pair via `Promise.withResolvers()` and stores `{resolve, reject}`
 * on `tab.pending` so `releaseTab` can reject in-flight runs when a tab dies.
 * The "worker" backend awaits `promise` itself (via `raceWithTimeout`), but
 * the "cmux" backend never does — it races `runCmuxCode` directly and the
 * local `promise` variable goes unconsumed. When `releaseTab` later called
 * `pending.reject(closeError)` against that unconsumed promise, Bun surfaced
 * it as an unhandled rejection, which the CLI's top-level handler treats as
 * fatal and exits the whole session — including any unrelated sibling
 * subagents sharing the process's browser tabs.
 */

import { describe, expect, it, spyOn } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import type { CmuxKind } from "@oh-my-pi/pi-coding-agent/tools/browser/cmux/rpc";
import { CmuxSocketClient } from "@oh-my-pi/pi-coding-agent/tools/browser/cmux/socket-client";
import { acquireBrowser, getBrowsersMapForTest } from "@oh-my-pi/pi-coding-agent/tools/browser/registry";
import {
	acquireTab,
	getTabsMapForTest,
	releaseTab,
	runInTab,
} from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";

function makeKind(socketSuffix: string): CmuxKind {
	return { kind: "cmux", socketPath: `/tmp/omp-test-${socketSuffix}.sock`, surface: `surface-${socketSuffix}` };
}

function makeSession(): ToolSession {
	return { cwd: "/tmp", settings: Settings.isolated() } as unknown as ToolSession;
}

async function drainAllTabs(): Promise<void> {
	for (const name of [...getTabsMapForTest().keys()]) {
		await releaseTab(name, { kill: false }).catch(() => undefined);
	}
}

describe("browser lifecycle — cmux tab release while a run is in flight", () => {
	it("does not raise an unhandled rejection when releaseTab fires mid-run", async () => {
		const { promise: navigateGate, resolve: releaseNavigateGate } = Promise.withResolvers<void>();

		const connectSpy = spyOn(CmuxSocketClient.prototype, "connect").mockResolvedValue(undefined);
		const closeSpy = spyOn(CmuxSocketClient.prototype, "close").mockImplementation(() => undefined);
		const requestSpy = spyOn(CmuxSocketClient.prototype, "request").mockImplementation(
			async (method: string): Promise<Record<string, unknown>> => {
				if (method === "browser.open_split") return { surface_id: "surface-pending-reject", url: "about:blank" };
				if (method === "browser.navigate") {
					// Block the in-flight run here so `releaseTab` below races it.
					await navigateGate;
					return { url: "about:blank" };
				}
				return {};
			},
		);

		const unhandledRejections: unknown[] = [];
		const onUnhandledRejection = (reason: unknown): void => {
			unhandledRejections.push(reason);
		};
		process.on("unhandledRejection", onUnhandledRejection);

		try {
			const kind = makeKind("pending-reject");
			const browser = await acquireBrowser(kind, { cwd: "/tmp" });
			await acquireTab("docfinal", browser, { timeoutMs: 5_000 });

			const runPromise = runInTab("docfinal", {
				code: "await tab.goto('about:blank');",
				timeoutMs: 5_000,
				session: makeSession(),
			});
			// Swallow the run's own rejection (expected once the tab is closed
			// out from under it) — this test only cares that nothing escapes as
			// an *unhandled* rejection.
			runPromise.catch(() => undefined);

			// Let the mocked "browser.navigate" request actually start and
			// register itself on `tab.pending` before we release the tab.
			while ((getTabsMapForTest().get("docfinal")?.pending.size ?? 0) === 0) {
				await Promise.resolve();
			}

			// Simulate a sibling subagent (or the idle reaper) tearing the tab
			// down while the run above is still blocked on `navigateGate`.
			await releaseTab("docfinal", { kill: false });

			// Unblock the mocked RPC call now that the tab is gone; `runCmuxCode`
			// must settle (reject) through its own abort path without producing
			// a second, unhandled rejection.
			releaseNavigateGate();
			await runPromise.catch(() => undefined);

			// Give the microtask queue (and Bun's unhandledRejection reporting,
			// which fires on a later tick) a chance to flush.
			await Promise.resolve();
			await Promise.resolve();

			expect(unhandledRejections).toEqual([]);
			expect(getTabsMapForTest().has("docfinal")).toBe(false);
			expect(getBrowsersMapForTest().size).toBe(0);
		} finally {
			process.off("unhandledRejection", onUnhandledRejection);
			connectSpy.mockRestore();
			closeSpy.mockRestore();
			requestSpy.mockRestore();
			await drainAllTabs();
		}
	});
});
