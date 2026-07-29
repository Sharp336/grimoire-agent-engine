/**
 * Control-frame contract for the `ctl`/`ctl-result` collab surface (Phase 4):
 * a remote app driving the host session over the existing relay transport.
 *
 * The collab-web `local-relay.test.ts` harness has no real host (its "host" is a
 * raw socket), so every case here requires the host dispatch that lives in
 * `CollabHost`. This suite drives a real `CollabHost` over the in-process
 * relay + fake WebSocket transport (see ./helpers/in-memory-relay), with real
 * AES-GCM sealing — only the TUI context and the network transport are
 * stubbed, mirroring `read-only.test.ts`.
 *
 * Cases:
 *   (a) `ctl` from a view-only (no write token) peer is denied.
 *   (b) a full-link peer is denied with `code: "control-disabled"` when the
 *       host has not opted in via `collab.allowRemoteControl`.
 *   (c) with the setting on, `models-list` returns `ok: true`.
 *   (d) an oversized `sessions-list` response arrives shrunk, not dropped.
 *   (e) a proto-3 guest against a proto-4 host fails closed at hello.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { importRoomKey } from "@oh-my-pi/pi-coding-agent/collab/crypto";
import { CollabHost } from "@oh-my-pi/pi-coding-agent/collab/host";
import { COLLAB_PROTO, type CollabFrame, parseCollabLink } from "@oh-my-pi/pi-coding-agent/collab/protocol";
import { CollabSocket } from "@oh-my-pi/pi-coding-agent/collab/relay-client";
import { MAX_REPLICATED_PAYLOAD_BYTES } from "@oh-my-pi/pi-coding-agent/collab/replication-shrink";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import type { SessionInfo } from "@oh-my-pi/pi-coding-agent/session/session-listing";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { CollabControlCommand } from "@oh-my-pi/pi-wire";
import { installInMemoryRelay, uninstallInMemoryRelay } from "./helpers/in-memory-relay";

interface HostState {
	allowControl: boolean;
	models: unknown[];
	sessionStats: unknown;
	setModelCalls: unknown[];
	setThinkingCalls: unknown[];
	compactCalls: unknown[];
	switchCalls: string[];
	sessionId: string;
	cwd: string;
	resumeTargets: Map<string, { id: string; cwd: string }>;
	controlOrder: string[];
	compactBlock?: Promise<void>;
	compactStarted?: () => void;
	emitSessionEvent?: () => void;
	resumeAfterSwitchFailure?: { id: string; cwd: string; error: Error };
}

interface HostHarness {
	ctx: InteractiveModeContext;
	state: HostState;
}

/**
 * Minimal InteractiveModeContext double: only the members CollabHost touches.
 *
 * Deliberate test-double escape hatch (identical to read-only.test.ts): the
 * host is driven through its public socket, so a structurally-complete context
 * is neither possible nor useful. `state` holds mutable knobs each test sets
 * before sending a `ctl` frame; the host reads them at dispatch time.
 */
function makeHostContext(): HostHarness {
	const state: HostState = {
		allowControl: false,
		models: [
			{
				provider: "test",
				id: "alpha",
				name: "Alpha",
				reasoning: true,
				input: ["text"],
				supportsTools: true,
				contextWindow: 200_000,
				maxTokens: 16_000,
				headers: { Authorization: "Bearer collab-model-secret" },
				api: "anthropic-messages",
				baseUrl: "https://private.example.test",
				compat: { private: true },
				compatConfig: { private: true },
			},
		],
		sessionStats: { tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 } },
		setModelCalls: [],
		setThinkingCalls: [],
		compactCalls: [],
		switchCalls: [],
		sessionId: "sess-1",
		cwd: "/tmp",
		resumeTargets: new Map(),
		controlOrder: [],
	};
	const ctx = {
		settings: {
			get: (key: string): unknown => (key === "collab.allowRemoteControl" ? state.allowControl : ""),
		},
		sessionManager: {
			getSessionId: () => state.sessionId,
			getCwd: () => state.cwd,
			snapshotForReplication: () => ({
				header: { type: "session", id: state.sessionId, timestamp: new Date().toISOString(), cwd: state.cwd },
				entries: [],
			}),
			onEntryAppended: undefined,
		},
		session: {
			isStreaming: false,
			isAborting: false,
			queuedMessageCount: 0,
			sessionName: "test",
			model: undefined,
			thinkingLevel: undefined,
			subscribe: (listener: (event: { type: "agent_start" }) => void) => {
				state.emitSessionEvent = () => listener({ type: "agent_start" });
				return () => {
					state.emitSessionEvent = undefined;
				};
			},
			emitNotice: () => {},
			getAvailableModels: () => state.models,
			getSessionStats: () => state.sessionStats,
			modelRegistry: { awaitBackgroundRefresh: () => Promise.resolve() },
			setModel: (model: unknown) => {
				state.setModelCalls.push(model);
				return Promise.resolve({ switched: true });
			},
			setThinkingLevel: (level: unknown) => {
				state.setThinkingCalls.push(level);
			},
			compact: (instructions?: string) => {
				state.compactCalls.push(instructions);
				state.controlOrder.push("compact:start");
				state.compactStarted?.();
				return (state.compactBlock ?? Promise.resolve()).then(() => {
					state.controlOrder.push("compact:end");
					return { summary: "compacted" };
				});
			},
			switchSession: () => {
				throw new Error("collab controls must use handleResumeSession");
			},
		},
		eventBus: undefined,
		statusLine: {
			setCollabStatus: () => {},
			invalidate: () => {},
			getCachedContextBreakdown: () => ({ usedTokens: 0, contextWindow: 0 }),
		},
		ui: { requestRender: () => {} },
		showStatus: () => {},
		handleResumeSession: (sessionPath: string) => {
			state.switchCalls.push(sessionPath);
			state.controlOrder.push("switch");
			const target = state.resumeTargets.get(sessionPath);
			if (target) {
				state.sessionId = target.id;
				state.cwd = target.cwd;
			}
			const failure = state.resumeAfterSwitchFailure;
			if (failure) {
				state.sessionId = failure.id;
				state.cwd = failure.cwd;
				state.emitSessionEvent?.();
				return Promise.reject(failure.error);
			}
			state.emitSessionEvent?.();
			return Promise.resolve(true);
		},
		collabHost: undefined,
	} as unknown as InteractiveModeContext;
	return { ctx, state };
}

/** Debounced broadcasts + the snapshot-chunk train that follow every welcome; not asserted on. */
const FILTERED_FRAME_TYPES: Record<string, true> = {
	state: true,
	agents: true,
	entry: true,
	event: true,
	bus: true,
	"snapshot-chunk": true,
};

interface TestGuest {
	socket: CollabSocket;
	nextFrame(): Promise<CollabFrame>;
}

/** Full-link guest speaking the wire protocol directly, sending proto-4 hello. */
async function joinAsGuest(link: string, name: string, writeTokenOverride?: string): Promise<TestGuest> {
	const parsed = parseCollabLink(link);
	if ("error" in parsed) throw new Error(parsed.error);
	const writeToken =
		writeTokenOverride ?? (parsed.writeToken ? Buffer.from(parsed.writeToken).toString("base64url") : undefined);
	const key = await importRoomKey(parsed.key);
	const socket = new CollabSocket({ wsUrl: parsed.wsUrl, role: "guest", key });
	const queue: CollabFrame[] = [];
	const waiters: ((frame: CollabFrame) => void)[] = [];
	socket.onFrame = frame => {
		if (FILTERED_FRAME_TYPES[frame.t]) return;
		const waiter = waiters.shift();
		if (waiter) waiter(frame);
		else queue.push(frame);
	};
	socket.onOpen = () => socket.send({ t: "hello", proto: COLLAB_PROTO, name, writeToken });
	socket.connect();
	const nextFrame = (): Promise<CollabFrame> => {
		const queued = queue.shift();
		if (queued) return Promise.resolve(queued);
		const { promise, resolve } = Promise.withResolvers<CollabFrame>();
		waiters.push(resolve);
		return promise;
	};
	return { socket, nextFrame };
}

/** Connect a guest that sends an arbitrary proto version at hello (for the mismatch case). */
async function joinWithProto(link: string, proto: number): Promise<TestGuest> {
	const parsed = parseCollabLink(link);
	if ("error" in parsed) throw new Error(parsed.error);
	const key = await importRoomKey(parsed.key);
	const socket = new CollabSocket({ wsUrl: parsed.wsUrl, role: "guest", key });
	const queue: CollabFrame[] = [];
	const waiters: ((frame: CollabFrame) => void)[] = [];
	socket.onFrame = frame => {
		if (FILTERED_FRAME_TYPES[frame.t]) return;
		const waiter = waiters.shift();
		if (waiter) waiter(frame);
		else queue.push(frame);
	};
	socket.onOpen = () => socket.send({ t: "hello", proto, name: "old-client" });
	socket.connect();
	const nextFrame = (): Promise<CollabFrame> => {
		const queued = queue.shift();
		if (queued) return Promise.resolve(queued);
		const { promise, resolve } = Promise.withResolvers<CollabFrame>();
		waiters.push(resolve);
		return promise;
	};
	return { socket, nextFrame };
}

type CtlResult = Extract<CollabFrame, { t: "ctl-result" }>;

function requireCtlResult(frame: CollabFrame): CtlResult {
	if (frame.t !== "ctl-result") throw new Error(`expected ctl-result, got ${frame.t}`);
	return frame;
}

/** Narrow a ctl-result to its success variant; throws if it was a failure. */
function okResult(frame: CollabFrame): Extract<CtlResult, { ok: true }> {
	const r = requireCtlResult(frame);
	if (!r.ok) throw new Error(`expected ok:true, got ok:false (${r.error})`);
	return r;
}

/** Narrow a ctl-result to its failure variant; throws if it was a success. */
function failResult(frame: CollabFrame): Extract<CtlResult, { ok: false }> {
	const r = requireCtlResult(frame);
	if (r.ok) throw new Error("expected ok:false, got ok:true");
	return r;
}

/** Collect ordered ctl results while permitting a session-switch resync welcome between them. */
async function ctlResults(guest: TestGuest, count: number): Promise<CtlResult[]> {
	const results: CtlResult[] = [];
	while (results.length < count) {
		const frame = await guest.nextFrame();
		if (frame.t === "ctl-result") results.push(frame);
	}
	return results;
}

function sessionInfo(id: string, cwd = "/resumed-project"): SessionInfo {
	return {
		path: `/tmp/${id}.jsonl`,
		id,
		cwd,
		created: new Date(),
		modified: new Date(),
		messageCount: 1,
		size: 1,
		firstMessage: "",
		allMessagesText: "",
	};
}

/** Narrow a wire `unknown` payload into an object map; throws a clear error if it isn't one. */
function obj(data: unknown): Record<string, unknown> {
	if (!data || typeof data !== "object") throw new Error(`expected object payload, got ${typeof data}`);
	return data as Record<string, unknown>;
}

/** Narrow an `unknown` into an array; throws a clear error if it isn't one. */
function arr(value: unknown): unknown[] {
	if (!Array.isArray(value)) throw new Error(`expected array, got ${typeof value}`);
	return value;
}

const guestCleanups: (() => void)[] = [];
let harness: HostHarness;
let host: CollabHost;

beforeAll(async () => {
	installInMemoryRelay();
	harness = makeHostContext();
	host = new CollabHost(harness.ctx);
	await host.start("ws://localhost:8787");
});

afterEach(() => {
	for (const cleanup of guestCleanups.splice(0).reverse()) cleanup();
	harness.state.allowControl = false;
});

afterAll(async () => {
	uninstallInMemoryRelay();
	await host.stop("test done");
});

describe("collab control frames", () => {
	it("denies ctl from a view-only peer with no write token", async () => {
		// Setting is on, but the peer holds only the view link — control is a write capability.
		harness.state.allowControl = true;
		const guest = await joinAsGuest(host.viewLink, "viewer");
		guestCleanups.push(() => guest.socket.close());
		await guest.nextFrame(); // welcome (read-only)

		guest.socket.send({ t: "ctl", reqId: 1, cmd: { k: "models-list" } });
		const result = failResult(await guest.nextFrame());
		expect(result.code).toBe("control-disabled");
		expect(harness.state.setModelCalls).toHaveLength(0);
	});

	it("denies ctl from a full-link peer when the host has not opted in", async () => {
		harness.state.allowControl = false;
		const guest = await joinAsGuest(host.link, "writer");
		guestCleanups.push(() => guest.socket.close());
		await guest.nextFrame(); // welcome

		guest.socket.send({ t: "ctl", reqId: 2, cmd: { k: "models-list" } });
		const result = failResult(await guest.nextFrame());
		expect(result.code).toBe("control-disabled");
		expect(result.error).toContain("collab.allowRemoteControl");
	});

	it("runs models-list and returns ok when the host has opted in", async () => {
		harness.state.allowControl = true;
		const guest = await joinAsGuest(host.link, "writer");
		guestCleanups.push(() => guest.socket.close());
		await guest.nextFrame(); // welcome

		guest.socket.send({ t: "ctl", reqId: 3, cmd: { k: "models-list" } });
		const result = okResult(await guest.nextFrame());
		const models = arr(obj(result.data).models);
		expect(models).toHaveLength(1);
	});

	it("projects models-list through the public DTO without credentials or transport fields", async () => {
		harness.state.allowControl = true;
		const guest = await joinAsGuest(host.link, "writer");
		guestCleanups.push(() => guest.socket.close());
		await guest.nextFrame(); // welcome

		guest.socket.send({ t: "ctl", reqId: 30, cmd: { k: "models-list" } });
		const result = okResult(await guest.nextFrame());
		const serialized = JSON.stringify(result.data);
		expect(serialized).not.toContain("collab-model-secret");
		expect(serialized).not.toContain("Authorization");
		expect(serialized).not.toContain("headers");
		expect(serialized).not.toContain("compat");
		expect(serialized).not.toContain("baseUrl");
		expect(serialized).not.toContain("api");
		expect(obj(arr(obj(result.data).models)[0]).id).toBe("alpha");
	});

	it("switches by session ID through interactive resume and keeps the room live on the new snapshot", async () => {
		harness.state.allowControl = true;
		const target = sessionInfo("resumed-session");
		harness.state.resumeTargets.set(target.path, { id: target.id, cwd: target.cwd });
		const listSpy = spyOn(SessionManager, "listAll").mockImplementation(async () => [target]);
		try {
			const guest = await joinAsGuest(host.link, "writer");
			guestCleanups.push(() => guest.socket.close());
			await guest.nextFrame(); // initial welcome

			guest.socket.send({ t: "ctl", reqId: 31, cmd: { k: "switch-session", sessionId: target.id } });
			const resync = await guest.nextFrame();
			expect(resync.t).toBe("welcome");
			if (resync.t === "welcome") {
				expect(resync.header.id).toBe(target.id);
				expect(resync.state.cwd).toBe(target.cwd);
			}
			expect(obj(okResult(await guest.nextFrame()).data).cancelled).toBe(false);
			expect(harness.state.switchCalls).toEqual([target.path]);
			expect(host.participants).toHaveLength(2);

			guest.socket.send({ t: "ctl", reqId: 32, cmd: { k: "session-stats" } });
			expect(okResult(await guest.nextFrame()).reqId).toBe(32);
		} finally {
			listSpy.mockRestore();
		}
	});

	it("rebinds and resyncs the room when resume changes the ID twice then rejects", async () => {
		harness.state.allowControl = true;
		const target = sessionInfo("intermediate-session");
		const finalSession = { id: "resumed-before-failure", cwd: "/tmp/resumed-before-failure" };
		harness.state.resumeTargets.set(target.path, { id: target.id, cwd: target.cwd });
		harness.state.resumeAfterSwitchFailure = {
			...finalSession,
			error: new Error("resume render failed"),
		};
		const listSpy = spyOn(SessionManager, "listAll").mockImplementation(async () => [target]);
		try {
			const guest = await joinAsGuest(host.link, "writer");
			guestCleanups.push(() => guest.socket.close());
			await guest.nextFrame(); // initial welcome

			guest.socket.send({ t: "ctl", reqId: 39, cmd: { k: "switch-session", sessionId: target.id } });
			const resync = await guest.nextFrame();
			expect(resync.t).toBe("welcome");
			if (resync.t === "welcome") {
				expect(resync.header.id).toBe(finalSession.id);
				expect(resync.state.cwd).toBe(finalSession.cwd);
			}
			const failed = failResult(await guest.nextFrame());
			expect(failed.reqId).toBe(39);
			expect(failed.error).toBe("resume render failed");

			harness.state.emitSessionEvent?.();
			const manager = harness.ctx.sessionManager as unknown as { onEntryAppended?: (entry: unknown) => void };
			manager.onEntryAppended?.({
				id: "entry-after-resume-failure",
				parentId: null,
				timestamp: new Date().toISOString(),
				type: "model_change",
				model: "test/alpha",
			});
			await Bun.sleep(150);
			expect(host.participants).toHaveLength(2);

			guest.socket.send({ t: "ctl", reqId: 40, cmd: { k: "session-stats" } });
			expect(okResult(await guest.nextFrame()).reqId).toBe(40);
		} finally {
			harness.state.resumeAfterSwitchFailure = undefined;
			listSpy.mockRestore();
		}
	});

	it("serializes a concurrent switch followed by compact in arrival order", async () => {
		harness.state.allowControl = true;
		harness.state.controlOrder.length = 0;
		const target = sessionInfo("switch-before-compact");
		harness.state.resumeTargets.set(target.path, { id: target.id, cwd: target.cwd });
		const listSpy = spyOn(SessionManager, "listAll").mockImplementation(async () => [target]);
		try {
			const guest = await joinAsGuest(host.link, "writer");
			guestCleanups.push(() => guest.socket.close());
			await guest.nextFrame(); // welcome

			guest.socket.send({ t: "ctl", reqId: 33, cmd: { k: "switch-session", sessionId: target.id } });
			guest.socket.send({ t: "ctl", reqId: 34, cmd: { k: "compact" } });
			const results = await ctlResults(guest, 2);
			expect(results.map(result => result.reqId)).toEqual([33, 34]);
			expect(harness.state.controlOrder).toEqual(["switch", "compact:start", "compact:end"]);
		} finally {
			listSpy.mockRestore();
		}
	});

	it("continues the control queue after a failed command", async () => {
		harness.state.allowControl = true;
		harness.state.controlOrder.length = 0;
		const listSpy = spyOn(SessionManager, "listAll").mockImplementation(async () => []);
		try {
			const guest = await joinAsGuest(host.link, "writer");
			guestCleanups.push(() => guest.socket.close());
			await guest.nextFrame(); // welcome

			guest.socket.send({ t: "ctl", reqId: 37, cmd: { k: "switch-session", sessionId: "missing" } });
			guest.socket.send({ t: "ctl", reqId: 38, cmd: { k: "compact" } });
			const [failed, compacted] = await ctlResults(guest, 2);
			expect(failed?.reqId).toBe(37);
			expect(failed?.ok).toBe(false);
			expect(compacted?.reqId).toBe(38);
			expect(compacted?.ok).toBe(true);
			expect(harness.state.controlOrder).toEqual(["compact:start", "compact:end"]);
		} finally {
			listSpy.mockRestore();
		}
	});

	it("serializes a concurrent compact followed by switch in arrival order", async () => {
		harness.state.allowControl = true;
		harness.state.controlOrder.length = 0;
		const compactGate = Promise.withResolvers<void>();
		const compactStarted = Promise.withResolvers<void>();
		harness.state.compactBlock = compactGate.promise;
		harness.state.compactStarted = compactStarted.resolve;
		const target = sessionInfo("compact-before-switch");
		harness.state.resumeTargets.set(target.path, { id: target.id, cwd: target.cwd });
		const listSpy = spyOn(SessionManager, "listAll").mockImplementation(async () => [target]);
		try {
			const guest = await joinAsGuest(host.link, "writer");
			guestCleanups.push(() => guest.socket.close());
			await guest.nextFrame(); // welcome

			guest.socket.send({ t: "ctl", reqId: 35, cmd: { k: "compact" } });
			guest.socket.send({ t: "ctl", reqId: 36, cmd: { k: "switch-session", sessionId: target.id } });
			await compactStarted.promise;
			expect(harness.state.controlOrder).toEqual(["compact:start"]);
			expect(harness.state.switchCalls).not.toContain(target.path);
			compactGate.resolve();

			const results = await ctlResults(guest, 2);
			expect(results.map(result => result.reqId)).toEqual([35, 36]);
			expect(harness.state.controlOrder).toEqual(["compact:start", "compact:end", "switch"]);
		} finally {
			harness.state.compactBlock = undefined;
			harness.state.compactStarted = undefined;
			listSpy.mockRestore();
		}
	});

	it("shrinks an oversized sessions-list response instead of dropping it", async () => {
		harness.state.allowControl = true;
		// sessions-list reads real session storage via the static SessionManager.listAll;
		// override it deterministically with an oversized payload so the shrink path is
		// exercised exactly as an app would observe it (restored via mockRestore).
		const fat: SessionInfo = {
			path: "/tmp/fat.jsonl",
			id: "fat",
			cwd: "/tmp",
			title: "x".repeat(4096),
			created: new Date(),
			modified: new Date(),
			messageCount: 1,
			size: 1,
			firstMessage: "y".repeat(4096),
			allMessagesText: "z".repeat(4096),
		};
		const listSpy = spyOn(SessionManager, "listAll").mockImplementation(async () =>
			Array.from({ length: 50_000 }, () => fat),
		);
		try {
			const guest = await joinAsGuest(host.link, "writer");
			guestCleanups.push(() => guest.socket.close());
			await guest.nextFrame(); // welcome

			guest.socket.send({ t: "ctl", reqId: 4, cmd: { k: "sessions-list", limit: 50_000 } });
			const result = okResult(await guest.nextFrame());
			// Frame arrived (not dropped) and was shrunk below the per-frame ceiling.
			const serialized = JSON.stringify(result.data);
			expect(serialized.length).toBeLessThanOrEqual(MAX_REPLICATED_PAYLOAD_BYTES);
			expect(serialized).toContain("elided for collab session");
			const payload = obj(result.data);
			expect(payload.total).toBe(50_000);
			const sessions = arr(payload.sessions);
			// limit clamps to the 1..5000 window; 50000 is clamped to 5000 before the shrink
			// clips the array further, so the served slice is well under the requested 50000.
			expect(sessions.length).toBeLessThanOrEqual(5000);
		} finally {
			listSpy.mockRestore();
		}
	});

	it("clamps the sessions-list limit to the documented window", async () => {
		harness.state.allowControl = true;
		// 6000 small sessions: under the 1 MB ceiling, so the served slice length
		// reflects the clamp directly (no shrink clipping).
		const tiny: SessionInfo = {
			path: "/tmp/s.jsonl",
			id: "s",
			cwd: "/tmp",
			created: new Date(),
			modified: new Date(),
			messageCount: 1,
			size: 1,
			firstMessage: "",
			allMessagesText: "",
		};
		const listSpy = spyOn(SessionManager, "listAll").mockImplementation(async () =>
			Array.from({ length: 6000 }, () => tiny),
		);
		const guest = await joinAsGuest(host.link, "writer");
		guestCleanups.push(() => guest.socket.close());
		await guest.nextFrame(); // welcome
		try {
			// limit 0 clamps up to 1; limit 1_000_000 clamps down to 5000.
			guest.socket.send({ t: "ctl", reqId: 5, cmd: { k: "sessions-list", limit: 0 } });
			let result = okResult(await guest.nextFrame());
			expect(arr(obj(result.data).sessions).length).toBe(1);

			guest.socket.send({ t: "ctl", reqId: 6, cmd: { k: "sessions-list", limit: 1_000_000 } });
			result = okResult(await guest.nextFrame());
			expect(arr(obj(result.data).sessions).length).toBe(5000);
		} finally {
			listSpy.mockRestore();
		}
	});

	it("rejects set-thinking-level with an unsupported level and leaves the session unchanged", async () => {
		harness.state.allowControl = true;
		const guest = await joinAsGuest(host.link, "writer");
		guestCleanups.push(() => guest.socket.close());
		await guest.nextFrame(); // welcome

		// "bogus" matches no configured-thinking-level selector or abbreviation, so
		// the host must reject it before touching the session's thinking state.
		guest.socket.send({ t: "ctl", reqId: 7, cmd: { k: "set-thinking-level", level: "bogus" } });
		const result = failResult(await guest.nextFrame());
		expect(result.ok).toBe(false);
		expect(result.error).toContain("bogus");
		// Validation rejected before reaching the session, so its thinking state is untouched.
		expect(harness.state.setThinkingCalls).toHaveLength(0);
	});

	it("fails closed when a proto-3 guest joins a proto-4 host", async () => {
		const guest = await joinWithProto(host.viewLink, 3);
		guestCleanups.push(() => guest.socket.close());

		const frame = await guest.nextFrame();
		expect(frame.t).toBe("error");
		if (frame.t === "error") expect(frame.message).toContain("protocol mismatch");
	});
});

/** Compile-time guard: every command variant is sendable as a ctl frame payload. */
const _allCommands: CollabControlCommand[] = [
	{ k: "sessions-list", limit: 10 },
	{ k: "models-list" },
	{ k: "session-stats" },
	{ k: "set-model", provider: "p", modelId: "m" },
	{ k: "set-thinking-level", level: "high" },
	{ k: "compact", customInstructions: "c" },
	{ k: "switch-session", sessionId: "session-id" },
];
void _allCommands;
