import { describe, expect, it } from "bun:test";
import { DEFAULT_RECORDING_LIMITS } from "@oh-my-pi/pi-coding-agent/tools/browser/network-recorder";
import type { Transport, WorkerInbound, WorkerOutbound } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-protocol";
import { WorkerCore } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-worker";
import type { CDPSession, Page } from "puppeteer-core";

// The worker recording channel is exercised through its real inbound-message handler
// (a `Transport`) and an injected CDP transport, so every assertion is a genuine
// observable contract: an emitted outbound message or a HAR the worker produced.

type CdpHandler = (payload: unknown) => void;

type HarEntry = {
	time: number;
	startedDateTime: string;
	request: {
		method: string;
		url: string;
		headers: Array<{ name: string; value: string }>;
		postData?: { mimeType: string; text: string };
	};
	response: {
		status: number;
		headers: Array<{ name: string; value: string }>;
		content: { mimeType: string; size: number; text?: string };
	};
};
type Har = { log: { entries: HarEntry[] } };

class TestTransport implements Transport {
	readonly sent: WorkerOutbound[] = [];
	#handler: ((msg: WorkerInbound) => void) | null = null;
	#waiters = new Set<{ match: (m: WorkerOutbound) => boolean; resolve: (m: WorkerOutbound) => void }>();

	send(msg: WorkerOutbound | WorkerInbound): void {
		const out = msg as WorkerOutbound;
		this.sent.push(out);
		for (const waiter of [...this.#waiters]) {
			if (waiter.match(out)) {
				this.#waiters.delete(waiter);
				waiter.resolve(out);
			}
		}
	}

	onMessage(handler: (msg: WorkerOutbound | WorkerInbound) => void): () => void {
		this.#handler = handler as (msg: WorkerInbound) => void;
		return () => {
			this.#handler = null;
		};
	}

	close(): void {}

	deliver(msg: WorkerInbound): void {
		if (!this.#handler) throw new Error("worker is not listening on the transport");
		this.#handler(msg);
	}

	byType<T extends WorkerOutbound["type"]>(type: T): Array<Extract<WorkerOutbound, { type: T }>> {
		return this.sent.filter((m): m is Extract<WorkerOutbound, { type: T }> => m.type === type);
	}

	next<T extends WorkerOutbound["type"]>(
		type: T,
		match?: (m: Extract<WorkerOutbound, { type: T }>) => boolean,
	): Promise<Extract<WorkerOutbound, { type: T }>> {
		const predicate = (m: WorkerOutbound): m is Extract<WorkerOutbound, { type: T }> =>
			m.type === type && (!match || match(m as Extract<WorkerOutbound, { type: T }>));
		const existing = this.sent.find(predicate);
		if (existing) return Promise.resolve(existing);
		const { promise, resolve } = Promise.withResolvers<Extract<WorkerOutbound, { type: T }>>();
		this.#waiters.add({ match: predicate, resolve: resolve as (m: WorkerOutbound) => void });
		return promise;
	}
}

class FakeCdpSession {
	readonly commands: Array<{ method: string; params?: Record<string, unknown> }> = [];
	detachCount = 0;
	networkDisableCount = 0;
	networkEnableError: Error | null = null;
	frameTreeError: Error | null = null;
	networkEnableGate: Promise<void> | null = null;
	#handlers = new Map<string, Set<CdpHandler>>();
	#bodies = new Map<string, PromiseWithResolvers<{ body: string; base64Encoded: boolean }>>();

	on(event: string, handler: CdpHandler): this {
		let set = this.#handlers.get(event);
		if (!set) {
			set = new Set();
			this.#handlers.set(event, set);
		}
		set.add(handler);
		return this;
	}

	off(event: string, handler: CdpHandler): this {
		this.#handlers.get(event)?.delete(handler);
		return this;
	}

	emit(event: string, payload: unknown): void {
		for (const handler of [...(this.#handlers.get(event) ?? [])]) handler(payload);
	}

	totalListeners(): number {
		let count = 0;
		for (const set of this.#handlers.values()) count += set.size;
		return count;
	}

	#bodyResolver(requestId: string): PromiseWithResolvers<{ body: string; base64Encoded: boolean }> {
		let entry = this.#bodies.get(requestId);
		if (!entry) {
			entry = Promise.withResolvers();
			this.#bodies.set(requestId, entry);
		}
		return entry;
	}

	resolveBody(requestId: string, body: string, base64Encoded = false): void {
		this.#bodyResolver(requestId).resolve({ body, base64Encoded });
	}

	rejectBody(requestId: string, error: Error): void {
		this.#bodyResolver(requestId).reject(error);
	}

	async send(method: string, params?: Record<string, unknown>): Promise<unknown> {
		this.commands.push({ method, params });
		if (method === "Network.enable") {
			if (this.networkEnableGate) await this.networkEnableGate;
			if (this.networkEnableError) throw this.networkEnableError;
			return {};
		}
		if (method === "Network.disable") {
			this.networkDisableCount++;
			return {};
		}
		if (method === "Page.getFrameTree") {
			if (this.frameTreeError) throw this.frameTreeError;
			return { frameTree: { frame: { id: "frame", url: "https://shop.test/" }, childFrames: [] } };
		}
		if (method === "Network.getResponseBody") {
			return this.#bodyResolver(String(params?.requestId ?? "")).promise;
		}
		return {};
	}

	async detach(): Promise<void> {
		this.detachCount++;
	}
}

function fakePage(url = "https://shop.test/products"): Page {
	return { url: () => url, isClosed: () => false } as unknown as Page;
}

function makeWorker(
	session: FakeCdpSession,
	page = fakePage(),
	dispose?: () => Promise<void> | void,
	acquire?: Promise<void>,
): { transport: TestTransport; core: WorkerCore } {
	const transport = new TestTransport();
	const core = new WorkerCore(transport, {
		page,
		targetId: "target-1",
		pageCdpClient: async () => {
			if (acquire) await acquire;
			return dispose ? { client: session as unknown as CDPSession, dispose } : (session as unknown as CDPSession);
		},
	});
	return { transport, core };
}

let idSeq = 0;
const nextId = (): string => `rec-${++idSeq}`;

function requestWillBeSent(
	requestId: string,
	url: string,
	headers: Record<string, string> = { "content-type": "application/json" },
	postData?: string,
) {
	return {
		requestId,
		request: { url, method: postData ? "POST" : "GET", headers, postData },
		wallTime: 1_700_000_000,
		timestamp: 100,
	};
}

function requestExtraInfo(requestId: string, headers: Record<string, string>) {
	return {
		requestId,
		headers,
		associatedCookies: [{ cookie: { name: "sid", value: "top-secret-cookie" }, blockedReasons: [] }],
	};
}

function responseReceived(
	requestId: string,
	url: string,
	headers: Record<string, string> = { "content-type": "application/json" },
	status = 200,
	mimeType = "application/json",
) {
	return {
		requestId,
		response: { url, status, statusText: "OK", headers, mimeType, encodedDataLength: 0 },
		timestamp: 101,
	};
}

function loadingFinished(requestId: string, encodedDataLength = 20) {
	return { requestId, timestamp: 102, encodedDataLength };
}

function loadingFailed(requestId: string) {
	return { requestId, timestamp: 102, type: "Fetch", errorText: "net::ERR_FAILED", canceled: false };
}

function har(stopped: Extract<WorkerOutbound, { type: "recording-stopped" }>): Har {
	return stopped.summary.har as unknown as Har;
}

describe("WorkerCore recording control", () => {
	it("populates omitted limits with defaults and scopes to the live page origin", async () => {
		const session = new FakeCdpSession();
		const { transport } = makeWorker(session, fakePage("https://shop.test/products?ref=1"));

		const started = transport.next("recording-started");
		transport.deliver({ type: "recording-start", id: nextId() });
		const msg = await started;

		expect(msg.scope).toEqual(["https://shop.test"]);
		expect(msg.limits).toEqual(DEFAULT_RECORDING_LIMITS);
		expect(session.commands.some(c => c.method === "Network.enable")).toBe(true);
	});

	it("emits only recording-started on start and only recording-stopped on stop", async () => {
		const session = new FakeCdpSession();
		const { transport } = makeWorker(session);

		const startId = nextId();
		const started = transport.next("recording-started");
		transport.deliver({ type: "recording-start", id: startId });
		expect((await started).id).toBe(startId);
		expect(transport.byType("recording-error")).toHaveLength(0);

		const stopId = nextId();
		const stopped = transport.next("recording-stopped");
		transport.deliver({ type: "recording-stop", id: stopId, timeoutMs: 1_000 });
		const stopMsg = await stopped;

		expect(stopMsg.id).toBe(stopId);
		expect(stopMsg.summary.entryCount).toBe(0);
		expect(transport.byType("recording-stopped")).toHaveLength(1);
		expect(transport.byType("recording-error")).toHaveLength(0);
	});

	it("never routes a recording reply onto the run result channel", async () => {
		const session = new FakeCdpSession();
		const { transport } = makeWorker(session);

		transport.deliver({ type: "recording-start", id: nextId() });
		await transport.next("recording-started");
		const stopped = transport.next("recording-stopped");
		transport.deliver({ type: "recording-stop", id: nextId(), timeoutMs: 1_000 });
		await stopped;

		expect(transport.sent.every(m => m.type.startsWith("recording-") || m.type === "log")).toBe(true);
		expect(transport.byType("result")).toHaveLength(0);
	});

	it("cancels without a HAR and leaves a clean follow-up start", async () => {
		const session = new FakeCdpSession();
		const { transport } = makeWorker(session);

		transport.deliver({ type: "recording-start", id: nextId() });
		await transport.next("recording-started");

		const cancelId = nextId();
		const canceled = transport.next("recording-canceled");
		transport.deliver({ type: "recording-cancel", id: cancelId });
		const cancelMsg = await canceled;
		expect(cancelMsg.id).toBe(cancelId);
		expect("summary" in cancelMsg).toBe(false);
		expect("har" in cancelMsg).toBe(false);

		// State was cleared: a fresh start succeeds immediately.
		const startId = nextId();
		const started = transport.next("recording-started", m => m.id === startId);
		transport.deliver({ type: "recording-start", id: startId });
		expect((await started).id).toBe(startId);
	});

	it("captures a delayed response body before stop resolves", async () => {
		const session = new FakeCdpSession();
		const { transport } = makeWorker(session);
		const url = "https://shop.test/api/items";
		const rid = "req-body";

		transport.deliver({ type: "recording-start", id: nextId() });
		await transport.next("recording-started");
		session.emit("Network.requestWillBeSent", requestWillBeSent(rid, url));
		session.emit("Network.responseReceived", responseReceived(rid, url));
		session.emit("Network.loadingFinished", loadingFinished(rid));

		const stopped = transport.next("recording-stopped");
		transport.deliver({ type: "recording-stop", id: nextId(), timeoutMs: 2_000 });
		// The body arrives only after stop began draining; stop must wait for it.
		session.resolveBody(rid, '{"result":"ok"}');
		const stopMsg = await stopped;

		expect(stopMsg.summary.capturedBodyCount).toBe(1);
		const entry = har(stopMsg).log.entries[0];
		expect(entry.request.url).toBe(url);
		expect(entry.response.content.mimeType).toBe("application/json");
		expect(entry.response.content.text).toBe('{"result":"ok"}');
	});

	it("omits the body on a read timeout and still resolves the stop", async () => {
		const session = new FakeCdpSession();
		const { transport } = makeWorker(session);
		const url = "https://shop.test/api/slow";
		const rid = "req-timeout";

		transport.deliver({ type: "recording-start", id: nextId(), limits: { maxBodyWaitMs: 5 } });
		await transport.next("recording-started");
		session.emit("Network.requestWillBeSent", requestWillBeSent(rid, url));
		session.emit("Network.responseReceived", responseReceived(rid, url));
		session.emit("Network.loadingFinished", loadingFinished(rid));

		// getResponseBody is never resolved: the worker-side maxBodyWaitMs race must win.
		const stopped = transport.next("recording-stopped");
		transport.deliver({ type: "recording-stop", id: nextId(), timeoutMs: 2_000 });
		const stopMsg = await stopped;

		expect(stopMsg.summary.capturedBodyCount).toBe(0);
		expect(stopMsg.summary.omittedBodyCount).toBeGreaterThanOrEqual(1);
		expect(har(stopMsg).log.entries).toHaveLength(1);
	});

	it("omits the body and drains when a request fails to load", async () => {
		const session = new FakeCdpSession();
		const { transport } = makeWorker(session);
		const url = "https://shop.test/api/fail";
		const rid = "req-fail";

		transport.deliver({ type: "recording-start", id: nextId() });
		await transport.next("recording-started");
		session.emit("Network.requestWillBeSent", requestWillBeSent(rid, url));
		session.emit("Network.responseReceived", responseReceived(rid, url, { "content-type": "application/json" }, 500));
		session.emit("Network.loadingFailed", loadingFailed(rid));

		const stopped = transport.next("recording-stopped");
		transport.deliver({ type: "recording-stop", id: nextId(), timeoutMs: 2_000 });
		const stopMsg = await stopped;

		expect(stopMsg.summary.capturedBodyCount).toBe(0);
		expect(har(stopMsg).log.entries).toHaveLength(1);
	});

	it("drains a pre-cutoff request whose completion arrives after stop", async () => {
		const session = new FakeCdpSession();
		const { transport } = makeWorker(session);
		const url = "https://shop.test/api/late";
		const rid = "req-late";

		transport.deliver({ type: "recording-start", id: nextId() });
		await transport.next("recording-started");
		session.emit("Network.requestWillBeSent", requestWillBeSent(rid, url));

		// Stop while the request is still in flight; its completion is queued afterwards.
		const stopped = transport.next("recording-stopped");
		transport.deliver({ type: "recording-stop", id: nextId(), timeoutMs: 2_000 });
		session.emit("Network.responseReceived", responseReceived(rid, url));
		session.emit("Network.loadingFinished", loadingFinished(rid));
		session.resolveBody(rid, '{"late":true}');
		const stopMsg = await stopped;

		expect(har(stopMsg).log.entries).toHaveLength(1);
		expect(har(stopMsg).log.entries[0].request.url).toBe(url);
		expect(stopMsg.summary.capturedBodyCount).toBe(1);
	});

	it("excludes requests that begin after the stop cutoff", async () => {
		const session = new FakeCdpSession();
		const { transport } = makeWorker(session);
		const preUrl = "https://shop.test/api/one";
		const postUrl = "https://shop.test/api/two";
		const pre = "req-pre";
		const post = "req-post";

		transport.deliver({ type: "recording-start", id: nextId() });
		await transport.next("recording-started");
		session.emit("Network.requestWillBeSent", requestWillBeSent(pre, preUrl));

		const stopped = transport.next("recording-stopped");
		transport.deliver({ type: "recording-stop", id: nextId(), timeoutMs: 2_000 });
		// A brand-new request after the cutoff must never widen the capture.
		session.emit("Network.requestWillBeSent", requestWillBeSent(post, postUrl));
		session.emit("Network.responseReceived", responseReceived(post, postUrl));
		session.emit("Network.loadingFinished", loadingFinished(post));
		// The pre-cutoff request finishes and is included.
		session.emit("Network.responseReceived", responseReceived(pre, preUrl));
		session.emit("Network.loadingFinished", loadingFinished(pre));
		session.resolveBody(pre, '{"pre":true}');
		const stopMsg = await stopped;

		const urls = har(stopMsg).log.entries.map(e => e.request.url);
		expect(urls).toContain(preUrl);
		expect(urls).not.toContain(postUrl);
		expect(har(stopMsg).log.entries).toHaveLength(1);
	});

	it("merges request ExtraInfo headers that arrive before the base event and drops cookies", async () => {
		const session = new FakeCdpSession();
		const { transport } = makeWorker(session);
		const url = "https://shop.test/api/extra";
		const rid = "req-extra";

		transport.deliver({ type: "recording-start", id: nextId() });
		await transport.next("recording-started");
		// ExtraInfo precedes the base request event.
		session.emit(
			"Network.requestWillBeSentExtraInfo",
			requestExtraInfo(rid, { "X-Merged": "yes", cookie: "session=top-secret" }),
		);
		session.emit("Network.requestWillBeSent", requestWillBeSent(rid, url, { "content-type": "application/json" }));
		session.emit("Network.responseReceived", responseReceived(rid, url));
		session.emit("Network.loadingFinished", loadingFinished(rid));

		const stopped = transport.next("recording-stopped");
		transport.deliver({ type: "recording-stop", id: nextId(), timeoutMs: 2_000 });
		session.resolveBody(rid, '{"ok":true}');
		const stopMsg = await stopped;

		const entry = har(stopMsg).log.entries[0];
		const headers = new Map(entry.request.headers.map(h => [h.name, h.value]));
		expect(headers.get("x-merged")).toBe("yes");
		expect(headers.get("cookie")).toBe("[REDACTED]");
		expect(JSON.stringify(stopMsg.summary.har)).not.toContain("top-secret");
	});

	it("emits recording-error and clears state when there is no page CDP client", async () => {
		const transport = new TestTransport();
		new WorkerCore(transport, { page: fakePage(), targetId: "t", pageCdpClient: () => null });

		const errored = transport.next("recording-error");
		transport.deliver({ type: "recording-start", id: nextId() });
		const err = await errored;
		expect(err.error.message).toContain("CDP session");
		expect(transport.byType("recording-started")).toHaveLength(0);

		// State was cleared: stopping now reports "no active recording" rather than a stale HAR.
		const stopErr = transport.next("recording-error");
		transport.deliver({ type: "recording-stop", id: nextId(), timeoutMs: 1_000 });
		expect((await stopErr).error).toBeDefined();
	});
	it("disposes an owned CDP session exactly once on normal stop and repeated cycles", async () => {
		const session = new FakeCdpSession();
		let disposeCount = 0;
		const { transport } = makeWorker(session, fakePage(), () => {
			disposeCount++;
		});
		for (let cycle = 0; cycle < 2; cycle++) {
			const started = transport.next("recording-started");
			transport.deliver({ type: "recording-start", id: nextId() });
			await started;
			const stopped = transport.next("recording-stopped");
			transport.deliver({ type: "recording-stop", id: nextId(), timeoutMs: 1_000 });
			await stopped;
		}
		expect(disposeCount).toBe(2);
	});

	it("disposes an owned CDP session exactly once when canceled", async () => {
		const session = new FakeCdpSession();
		let disposeCount = 0;
		const { transport } = makeWorker(session, fakePage(), () => {
			disposeCount++;
		});
		const started = transport.next("recording-started");
		transport.deliver({ type: "recording-start", id: nextId() });
		await started;
		const canceled = transport.next("recording-canceled");
		transport.deliver({ type: "recording-cancel", id: nextId() });
		await canceled;
		expect(disposeCount).toBe(1);
	});

	it("disposes an owned CDP session exactly once when Network.enable fails", async () => {
		const session = new FakeCdpSession();
		session.networkEnableError = new Error("boom");
		let disposeCount = 0;
		const { transport } = makeWorker(session, fakePage(), () => {
			disposeCount++;
		});
		const errored = transport.next("recording-error");
		transport.deliver({ type: "recording-start", id: nextId() });
		await errored;
		expect(disposeCount).toBe(1);
	});

	it("emits recording-error without disabling the session when Network.enable fails", async () => {
		const session = new FakeCdpSession();
		session.networkEnableError = new Error("boom raw cdp detail");
		const { transport } = makeWorker(session);

		const errored = transport.next("recording-error");
		transport.deliver({ type: "recording-start", id: nextId() });
		const err = await errored;

		expect(err.error.message).not.toContain("boom raw cdp detail");
		expect(session.networkDisableCount).toBe(0);
		expect(session.detachCount).toBe(0);
	});

	it("aborts a start whose Network.enable is still in flight when canceled", async () => {
		const session = new FakeCdpSession();
		const gate = Promise.withResolvers<void>();
		session.networkEnableGate = gate.promise;
		const { transport } = makeWorker(session);

		const startId = nextId();
		transport.deliver({ type: "recording-start", id: startId });
		const cancelId = nextId();
		const canceled = transport.next("recording-canceled");
		transport.deliver({ type: "recording-cancel", id: cancelId });
		expect((await canceled).id).toBe(cancelId);

		// Release the in-flight enable; the aborted start must not emit a late recording-started.
		gate.resolve();

		const secondStart = nextId();
		const started = transport.next("recording-started", m => m.id === secondStart);
		transport.deliver({ type: "recording-start", id: secondStart });
		await started;
		const stopped = transport.next("recording-stopped");
		transport.deliver({ type: "recording-stop", id: nextId(), timeoutMs: 1_000 });
		await stopped;

		expect(transport.byType("recording-started")).toHaveLength(1);
		expect(transport.byType("recording-started")[0].id).toBe(secondStart);
	});
	it("disposes an owned session when stop supersedes delayed CDP acquisition", async () => {
		const session = new FakeCdpSession();
		const acquisition = Promise.withResolvers<void>();
		const disposed = Promise.withResolvers<void>();
		let disposeCount = 0;
		const { transport } = makeWorker(
			session,
			fakePage(),
			() => {
				disposeCount++;
				disposed.resolve();
			},
			acquisition.promise,
		);
		transport.deliver({ type: "recording-start", id: nextId() });
		const stopError = transport.next("recording-error");
		transport.deliver({ type: "recording-stop", id: nextId(), timeoutMs: 1_000 });
		await stopError;
		acquisition.resolve();
		await disposed.promise;
		expect(disposeCount).toBe(1);
		expect(transport.byType("recording-started")).toHaveLength(0);
	});

	it("disposes an owned session when cancel supersedes delayed CDP acquisition", async () => {
		const session = new FakeCdpSession();
		const acquisition = Promise.withResolvers<void>();
		const disposed = Promise.withResolvers<void>();
		let disposeCount = 0;
		const { transport } = makeWorker(
			session,
			fakePage(),
			() => {
				disposeCount++;
				disposed.resolve();
			},
			acquisition.promise,
		);
		transport.deliver({ type: "recording-start", id: nextId() });
		const canceled = transport.next("recording-canceled");
		transport.deliver({ type: "recording-cancel", id: nextId() });
		await canceled;
		acquisition.resolve();
		await disposed.promise;
		expect(disposeCount).toBe(1);
		expect(transport.byType("recording-started")).toHaveLength(0);
	});

	it("disposes an owned session when close supersedes delayed CDP acquisition", async () => {
		const session = new FakeCdpSession();
		const acquisition = Promise.withResolvers<void>();
		const disposed = Promise.withResolvers<void>();
		let disposeCount = 0;
		const { transport } = makeWorker(
			session,
			fakePage(),
			() => {
				disposeCount++;
				disposed.resolve();
			},
			acquisition.promise,
		);
		transport.deliver({ type: "recording-start", id: nextId() });
		const closed = transport.next("closed");
		transport.deliver({ type: "close" });
		await closed;
		acquisition.resolve();
		await disposed.promise;
		expect(disposeCount).toBe(1);
		expect(transport.byType("recording-started")).toHaveLength(0);
	});

	it("logs only requestId + origin (no path/query) when the body read fails", async () => {
		const session = new FakeCdpSession();
		const { transport } = makeWorker(session);
		// A sensitive account id sits in the PATH (and a token in the query): neither may reach the log.
		const url = "https://shop.test/accounts/SECRET-ACCOUNT-9f3a2b/orders?token=leak-marker";
		const rid = "req-err";

		transport.deliver({ type: "recording-start", id: nextId() });
		await transport.next("recording-started");
		session.emit("Network.requestWillBeSent", requestWillBeSent(rid, url));
		session.emit("Network.responseReceived", responseReceived(rid, url));
		session.emit("Network.loadingFinished", loadingFinished(rid));
		session.rejectBody(rid, new Error("raw cdp secret payload"));

		const stopped = transport.next("recording-stopped");
		transport.deliver({ type: "recording-stop", id: nextId(), timeoutMs: 2_000 });
		const stopMsg = await stopped;

		expect(stopMsg.summary.capturedBodyCount).toBe(0);
		const failureLog = transport.byType("log").find(m => m.meta && "reason" in (m.meta ?? {}));
		expect(failureLog).toBeDefined();
		const meta = failureLog?.meta ?? {};
		// Origin only — no path, query, or full URL.
		expect(meta.origin).toBe("https://shop.test");
		expect(meta.url).toBeUndefined();
		expect(meta.reason).toBe("unavailable");
		expect(meta.requestId).toBe(rid);
		// The whole emitted log carries no sensitive path/query segment nor the raw CDP error text.
		const serialized = JSON.stringify(failureLog);
		expect(serialized).not.toContain("SECRET-ACCOUNT-9f3a2b");
		expect(serialized).not.toContain("/accounts/");
		expect(serialized).not.toContain("token=leak-marker");
		expect(serialized).not.toContain("raw cdp secret payload");
	});

	it("reports recording-error when the page session dies during the stop drain", async () => {
		const session = new FakeCdpSession();
		const { transport } = makeWorker(session);
		const rid = "req-dead";

		transport.deliver({ type: "recording-start", id: nextId() });
		await transport.next("recording-started");
		session.emit("Network.requestWillBeSent", requestWillBeSent(rid, "https://shop.test/api/hang"));

		session.frameTreeError = new Error("Session closed");
		const errored = transport.next("recording-error");
		transport.deliver({ type: "recording-stop", id: nextId(), timeoutMs: 2_000 });
		const err = await errored;

		expect(err.error.message).not.toContain("Session closed");
		expect(session.networkDisableCount).toBe(0);
		expect(session.detachCount).toBe(0);
		expect(transport.byType("recording-stopped")).toHaveLength(0);
	});

	it("never disables or detaches the shared page session across stop and cancel", async () => {
		const session = new FakeCdpSession();
		const { transport } = makeWorker(session);
		const rid = "req-share";

		transport.deliver({ type: "recording-start", id: nextId() });
		await transport.next("recording-started");
		session.emit("Network.requestWillBeSent", requestWillBeSent(rid, "https://shop.test/api/x"));
		session.emit("Network.responseReceived", responseReceived(rid, "https://shop.test/api/x"));
		session.emit("Network.loadingFinished", loadingFinished(rid));
		session.resolveBody(rid, '{"ok":1}');
		const stopped = transport.next("recording-stopped");
		transport.deliver({ type: "recording-stop", id: nextId(), timeoutMs: 2_000 });
		await stopped;

		transport.deliver({ type: "recording-start", id: nextId() });
		await transport.next("recording-started", () => transport.byType("recording-started").length === 2);
		const canceled = transport.next("recording-canceled");
		transport.deliver({ type: "recording-cancel", id: nextId() });
		await canceled;

		expect(session.networkDisableCount).toBe(0);
		expect(session.detachCount).toBe(0);
		expect(session.totalListeners()).toBe(0);
	});

	it("settles a start still enabling when stop races in, with one terminal and no late start", async () => {
		const session = new FakeCdpSession();
		const gate = Promise.withResolvers<void>();
		session.networkEnableGate = gate.promise;
		const { transport } = makeWorker(session);

		const startId = nextId();
		transport.deliver({ type: "recording-start", id: startId });
		const stopId = nextId();
		const errored = transport.next("recording-error", m => m.id === stopId);
		transport.deliver({ type: "recording-stop", id: stopId, timeoutMs: 1_000 });
		expect((await errored).id).toBe(stopId);

		// Release the in-flight enable; the superseded start must not emit a late recording-started.
		gate.resolve();

		// Fence: a fresh start/stop cycle flushes the resumed start and proves state was cleared.
		const secondStart = nextId();
		const started = transport.next("recording-started", m => m.id === secondStart);
		transport.deliver({ type: "recording-start", id: secondStart });
		await started;
		const stopped = transport.next("recording-stopped");
		transport.deliver({ type: "recording-stop", id: nextId(), timeoutMs: 1_000 });
		await stopped;

		expect(transport.byType("recording-started").map(m => m.id)).toEqual([secondStart]);
		expect(transport.byType("recording-error").map(m => m.id)).toEqual([stopId]);
	});

	it("emits only recording-canceled when cancel arrives during an in-flight stop drain", async () => {
		const session = new FakeCdpSession();
		const { transport } = makeWorker(session);
		const rid = "req-drain-cancel";

		transport.deliver({ type: "recording-start", id: nextId() });
		await transport.next("recording-started");
		session.emit("Network.requestWillBeSent", requestWillBeSent(rid, "https://shop.test/api/hang"));

		// Stop begins draining and blocks on the never-completing request.
		transport.deliver({ type: "recording-stop", id: nextId(), timeoutMs: 5_000 });
		const cancelId = nextId();
		const canceled = transport.next("recording-canceled", m => m.id === cancelId);
		transport.deliver({ type: "recording-cancel", id: cancelId });
		expect((await canceled).id).toBe(cancelId);

		// Fence: a fresh start/stop cycle proves the superseded drain resolved silently.
		const secondStart = nextId();
		const started = transport.next("recording-started", m => m.id === secondStart);
		transport.deliver({ type: "recording-start", id: secondStart });
		await started;
		const stopped = transport.next("recording-stopped");
		transport.deliver({ type: "recording-stop", id: nextId(), timeoutMs: 1_000 });
		await stopped;

		expect(transport.byType("recording-error")).toHaveLength(0);
		expect(transport.byType("recording-canceled").map(m => m.id)).toEqual([cancelId]);
		expect(transport.byType("recording-stopped")).toHaveLength(1);
	});

	it("excludes non-HTTP and out-of-scope origins from the capture", async () => {
		const session = new FakeCdpSession();
		const { transport } = makeWorker(session, fakePage("https://shop.test/products"));
		const keep = "req-keep";

		transport.deliver({ type: "recording-start", id: nextId() });
		await transport.next("recording-started");
		// In-scope request is captured.
		session.emit("Network.requestWillBeSent", requestWillBeSent(keep, "https://shop.test/api/keep"));
		session.emit("Network.responseReceived", responseReceived(keep, "https://shop.test/api/keep"));
		session.emit("Network.loadingFinished", loadingFinished(keep));
		// Out-of-scope origin (e.g. after a cross-origin navigation) must never widen scope.
		session.emit("Network.requestWillBeSent", requestWillBeSent("req-cross", "https://evil.test/api/steal"));
		session.emit("Network.responseReceived", responseReceived("req-cross", "https://evil.test/api/steal"));
		session.emit("Network.loadingFinished", loadingFinished("req-cross"));
		// Non-HTTP schemes are never in scope.
		session.emit("Network.requestWillBeSent", requestWillBeSent("req-ws", "ws://shop.test/socket"));
		session.emit("Network.requestWillBeSent", requestWillBeSent("req-about", "about:blank"));
		session.emit("Network.requestWillBeSent", requestWillBeSent("req-data", "data:text/plain,hi"));

		const stopped = transport.next("recording-stopped");
		transport.deliver({ type: "recording-stop", id: nextId(), timeoutMs: 2_000 });
		session.resolveBody(keep, '{"kept":true}');
		const stopMsg = await stopped;

		expect(har(stopMsg).log.entries.map(e => e.request.url)).toEqual(["https://shop.test/api/keep"]);
		const serialized = JSON.stringify(stopMsg.summary.har);
		expect(serialized).not.toContain("evil.test");
		expect(serialized).not.toContain("ws://");
		expect(serialized).not.toContain("data:text");
	});

	it("derives HAR timing from the monotonic clock while startedDateTime keeps epoch wall time", async () => {
		const session = new FakeCdpSession();
		const { transport } = makeWorker(session);
		const url = "https://shop.test/api/timing";
		const rid = "req-timing";

		transport.deliver({ type: "recording-start", id: nextId() });
		await transport.next("recording-started");
		// wallTime is epoch seconds; timestamp is the monotonic CDP clock. Elapsed time must use the
		// monotonic delta (101 - 100 = 1s), not the epoch/monotonic mix that clamps duration to zero.
		session.emit("Network.requestWillBeSent", requestWillBeSent(rid, url));
		session.emit("Network.responseReceived", responseReceived(rid, url));
		session.emit("Network.loadingFinished", loadingFinished(rid));

		const stopped = transport.next("recording-stopped");
		transport.deliver({ type: "recording-stop", id: nextId(), timeoutMs: 2_000 });
		session.resolveBody(rid, '{"ok":true}');
		const stopMsg = await stopped;

		const entry = har(stopMsg).log.entries[0];
		expect(entry.time).toBeCloseTo(1_000, 5);
		expect(entry.startedDateTime).toBe(new Date(1_700_000_000_000).toISOString());
	});

	it("merges delayed request ExtraInfo for a pre-cutoff request during the stop drain", async () => {
		const session = new FakeCdpSession();
		const { transport } = makeWorker(session);
		const url = "https://shop.test/api/delayed";
		const rid = "req-delayed-extra";

		transport.deliver({ type: "recording-start", id: nextId() });
		await transport.next("recording-started");
		// The request is captured before stop, but its raw-header ExtraInfo has not arrived yet.
		session.emit("Network.requestWillBeSent", requestWillBeSent(rid, url, { "content-type": "application/json" }));

		const stopped = transport.next("recording-stopped");
		transport.deliver({ type: "recording-stop", id: nextId(), timeoutMs: 2_000 });
		// ExtraInfo (raw headers, incl. cookie) arrives only after the cutoff; a pre-cutoff id must
		// still merge it before the drain completes.
		session.emit(
			"Network.requestWillBeSentExtraInfo",
			requestExtraInfo(rid, { "x-delayed-extra": "present", cookie: "session=late-cookie-secret" }),
		);
		session.emit("Network.responseReceived", responseReceived(rid, url));
		session.emit("Network.loadingFinished", loadingFinished(rid));
		session.resolveBody(rid, '{"ok":true}');
		const stopMsg = await stopped;

		const entry = har(stopMsg).log.entries[0];
		const headers = new Map(entry.request.headers.map(h => [h.name, h.value]));
		expect(headers.get("x-delayed-extra")).toBe("present");
		expect(headers.get("cookie")).toBe("[REDACTED]");
		expect(JSON.stringify(stopMsg.summary.har)).not.toContain("late-cookie-secret");
	});

	it("merges delayed response ExtraInfo (Set-Cookie) for a pre-cutoff request during the stop drain", async () => {
		const session = new FakeCdpSession();
		const { transport } = makeWorker(session);
		const url = "https://shop.test/api/set-cookie";
		const rid = "req-res-extra";

		transport.deliver({ type: "recording-start", id: nextId() });
		await transport.next("recording-started");
		session.emit("Network.requestWillBeSent", requestWillBeSent(rid, url));

		const stopped = transport.next("recording-stopped");
		transport.deliver({ type: "recording-stop", id: nextId(), timeoutMs: 2_000 });
		// responseReceived is recorded during the drain, then its raw ExtraInfo (Set-Cookie + a
		// custom header) arrives late; a pre-cutoff id must still merge it after the base event.
		session.emit("Network.responseReceived", responseReceived(rid, url));
		session.emit("Network.responseReceivedExtraInfo", {
			requestId: rid,
			headers: { "x-res-extra": "present", "set-cookie": "session=late-set-cookie-secret; Secure" },
		});
		session.emit("Network.loadingFinished", loadingFinished(rid));
		session.resolveBody(rid, '{"ok":true}');
		const stopMsg = await stopped;

		const entry = har(stopMsg).log.entries[0];
		const headers = new Map(entry.response.headers.map(h => [h.name, h.value]));
		expect(headers.get("x-res-extra")).toBe("present");
		expect(headers.get("set-cookie")).toBe("[REDACTED]");
		expect(JSON.stringify(stopMsg.summary.har)).not.toContain("late-set-cookie-secret");
	});
});
