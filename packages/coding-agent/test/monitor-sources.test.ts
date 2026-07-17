import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { MONITOR_INPUT_MAX_BYTES, MonitorEventChannel } from "@oh-my-pi/pi-coding-agent/monitor/events";
import {
	MONITOR_SOURCE_ABORT_FLOOD,
	MONITOR_SOURCE_ABORT_OVERSIZED_INPUT,
	runCommandMonitor,
	runWebSocketMonitor,
} from "@oh-my-pi/pi-coding-agent/monitor/sources";

const servers: Bun.Server<unknown>[] = [];
const sockets = new Set<Bun.ServerWebSocket<unknown>>();
function createChannel(
	sourceController: AbortController,
	emitted: string[],
	onEmit?: (text: string) => void,
): MonitorEventChannel {
	return new MonitorEventChannel({
		emit: text => {
			emitted.push(text);
			onEmit?.(text);
		},
		onFlood: () => sourceController.abort(MONITOR_SOURCE_ABORT_FLOOD),
		onOversizedInput: () => sourceController.abort(MONITOR_SOURCE_ABORT_OVERSIZED_INPUT),
	});
}

function processIsAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function serveWebSocket(open: (socket: Bun.ServerWebSocket<unknown>) => void): string {
	const server = Bun.serve({
		port: 0,
		fetch(request, instance) {
			if (instance.upgrade(request)) return undefined;
			return new Response("upgrade required", { status: 426 });
		},
		websocket: {
			open(socket) {
				sockets.add(socket);
				open(socket);
			},
			message() {},
			close(socket) {
				sockets.delete(socket);
			},
		},
	});
	servers.push(server);
	return `ws://127.0.0.1:${server.port}/monitor`;
}

afterEach(() => {
	for (const socket of sockets) socket.terminate();
	sockets.clear();
	for (const server of servers.splice(0)) void server.stop(true);
});

describe("runCommandMonitor", () => {
	it("emits complete shell lines before normal completion", async () => {
		const sourceController = new AbortController();
		const emitted: string[] = [];
		const result = await runCommandMonitor({
			command: "printf 'one\\ntwo\\n'",
			cwd: process.cwd(),
			sessionKey: "monitor-source-lines:async:test",
			signal: new AbortController().signal,
			sourceController,
			channel: createChannel(sourceController, emitted),
			timeoutMs: 5_000,
		});

		expect(result).toEqual({ status: "completed", summary: "Command monitor exited normally (code 0)." });
		expect(emitted.join("\n")).toContain("one\ntwo");
	});

	it("cancels a long-running shell and emits nothing afterward", async () => {
		const managerController = new AbortController();
		const sourceController = new AbortController();
		const emitted: string[] = [];
		const started = Promise.withResolvers<void>();
		const running = runCommandMonitor({
			command: "echo started; while true; do echo tick; sleep 0.05; done",
			cwd: process.cwd(),
			sessionKey: "monitor-source-cancel:async:test",
			signal: managerController.signal,
			sourceController,
			channel: createChannel(sourceController, emitted, text => {
				if (text.includes("started")) started.resolve();
			}),
			timeoutMs: 5_000,
		});

		await started.promise;
		managerController.abort();
		const result = await running;
		const countAfterCancel = emitted.length;
		await Promise.resolve();

		expect(result.status).toBe("cancelled");
		expect(emitted).toHaveLength(countAfterCancel);
	});

	it("distinguishes non-zero exit, timeout, and flood abort", async () => {
		const abnormalController = new AbortController();
		const abnormal = await runCommandMonitor({
			command: "exit 7",
			cwd: process.cwd(),
			sessionKey: "monitor-source-exit:async:test",
			signal: new AbortController().signal,
			sourceController: abnormalController,
			channel: createChannel(abnormalController, []),
			timeoutMs: 5_000,
		});
		expect(abnormal).toMatchObject({ status: "failed", reason: "abnormal-exit" });

		const timeoutController = new AbortController();
		const timedOut = await runCommandMonitor({
			command: "sleep 10",
			cwd: process.cwd(),
			sessionKey: "monitor-source-timeout:async:test",
			signal: new AbortController().signal,
			sourceController: timeoutController,
			channel: createChannel(timeoutController, []),
			timeoutMs: 50,
		});
		expect(timedOut).toMatchObject({ status: "failed", reason: "timeout" });
		expect(timeoutController.signal.aborted).toBe(false);

		const floodController = new AbortController();
		floodController.abort(MONITOR_SOURCE_ABORT_FLOOD);
		const flooded = await runCommandMonitor({
			command: "sleep 10",
			cwd: process.cwd(),
			sessionKey: "monitor-source-flood:async:test",
			signal: new AbortController().signal,
			sourceController: floodController,
			channel: createChannel(floodController, []),
			timeoutMs: 5_000,
		});
		expect(flooded).toMatchObject({ status: "failed", reason: "flood" });
	});

	it.skipIf(process.platform === "win32")(
		"terminates detached children before normal and non-zero command monitors settle",
		async () => {
			for (const [suffix, trailer, expectedStatus] of [
				["success", "true", "completed"],
				["failure", "false", "failed"],
			] as const) {
				const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), `omp-monitor-${suffix}-`));
				const pidFile = path.join(tempDir, "child.pid");
				const quotedPidFile = `'${pidFile.replaceAll("'", "'\\''")}'`;
				let pid: number | undefined;
				try {
					const sourceController = new AbortController();
					const result = await runCommandMonitor({
						command: `PID_FILE=${quotedPidFile}; export PID_FILE; nohup sh -c 'echo $$ > "$PID_FILE"; exec /bin/sleep 30' >/dev/null 2>&1 & while [ ! -s "$PID_FILE" ]; do /bin/sleep 0.01; done; ${trailer}`,
						cwd: tempDir,
						sessionKey: `monitor-source-background-${suffix}:async:test`,
						signal: new AbortController().signal,
						sourceController,
						channel: createChannel(sourceController, []),
						timeoutMs: 5_000,
					});
					pid = Number.parseInt(await Bun.file(pidFile).text(), 10);

					expect(result.status).toBe(expectedStatus);
					expect(Number.isInteger(pid)).toBe(true);
					expect(processIsAlive(pid)).toBe(false);
				} finally {
					if (pid !== undefined && processIsAlive(pid)) {
						process.kill(pid, "SIGKILL");
					}
					await fs.rm(tempDir, { recursive: true, force: true });
				}
			}
		},
	);
});

describe("runWebSocketMonitor", () => {
	it("emits text and bounded binary placeholders before a clean close", async () => {
		const url = serveWebSocket(socket => {
			socket.send("hello");
			socket.send(new Uint8Array([1, 2, 3, 4]));
			socket.close(1000, "done");
		});
		const sourceController = new AbortController();
		const emitted: string[] = [];
		const result = await runWebSocketMonitor({
			url,
			signal: new AbortController().signal,
			sourceController,
			channel: createChannel(sourceController, emitted),
			timeoutMs: 5_000,
		});

		expect(result.status).toBe("completed");
		expect(emitted.join("\n")).toContain("hello");
		expect(emitted.join("\n")).toContain("[binary frame, 4 bytes]");
	});

	it("maps abnormal close and timeout to typed failures", async () => {
		const abnormalUrl = serveWebSocket(socket => socket.close(1011, "broken"));
		const abnormalController = new AbortController();
		const abnormal = await runWebSocketMonitor({
			url: abnormalUrl,
			signal: new AbortController().signal,
			sourceController: abnormalController,
			channel: createChannel(abnormalController, []),
			timeoutMs: 5_000,
		});
		expect(abnormal).toMatchObject({ status: "failed", reason: "abnormal-exit" });

		const timeoutUrl = serveWebSocket(() => {});
		const timeoutController = new AbortController();
		const timedOut = await runWebSocketMonitor({
			url: timeoutUrl,
			signal: new AbortController().signal,
			sourceController: timeoutController,
			channel: createChannel(timeoutController, []),
			timeoutMs: 50,
		});
		expect(timedOut).toMatchObject({ status: "failed", reason: "timeout" });
	});

	it("leaves no live socket after cancellation during a delayed WebSocket handshake", async () => {
		const requestSeen = Promise.withResolvers<void>();
		const releaseHandshake = Promise.withResolvers<void>();
		const server = Bun.serve({
			port: 0,
			async fetch(request, instance) {
				requestSeen.resolve();
				await releaseHandshake.promise;
				if (instance.upgrade(request)) return undefined;
				return new Response("upgrade cancelled", { status: 409 });
			},
			websocket: {
				open(socket) {
					sockets.add(socket);
				},
				message() {},
				close(socket) {
					sockets.delete(socket);
				},
			},
		});
		servers.push(server);
		const managerController = new AbortController();
		const sourceController = new AbortController();
		try {
			const running = runWebSocketMonitor({
				url: `ws://127.0.0.1:${server.port}/delayed`,
				signal: managerController.signal,
				sourceController,
				channel: createChannel(sourceController, []),
				timeoutMs: 5_000,
			});
			await requestSeen.promise;
			managerController.abort();
			expect(await running).toMatchObject({ status: "cancelled" });

			releaseHandshake.resolve();
			await Bun.sleep(50);
			expect(sockets.size).toBe(0);
		} finally {
			releaseHandshake.resolve();
		}
	});

	it("rejects malformed URLs and protocols without opening a connection", async () => {
		for (const options of [
			{ url: "https://example.com/socket" },
			{ url: "ws://user:secret@example.com/socket" },
			{ url: "ws://example.com/socket", protocols: [""] },
			{ url: "ws://example.com/socket", protocols: ["same", "same"] },
		]) {
			const sourceController = new AbortController();
			const result = await runWebSocketMonitor({
				...options,
				signal: new AbortController().signal,
				sourceController,
				channel: createChannel(sourceController, []),
				timeoutMs: 5_000,
			});
			expect(result).toMatchObject({ status: "failed", reason: "invalid-source" });
		}
	});

	it("fails closed on a WebSocket frame above 1 MiB", async () => {
		const url = serveWebSocket(socket => socket.send(new Uint8Array(MONITOR_INPUT_MAX_BYTES + 1)));
		const sourceController = new AbortController();
		const result = await runWebSocketMonitor({
			url,
			signal: new AbortController().signal,
			sourceController,
			channel: createChannel(sourceController, []),
			timeoutMs: 5_000,
		});

		expect(result).toMatchObject({ status: "failed", reason: "oversized-input" });
	});
});
