import { getPuppeteerDir, logger, postmortem, Snowflake, withTimeout, workerHostEntry } from "@oh-my-pi/pi-utils";
import type { Page, Target } from "puppeteer-core";
import { callSessionTool } from "../../eval/js/tool-bridge";
import { webpExclusionForModel } from "../../utils/image-loading";
import type { ToolSession } from "../index";
import { expandPath } from "../path-utils";
import { ToolAbortError, ToolError } from "../tool-errors";
import { pickElectronTarget } from "./attach";
import { CmuxTab, runCmuxCode } from "./cmux/cmux-tab";
import { mapWaitUntil } from "./cmux/rpc";
import { DEFAULT_VIEWPORT } from "./launch";
import type { RecordingLimits, RecordingSummary } from "./network-recorder";
import {
	type BrowserHandle,
	type BrowserKindTag,
	type CmuxBrowserHandle,
	holdBrowser,
	type PuppeteerBrowserHandle,
	releaseBrowser,
} from "./registry";
import type {
	ReadyInfo,
	RunErrorPayload,
	RunResultOk,
	SessionSnapshot,
	Transferable,
	Transport,
	WorkerInbound,
	WorkerInitPayload,
	WorkerOutbound,
} from "./tab-protocol";

// Coding-agent binary/bundle workers route through the CLI entrypoint with a
// hidden argv mode, so compiled/npm builds only need one JavaScript entry.

export interface WorkerHandle {
	send(msg: WorkerInbound, transferList?: Transferable[]): void;
	onMessage(handler: (msg: WorkerOutbound) => void): () => void;
	onError(handler: (error: Error) => void): () => void;
	terminate(): Promise<void>;
	readonly mode: "worker" | "inline";
}

export type DialogPolicy = "accept" | "dismiss";

export interface PendingRun {
	resolve(result: RunResultOk): void;
	reject(error: unknown): void;
	session: ToolSession;
	signal?: AbortSignal;
	toolCalls: Map<string, AbortController>;
	/**
	 * Fires when `releaseTab` closes the tab out from under an in-flight run
	 * (sibling `browser close --all`, session-scoped reap, etc.). Composed
	 * into the cmux run's signal so `wait(...)`, cmux socket calls, and the
	 * facade proxies unwind promptly instead of blocking to the run's
	 * timeout. `pending.reject` still fires first so the awaiting caller
	 * sees the tab-close error immediately; `closeAc` propagates the
	 * cancellation into the still-running `runCmuxCode` body (issue #4499).
	 */
	closeAc?: AbortController;
}

/** Phase of a tab's single active network recording; undefined means no recording. */
export type TabRecordingPhase = "starting" | "active" | "stopping";

/**
 * A recording control op (start/stop/cancel) awaiting its worker reply. Bound to the exact
 * worker instance + generation that issued it so a reply from a superseded worker (after a
 * recycle/replacement/kill) can never settle it or corrupt the current recording.
 */
interface PendingControl {
	resolve(msg: WorkerOutbound): void;
	reject(error: unknown): void;
	worker: WorkerHandle;
	generation: number;
}

interface TabSessionBase<TBrowser extends BrowserHandle = BrowserHandle> {
	name: string;
	browser: TBrowser;
	targetId: string;
	state: "alive" | "dead";
	info: ReadyInfo;
	pending: Map<string, PendingRun>;
	dialogPolicy?: DialogPolicy;
	kindTag: BrowserKindTag;
	/**
	 * Session id of the caller that CREATED the tab. Preserved across reuse so
	 * that dispose of the creating session can reap browser resources without
	 * yanking the tab out from under a subagent that only reused it.
	 * Undefined when the acquirer did not identify itself.
	 */
	ownerSessionId?: string;
}

export interface WorkerTabSession extends TabSessionBase<PuppeteerBrowserHandle> {
	backend: "worker";
	worker: WorkerHandle;
	/** Phase of this tab's single active/in-flight network recording, if any. */
	recording?: TabRecordingPhase;
}

interface ManagedWorkerTabSession extends WorkerTabSession {
	/** Monotonic counter bumped on every worker replacement/teardown; see {@link PendingControl}. */
	workerGeneration: number;
	/** Pending recording control ops keyed by controlId (`recording-<snowflake>`). */
	controls: Map<string, PendingControl>;
}

export interface CmuxTabSession extends TabSessionBase<CmuxBrowserHandle> {
	backend: "cmux";
	cmuxTab: CmuxTab;
	cmuxOwnsSurface: boolean;
	cmuxAttachedSurface?: string;
}

export type TabSession = WorkerTabSession | CmuxTabSession;

export interface AcquireTabOptions {
	url?: string;
	waitUntil?: "load" | "domcontentloaded" | "networkidle0" | "networkidle2";
	viewport?: { width: number; height: number; deviceScaleFactor?: number };
	target?: string;
	signal?: AbortSignal;
	timeoutMs: number;
	dialogs?: DialogPolicy;
	cmuxSurface?: string;
	/**
	 * Session id of the acquirer. Recorded on the tab when created (never on
	 * reuse) so `releaseTabsForOwner` can walk the shared tabs map on session
	 * dispose. Optional — omitting it opts the tab out of session-scoped reap.
	 */
	ownerSessionId?: string;
}

export interface AcquireTabResult {
	tab: TabSession;
	created: boolean;
}

export interface RunInTabOptions {
	code: string;
	timeoutMs: number;
	signal?: AbortSignal;
	session: ToolSession;
}

export interface ReleaseTabOptions {
	kill?: boolean;
	/** Maximum time for each asynchronous cleanup resource before close fails with diagnostics. */
	timeoutMs?: number;
}

const tabs = new Map<string, ManagedWorkerTabSession | CmuxTabSession>();
// Per-name acquisition chain: serializes concurrent `acquireTab` calls for the
// same tab name so the existence check and `tabs.set` (separated by several
// awaits) cannot interleave and leak a worker + browser refCount.
const acquireChains = new Map<string, Promise<void>>();
const GRACE_MS = 750;
// Names of tabs the supervisor force-killed (timeout past grace, failed recycle),
// mapped to the kill reason. Lets the next `run` on that name explain WHY the tab
// vanished instead of a bare "not alive". Cleared when the name is opened again.
const killedTabs = new Map<string, string>();
const DEFAULT_TAB_CLOSE_TIMEOUT_MS = 5_000;
class RecoverableWorkerError extends ToolError {}

async function waitForTabCleanup<T>(
	tab: TabSession,
	timeoutMs: number,
	pendingResource: string,
	promise: Promise<T>,
): Promise<T> {
	const message = `Timed out after ${timeoutMs}ms closing ${tab.kindTag} browser tab ${JSON.stringify(tab.name)}; pending resource: ${pendingResource}`;
	try {
		return await withTimeout(promise, timeoutMs, message);
	} catch (error) {
		if (error instanceof Error && error.message === message) throw new ToolError(message);
		throw error;
	}
}

export function getTab(name: string): TabSession | undefined {
	return tabs.get(name);
}

export function acquireTab(name: string, browser: BrowserHandle, opts: AcquireTabOptions): Promise<AcquireTabResult> {
	const prior = acquireChains.get(name) ?? Promise.resolve();
	const result = prior.then(() => acquireTabImpl(name, browser, opts));
	const tail = result.then(
		() => undefined,
		() => undefined,
	);
	acquireChains.set(name, tail);
	void tail.then(() => {
		if (acquireChains.get(name) === tail) acquireChains.delete(name);
	});
	return result;
}

async function acquireTabImpl(
	name: string,
	browser: BrowserHandle,
	opts: AcquireTabOptions,
): Promise<AcquireTabResult> {
	// Serialized opens can sit behind a slow predecessor in the per-name
	// chain; honor an abort at dequeue instead of spawning a worker and
	// browser hold nobody is waiting for.
	if (opts.signal?.aborted) {
		throw new ToolAbortError("Browser tab open aborted");
	}
	killedTabs.delete(name);
	// Temporary refCount hold so releasing an existing tab on the SAME browser
	// below cannot drop it to refCount 0 and dispose the instance we are about
	// to reuse (e.g. reopening the sole tab with a different dialogs policy).
	let tempHold = false;
	const existing = tabs.get(name);
	if (existing) {
		if (existing.browser === browser && existing.state === "alive") {
			const requestedCmuxSurface = "client" in browser ? (opts.cmuxSurface ?? browser.surface) : undefined;
			if (existing.backend === "cmux" && existing.cmuxAttachedSurface !== requestedCmuxSurface) {
				holdBrowser(browser);
				tempHold = true;
				await releaseTab(name, { kill: false });
			} else if (opts.dialogs !== undefined && opts.dialogs !== existing.dialogPolicy) {
				holdBrowser(browser);
				tempHold = true;
				await releaseTab(name, { kill: false });
			} else {
				const reuseSteps: string[] = [];
				if (opts.viewport && browser.kind.kind !== "cmux") {
					const dsf = opts.viewport.deviceScaleFactor;
					reuseSteps.push(
						`await page.setViewport({ width: ${opts.viewport.width}, height: ${opts.viewport.height}, deviceScaleFactor: ${dsf === undefined ? "undefined" : String(dsf)} });`,
					);
				}
				if (opts.url) {
					reuseSteps.push(
						`await tab.goto(${JSON.stringify(opts.url)}, { waitUntil: ${JSON.stringify(opts.waitUntil ?? "load")} });`,
					);
				}
				if (reuseSteps.length) {
					await runInTabWithSnapshot(
						name,
						{
							code: reuseSteps.join("\n"),
							timeoutMs: opts.timeoutMs,
							signal: opts.signal,
						},
						{ cwd: process.cwd() },
					);
				}
				return { tab: tabs.get(name)!, created: false };
			}
		} else {
			if (existing.browser === browser) {
				holdBrowser(browser);
				tempHold = true;
			}
			await releaseTab(name, { kill: false });
		}
	}

	if ("client" in browser) {
		try {
			const result = await acquireCmuxTab(name, browser, opts);
			if (tempHold) await releaseBrowser(browser, { kill: false });
			return result;
		} catch (error) {
			if (tempHold || browser.refCount === 0) await releaseBrowser(browser, { kill: false });
			throw error;
		}
	}
	let initPayload: WorkerInitPayload;
	let worker: WorkerHandle;
	try {
		initPayload = await buildInitPayload(browser, opts);
		worker = await spawnTabWorker();
	} catch (error) {
		// Failing before the worker took its own hold must release the
		// temporary one, or the browser's refCount never reaches 0 again.
		if (tempHold || browser.refCount === 0) await releaseBrowser(browser, { kill: false });
		throw error;
	}
	let info: ReadyInfo;
	try {
		info = await initializeTabWorker(worker, initPayload, opts.timeoutMs + GRACE_MS);
	} catch (error) {
		// `BuildMessage`-class failures arrive asynchronously via the worker's `error` event,
		// after `spawnTabWorker`'s synchronous try/catch has already returned. Fall back to
		// the inline worker here so module-resolution failures don't poison every tab open.
		await worker.terminate().catch(() => undefined);
		if (worker.mode === "inline") {
			if (tempHold || browser.refCount === 0) await releaseBrowser(browser, { kill: false });
			throw error;
		}
		logger.warn("Tab worker init failed; retrying with inline tab worker (no sync-loop guard)", {
			error: error instanceof Error ? error.message : String(error),
		});
		worker = await spawnInlineWorker();
		try {
			info = await initializeTabWorker(worker, initPayload, opts.timeoutMs + GRACE_MS);
		} catch (inlineError) {
			await worker.terminate().catch(() => undefined);
			if (tempHold || browser.refCount === 0) await releaseBrowser(browser, { kill: false });
			const finalError = new ToolError(
				`Failed to start browser tab worker (inline fallback also failed): ${inlineError instanceof Error ? inlineError.message : String(inlineError)}`,
			);
			(finalError as { cause?: unknown }).cause = error;
			throw finalError;
		}
	}

	// If the caller aborted while we were spawning/initializing the worker,
	// tear the freshly-built worker down before publishing the tab so the
	// browser refCount (which `holdBrowser` below would take) never grows for
	// a tab nobody is waiting for.
	if (opts.signal?.aborted) {
		await worker.terminate().catch(() => undefined);
		if (tempHold) await releaseBrowser(browser, { kill: false }).catch(() => undefined);
		throw new ToolAbortError("Browser tab open aborted");
	}

	holdBrowser(browser);
	if (tempHold) await releaseBrowser(browser, { kill: false });
	const tab: ManagedWorkerTabSession = {
		name,
		browser,
		targetId: info.targetId,
		backend: "worker",
		worker,
		state: "alive",
		info,
		pending: new Map(),
		dialogPolicy: opts.dialogs,
		kindTag: browser.kind.kind,
		ownerSessionId: opts.ownerSessionId,
		workerGeneration: 0,
		controls: new Map(),
	};
	attachLongLivedHandlers(tab, worker);
	tabs.set(name, tab);
	return { tab, created: true };
}

async function acquireCmuxTab(
	name: string,
	browser: CmuxBrowserHandle,
	opts: AcquireTabOptions,
): Promise<AcquireTabResult> {
	const attachedSurface = opts.cmuxSurface ?? browser.surface;
	if (attachedSurface?.startsWith("surface:")) {
		throw new ToolError(
			"app.surface must be a surface UUID (e.g. CMUX_SURFACE_ID), not a 'surface:N' ref; omit it to open a new split",
		);
	}

	let surfaceId = attachedSurface;
	let initialUrl = opts.url;
	let ownsSurface = false;
	try {
		if (!surfaceId) {
			const params: Record<string, unknown> = { url: opts.url ?? "about:blank", focus: false };
			if (process.env.CMUX_WORKSPACE_ID) params.workspace_id = process.env.CMUX_WORKSPACE_ID;
			if (process.env.CMUX_SURFACE_ID) params.surface_id = process.env.CMUX_SURFACE_ID;
			const result = await browser.client.request("browser.open_split", params, { timeoutMs: opts.timeoutMs });
			if (typeof result.surface_id !== "string" || result.surface_id.length === 0) {
				throw new ToolError("cmux browser.open_split did not return a surface_id");
			}
			surfaceId = result.surface_id;
			ownsSurface = true;
			if (typeof result.url === "string" && result.url.length > 0) initialUrl = result.url;
			if (opts.url) {
				await browser.client.request(
					"browser.wait",
					{
						surface_id: surfaceId,
						load_state: mapWaitUntil(opts.waitUntil ?? "load"),
						timeout_ms: opts.timeoutMs,
					},
					{ timeoutMs: opts.timeoutMs },
				);
			}
		}

		const cmuxTab = new CmuxTab({ client: browser.client, surfaceId, url: initialUrl });
		if (attachedSurface && opts.url) {
			await cmuxTab.goto(opts.url, { waitUntil: opts.waitUntil ?? "load", timeoutMs: opts.timeoutMs });
		}
		const info = await cmuxTab.readyInfo(opts.viewport ?? DEFAULT_VIEWPORT);
		// If the caller aborted while we were opening the cmux surface, close the
		// surface (if we own it) instead of taking a browser hold on it.
		if (opts.signal?.aborted) {
			throw new ToolAbortError("Browser tab open aborted");
		}
		holdBrowser(browser);
		const tab: CmuxTabSession = {
			name,
			browser,
			targetId: surfaceId,
			backend: "cmux",
			cmuxTab,
			cmuxOwnsSurface: ownsSurface,
			state: "alive",
			info,
			pending: new Map(),
			dialogPolicy: opts.dialogs,
			kindTag: browser.kind.kind,
			cmuxAttachedSurface: attachedSurface,
			ownerSessionId: opts.ownerSessionId,
		};
		tabs.set(name, tab);
		return { tab, created: true };
	} catch (error) {
		if (ownsSurface && surfaceId) {
			await browser.client.request("surface.close", { surface_id: surfaceId }).catch(() => undefined);
		}
		throw error;
	}
}

export async function runInTab(name: string, opts: RunInTabOptions): Promise<RunResultOk> {
	return await runInTabWithSnapshot(
		name,
		{ code: opts.code, timeoutMs: opts.timeoutMs, signal: opts.signal, session: opts.session },
		{
			cwd: opts.session.cwd,
			browserScreenshotDir: expandBrowserScreenshotDir(opts.session),
			excludeWebP: webpExclusionForModel(opts.session.getActiveModel?.()),
		},
	);
}

async function runInTabWithSnapshot(
	name: string,
	opts: { code: string; timeoutMs: number; signal?: AbortSignal; session?: ToolSession },
	snapshot: SessionSnapshot,
): Promise<RunResultOk> {
	const tab = tabs.get(name);
	if (!tab || tab.state === "dead") {
		const killed = killedTabs.get(name);
		throw new ToolError(
			killed
				? `Tab ${JSON.stringify(name)} was killed: ${killed}. Reopen it.`
				: `Tab ${JSON.stringify(name)} is not alive. Open it first with action:"open".`,
		);
	}
	if (tab.pending.size > 0) throw new ToolError(`Tab ${JSON.stringify(name)} is busy`);
	const id = Snowflake.next();
	const { promise, resolve, reject } = Promise.withResolvers<RunResultOk>();
	// `releaseTab` calls `pending.reject(closeError)` when the tab dies
	// out from under an in-flight run (sibling `browser close --all`,
	// session-scoped reap, etc.). Both backends below MUST end up awaiting
	// this same `promise` so:
	//   1. The caller sees `Tab ... was closed` immediately instead of
	//      blocking to the run's timeout, and
	//   2. `reject(...)` always has an attached handler — a zero-consumer
	//      rejection would fire `unhandledRejection` and the CLI's
	//      top-level handler would tear the whole session down, killing
	//      every other tab and subagent sharing the process (issue #4499).
	// The cmux branch also composes `closeAc.signal` into the run's abort
	// signal so `wait(...)`, cmux socket calls, and the facade proxies
	// unwind promptly when the tab is closed — otherwise a `wait(60_000)`
	// with no in-flight socket request would keep `runCmuxCode` blocked
	// until timeout even after the tab is gone.
	const closeAc = new AbortController();
	const pending: PendingRun = {
		resolve,
		reject,
		session: opts.session ?? ({} as ToolSession),
		signal: opts.signal,
		toolCalls: new Map(),
		closeAc,
	};
	tab.pending.set(id, pending);
	if (tab.backend === "cmux") {
		const runSignal = opts.signal ? AbortSignal.any([opts.signal, closeAc.signal]) : closeAc.signal;
		try {
			// `runCmuxCode.then(resolve, reject)` publishes the run's real
			// outcome to `promise`, but `releaseTab` may have already
			// rejected it — `Promise.withResolvers` settles on the first
			// call and later resolve/reject are no-ops, so the tab-close
			// error still wins the race.
			runCmuxCode(tab.cmuxTab, {
				code: opts.code,
				timeoutMs: opts.timeoutMs,
				signal: runSignal,
				session: pending.session,
				snapshot,
			}).then(resolve, reject);
			return await promise;
		} finally {
			tab.pending.delete(id);
		}
	}
	const abort = (): void => {
		tab.worker.send({ type: "abort", id });
		for (const ctrl of pending.toolCalls.values()) ctrl.abort(opts.signal?.reason);
	};
	if (opts.signal?.aborted) abort();
	else opts.signal?.addEventListener("abort", abort, { once: true });
	try {
		tab.worker.send({
			type: "run",
			id,
			name,
			code: opts.code,
			timeoutMs: opts.timeoutMs,
			session: snapshot,
		});
		try {
			return await raceWithTimeout(
				promise,
				opts.timeoutMs + GRACE_MS,
				"Browser code execution hung past grace; tab killed",
				async reason => await forceKillTab(name, reason),
			);
		} catch (error) {
			const runTimedOut =
				error instanceof ToolError && error.message.startsWith("Browser code execution timed out after ");
			if (runTimedOut || error instanceof RecoverableWorkerError) {
				try {
					if (tab.worker.mode === "inline") {
						const reason = runTimedOut
							? "Browser code execution timed out; tab killed"
							: "Browser request interception cleanup failed; tab killed";
						await forceKillTab(name, reason);
					} else {
						await recycleTimedOutWorkerTab(tab, opts.timeoutMs + GRACE_MS);
					}
				} catch (recycleError) {
					logger.warn("Failed to recycle browser tab worker; killing tab", {
						error: recycleError instanceof Error ? recycleError.message : String(recycleError),
					});
					await forceKillTab(name, "Browser tab worker recovery failed; tab killed");
				}
			}
			throw error;
		}
	} finally {
		opts.signal?.removeEventListener("abort", abort);
		tab.pending.delete(id);
	}
}

export async function releaseTab(name: string, opts: ReleaseTabOptions = {}): Promise<boolean> {
	const tab = tabs.get(name);
	if (!tab) {
		logger.debug("releaseTab: unknown tab", { name });
		return false;
	}
	const wasAlive = tab.state === "alive";
	tab.state = "dead";
	const closeError = postmortem.markExpectedCleanupError(new ToolError(`Tab ${JSON.stringify(name)} was closed`));
	if (tab.backend === "worker") {
		// Retire the worker generation and settle recording controls BEFORE the worker instance is
		// terminated, so no late reply can resolve a control or revive recording state (issue INV-579).
		bumpWorkerGeneration(tab);
		tab.recording = undefined;
		settleAllControlOps(tab, closeError);
	}
	for (const [id, pending] of tab.pending) {
		if (tab.backend === "worker") {
			try {
				tab.worker.send({ type: "abort", id, expectedCleanup: true });
			} catch {}
		}
		for (const ctrl of pending.toolCalls.values()) ctrl.abort(closeError);
		// Propagate the closure into the cmux run's abort signal so
		// `wait(...)`, in-flight cmux socket calls, and the facade proxies
		// unwind promptly. Firing this BEFORE `pending.reject` means
		// `runCmuxCode` finishes with `ToolAbortError` and its `.then(reject)`
		// is a no-op — `promise` still settles with the tab-close error via
		// the `reject` call below. Without it, a run that isn't currently
		// making a socket request (e.g. `await wait(60_000)`) would keep
		// `runCmuxCode` blocked until timeout even after `pending.reject`
		// unblocked the caller (issue #4499 review feedback).
		pending.closeAc?.abort(closeError);
		pending.reject(closeError);
	}
	tab.pending.clear();
	const timeoutMs = opts.timeoutMs ?? DEFAULT_TAB_CLOSE_TIMEOUT_MS;
	if (tab.backend === "cmux") {
		let closeError: unknown;
		if (wasAlive && tab.cmuxOwnsSurface) {
			try {
				await waitForTabCleanup(
					tab,
					timeoutMs,
					`cmux surface ${JSON.stringify(tab.targetId)} (surface.close)`,
					tab.browser.client.request("surface.close", { surface_id: tab.targetId }, { timeoutMs }),
				);
			} catch (err) {
				if (isLastSurfaceCloseError(err)) {
					logger.debug("Leaving cmux browser surface open because it is the last surface in the workspace", {
						error: err instanceof Error ? err.message : String(err),
					});
				} else {
					closeError = err;
				}
			}
		}
		try {
			await releaseBrowser(tab.browser, {
				kill: opts.kill ?? false,
				timeoutMs,
				resource: `tab ${JSON.stringify(name)}`,
			});
		} catch (error) {
			closeError ??= error;
		} finally {
			tabs.delete(name);
		}
		if (closeError) throw closeError;
		return true;
	}
	let cleanupError: unknown;
	let forced = false;
	if (wasAlive) {
		try {
			tab.worker.send({ type: "close" });
			await waitForClosed(tab);
		} catch {
			forced = true;
		}
	}
	await tab.worker.terminate().catch(() => undefined);
	if (forced && tab.kindTag === "headless") {
		try {
			await waitForTabCleanup(
				tab,
				timeoutMs,
				`orphan CDP target ${JSON.stringify(tab.targetId)} (Page.close)`,
				closeOrphanTarget(tab),
			);
		} catch (error) {
			cleanupError = error;
		}
	}
	try {
		await releaseBrowser(tab.browser, {
			kill: opts.kill ?? false,
			timeoutMs,
			resource: `tab ${JSON.stringify(name)}`,
		});
	} catch (error) {
		cleanupError ??= error;
	} finally {
		tabs.delete(name);
	}
	if (cleanupError) throw cleanupError;
	return true;
}

export async function releaseAllTabs(opts: ReleaseTabOptions = {}): Promise<number> {
	const names = [...tabs.keys()];
	let count = 0;
	for (const name of names) {
		if (await releaseTab(name, opts)) count++;
	}
	return count;
}

export async function dropHeadlessTabs(): Promise<void> {
	const names = [...tabs.values()].filter(tab => tab.kindTag === "headless").map(tab => tab.name);
	for (const name of names) await releaseTab(name);
}

/**
 * Release every tab created by the given session id. Invoked from
 * `AgentSession.dispose()` so headless/spawned Chromium and workers the
 * session opened do not leak into the long-lived process — the module-global
 * `tabs`/`browsers` maps that back this tool are not otherwise walked by
 * session teardown. (Issue #3963.)
 *
 * Ownership is recorded ONLY on tab creation (`acquireTab` with
 * `ownerSessionId`), never on reuse: a subagent re-driving a tab another
 * session opened will not yank teardown responsibility away from the
 * creator. Tabs opened with no owner (e.g. from an SDK caller that doesn't
 * identify a session) are skipped and must be released explicitly.
 */
export async function releaseTabsForOwner(ownerId: string, opts: ReleaseTabOptions = {}): Promise<number> {
	if (!ownerId) return 0;
	const names = [...tabs.values()].filter(tab => tab.ownerSessionId === ownerId).map(tab => tab.name);
	let count = 0;
	for (const name of names) {
		if (await releaseTab(name, opts)) count++;
	}
	return count;
}

/** Test-only accessor for the module-global tabs map. */
export function getTabsMapForTest(): ReadonlyMap<string, TabSession> {
	return tabs;
}

// ---------------------------------------------------------------------------
// Network recording control (INV-579)
// ---------------------------------------------------------------------------

/** Bound on the `recording-cancel` handshake after a control op is abandoned. */
const RECORDING_CANCEL_MS = 250;

export interface StartRecordingOptions {
	domains?: readonly string[];
	limits?: Partial<RecordingLimits>;
	signal?: AbortSignal;
	timeoutMs: number;
}

export interface StopRecordingOptions {
	signal?: AbortSignal;
	timeoutMs: number;
}

export interface StartRecordingResult {
	scope: readonly string[];
	backend: BrowserKindTag;
	tabName: string;
}

export interface StopRecordingResult extends RecordingSummary {
	backend: BrowserKindTag;
	tabName: string;
}

/** Register both long-lived worker handlers (message dispatch + failure) for a tab's worker. */
function attachLongLivedHandlers(tab: ManagedWorkerTabSession, worker: WorkerHandle): void {
	worker.onMessage(msg => handleTabMessage(tab, worker, msg));
	worker.onError(error => onWorkerFailure(tab, worker, error));
}

/**
 * Long-lived worker `error`/`closed` handler. A worker that dies or closes outside an
 * intentional release makes the tab unusable: settle every pending control, discard the
 * active recording, and mark the tab dead so future runs/starts reject until it is
 * reacquired. Messages from a superseded worker instance are ignored.
 */
function onWorkerFailure(tab: ManagedWorkerTabSession, sourceWorker: WorkerHandle, error: unknown): void {
	if (sourceWorker !== tab.worker) return;
	settleAllControlOps(tab, error);
	tab.recording = undefined;
	tab.state = "dead";
}

/** Reject and clear every pending recording control on a tab. */
function settleAllControlOps(tab: ManagedWorkerTabSession, error: unknown): void {
	if (tab.controls.size === 0) return;
	const controls = [...tab.controls.values()];
	tab.controls.clear();
	for (const control of controls) control.reject(error);
}

/** Reject and clear only the controls at or below `generation` — the retired worker's ops. */
function settleControlsUpToGeneration(tab: ManagedWorkerTabSession, generation: number, error: unknown): void {
	const stale = [...tab.controls].filter(([, control]) => control.generation <= generation);
	if (stale.length === 0) return;
	for (const [id] of stale) tab.controls.delete(id);
	for (const [, control] of stale) control.reject(error);
}

function bumpWorkerGeneration(tab: ManagedWorkerTabSession): void {
	tab.workerGeneration += 1;
}

function requireWorkerTab(name: string): ManagedWorkerTabSession {
	const tab = tabs.get(name);
	if (!tab || tab.state === "dead") {
		const killed = killedTabs.get(name);
		throw new ToolError(
			killed
				? `Tab ${JSON.stringify(name)} was killed: ${killed}. Reopen it.`
				: `Tab ${JSON.stringify(name)} is not alive. Open it first with action:"open".`,
		);
	}
	if (tab.backend !== "worker") {
		throw new ToolError(`Network recording is not supported for the ${tab.kindTag} browser backend`);
	}
	return tab;
}

/**
 * Validate an explicit recording domain as an exact HTTP(S) origin: reject credentials,
 * paths, queries, fragments, wildcards, and non-HTTP(S)/opaque schemes. Returns the
 * normalized (lowercased) origin. Omitted domains are resolved live by the worker instead.
 */
function validateRecordingOrigin(raw: string, index: number): string {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new ToolError(`Invalid recording domain at index ${index}: expected an http(s) origin`);
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new ToolError(`Recording domain at index ${index} must use an http(s) scheme`);
	}
	if (url.username || url.password) {
		throw new ToolError(`Recording domain at index ${index} must not include credentials`);
	}
	if (url.pathname !== "/") {
		throw new ToolError(`Recording domain at index ${index} must not include a path`);
	}
	if (url.search) {
		throw new ToolError(`Recording domain at index ${index} must not include a query string`);
	}
	if (url.hash) {
		throw new ToolError(`Recording domain at index ${index} must not include a fragment`);
	}
	if (url.hostname.includes("*")) {
		throw new ToolError(`Recording domain at index ${index} must not use wildcards`);
	}
	return url.origin.toLowerCase();
}

function validateRecordingDomains(domains: readonly string[]): string[] {
	return domains.map((domain, index) => validateRecordingOrigin(domain, index));
}

/**
 * Start a network recording on a worker-backed tab. Serializes via the per-tab `recording`
 * sentinel: a start while `starting`/`active`/`stopping` rejects without disturbing the
 * existing recording. Explicit domains are validated here; omitted domains are resolved live
 * by the worker from `page.url()` (the cached `tab.info.url` is only used to fail fast when the
 * tab has never left `about:blank`). Active state is retained only after `recording-started`.
 */
export async function startTabRecording(name: string, options: StartRecordingOptions): Promise<StartRecordingResult> {
	const tab = requireWorkerTab(name);
	if (tab.recording) throw new ToolError(`Tab ${JSON.stringify(name)} is already recording`);

	let domains: string[] | undefined;
	if (options.domains && options.domains.length > 0) {
		domains = validateRecordingDomains(options.domains);
	} else {
		// `tab.info.url` is only an about:blank UX preflight here — never the recording scope source
		// (the worker resolves scope live from page.url()); scope is never derived from this cached URL.
		const url = tab.info.url;
		if (!url || url === "about:blank") {
			throw new ToolError(
				`Tab ${JSON.stringify(name)} has no page to record; open a URL first or pass domains explicitly`,
			);
		}
		domains = undefined;
	}

	// Install the starting sentinel BEFORE sending so a concurrent start observes it and rejects.
	tab.recording = "starting";
	try {
		const reply = await runRecordingControl(
			tab,
			{ type: "recording-start", id: `recording-${Snowflake.next()}`, domains, limits: options.limits },
			options.timeoutMs,
			options.signal,
		);
		if (reply.type !== "recording-started") throw new ToolError(`Unexpected recording reply ${reply.type} for start`);
		tab.recording = "active";
		return { scope: reply.scope, backend: tab.kindTag, tabName: name };
	} finally {
		// Retain "active" only on success; discard any lingering "starting" on failure.
		if (tab.recording === "starting") tab.recording = undefined;
	}
}

/**
 * Stop the active recording and return its summary. Rejects when nothing is active
 * (`undefined`/`starting`) or a stop is already in flight (`already stopping`). The worker
 * drains for `timeoutMs`; the supervisor allows an extra grace before abandoning the control.
 */
export async function stopTabRecording(name: string, options: StopRecordingOptions): Promise<StopRecordingResult> {
	const tab = requireWorkerTab(name);
	if (tab.recording === "stopping")
		throw new ToolError(`Tab ${JSON.stringify(name)} is already stopping its recording`);
	if (tab.recording !== "active") throw new ToolError(`Tab ${JSON.stringify(name)} is not recording`);

	tab.recording = "stopping";
	try {
		const reply = await runRecordingControl(
			tab,
			{ type: "recording-stop", id: `recording-${Snowflake.next()}`, timeoutMs: options.timeoutMs },
			options.timeoutMs + GRACE_MS,
			options.signal,
		);
		if (reply.type !== "recording-stopped") throw new ToolError(`Unexpected recording reply ${reply.type} for stop`);
		return { ...reply.summary, backend: tab.kindTag, tabName: name };
	} finally {
		if (tab.recording === "stopping") tab.recording = undefined;
	}
}

function sendRecordingControl(
	tab: ManagedWorkerTabSession,
	msg: Extract<WorkerInbound, { type: "recording-start" | "recording-stop" | "recording-cancel" }>,
): void {
	if (tab.state !== "alive") throw new ToolError("Recording control worker unreachable: tab is not alive");
	try {
		tab.worker.send(msg);
	} catch (error) {
		throw new ToolError(
			`Recording control worker unreachable: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

/**
 * Register a pending control, send its message, and race the worker reply against a wall-clock
 * deadline and the caller's abort signal. A worker-delivered settle (resolve or reject) returns
 * or throws directly; a deadline/abort abandons the control and drives the bounded cancel +
 * recycle/kill cleanup before rethrowing the interrupt error.
 */
async function runRecordingControl(
	tab: ManagedWorkerTabSession,
	msg: Extract<WorkerInbound, { type: "recording-start" | "recording-stop" }>,
	deadlineMs: number,
	signal: AbortSignal | undefined,
): Promise<WorkerOutbound> {
	const controlId = msg.id;
	const worker = tab.worker;
	const generation = tab.workerGeneration;
	const { promise, resolve, reject } = Promise.withResolvers<WorkerOutbound>();
	void promise.catch(() => undefined);
	tab.controls.set(controlId, { resolve, reject, worker, generation });
	try {
		if (tab.state !== "alive" || tab.worker !== worker || tab.workerGeneration !== generation) {
			throw new ToolError("Recording control worker unreachable: worker changed before send");
		}
		sendRecordingControl(tab, msg);
	} catch (error) {
		tab.controls.delete(controlId);
		reject(error);
		throw error;
	}

	const { promise: interrupt, reject: interruptReject } = Promise.withResolvers<never>();
	const timer = setTimeout(() => {
		const label = msg.type === "recording-start" ? "start" : "stop";
		interruptReject(new ToolError(`Recording ${label} timed out after ${deadlineMs}ms`));
	}, deadlineMs);
	const onAbort = (): void => interruptReject(new ToolAbortError("Recording operation aborted"));
	if (signal) {
		if (signal.aborted) onAbort();
		else signal.addEventListener("abort", onAbort, { once: true });
	}
	try {
		return await Promise.race([promise, interrupt]);
	} catch (error) {
		if (tab.controls.has(controlId)) await abandonRecording(tab, error, deadlineMs, worker, generation);
		throw error;
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", onAbort);
	}
}

/**
 * Abandon a timed-out/aborted control: retire the worker generation and settle only the controls
 * from that retired generation, then run a bounded `recording-cancel` handshake. The recording
 * sentinel stays set (the start/stop caller's `finally` clears it) so a concurrent start/stop
 * rejects instead of registering a fresh control mid-handshake — and a fresh control that did slip
 * in lives at the new generation and is never settled here. A rejected or timed-out cancel recycles
 * (or, for inline workers, kills) the worker; a recycle/kill then settles every remaining control.
 */
async function abandonRecording(
	tab: ManagedWorkerTabSession,
	reason: unknown,
	timeoutMs: number,
	expectedWorker: WorkerHandle,
	expectedGeneration: number,
): Promise<void> {
	if (tab.state !== "alive" || tab.worker !== expectedWorker || tab.workerGeneration !== expectedGeneration) {
		settleControlsUpToGeneration(tab, expectedGeneration, reason);
		return;
	}
	const retiredGeneration = tab.workerGeneration;
	bumpWorkerGeneration(tab);
	settleControlsUpToGeneration(tab, retiredGeneration, reason);
	try {
		await cancelWorkerRecording(tab, expectedWorker);
	} catch (cancelError) {
		if (
			tab.state !== "alive" ||
			tab.worker !== expectedWorker ||
			(cancelError instanceof ToolError && /worker unreachable/i.test(cancelError.message))
		) {
			return;
		}
		logger.warn("Recording cancel was rejected or timed out; recycling browser tab worker", {
			error: cancelError instanceof Error ? cancelError.message : String(cancelError),
		});
		await recycleOrKillTab(tab, timeoutMs, "Recording control was not acknowledged; tab recycled");
	}
}

/**
 * Send `recording-cancel` and wait, bounded by {@link RECORDING_CANCEL_MS}, for the worker's reply.
 * `recording-canceled` resolves cleanly; `recording-error` rejects (the worker could not cancel) and
 * a missed deadline throws — both propagate so {@link abandonRecording} recycles/kills rather than
 * treating a failed cancel as an acknowledgement.
 */
async function cancelWorkerRecording(tab: ManagedWorkerTabSession, expectedWorker?: WorkerHandle): Promise<void> {
	if (tab.state !== "alive") throw new ToolError("Recording control worker unreachable: tab is not alive");
	const worker = expectedWorker ?? tab.worker;
	const generation = tab.workerGeneration;
	if (tab.worker !== worker) throw new ToolError("Recording control worker unreachable: worker changed before cancel");
	const { promise, resolve, reject } = Promise.withResolvers<WorkerOutbound>();
	const controlId = `recording-${Snowflake.next()}`;
	tab.controls.set(controlId, { resolve, reject, worker, generation });
	void promise.catch(() => undefined);
	try {
		if (tab.worker !== worker || tab.workerGeneration !== generation) {
			throw new ToolError("Recording control worker unreachable: worker changed before cancel");
		}
		sendRecordingControl(tab, { type: "recording-cancel", id: controlId });
	} catch (error) {
		tab.controls.delete(controlId);
		reject(error);
		throw error;
	}
	await raceWithTimeout(promise, RECORDING_CANCEL_MS, "Recording cancel was not acknowledged in time");
}

/** Recycle a timed-out worker-backed tab (or force-kill an inline one) after a failed cancel. */
async function recycleOrKillTab(tab: ManagedWorkerTabSession, timeoutMs: number, reason: string): Promise<void> {
	if (tab.worker.mode === "inline") {
		await forceKillTab(tab.name, reason);
		return;
	}
	try {
		await recycleTimedOutWorkerTab(tab, timeoutMs + GRACE_MS);
	} catch {
		await forceKillTab(tab.name, reason);
	}
}

/** Test-only: install a worker-backed tab with an injected {@link WorkerHandle}. */
export function registerWorkerTabForTest(options: {
	name: string;
	worker: WorkerHandle;
	browser: PuppeteerBrowserHandle;
	url?: string;
	ownerSessionId?: string;
	dialogPolicy?: DialogPolicy;
}): WorkerTabSession {
	const info: ReadyInfo = {
		url: options.url ?? "https://example.test/",
		viewport: { width: 1280, height: 800 },
		targetId: `test-target-${options.name}`,
	};
	const tab: ManagedWorkerTabSession = {
		name: options.name,
		browser: options.browser,
		targetId: info.targetId,
		backend: "worker",
		worker: options.worker,
		state: "alive",
		info,
		pending: new Map(),
		dialogPolicy: options.dialogPolicy,
		kindTag: options.browser.kind.kind,
		ownerSessionId: options.ownerSessionId,
		workerGeneration: 0,
		controls: new Map(),
	};
	holdBrowser(options.browser);
	attachLongLivedHandlers(tab, options.worker);
	tabs.set(options.name, tab);
	return tab;
}

function isLastSurfaceCloseError(err: unknown): boolean {
	const message = err instanceof Error ? err.message : String(err);
	return /last/i.test(message);
}

async function buildInitPayload(browser: PuppeteerBrowserHandle, opts: AcquireTabOptions): Promise<WorkerInitPayload> {
	const safeDir = getPuppeteerDir();
	const browserWSEndpoint = browser.browser.wsEndpoint();
	if (!browserWSEndpoint) throw new ToolError("Browser websocket endpoint is unavailable");
	if (browser.kind.kind === "headless") {
		return {
			mode: "headless",
			browserWSEndpoint,
			safeDir,
			viewport: opts.viewport,
			dialogs: opts.dialogs,
			url: opts.url,
			waitUntil: opts.waitUntil,
			timeoutMs: opts.timeoutMs,
		};
	}
	const page = await pickElectronTarget(browser.browser, opts.target);
	const targetId = await targetIdForPage(page);
	return {
		mode: "attach",
		browserWSEndpoint,
		safeDir,
		targetId,
		dialogs: opts.dialogs,
	};
}

function handleTabMessage(tab: ManagedWorkerTabSession, sourceWorker: WorkerHandle, msg: WorkerOutbound): void {
	switch (msg.type) {
		case "recording-started":
		case "recording-stopped":
		case "recording-canceled":
		case "recording-error": {
			// Ignore recording replies from a superseded worker before any control or state mutation.
			if (sourceWorker !== tab.worker) return;
			const control = tab.controls.get(msg.id);
			if (!control || control.worker !== sourceWorker) return;
			tab.controls.delete(msg.id);
			if (msg.type === "recording-error") control.reject(errorFromPayload(msg.error));
			else control.resolve(msg);
			return;
		}
		case "closed":
			// An unexpected worker close (not driven by releaseTab, which bumps the generation first)
			// leaves the tab unusable: settle controls, discard recording, and mark it dead.
			onWorkerFailure(tab, sourceWorker, new ToolError(`Tab ${JSON.stringify(tab.name)} worker closed`));
			return;
		case "result": {
			const pending = tab.pending.get(msg.id);
			if (!pending) return;
			tab.pending.delete(msg.id);
			if (msg.ok) pending.resolve(msg.payload);
			else pending.reject(errorFromPayload(msg.error));
			return;
		}
		case "ready":
			tab.info = msg.info;
			return;
		case "tool-call":
			void dispatchToolCall(tab, msg);
			return;
		case "log":
			logWorkerMessage(msg);
			return;
	}
}

async function dispatchToolCall(
	tab: ManagedWorkerTabSession,
	msg: Extract<WorkerOutbound, { type: "tool-call" }>,
): Promise<void> {
	const pending = tab.pending.get(msg.runId);
	if (!pending?.session.cwd) {
		safeSend(tab, {
			type: "tool-reply",
			id: msg.id,
			reply: {
				ok: false,
				error: { name: "ToolError", message: "No active run for tool call", isToolError: true, isAbort: false },
			},
		});
		return;
	}
	const ctrl = new AbortController();
	pending.toolCalls.set(msg.id, ctrl);
	const onParentAbort = (): void => ctrl.abort(pending.signal?.reason);
	if (pending.signal?.aborted) onParentAbort();
	else pending.signal?.addEventListener("abort", onParentAbort, { once: true });
	try {
		const value = await callSessionTool(msg.name, msg.args, {
			session: pending.session,
			signal: ctrl.signal,
			emitStatus: () => {
				// Status events from tool calls aren't piped back to user code yet; the worker
				// already pushes its own helper status via the display channel.
			},
		});
		safeSend(tab, { type: "tool-reply", id: msg.id, reply: { ok: true, value } });
	} catch (error) {
		safeSend(tab, { type: "tool-reply", id: msg.id, reply: { ok: false, error: toErrorPayload(error) } });
	} finally {
		pending.toolCalls.delete(msg.id);
		pending.signal?.removeEventListener("abort", onParentAbort);
	}
}

function safeSend(tab: ManagedWorkerTabSession, msg: WorkerInbound): void {
	if (tab.state !== "alive") return;
	try {
		tab.worker.send(msg);
	} catch (err) {
		logger.debug("tab worker send failed", { error: err instanceof Error ? err.message : String(err) });
	}
}

function toErrorPayload(error: unknown): RunErrorPayload {
	if (error instanceof Error) {
		return {
			name: error.name,
			message: error.message,
			stack: error.stack,
			isAbort: error.name === "AbortError" || error.name === "ToolAbortError",
			isToolError: error instanceof ToolError || error.name === "ToolError",
		};
	}
	return { name: "Error", message: String(error), isAbort: false, isToolError: false };
}

async function recycleTimedOutWorkerTab(tab: ManagedWorkerTabSession, timeoutMs: number): Promise<void> {
	// A recycle retires the current worker: capture its generation, bump, and settle only the
	// controls at/below the retired generation before the instance is torn down. A control that
	// registers against the fresh (post-bump) worker survives; late replies from the old worker
	// are ignored by the generation/instance guard.
	const retiredGeneration = tab.workerGeneration;
	bumpWorkerGeneration(tab);
	settleControlsUpToGeneration(
		tab,
		retiredGeneration,
		postmortem.markExpectedCleanupError(new ToolError("Browser tab worker recycled")),
	);
	tab.recording = undefined;
	const oldWorker = tab.worker;
	await oldWorker.terminate().catch(() => undefined);
	const browserWSEndpoint = tab.browser.browser.wsEndpoint();
	if (!browserWSEndpoint) throw new ToolError("Browser websocket endpoint is unavailable");
	const payload: WorkerInitPayload = {
		mode: "attach",
		browserWSEndpoint,
		safeDir: getPuppeteerDir(),
		targetId: tab.targetId,
		dialogs: tab.dialogPolicy,
		// Unblock a wedged page (open JS dialog, hung navigation) before adopting it —
		// otherwise init stalls, times out, and the tab gets force-killed.
		recover: true,
	};
	let worker = await spawnTabWorker();
	try {
		const info = await initializeTabWorker(worker, payload, timeoutMs);
		tab.worker = worker;
		tab.info = info;
		tab.state = "alive";
		attachLongLivedHandlers(tab, worker);
	} catch (error) {
		await worker.terminate().catch(() => undefined);
		worker = await spawnInlineWorker();
		try {
			const info = await initializeTabWorker(worker, payload, timeoutMs);
			tab.worker = worker;
			tab.info = info;
			tab.state = "alive";
			attachLongLivedHandlers(tab, worker);
		} catch (inlineError) {
			await worker.terminate().catch(() => undefined);
			const finalError = new ToolError(
				`Failed to recycle timed-out browser tab worker (inline fallback also failed): ${inlineError instanceof Error ? inlineError.message : String(inlineError)}`,
			);
			Object.defineProperty(finalError, "cause", { value: error, configurable: true });
			throw finalError;
		}
	}
}

async function forceKillTab(name: string, reason: string): Promise<void> {
	const tab = tabs.get(name);
	if (!tab) return;
	killedTabs.set(name, reason);
	tab.state = "dead";
	const error = postmortem.markExpectedCleanupError(new ToolError(reason));
	if (tab.backend === "worker") {
		bumpWorkerGeneration(tab);
		tab.recording = undefined;
		settleAllControlOps(tab, error);
	}
	for (const pending of tab.pending.values()) pending.reject(error);
	tab.pending.clear();
	if (tab.backend === "cmux") {
		await releaseBrowser(tab.browser, { kill: false });
		tabs.delete(name);
		return;
	}
	await tab.worker.terminate().catch(() => undefined);
	if (tab.kindTag === "headless") await closeOrphanTarget(tab);
	await releaseBrowser(tab.browser, { kill: false });
	tabs.delete(name);
}

async function closeOrphanTarget(tab: ManagedWorkerTabSession): Promise<void> {
	for (const target of tab.browser.browser.targets()) {
		if ((await targetIdForTarget(target).catch(() => "")) !== tab.targetId) continue;
		const page = await target.page().catch(() => null);
		await page?.close().catch(() => undefined);
		return;
	}
}

async function waitForClosed(tab: ManagedWorkerTabSession): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	const unsubscribe = tab.worker.onMessage(msg => {
		if (msg.type === "closed") resolve();
	});
	try {
		await raceWithTimeout(promise, GRACE_MS, "Timed out closing browser tab worker");
	} finally {
		unsubscribe();
	}
}

function expandBrowserScreenshotDir(session: ToolSession): string | undefined {
	const value = session.settings.get("browser.screenshotDir") as string | undefined;
	return value ? expandPath(value) : undefined;
}

async function targetIdForPage(page: Page): Promise<string> {
	return await targetIdForTarget(page.target());
}

async function targetIdForTarget(target: Target): Promise<string> {
	const raw = target as unknown as { _targetId?: unknown };
	if (typeof raw._targetId === "string") return raw._targetId;
	const session = await target.createCDPSession();
	try {
		const info = (await session.send("Target.getTargetInfo")) as { targetInfo?: { targetId?: string } };
		if (info.targetInfo?.targetId) return info.targetInfo.targetId;
		throw new ToolError("Target id unavailable from CDP target info");
	} finally {
		await session.detach().catch(() => undefined);
	}
}

function errorFromPayload(payload: RunErrorPayload): Error {
	const error = payload.recoverTab
		? new RecoverableWorkerError(payload.message)
		: payload.isAbort
			? new ToolAbortError()
			: payload.isToolError
				? new ToolError(payload.message)
				: new Error(payload.message);
	error.name = payload.name;
	if (payload.stack) error.stack = payload.stack;
	return error;
}

function logWorkerMessage(msg: Extract<WorkerOutbound, { type: "log" }>): void {
	if (msg.level === "debug") logger.debug(msg.msg, msg.meta);
	else if (msg.level === "warn") logger.warn(msg.msg, msg.meta);
	else logger.error(msg.msg, msg.meta);
}

async function raceWithTimeout<T>(
	promise: Promise<T>,
	timeoutMs: number,
	reason: string,
	onTimeout?: (reason: string) => Promise<void>,
): Promise<T> {
	const timeoutSignal = AbortSignal.timeout(timeoutMs);
	const { promise: timeoutPromise, reject } = Promise.withResolvers<never>();
	const onAbort = (): void => reject(new ToolError(reason));
	timeoutSignal.addEventListener("abort", onAbort, { once: true });
	try {
		return await Promise.race([promise, timeoutPromise]);
	} catch (error) {
		if (error instanceof ToolError && error.message === reason) await onTimeout?.(reason);
		throw error;
	} finally {
		timeoutSignal.removeEventListener("abort", onAbort);
	}
}

/**
 * Test-only override for the tab-worker factory. Lets a hermetic recycle test substitute an
 * injected {@link WorkerHandle} for the real Bun worker without a parallel spawn path.
 */
let tabWorkerFactoryForTest: (() => Promise<WorkerHandle>) | undefined;
export function setTabWorkerFactoryForTest(factory: (() => Promise<WorkerHandle>) | undefined): void {
	tabWorkerFactoryForTest = factory;
}

async function spawnTabWorker(): Promise<WorkerHandle> {
	if (tabWorkerFactoryForTest) return tabWorkerFactoryForTest();
	try {
		const hostEntry = workerHostEntry();
		const worker = hostEntry
			? new Worker(hostEntry, { type: "module", argv: ["__omp_worker_tab"] })
			: new Worker(new URL("./tab-worker-entry.ts", import.meta.url).href, { type: "module" });
		return wrapBunWorker(worker);
	} catch (err) {
		logger.warn("Bun Worker spawn failed; using inline tab worker (no sync-loop guard)", {
			error: err instanceof Error ? err.message : String(err),
		});
		return spawnInlineWorker();
	}
}

function wrapBunWorker(worker: Worker): WorkerHandle {
	return {
		mode: "worker",
		send(msg, transferList) {
			worker.postMessage(msg, { transfer: transferList ?? [] });
		},
		onMessage(handler) {
			const wrap = (event: MessageEvent): void => handler(event.data as WorkerOutbound);
			worker.addEventListener("message", wrap);
			return () => worker.removeEventListener("message", wrap);
		},
		onError(handler) {
			const onError = (event: ErrorEvent): void => handler(errorFromWorkerEvent(event));
			const onMessageError = (event: MessageEvent): void =>
				handler(new ToolError(`Tab worker message error: ${String(event.data)}`));
			worker.addEventListener("error", onError);
			worker.addEventListener("messageerror", onMessageError);
			return () => {
				worker.removeEventListener("error", onError);
				worker.removeEventListener("messageerror", onMessageError);
			};
		},
		async terminate() {
			worker.terminate();
		},
	};
}

/**
 * Inline fallback for environments where Bun cannot compile or spawn the worker
 * entry. This preserves normal browser behavior but cannot interrupt synchronous
 * infinite loops because user code runs on the main thread.
 */
async function spawnInlineWorker(): Promise<WorkerHandle> {
	const hostListeners = new Set<(message: WorkerOutbound) => void>();
	const workerListeners = new Set<(message: WorkerInbound) => void>();
	const workerTransport: Transport = {
		send: msg =>
			queueMicrotask(() => {
				for (const listener of hostListeners) listener(msg as WorkerOutbound);
			}),
		onMessage: handler => {
			const typed = handler as (message: WorkerInbound) => void;
			workerListeners.add(typed);
			return () => workerListeners.delete(typed);
		},
		close: () => {},
	};
	const { WorkerCore } = await import("./tab-worker");
	new WorkerCore(workerTransport);
	return {
		mode: "inline",
		send: msg =>
			queueMicrotask(() => {
				for (const listener of workerListeners) listener(msg);
			}),
		onMessage: handler => {
			hostListeners.add(handler);
			return () => hostListeners.delete(handler);
		},
		onError: () => () => {},
		async terminate() {},
	};
}

async function initializeTabWorker(
	worker: WorkerHandle,
	payload: WorkerInitPayload,
	timeoutMs: number,
): Promise<ReadyInfo> {
	const { promise, resolve, reject } = Promise.withResolvers<ReadyInfo>();
	const unlisten = worker.onMessage(msg => {
		if (msg.type === "ready") resolve(msg.info);
		else if (msg.type === "init-failed") reject(errorFromPayload(msg.error));
		else if (msg.type === "log") logWorkerMessage(msg);
	});
	const unlistenError = worker.onError(error => {
		reject(new ToolError(`Tab worker failed during startup: ${error.message}`));
	});
	try {
		worker.send({ type: "init", payload });
		return await raceWithTimeout(promise, timeoutMs, "Timed out initializing browser tab worker");
	} finally {
		unlisten();
		unlistenError();
	}
}

export function initializeTabWorkerForTest(
	worker: WorkerHandle,
	payload: WorkerInitPayload,
	timeoutMs: number,
): Promise<ReadyInfo> {
	return initializeTabWorker(worker, payload, timeoutMs);
}

function errorFromWorkerEvent(event: ErrorEvent): Error {
	if (event.error instanceof Error) return event.error;
	if (event.message) return new Error(event.message);
	return new Error("Unknown tab worker error");
}
