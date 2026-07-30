import { afterEach, describe, expect, it, vi } from "bun:test";
import * as http from "node:http";
import { create } from "@bufbuild/protobuf";
import { connectNodeAdapter } from "@connectrpc/connect-node";
import { streamCursor } from "@oh-my-pi/pi-ai/providers/cursor";
import type { Context, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import {
	AgentServerMessageSchema,
	InteractionUpdateSchema,
	TurnEndedUpdateSchema,
} from "@oh-my-pi/pi-catalog/discovery/cursor-gen/agent_pb";
import {
	GetServerConfigResponseSchema,
	Http2Config,
	ServerConfigService,
} from "@oh-my-pi/pi-catalog/discovery/cursor-gen/server_config_pb";
import * as cursorHttp1 from "../src/providers/cursor/http1";
import { disposeServerConfigCache } from "../src/providers/cursor/server-config";
import {
	BidiAppendResponseSchema,
	CursorAgentService,
	CursorBidiService,
} from "../src/providers/cursor/transport-descriptors";
import * as requestDebug from "../src/utils/request-debug";

// The request-debug + cursor/http1 namespace spies and PI_REQ_DEBUG env would
// leak across tests in the same process, so re-run just this case in a child bun.
const ISOLATED_FLAG = "OMP_ISOLATED_CURSOR_LOG_CLEANUP";
const TEST_NAME = "runs transport cleanup even when the debug response log close rejects";

async function runInIsolatedProcess(): Promise<boolean> {
	if (Bun.env[ISOLATED_FLAG] === "1") return false;
	const child = Bun.spawn([process.execPath, "test", import.meta.path, "-t", TEST_NAME], {
		cwd: new URL("..", import.meta.url).pathname,
		env: { ...process.env, TMPDIR: "/dev/shm", [ISOLATED_FLAG]: "1" },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	if (exitCode !== 0) throw new Error(`${stderr}\n${stdout}`);
	return true;
}

const servers = new Set<http.Server>();

afterEach(async () => {
	vi.restoreAllMocks();
	delete process.env.PI_REQ_DEBUG;
	await disposeServerConfigCache();
	await Promise.all(
		Array.from(servers, server => {
			const closed = Promise.withResolvers<void>();
			server.close(() => closed.resolve());
			return closed.promise;
		}),
	);
	servers.clear();
});

async function http1ConfigServer(): Promise<string> {
	const server = http.createServer(
		connectNodeAdapter({
			routes: router => {
				router.service(ServerConfigService, {
					getServerConfig: () =>
						create(GetServerConfigResponseSchema, { http2Config: Http2Config.FORCE_BIDI_DISABLED }),
				});
				router.service(CursorBidiService, {
					bidiAppend: () => create(BidiAppendResponseSchema, {}),
				});
				router.service(CursorAgentService, {
					async *runSSE() {
						yield create(AgentServerMessageSchema, {
							message: {
								case: "interactionUpdate",
								value: create(InteractionUpdateSchema, {
									message: { case: "turnEnded", value: create(TurnEndedUpdateSchema, {}) },
								}),
							},
						});
					},
				});
			},
		}),
	);
	servers.add(server);
	const listening = Promise.withResolvers<void>();
	server.once("error", listening.reject);
	server.listen(0, "127.0.0.1", listening.resolve);
	await listening.promise;
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Test server has no TCP address");
	return `http://127.0.0.1:${address.port}`;
}

describe("Cursor transport cleanup with a failing debug response log", () => {
	it(TEST_NAME, async () => {
		if (await runInIsolatedProcess()) return;

		// Force request debugging on, then swap the debug-session factory for one
		// whose response log rejects on close — the failure mode the finally block
		// must not allow to skip heartbeat/bridge/lease cleanup.
		process.env.PI_REQ_DEBUG = "1";
		const failingLog: requestDebug.RequestDebugResponseLog = {
			write() {
				/* diagnostics only; never throws from the stream loop */
			},
			close() {
				return Promise.reject(new Error("disk full: response log close failed"));
			},
		};
		const createSessionSpy = vi.spyOn(requestDebug, "createRequestDebugSession").mockResolvedValue({
			id: 1,
			requestPath: "rr-session-1.json",
			responsePath: "rr-session-1.res.log",
			async openResponseLog() {
				return failingLog;
			},
			async wrapResponse(response: Response) {
				return response;
			},
		});

		// The H1 bridge close runs in the finally AFTER the (failing) log close, so
		// resolving here is the deterministic proof that teardown was reached. A
		// missing `.catch` on the log close aborts the finally first, so this never
		// resolves and the test times out — the mutation signal.
		const cleanupReached = Promise.withResolvers<void>();
		const originalCreateBridge = cursorHttp1.createCursorHttp1Bridge;
		const createBridgeSpy = vi.spyOn(cursorHttp1, "createCursorHttp1Bridge").mockImplementation(async options => {
			const bridge = await originalCreateBridge(options);
			const realClose = bridge.close.bind(bridge);
			bridge.close = ((reason: "dispose"): Promise<void> => {
				cleanupReached.resolve();
				return realClose(reason);
			}) as typeof bridge.close;
			return bridge;
		});

		// Swallow the fire-and-forget IIFE rejection so a reverted fix surfaces as a
		// clean timeout instead of cross-test unhandled-rejection noise.
		const swallow = (): void => undefined;
		process.on("unhandledRejection", swallow);

		const baseUrl = await http1ConfigServer();
		const model = buildModel({
			id: "cursor-log-cleanup",
			name: "Cursor log cleanup",
			api: "cursor-agent",
			provider: "cursor",
			baseUrl,
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1,
			maxTokens: 1,
		}) satisfies Model<"cursor-agent">;
		const context: Context = { messages: [{ role: "user", content: "cleanup", timestamp: 1 }] };

		try {
			const result = await streamCursor(model, context, { apiKey: "cleanup-key" }).result();
			expect(result.stopReason).toBe("stop");
			// Both spies must actually intercept — otherwise the assertion below is a
			// false green (real log closes cleanly / real bridge close is unobserved).
			expect(createSessionSpy).toHaveBeenCalled();
			expect(createBridgeSpy).toHaveBeenCalled();
			// Awaits the real teardown event (bridge close), which only runs if the
			// failing log close was swallowed. Never resolves when the fix is reverted.
			await cleanupReached.promise;
		} finally {
			process.off("unhandledRejection", swallow);
		}
	}, 5000);
});
