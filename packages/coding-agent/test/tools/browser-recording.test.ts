import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { registerArtifactsDir } from "@oh-my-pi/pi-coding-agent/internal-urls/registry-helpers";
import { initTheme, theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { BrowserTool, type BrowserToolDetails, setHarArtifactIoForTest } from "@oh-my-pi/pi-coding-agent/tools/browser";
import { ensureChromiumExecutable } from "@oh-my-pi/pi-coding-agent/tools/browser/launch";
import {
	DEFAULT_RECORDING_LIMITS,
	type RecordingSummary,
} from "@oh-my-pi/pi-coding-agent/tools/browser/network-recorder";
import { getBrowsersMapForTest, type PuppeteerBrowserHandle } from "@oh-my-pi/pi-coding-agent/tools/browser/registry";
import { browserToolRenderer } from "@oh-my-pi/pi-coding-agent/tools/browser/render";
import type { RunResultOk, WorkerInbound, WorkerOutbound } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-protocol";
import {
	getTabsMapForTest,
	registerWorkerTabForTest,
	releaseTab,
	releaseTabsForOwner,
	setTabWorkerFactoryForTest,
	startTabRecording,
	stopTabRecording,
	type WorkerHandle,
	type WorkerTabSession,
} from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { ToolAbortError } from "@oh-my-pi/pi-coding-agent/tools/tool-errors";

// The supervisor recording lifecycle is exercised through an injectable worker
// transport: a `FakeWorker` stands in for the real Bun worker and deterministically
// replays the frozen Task-2 worker protocol (recording-started/-stopped/-canceled/
// -error, closed) so every assertion is an observable supervisor contract — a
// resolved/rejected control op, a settled state transition, or a cleanup guarantee.
//
// The supervisor registers each control op and mutates recording state synchronously
// (before its first await), so these tests read state immediately after the call with
// no artificial yield. Only the deadline/cancel/recycle tests use a small real timeout,
// because the supervisor's wall-clock deadline is exactly the contract under test.

type RecordingReaction = "ack" | "silent";

interface ResponderOptions {
	start?: RecordingReaction;
	stop?: RecordingReaction;
	cancel?: RecordingReaction;
	scope?: string[];
	summary?: RecordingSummary;
}

function emptyRun(): RunResultOk {
	return { displays: [], returnValue: undefined, screenshots: [] };
}

function makeSummary(entryCount = 1): RecordingSummary {
	return {
		har: { log: { version: "1.2", entries: [] } },
		entryCount,
		capturedBodyCount: 0,
		omittedBodyCount: 0,
		totalBytes: 0,
		truncated: false,
	};
}

class FakeWorker implements WorkerHandle {
	readonly mode: "worker" | "inline";
	readonly sent: WorkerInbound[] = [];
	terminated = false;
	#respond?: (msg: WorkerInbound, worker: FakeWorker) => void;
	#throwOnSend: boolean;
	#messageHandlers = new Set<(msg: WorkerOutbound) => void>();
	#errorHandlers = new Set<(error: Error) => void>();

	constructor(
		opts: {
			mode?: "worker" | "inline";
			respond?: (msg: WorkerInbound, worker: FakeWorker) => void;
			throwOnSend?: boolean;
		} = {},
	) {
		this.mode = opts.mode ?? "worker";
		this.#respond = opts.respond;
		this.#throwOnSend = opts.throwOnSend ?? false;
	}

	send(msg: WorkerInbound): void {
		if (this.#throwOnSend) throw new Error("transport unavailable");
		this.sent.push(msg);
		this.#respond?.(msg, this);
	}

	onMessage(handler: (msg: WorkerOutbound) => void): () => void {
		this.#messageHandlers.add(handler);
		return () => this.#messageHandlers.delete(handler);
	}

	onError(handler: (error: Error) => void): () => void {
		this.#errorHandlers.add(handler);
		return () => this.#errorHandlers.delete(handler);
	}

	async terminate(): Promise<void> {
		this.terminated = true;
	}

	emit(msg: WorkerOutbound): void {
		for (const handler of [...this.#messageHandlers]) handler(msg);
	}

	emitError(error: Error): void {
		for (const handler of [...this.#errorHandlers]) handler(error);
	}

	lastSent<T extends WorkerInbound["type"]>(type: T): Extract<WorkerInbound, { type: T }> | undefined {
		for (let i = this.sent.length - 1; i >= 0; i--) {
			const msg = this.sent[i];
			if (msg.type === type) return msg as Extract<WorkerInbound, { type: T }>;
		}
		return undefined;
	}
}

function responder(opts: ResponderOptions = {}): (msg: WorkerInbound, worker: FakeWorker) => void {
	const start = opts.start ?? "ack";
	const stop = opts.stop ?? "ack";
	const cancel = opts.cancel ?? "ack";
	// Real workers deliver replies asynchronously via postMessage; mirror that with queueMicrotask so
	// `waitForClosed` (which subscribes only after the close is sent) observes the `closed` reply.
	return (msg, worker) => {
		const reply = (out: WorkerOutbound): void => queueMicrotask(() => worker.emit(out));
		switch (msg.type) {
			case "close":
				reply({ type: "closed" });
				return;
			case "run":
				reply({ type: "result", id: msg.id, ok: true, payload: emptyRun() });
				return;
			case "init":
				reply({
					type: "ready",
					info: { url: "https://shop.test/", viewport: { width: 1280, height: 800 }, targetId: "recycled-target" },
				});
				return;
			case "recording-start":
				if (start === "ack") {
					const scope =
						opts.scope ?? (msg.domains && msg.domains.length > 0 ? [...msg.domains] : ["https://shop.test"]);
					reply({ type: "recording-started", id: msg.id, scope, limits: DEFAULT_RECORDING_LIMITS });
				}
				return;
			case "recording-stop":
				if (stop === "ack")
					reply({ type: "recording-stopped", id: msg.id, summary: opts.summary ?? makeSummary() });
				return;
			case "recording-cancel":
				if (cancel === "ack") reply({ type: "recording-canceled", id: msg.id });
				return;
		}
	};
}

let browserSeq = 0;
function makeBrowser(): PuppeteerBrowserHandle {
	browserSeq += 1;
	return {
		key: `test-recording-browser-${browserSeq}`,
		kind: { kind: "connected", cdpUrl: `ws://127.0.0.1/devtools/browser/test-${browserSeq}` },
		refCount: 0,
		browser: {
			connected: false,
			wsEndpoint: () => "ws://127.0.0.1/devtools/browser/fake",
		} as unknown as PuppeteerBrowserHandle["browser"],
		stealth: { browserSession: null, override: null },
	};
}

type ManagedTestTab = WorkerTabSession & {
	workerGeneration: number;
	controls: Map<string, unknown>;
};

let tabSeq = 0;
function register(
	opts: { worker: WorkerHandle; url?: string; ownerSessionId?: string } = { worker: new FakeWorker() },
): { name: string; tab: ManagedTestTab; worker: WorkerHandle } {
	tabSeq += 1;
	const name = `rec-tab-${tabSeq}`;
	const tab = registerWorkerTabForTest({
		name,
		worker: opts.worker,
		browser: makeBrowser(),
		url: opts.url ?? "https://shop.test/",
		ownerSessionId: opts.ownerSessionId,
	});
	return { name, tab: tab as ManagedTestTab, worker: opts.worker };
}

afterEach(async () => {
	// Unconditional guard: a failed test must never leak the module-level worker factory.
	setTabWorkerFactoryForTest(undefined);
	for (const name of [...getTabsMapForTest().keys()]) {
		await releaseTab(name, { kill: false }).catch(() => undefined);
	}
});

describe("startTabRecording / stopTabRecording state machine", () => {
	it("rejects an overlapping start and resolves stop with the first recording", async () => {
		const { name } = register({ worker: new FakeWorker({ respond: responder() }) });

		const first = startTabRecording(name, { timeoutMs: 1_000 });
		const second = startTabRecording(name, { timeoutMs: 1_000 });
		await expect(second).rejects.toThrow("already recording");

		const started = await first;
		expect(started.scope).toEqual(["https://shop.test"]);

		const stopped = await stopTabRecording(name, { timeoutMs: 1_000 });
		expect(stopped.entryCount).toBe(1);
	});

	it("rejects a second start while active and while stopping", async () => {
		const { name } = register({ worker: new FakeWorker({ respond: responder({ stop: "silent" }) }) });
		await startTabRecording(name, { timeoutMs: 1_000 });

		await expect(startTabRecording(name, { timeoutMs: 1_000 })).rejects.toThrow("already recording");

		const stopping = stopTabRecording(name, { timeoutMs: 30_000 });
		await expect(startTabRecording(name, { timeoutMs: 1_000 })).rejects.toThrow("already recording");

		void stopping.catch(() => undefined);
	});

	it("rejects stop when not recording and when already stopping", async () => {
		const { name } = register({ worker: new FakeWorker({ respond: responder({ stop: "silent" }) }) });

		await expect(stopTabRecording(name, { timeoutMs: 1_000 })).rejects.toThrow("not recording");

		await startTabRecording(name, { timeoutMs: 1_000 });
		const stopping = stopTabRecording(name, { timeoutMs: 30_000 });
		await expect(stopTabRecording(name, { timeoutMs: 1_000 })).rejects.toThrow("already stopping");

		void stopping.catch(() => undefined);
	});

	it("allows a fresh start only after the prior recording finished", async () => {
		const { name, tab } = register({ worker: new FakeWorker({ respond: responder() }) });
		await startTabRecording(name, { timeoutMs: 1_000 });
		await stopTabRecording(name, { timeoutMs: 1_000 });
		expect(tab.recording).toBeUndefined();

		const again = await startTabRecording(name, { timeoutMs: 1_000 });
		expect(again.scope).toEqual(["https://shop.test"]);
		expect(tab.recording).toBe("active");
	});

	it("clears state and permits a retry after the worker rejects a start", async () => {
		const worker = new FakeWorker({
			respond: (msg, w) => {
				if (msg.type === "recording-start") {
					w.emit({
						type: "recording-error",
						id: msg.id,
						error: {
							name: "ToolError",
							message: "A recording is already active",
							isToolError: true,
							isAbort: false,
						},
					});
				} else if (msg.type === "close") {
					queueMicrotask(() => w.emit({ type: "closed" }));
				}
			},
		});
		const { name, tab } = register({ worker });

		await expect(startTabRecording(name, { timeoutMs: 1_000 })).rejects.toThrow("A recording is already active");
		expect(tab.recording).toBeUndefined();
		expect(tab.controls.size).toBe(0);
	});
});

describe("startTabRecording validation and scope", () => {
	it("rejects recording on a tab that is not open", async () => {
		await expect(startTabRecording("no-such-tab", { timeoutMs: 1_000 })).rejects.toThrow("not alive");
	});

	it("rejects recording on an unsupported (cmux) backend", async () => {
		// A minimal cmux-backed tab: recording is a Puppeteer-only feature and must be
		// rejected before any worker message.
		const map = getTabsMapForTest() as Map<string, WorkerTabSession>;
		const cmuxTab = {
			name: "cmux-rec",
			state: "alive",
			backend: "cmux",
			kindTag: "cmux",
		} as unknown as WorkerTabSession;
		map.set("cmux-rec", cmuxTab);
		try {
			await expect(startTabRecording("cmux-rec", { timeoutMs: 1_000 })).rejects.toThrow(
				/not supported|unsupported/i,
			);
		} finally {
			map.delete("cmux-rec");
		}
	});

	it("rejects omitted domains on an about:blank tab with a friendly error and sends nothing", async () => {
		const worker = new FakeWorker({ respond: responder() });
		const { name } = register({ worker, url: "about:blank" });

		await expect(startTabRecording(name, { timeoutMs: 1_000 })).rejects.toThrow(
			"open a URL first or pass domains explicitly",
		);
		expect(worker.sent.filter(m => m.type === "recording-start")).toHaveLength(0);
	});

	it.each([
		["shop.test", /http/i],
		["ftp://shop.test", /http/i],
		["javascript:alert(1)", /http/i],
		["https://user:pass@shop.test", /credential/i],
		["https://shop.test/path", /path/i],
		["https://shop.test/?token=super-secret", /query/i],
		["https://shop.test/#fragment-secret", /fragment/i],
		["https://*.shop.test", /wildcard/i],
	])("rejects the invalid domain %s without echoing provider input", async (domain, pattern) => {
		const { name } = register({ worker: new FakeWorker({ respond: responder() }) });
		const error = await startTabRecording(name, { timeoutMs: 1_000, domains: [domain] }).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(Error);
		const message = error instanceof Error ? error.message : String(error);
		expect(message).toMatch(pattern);
		expect(message).not.toContain(domain);
		expect(message).not.toContain("pass");
		expect(message).not.toContain("super-secret");
		expect(message).not.toContain("fragment-secret");
	});

	it("forwards normalized explicit origins to the worker and returns their scope", async () => {
		const worker = new FakeWorker({ respond: responder() });
		const { name } = register({ worker });

		const started = await startTabRecording(name, {
			timeoutMs: 1_000,
			domains: ["https://SHOP.test", "https://api.shop.test:8443/"],
		});
		expect(started.scope).toEqual(["https://shop.test", "https://api.shop.test:8443"]);

		const sent = worker.lastSent("recording-start");
		expect(sent?.domains).toEqual(["https://shop.test", "https://api.shop.test:8443"]);
	});

	it("fixes recording scope at start and never re-derives or widens it across navigation", async () => {
		const worker = new FakeWorker({ respond: responder() });
		const { name, tab } = register({ worker, url: "https://shop.test/" });

		const started = await startTabRecording(name, { timeoutMs: 1_000 });
		expect(started.scope).toEqual(["https://shop.test"]);
		const firstStarts = worker.sent.filter(m => m.type === "recording-start");
		expect(firstStarts).toHaveLength(1);
		// Omitted domains are resolved live by the worker, never derived from the cached URL.
		expect((firstStarts[0] as Extract<WorkerInbound, { type: "recording-start" }>).domains).toBeUndefined();

		// Same-target same-origin navigation, then a cross-origin navigation, refresh the tab's known
		// URL. The supervisor must not send another recording-start or widen the fixed scope — a
		// later-origin request is excluded because scope was pinned at start.
		tab.info = { ...tab.info, url: "https://shop.test/cart" };
		tab.info = { ...tab.info, url: "https://other.test/landing" };
		expect(worker.sent.filter(m => m.type === "recording-start")).toHaveLength(1);
		expect(tab.recording).toBe("active");

		const stopped = await stopTabRecording(name, { timeoutMs: 1_000 });
		expect(stopped.entryCount).toBe(1);
	});
});

describe("recording control deadlines, cancel, and recycle", () => {
	// These four tests use a small real timeout because the supervisor's wall-clock
	// deadline (and its bounded cancel handshake) is the exact behavior under test;
	// no injectable clock exists and adding one would be a parallel convention.
	it("cancels and discards state when a start times out but the worker acknowledges the cancel", async () => {
		const worker = new FakeWorker({ respond: responder({ start: "silent", cancel: "ack" }) });
		const { name, tab } = register({ worker });

		await expect(startTabRecording(name, { timeoutMs: 20 })).rejects.toThrow(/timed out/i);
		expect(tab.recording).toBeUndefined();
		expect(tab.controls.size).toBe(0);
		expect(tab.workerGeneration).toBe(1);
		expect(worker.lastSent("recording-cancel")).toBeDefined();
		// A clean cancel-ack must not tear the tab down.
		expect(worker.terminated).toBe(false);
		expect(getTabsMapForTest().has(name)).toBe(true);
	});

	it("kills the tab when a timed-out start's cancel is never acknowledged", async () => {
		const worker = new FakeWorker({ mode: "inline", respond: responder({ start: "silent", cancel: "silent" }) });
		const { name } = register({ worker });

		await expect(startTabRecording(name, { timeoutMs: 20 })).rejects.toThrow(/timed out/i);
		expect(getTabsMapForTest().has(name)).toBe(false);
		expect(worker.terminated).toBe(true);
		// A killed tab reports the kill on the next attempt.
		await expect(startTabRecording(name, { timeoutMs: 20 })).rejects.toThrow(/killed|not alive/i);
	});

	it("aborts a pending start promptly on signal and cancels the recording", async () => {
		const worker = new FakeWorker({ respond: responder({ start: "silent", cancel: "ack" }) });
		const { name, tab } = register({ worker });
		const controller = new AbortController();

		const start = startTabRecording(name, { timeoutMs: 60_000, signal: controller.signal });
		controller.abort();

		await expect(start).rejects.toBeInstanceOf(ToolAbortError);
		expect(tab.recording).toBeUndefined();
		expect(tab.controls.size).toBe(0);
		expect(worker.lastSent("recording-cancel")).toBeDefined();
	});

	it("cancels and discards state when a stop times out", async () => {
		const worker = new FakeWorker({ respond: responder({ stop: "silent", cancel: "ack" }) });
		const { name, tab } = register({ worker });
		await startTabRecording(name, { timeoutMs: 1_000 });

		await expect(stopTabRecording(name, { timeoutMs: 20 })).rejects.toThrow(/timed out/i);
		expect(tab.recording).toBeUndefined();
		expect(tab.controls.size).toBe(0);
		expect(worker.lastSent("recording-cancel")).toBeDefined();
	});

	it("serializes a concurrent start issued during an abandoned start's cancel handshake", async () => {
		const cancelSeen = Promise.withResolvers<void>();
		let releaseCancel: (() => void) | undefined;
		let startCount = 0;
		const worker = new FakeWorker({
			respond: (msg, w) => {
				if (msg.type === "close") queueMicrotask(() => w.emit({ type: "closed" }));
				else if (msg.type === "recording-start") {
					startCount += 1;
					// The first start is silent (times out); a later start acknowledges.
					if (startCount > 1) {
						queueMicrotask(() =>
							w.emit({
								type: "recording-started",
								id: msg.id,
								scope: ["https://shop.test"],
								limits: DEFAULT_RECORDING_LIMITS,
							}),
						);
					}
				} else if (msg.type === "recording-cancel") {
					const { id } = msg;
					releaseCancel = () => queueMicrotask(() => w.emit({ type: "recording-canceled", id }));
					cancelSeen.resolve();
				}
			},
		});
		const { name, tab } = register({ worker });

		const start1 = startTabRecording(name, { timeoutMs: 20 });
		void start1.catch(() => undefined);
		await cancelSeen.promise; // abandonment has reached (and is holding) the cancel handshake

		// The recording sentinel is still held, so a concurrent start rejects rather than registering
		// a fresh control that the abandon could wrongly settle.
		await expect(startTabRecording(name, { timeoutMs: 1_000 })).rejects.toThrow("already recording");
		expect(tab.controls.size).toBe(1); // only the in-flight cancel control

		releaseCancel?.(); // ack the cancel -> abandonment completes
		await expect(start1).rejects.toThrow(/timed out/i);
		expect(tab.recording).toBeUndefined();
		expect(tab.controls.size).toBe(0);

		// A fresh start now succeeds on the recovered worker with its own control intact.
		const started = await startTabRecording(name, { timeoutMs: 1_000 });
		expect(started.scope).toEqual(["https://shop.test"]);
	});

	it("kills the tab when the worker rejects the cancel after a timed-out start", async () => {
		const worker = new FakeWorker({
			mode: "inline",
			respond: (msg, w) => {
				if (msg.type === "close") queueMicrotask(() => w.emit({ type: "closed" }));
				else if (msg.type === "recording-cancel") {
					// A recording-error on cancel means the worker could NOT cancel — never a clean ack.
					queueMicrotask(() =>
						w.emit({
							type: "recording-error",
							id: msg.id,
							error: { name: "ToolError", message: "cancel failed", isToolError: true, isAbort: false },
						}),
					);
				}
				// recording-start stays silent so the start deadline fires.
			},
		});
		const { name } = register({ worker });

		await expect(startTabRecording(name, { timeoutMs: 20 })).rejects.toThrow(/timed out/i);
		expect(getTabsMapForTest().has(name)).toBe(false);
		expect(worker.terminated).toBe(true);
	});

	it("recycles a worker-mode tab with a fresh worker when a timed-out start's cancel is unacknowledged", async () => {
		const w1 = new FakeWorker({ respond: responder({ start: "silent", cancel: "silent" }) });
		const w2 = new FakeWorker({ respond: responder() });
		setTabWorkerFactoryForTest(async () => w2);
		try {
			const { name, tab } = register({ worker: w1 });
			const genBefore = tab.workerGeneration;

			await expect(startTabRecording(name, { timeoutMs: 20 })).rejects.toThrow(/timed out/i);

			expect(w1.terminated).toBe(true);
			expect(tab.worker).toBe(w2);
			expect(tab.state).toBe("alive");
			expect(tab.recording).toBeUndefined();
			expect(tab.controls.size).toBe(0);
			expect(tab.workerGeneration).toBe(genBefore + 2); // abandon bump + recycle bump

			// The replacement worker is live and usable.
			const started = await startTabRecording(name, { timeoutMs: 1_000 });
			expect(started.scope).toEqual(["https://shop.test"]);
		} finally {
			setTabWorkerFactoryForTest(undefined);
		}
	});

	it("recycle rejects retired-generation controls but preserves a control registered mid-recycle", async () => {
		const spawnReached = Promise.withResolvers<void>();
		const spawnGate = Promise.withResolvers<void>();
		// start silent (times out); cancel replies recording-error so abandon recycles immediately.
		const w1 = new FakeWorker({
			respond: (msg, w) => {
				if (msg.type === "close") queueMicrotask(() => w.emit({ type: "closed" }));
				else if (msg.type === "recording-cancel") {
					queueMicrotask(() =>
						w.emit({
							type: "recording-error",
							id: msg.id,
							error: { name: "ToolError", message: "cancel failed", isToolError: true, isAbort: false },
						}),
					);
				}
			},
		});
		const w2 = new FakeWorker({ respond: responder() });
		setTabWorkerFactoryForTest(async () => {
			spawnReached.resolve();
			await spawnGate.promise; // pause recycle at the spawn step, after its generation-scoped settle
			return w2;
		});
		const { name, tab } = register({ worker: w1 });

		const start1 = startTabRecording(name, { timeoutMs: 20 });
		void start1.catch(() => undefined);
		await spawnReached.promise; // recycle has bumped and settled retired-generation controls

		// The abandoned start + cancel controls (retired generations) were rejected before the spawn.
		expect(tab.controls.size).toBe(0);
		const recycleGeneration = tab.workerGeneration;

		// A control registered mid-recycle lives at the fresh (post-bump) generation and must survive.
		const start2 = startTabRecording(name, { timeoutMs: 60_000 });
		void start2.catch(() => undefined);
		expect(tab.controls.size).toBe(1);
		const freshControlId = [...tab.controls.keys()][0];

		spawnGate.resolve(); // let recycle install the replacement worker
		await expect(start1).rejects.toThrow(/timed out/i);

		expect(tab.worker).toBe(w2);
		expect(w1.terminated).toBe(true);
		expect(tab.workerGeneration).toBe(recycleGeneration); // no extra bump; recycle settled once, pre-spawn
		expect(tab.controls.has(freshControlId)).toBe(true); // fresh (post-bump) control survived recycle
	});
});

describe("long-lived worker failure cleanup", () => {
	it("settles a pending control and disables further starts when the worker errors", async () => {
		const worker = new FakeWorker({ respond: responder({ start: "silent" }) });
		const { name, tab } = register({ worker });

		const start = startTabRecording(name, { timeoutMs: 60_000 });
		expect(tab.controls.size).toBe(1);

		worker.emitError(new Error("worker crashed"));

		await expect(start).rejects.toThrow("worker crashed");
		expect(tab.controls.size).toBe(0);
		expect(tab.recording).toBeUndefined();
		expect(tab.state).toBe("dead");
		await expect(startTabRecording(name, { timeoutMs: 1_000 })).rejects.toThrow("not alive");
	});

	it("settles a pending control when the worker reports it closed", async () => {
		const worker = new FakeWorker({ respond: responder({ start: "silent" }) });
		const { name, tab } = register({ worker });

		const start = startTabRecording(name, { timeoutMs: 60_000 });
		expect(tab.controls.size).toBe(1);

		worker.emit({ type: "closed" });

		await expect(start).rejects.toThrow();
		expect(tab.controls.size).toBe(0);
		expect(tab.recording).toBeUndefined();
		expect(tab.state).toBe("dead");
	});
	it("fails a recording start immediately when the tab is already dead without recycling", async () => {
		const worker = new FakeWorker({ respond: responder() });
		const { name, tab } = register({ worker });
		tab.state = "dead";

		const startedAt = performance.now();
		await expect(startTabRecording(name, { timeoutMs: 1_000 })).rejects.toThrow(/not alive/i);
		expect(performance.now() - startedAt).toBeLessThan(250);
		expect(worker.sent).toHaveLength(0);
		expect(worker.terminated).toBe(false);
	});

	it("fails a recording start immediately when worker transport throws", async () => {
		const worker = new FakeWorker({ throwOnSend: true });
		const { name, tab } = register({ worker });

		await expect(startTabRecording(name, { timeoutMs: 1_000 })).rejects.toThrow(
			/worker unreachable|transport unavailable/i,
		);
		expect(tab.recording).toBeUndefined();
		expect(tab.controls.size).toBe(0);
		expect(worker.terminated).toBe(false);
	});

	it("ignores recording messages from a superseded worker", async () => {
		const w1 = new FakeWorker({ respond: responder({ start: "silent" }) });
		const { name, tab } = register({ worker: w1 });

		const start = startTabRecording(name, { timeoutMs: 60_000 });
		void start.catch(() => undefined);
		expect(tab.controls.size).toBe(1);
		const controlId = [...tab.controls.keys()][0];

		// Simulate the supervisor swapping in a fresh worker (as recycle does).
		const w2 = new FakeWorker({ respond: responder() });
		tab.worker = w2;
		tab.workerGeneration += 1;

		// A late message from the retired worker — even a recording-error — must be
		// ignored before it can settle a control or mutate recording state.
		w1.emit({
			type: "recording-error",
			id: controlId,
			error: { name: "Error", message: "stale boom", isToolError: false, isAbort: false },
		});

		expect(tab.controls.size).toBe(1);
		expect(tab.recording).toBe("starting");
		expect(tab.state).toBe("alive");
	});
});
it("keeps WorkerTabSession constructible without recording internals", () => {
	const worker = new FakeWorker();
	const browser = makeBrowser();
	const legacy: WorkerTabSession = {
		name: "legacy",
		browser,
		targetId: "legacy-target",
		backend: "worker",
		worker,
		state: "alive",
		info: { url: "https://shop.test/", viewport: { width: 1280, height: 800 }, targetId: "legacy-target" },
		pending: new Map(),
		kindTag: "connected",
	};
	expect(legacy.backend).toBe("worker");
});

describe("release and disposal discard recording state", () => {
	it("rejects an in-flight stop, clears controls, and bumps generation on releaseTab", async () => {
		const worker = new FakeWorker({ respond: responder({ stop: "silent" }) });
		const { name, tab } = register({ worker });
		await startTabRecording(name, { timeoutMs: 1_000 });

		const stopping = stopTabRecording(name, { timeoutMs: 30_000 });
		// releaseTab settles the stop control mid-flight; guard the rejection before that happens.
		void stopping.catch(() => undefined);
		expect(tab.controls.size).toBe(1);
		expect(tab.recording).toBe("stopping");

		const genBefore = tab.workerGeneration;
		await releaseTab(name, { kill: false });
		await expect(stopping).rejects.toThrow(/closed/i);
		expect(tab.controls.size).toBe(0);
		expect(tab.recording).toBeUndefined();
		expect(tab.workerGeneration).toBe(genBefore + 1);
		expect(getTabsMapForTest().has(name)).toBe(false);
	});

	it("tears down an owned recording tab on session disposal", async () => {
		const worker = new FakeWorker({ respond: responder({ start: "silent" }) });
		const { name, tab } = register({ worker, ownerSessionId: "session-rec" });
		const start = startTabRecording(name, { timeoutMs: 30_000 });
		void start.catch(() => undefined);
		expect(tab.controls.size).toBe(1);

		const released = await releaseTabsForOwner("session-rec", { kill: false });
		expect(released).toBe(1);
		await expect(start).rejects.toThrow(/closed/i);
		expect(tab.controls.size).toBe(0);
		expect(getTabsMapForTest().has(name)).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// INV-579 Task 4: public tool actions, approval disclosure, artifact, renderer
// ---------------------------------------------------------------------------

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map(c => c.text)
		.join("\n");
}

function makeRecordingSession(artifactDir: string, allocate = true): ToolSession {
	let seq = 0;
	return {
		cwd: "/tmp/test",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getArtifactsDir: () => artifactDir,
		settings: Settings.isolated({ "browser.headless": true }),
		allocateOutputArtifact: async (toolType: string) => {
			if (!allocate) return {};
			const id = String(seq++);
			return { id, path: path.join(artifactDir, `${id}.${toolType}.log`) };
		},
	} as unknown as ToolSession;
}

// A recognizable string buried in the captured HAR: it must reach the artifact
// file verbatim but never the tool text, details, or any error message.
const HAR_MARKER = "secret-marker-do-not-leak-xyz";
function markedSummary(): RecordingSummary {
	return {
		har: {
			log: {
				version: "1.2",
				creator: { name: "oh-my-pi", version: "1" },
				entries: [{ request: { method: "GET", url: `https://shop.test/${HAR_MARKER}` } }],
			},
		},
		entryCount: 3,
		capturedBodyCount: 1,
		omittedBodyCount: 2,
		totalBytes: 4096,
		truncated: true,
	};
}

async function chromiumCanLaunch(): Promise<boolean> {
	try {
		const executable = await ensureChromiumExecutable();
		if (!executable) return false;
		return Bun.spawnSync([executable, "--version"], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;
	} catch {
		return false;
	}
}

const REAL_BROWSER_AVAILABLE = await chromiumCanLaunch();

function startRecordingFixture(): Bun.Server<undefined> {
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const url = new URL(request.url);
			if (url.pathname === "/api/cart") {
				const body = (await request.json()) as { itemId?: string };
				return Response.json({ ok: true, itemId: body.itemId });
			}
			if (url.pathname === "/pixel.png") {
				return new Response(Uint8Array.from([137, 80, 78, 71]), {
					headers: { "content-type": "image/png" },
				});
			}
			if (url.pathname === "/next") {
				return new Response("<!doctype html><title>next</title><p>done</p>", {
					headers: { "content-type": "text/html; charset=utf-8" },
				});
			}
			if (url.pathname === "/reset/path-secret") {
				return new Response('<!doctype html><title>fixture</title><img src="/pixel.png">', {
					headers: { "content-type": "text/html; charset=utf-8" },
				});
			}
			return new Response("not found", { status: 404 });
		},
	});
	return server;
}

describe.skipIf(!REAL_BROWSER_AVAILABLE)("BrowserTool recording local browser smoke", () => {
	it("records, sanitizes, reads, and cleans up a real browser lifecycle twice", async () => {
		const server = startRecordingFixture();
		const artifactDir = await fs.mkdtemp(path.join(os.tmpdir(), "browser-har-real-"));
		const unregisterArtifacts = registerArtifactsDir(artifactDir);
		const session = makeRecordingSession(artifactDir);
		const tool = new BrowserTool(session);
		const origin = `http://127.0.0.1:${server.port}`;
		try {
			for (let iteration = 0; iteration < 2; iteration++) {
				const name = `recording-smoke-${process.pid}-${iteration}`;
				let recording = false;
				try {
					await tool.execute("open", {
						action: "open",
						name,
						url: `${origin}/reset/path-secret`,
						wait_until: "networkidle0",
					});
					await tool.execute("start_recording", {
						action: "start_recording",
						name,
						domains: [origin],
					});
					recording = true;
					await tool.execute("run", {
						action: "run",
						name,
						code: `return await tab.evaluate(async () => {
								const response = await fetch("/api/cart?query-secret", {
									method: "POST",
									headers: { "content-type": "application/json", authorization: "Bearer local-secret" },
									body: JSON.stringify({ credentials: { password: "nested-secret" }, accountId: "account-secret", itemId: "42" }),
								});
								await response.json();
								return response.status;
							});`,
					});
					await tool.execute("navigate", {
						action: "run",
						name,
						code: `await tab.goto("${origin}/next", { waitUntil: "networkidle0" }); return await tab.url();`,
					});
					await tool.execute("flush-events", {
						action: "run",
						name,
						code: "await wait(100); return await tab.url();",
					});
					const stopped = await tool.execute("stop_recording", { action: "stop_recording", name });
					recording = false;
					const artifactId = stopped.details?.artifactId;
					expect(artifactId).toMatch(/^\d+$/);
					const artifactUri = `artifact://${artifactId}`;
					const readResult = await new ReadTool(session).execute(`read-${iteration}`, {
						path: `${artifactUri}:raw`,
					});
					const document = JSON.parse(textOf(readResult)) as {
						log: {
							entries: Array<{
								request: { url: string; postData?: { text?: string } };
								response: { content?: { text?: string } };
							}>;
						};
					};
					const serialized = JSON.stringify(document);
					const cartEntry = document.log.entries.find(entry => entry.request.url.endsWith("/api/cart"));
					expect(cartEntry).toBeDefined();
					expect(cartEntry?.request.postData?.text).toContain('"itemId":"42"');
					expect(cartEntry?.response.content?.text).toContain('"itemId":"42"');
					const navigationEntry = document.log.entries.find(entry => entry.request.url.endsWith("/next"));
					expect(navigationEntry).toBeDefined();
					expect(navigationEntry?.response.content?.text).toBeUndefined();
					expect(serialized).not.toContain("Bearer local-secret");
					expect(serialized).not.toContain("query-secret");
					expect(serialized).not.toContain("nested-secret");
					expect(serialized).toContain('\\"itemId\\":\\"42\\"');
					expect(serialized).not.toContain("account-secret");
					expect(serialized).not.toContain("path-secret");
					expect(stopped.details?.recording?.capturedBodyCount).toBeGreaterThan(0);
					expect(stopped.details?.recording?.omittedBodyCount).toBeGreaterThan(0);
					expect(textOf(stopped)).toContain(artifactUri);
					expect(textOf(stopped)).not.toContain("Bearer local-secret");
					expect(JSON.stringify(stopped.details)).not.toContain("nested-secret");
				} finally {
					if (recording)
						await tool.execute("stop-cleanup", { action: "stop_recording", name }).catch(() => undefined);
					await tool.execute("close-cleanup", { action: "close", name, kill: true }).catch(() => undefined);
					expect(getTabsMapForTest().has(name)).toBe(false);
				}
				expect(getBrowsersMapForTest().size).toBe(0);
			}
		} finally {
			unregisterArtifacts();
			server.stop(true);
			await fs.rm(artifactDir, { recursive: true, force: true });
		}
	}, 60_000);
});

describe("BrowserTool recording actions", () => {
	let artifactDir: string;
	beforeEach(async () => {
		artifactDir = await fs.mkdtemp(path.join(os.tmpdir(), "browser-har-"));
	});
	afterEach(async () => {
		setHarArtifactIoForTest(undefined);
		await fs.rm(artifactDir, { recursive: true, force: true }).catch(() => undefined);
	});

	it("start_recording requires an open supported tab and reports the normalized effective scope", async () => {
		const tool = new BrowserTool(makeRecordingSession(artifactDir));
		const { name } = register({ worker: new FakeWorker({ respond: responder() }) });

		const result = await tool.execute("rec-start", {
			action: "start_recording",
			name,
			domains: ["https://SHOP.test"],
		});

		expect(result.isError).toBeFalsy();
		expect(result.details?.scope).toEqual(["https://shop.test"]);
		expect(textOf(result)).toContain("https://shop.test");
	});

	it("start_recording on a tab that is not open surfaces an explicit error", async () => {
		const tool = new BrowserTool(makeRecordingSession(artifactDir));
		await expect(tool.execute("rec-start", { action: "start_recording", name: "no-such-tab" })).rejects.toThrow(
			/not alive|Open it first/,
		);
	});

	it("start_recording on an unsupported cmux backend fails explicitly", async () => {
		const tool = new BrowserTool(makeRecordingSession(artifactDir));
		const map = getTabsMapForTest() as Map<string, WorkerTabSession>;
		const cmuxTab = {
			name: "cmux-pub",
			state: "alive",
			backend: "cmux",
			kindTag: "cmux",
		} as unknown as WorkerTabSession;
		map.set("cmux-pub", cmuxTab);
		try {
			await expect(tool.execute("rec-start", { action: "start_recording", name: "cmux-pub" })).rejects.toThrow(
				/not supported|unsupported/i,
			);
		} finally {
			map.delete("cmux-pub");
		}
	});

	it("start_recording approval discloses personal-data capture into a bounded sanitized artifact", () => {
		const tool = new BrowserTool(makeRecordingSession(artifactDir));
		const lines = tool.formatApprovalDetails?.({ action: "start_recording", name: "docs" });
		const text = (Array.isArray(lines) ? lines.join("\n") : String(lines ?? "")).toLowerCase();
		expect(text).toContain("account or personal data");
		expect(text).toContain("sanitized");
		expect(text).toContain("bounded");
		expect(text).toContain("artifact");
	});
	it("does not expose invalid recording domains in approval details", () => {
		const tool = new BrowserTool(makeRecordingSession(artifactDir));
		const secret = "https://user:secret@example.test/reset?token=super-secret#fragment";
		const lines = tool.formatApprovalDetails?.({ action: "start_recording", name: "docs", domains: [secret] });
		const text = Array.isArray(lines) ? lines.join("\n") : String(lines ?? "");
		expect(text).toContain("(invalid origin)");
		expect(text).not.toContain(secret);
		expect(text).not.toContain("secret");
		expect(text).not.toContain("token=super-secret");
	});

	it("stop_recording approval discloses finalization and sanitized artifact persistence", () => {
		const tool = new BrowserTool(makeRecordingSession(artifactDir));
		const lines = tool.formatApprovalDetails?.({ action: "stop_recording", name: "docs" });
		const text = (Array.isArray(lines) ? lines.join("\n") : String(lines ?? "")).toLowerCase();
		expect(text).toContain("finalizes");
		expect(text).toContain("persists");
		expect(text).toContain("sanitized");
		expect(text).toContain("artifact");
	});

	it("advertises network recording and HAR artifacts in the discoverable summary", () => {
		const tool = new BrowserTool(makeRecordingSession(artifactDir));
		expect(tool.summary.toLowerCase()).toContain("record");
		expect(tool.summary.toLowerCase()).toContain("network");
		expect(tool.summary.toLowerCase()).toContain("har");
	});

	it("stop_recording writes valid HAR JSON to an artifact and returns only URI/count/truncation metadata", async () => {
		const tool = new BrowserTool(makeRecordingSession(artifactDir));
		const summary = markedSummary();
		const { name } = register({ worker: new FakeWorker({ respond: responder({ summary }) }) });
		await tool.execute("rec-start", { action: "start_recording", name });

		const result = await tool.execute("rec-stop", { action: "stop_recording", name });
		expect(result.isError).toBeFalsy();

		const artifactId = result.details?.artifactId;
		expect(typeof artifactId).toBe("string");

		// The full HAR is persisted verbatim to the artifact file.
		const harPath = path.join(artifactDir, `${artifactId}.browser-har.log`);
		const parsed = JSON.parse(await fs.readFile(harPath, "utf8")) as { log: { version: string } };
		expect(parsed.log.version).toBe("1.2");
		expect(JSON.stringify(parsed)).toContain(HAR_MARKER);

		// ...but only bounded metadata reaches the tool text + details — never the HAR body.
		const text = textOf(result);
		expect(text).toContain(`artifact://${artifactId}`);
		expect(text).toContain("3");
		expect(text).not.toContain(HAR_MARKER);
		expect(JSON.stringify(result.details)).not.toContain(HAR_MARKER);
		expect(result.details?.recording).toEqual({
			entryCount: 3,
			capturedBodyCount: 1,
			omittedBodyCount: 2,
			totalBytes: 4096,
			truncated: true,
		});
	});

	it("stop_recording persists the artifact at 0600 with no hidden staging leftovers", async () => {
		const tool = new BrowserTool(makeRecordingSession(artifactDir));
		const { name } = register({ worker: new FakeWorker({ respond: responder({ summary: markedSummary() }) }) });
		await tool.execute("rec-start", { action: "start_recording", name });
		const result = await tool.execute("rec-stop", { action: "stop_recording", name });

		const harPath = path.join(artifactDir, `${result.details?.artifactId}.browser-har.log`);
		const stat = await fs.stat(harPath);
		expect(stat.mode & 0o777).toBe(0o600);
		const hidden = (await fs.readdir(artifactDir)).filter(f => f.startsWith("."));
		expect(hidden).toEqual([]);
	});

	it("stop_recording fails without serializing the HAR when no artifact slot is available", async () => {
		const tool = new BrowserTool(makeRecordingSession(artifactDir, false));
		const { name } = register({ worker: new FakeWorker({ respond: responder({ summary: markedSummary() }) }) });
		await tool.execute("rec-start", { action: "start_recording", name });

		const error = await tool.execute("rec-stop", { action: "stop_recording", name }).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(Error);
		const message = error instanceof Error ? error.message : String(error);
		expect(message).not.toContain(HAR_MARKER);
	});

	it("start_recording rejects fields that belong to other actions", async () => {
		const tool = new BrowserTool(makeRecordingSession(artifactDir));
		const { name } = register({ worker: new FakeWorker({ respond: responder() }) });
		for (const bad of [{ code: "return 1;" }, { all: true }, { kill: true }, { url: "https://x.test" }]) {
			await expect(tool.execute("rec-start", { action: "start_recording", name, ...bad })).rejects.toThrow(
				/does not accept/,
			);
		}
		// No recording-start was ever sent for the rejected calls.
		const tab = getTabsMapForTest().get(name) as WorkerTabSession | undefined;
		expect(tab?.recording).toBeUndefined();
	});

	it("stop_recording rejects domains and other irrelevant fields", async () => {
		const tool = new BrowserTool(makeRecordingSession(artifactDir));
		const { name } = register({ worker: new FakeWorker({ respond: responder() }) });
		for (const bad of [
			{ domains: ["https://x.test"] },
			{ code: "x" },
			{ url: "https://x.test" },
			{ all: true },
			{ kill: true },
		]) {
			await expect(tool.execute("rec-stop", { action: "stop_recording", name, ...bad })).rejects.toThrow(
				/does not accept|only accepted/,
			);
		}
	});
	it("rejects domains on open, close, and run instead of silently ignoring them", async () => {
		const tool = new BrowserTool(makeRecordingSession(artifactDir));
		for (const action of ["open", "close", "run"] as const) {
			await expect(
				tool.execute(`browser-${action}-domains`, {
					action,
					name: "docs",
					domains: ["https://secret.example.test"],
					...(action === "run" ? { code: "return 1;" } : {}),
				}),
			).rejects.toThrow(/domains.*start_recording|does not accept/i);
		}
	});

	it("stop_recording writes a 0600 final artifact and removes the temp when rename hits EXDEV", async () => {
		const tool = new BrowserTool(makeRecordingSession(artifactDir));
		setHarArtifactIoForTest({
			rename: async () => {
				throw Object.assign(new Error("cross-device link not permitted"), { code: "EXDEV" });
			},
		});
		const { name } = register({ worker: new FakeWorker({ respond: responder({ summary: markedSummary() }) }) });
		await tool.execute("rec-start", { action: "start_recording", name });

		const result = await tool.execute("rec-stop", { action: "stop_recording", name });
		expect(result.isError).toBeFalsy();

		const harPath = path.join(artifactDir, `${result.details?.artifactId}.browser-har.log`);
		const stat = await fs.stat(harPath);
		expect(stat.mode & 0o777).toBe(0o600);
		expect(JSON.parse(await fs.readFile(harPath, "utf8"))).toMatchObject({ log: { version: "1.2" } });
		// The hidden staging sibling was cleaned up after the direct-write fallback.
		const hidden = (await fs.readdir(artifactDir)).filter(f => f.startsWith("."));
		expect(hidden).toEqual([]);
	});
	it("preserves a foreign final artifact when EXDEV fallback hits EEXIST", async () => {
		const tool = new BrowserTool(makeRecordingSession(artifactDir));
		const foreign = "foreign-artifact";
		await fs.writeFile(path.join(artifactDir, "0.browser-har.log"), foreign, { mode: 0o600 });
		setHarArtifactIoForTest({
			writeExclusive0600: async (target, content) => {
				if (target.endsWith(".browser-har.log")) {
					throw Object.assign(new Error("already exists"), { code: "EEXIST" });
				}
				await fs.writeFile(target, content, { flag: "wx", mode: 0o600 });
			},
			rename: async () => {
				throw Object.assign(new Error("cross-device link not permitted"), { code: "EXDEV" });
			},
		});
		const { name } = register({ worker: new FakeWorker({ respond: responder({ summary: markedSummary() }) }) });
		await tool.execute("rec-start", { action: "start_recording", name });

		await expect(tool.execute("rec-stop", { action: "stop_recording", name })).rejects.toThrow(
			"Failed to persist browser recording artifact.",
		);
		expect(await fs.readFile(path.join(artifactDir, "0.browser-har.log"), "utf8")).toBe(foreign);
	});

	it("removes temp and partial final and leaks no HAR when the EXDEV direct-write fails verification", async () => {
		const tool = new BrowserTool(makeRecordingSession(artifactDir));
		setHarArtifactIoForTest({
			rename: async () => {
				throw Object.assign(new Error("cross-device link not permitted"), { code: "EXDEV" });
			},
			// Force the post-write verification to mismatch so the failure-cleanup path runs.
			stat: async () => ({ size: 1 }),
		});
		const { name } = register({ worker: new FakeWorker({ respond: responder({ summary: markedSummary() }) }) });
		await tool.execute("rec-start", { action: "start_recording", name });

		const error = await tool.execute("rec-stop", { action: "stop_recording", name }).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(Error);
		const message = error instanceof Error ? error.message : String(error);
		expect(message).toBe("Failed to persist browser recording artifact.");
		expect(message).not.toContain(artifactDir);
		expect(message).not.toContain(HAR_MARKER);
		// No temp and no partial final artifact are left behind.
		expect(await fs.readdir(artifactDir)).toEqual([]);
	});
	it("removes temp and partial final when EXDEV direct-write fails after creating the final", async () => {
		const tool = new BrowserTool(makeRecordingSession(artifactDir));
		setHarArtifactIoForTest({
			writeExclusive0600: async (target, content, onCreated) => {
				if (target.endsWith(".browser-har.log")) {
					await fs.writeFile(target, content, { flag: "wx", mode: 0o600 });
					onCreated?.();
					throw new Error(`write failed at ${target}: ${HAR_MARKER}`);
				}
				await fs.writeFile(target, content, { flag: "wx", mode: 0o600 });
			},
			rename: async () => {
				throw Object.assign(new Error("cross-device link not permitted"), { code: "EXDEV" });
			},
		});
		const { name } = register({ worker: new FakeWorker({ respond: responder({ summary: markedSummary() }) }) });
		await tool.execute("rec-start", { action: "start_recording", name });

		const error = await tool.execute("rec-stop", { action: "stop_recording", name }).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(Error);
		const message = error instanceof Error ? error.message : String(error);
		expect(message).toBe("Failed to persist browser recording artifact.");
		expect(message).not.toContain(artifactDir);
		expect(message).not.toContain(HAR_MARKER);
		expect(await fs.readdir(artifactDir)).toEqual([]);
	});
});

describe("browser recording renderer", () => {
	beforeAll(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
		await initTheme();
	});
	afterAll(() => {
		resetSettingsForTest();
	});

	function renderResultLines(
		details: BrowserToolDetails,
		output: string,
		args: Parameters<typeof browserToolRenderer.renderResult>[3],
	): string {
		const component = browserToolRenderer.renderResult(
			{ content: [{ type: "text", text: output }], details },
			{ expanded: true, isPartial: false } as Parameters<typeof browserToolRenderer.renderResult>[1],
			theme,
			args,
		);
		return stripVTControlCharacters((component.render(120) as readonly string[]).join("\n"));
	}

	it("labels start_recording and stop_recording as recording actions, not open or close", () => {
		const startLines = renderResultLines(
			{ action: "start_recording", name: "docs", browser: "headless", scope: ["https://shop.test"] },
			'Recording network traffic on tab "docs" (headless)',
			{ action: "start_recording", name: "docs" },
		);
		expect(startLines.toLowerCase()).toContain("recording");
		expect(startLines).not.toContain("Open ");
		expect(startLines).not.toContain("Close ");

		const stopLines = renderResultLines(
			{ action: "stop_recording", name: "docs", browser: "headless", artifactId: "7" },
			'Stopped recording on tab "docs"',
			{ action: "stop_recording", name: "docs" },
		);
		expect(stopLines.toLowerCase()).toContain("recording");
		expect(stopLines).not.toContain("Open ");
		expect(stopLines).not.toContain("Close ");
		expect(stopLines).toContain("artifact://7");
	});

	it("renders the recording action label while the call is pending approval", () => {
		const component = browserToolRenderer.renderCall(
			{ action: "start_recording", name: "docs" },
			{ isPartial: true } as Parameters<typeof browserToolRenderer.renderCall>[1],
			theme,
		);
		const lines = stripVTControlCharacters((component.render(120) as readonly string[]).join("\n"));
		expect(lines.toLowerCase()).toContain("recording");
	});
	it("does not render invalid secret-bearing domains on pending or result paths", () => {
		const secret = "https://user:secret@example.test/reset?token=super-secret#fragment";
		const callLines = stripVTControlCharacters(
			(
				browserToolRenderer
					.renderCall(
						{ action: "start_recording", name: "docs", domains: [secret] },
						{ isPartial: true } as Parameters<typeof browserToolRenderer.renderCall>[1],
						theme,
					)
					.render(120) as readonly string[]
			).join("\n"),
		);
		expect(callLines).toContain("(invalid origin)");
		expect(callLines).not.toContain("secret");
		expect(callLines).not.toContain("reset");
		expect(callLines).not.toContain("token");

		const resultLines = renderResultLines(
			{ action: "start_recording", name: "docs", browser: "headless", scope: [secret] },
			"Recording network traffic",
			{ action: "start_recording", name: "docs" },
		);
		expect(resultLines).toContain("(invalid origin)");
		expect(resultLines).not.toContain("secret");
		expect(resultLines).not.toContain("reset");
		expect(resultLines).not.toContain("token");
	});

	it("sanitizes tabs and width-truncates provider-controlled recording domains on both paths", () => {
		const overlong = `https://${"a".repeat(400)}.example.com`;
		const tabbed = "https://tab\ttab.example.com";

		// Pending/live path: scope comes straight from raw provider-controlled args.domains.
		const callLines = stripVTControlCharacters(
			(
				browserToolRenderer
					.renderCall(
						{ action: "start_recording", name: "docs", domains: [tabbed, overlong] },
						{ isPartial: true } as Parameters<typeof browserToolRenderer.renderCall>[1],
						theme,
					)
					.render(120) as readonly string[]
			).join("\n"),
		);
		expect(callLines).not.toContain("\t");
		expect(callLines).not.toContain("a".repeat(85));

		// Result/transcript path: details.scope is truncated + tab-sanitized too.
		const resultLines = renderResultLines(
			{ action: "start_recording", name: "docs", browser: "headless", scope: [tabbed, overlong] },
			"Recording network traffic",
			{ action: "start_recording", name: "docs" },
		);
		expect(resultLines).not.toContain("\t");
		expect(resultLines).not.toContain("a".repeat(85));
	});

	it("keeps the recording header a single bounded line under adversarial long/tab-heavy domains", () => {
		// Adversarial provider-controlled domain: real visible content (so it is not filtered as a
		// blank meta) wrapped around a huge tab run. Without the CONTENT-width truncation the
		// metadata expands to ~900 chars and wraps the single-line status header; rendered at a
		// generous width (200) a correctly bounded header is exactly one line.
		const pathological = `https://evil${"\t".repeat(300)}x.example.com`;

		// Pending/live path (renderCall): scope = raw provider-controlled args.domains.
		const callComponent = browserToolRenderer.renderCall(
			{ action: "start_recording", name: "d", domains: [pathological] },
			{ isPartial: true } as Parameters<typeof browserToolRenderer.renderCall>[1],
			theme,
		);
		expect(callComponent.render(200).length).toBe(1);

		// Result/transcript path (renderResult): details.scope, header only (empty output).
		const resultComponent = browserToolRenderer.renderResult(
			{
				content: [{ type: "text", text: "" }],
				details: { action: "start_recording", name: "d", scope: [pathological] },
			},
			{ expanded: true, isPartial: false } as Parameters<typeof browserToolRenderer.renderResult>[1],
			theme,
			{ action: "start_recording", name: "d" },
		);
		expect(resultComponent.render(200).length).toBe(1);
	});
});
