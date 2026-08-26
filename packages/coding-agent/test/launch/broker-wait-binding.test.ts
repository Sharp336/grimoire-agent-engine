/**
 * Process wait generation binding: waits must name the daemon id returned by
 * `start` (the generation), belong to the owning session, and never default
 * into a long exit wait on an already-ready daemon. Every refusal is
 * immediate and classified; steering/abort never kills the daemon.
 *
 * These are integration tests against a real in-process broker, real child
 * processes, and a real Unix socket: deterministic fake timers cannot drive
 * the child exits or the socket round-trips, so the few timers below exercise
 * genuine platform behavior (the one-shot child's own exit, and the abort
 * that interrupts an in-flight wait).
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { startDaemonBrokerFromEnvironment } from "../../src/launch/broker";
import { createDaemonBrokerClient, type DaemonBrokerClient, DaemonBrokerRejectedError } from "../../src/launch/client";
import {
	DAEMON_IDLE_GRACE_ENV,
	DAEMON_PROJECT_DIR_ENV,
	DAEMON_PROTOCOL_VERSION,
	DAEMON_RUNTIME_DIR_ENV,
	type DaemonSnapshot,
	type DaemonSpec,
	decodeDaemonWaitReject,
} from "../../src/launch/protocol";

function restoreEnv(name: string, value: string | undefined): void {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}

function startBroker(projectDir: string, runtimeDir: string): Promise<void> {
	const previousProjectDir = process.env[DAEMON_PROJECT_DIR_ENV];
	const previousRuntimeDir = process.env[DAEMON_RUNTIME_DIR_ENV];
	const previousGrace = process.env[DAEMON_IDLE_GRACE_ENV];
	process.env[DAEMON_PROJECT_DIR_ENV] = projectDir;
	process.env[DAEMON_RUNTIME_DIR_ENV] = runtimeDir;
	process.env[DAEMON_IDLE_GRACE_ENV] = "5000";
	const broker = startDaemonBrokerFromEnvironment();
	restoreEnv(DAEMON_PROJECT_DIR_ENV, previousProjectDir);
	restoreEnv(DAEMON_RUNTIME_DIR_ENV, previousRuntimeDir);
	restoreEnv(DAEMON_IDLE_GRACE_ENV, previousGrace);
	return broker;
}

/** Long-lived daemon that prints READY and stays alive. */
function readySpec(name: string, cwd: string): DaemonSpec {
	return {
		name,
		application: process.execPath,
		args: ["-e", "process.stdout.write('READY\\n'); setInterval(() => {}, 1000)"],
		env: {},
		cwd,
		pty: false,
		ready: { log: "READY", timeoutMs: 5_000 },
		restart: "no",
		persist: false,
		detached: false,
	};
}

/** One-shot daemon with no ready spec that exits after ~350 ms. */
function oneShotSpec(name: string, cwd: string): DaemonSpec {
	return {
		name,
		application: process.execPath,
		args: ["-e", "setTimeout(() => process.exit(0), 350)"],
		env: {},
		cwd,
		pty: false,
		restart: "no",
		persist: false,
		detached: false,
	};
}

/** Restart-always daemon that prints READY, then exits with code 3 after ~350 ms. */
function restartingReadySpec(name: string, cwd: string): DaemonSpec {
	return {
		name,
		application: process.execPath,
		args: ["-e", "process.stdout.write('READY\\n'); setTimeout(() => process.exit(3), 350)"],
		env: {},
		cwd,
		pty: false,
		ready: { log: "READY", timeoutMs: 5_000 },
		restart: "always",
		persist: false,
		detached: false,
	};
}

/**
 * Restart-always daemon whose first generation prints `firstOutput` (default
 * "booting", i.e. never ready) and exits with code 1 after `exitDelayMs`;
 * once the test writes "ok" into `markerPath`, the next generation prints
 * `okOutput` and stays alive. Lets a test arm the replacement generation's
 * behavior before the restart timer fires.
 */
function markerDaemonSpec(
	name: string,
	cwd: string,
	markerPath: string,
	okOutput: string,
	exitDelayMs: number,
	firstOutput = "booting\n",
): DaemonSpec {
	return {
		name,
		application: process.execPath,
		args: [
			"-e",
			`const fs = require('fs'); ` +
				`const marker = process.env.OMP_TEST_MARKER; ` +
				`const ok = marker && fs.existsSync(marker) && fs.readFileSync(marker, 'utf8').trim() === 'ok'; ` +
				`if (ok) { process.stdout.write(${JSON.stringify(okOutput)}); setInterval(() => {}, 1000); } ` +
				`else { process.stdout.write(${JSON.stringify(firstOutput)}); setTimeout(() => process.exit(1), ${exitDelayMs}); }`,
		],
		env: { OMP_TEST_MARKER: markerPath },
		cwd,
		pty: false,
		ready: { log: "READY", timeoutMs: 5_000 },
		restart: "always",
		persist: false,
		detached: false,
	};
}

/** Classified rejection payload carried by a broker error, or the raw message. */
function rejectOf(error: unknown): { code: string; message: string } {
	const message = error instanceof DaemonBrokerRejectedError ? error.message : String(error);
	const decoded = decodeDaemonWaitReject(message);
	return decoded ?? { code: "unexpected", message };
}

async function shutdown(client: DaemonBrokerClient, broker: Promise<void>, activeName: string): Promise<void> {
	await client.request({ op: "stop", name: activeName, timeoutMs: 2_000 }).catch(() => undefined);
	await client.request({ op: "shutdown" }).catch(() => undefined);
	client.close();
	await broker;
}

describe("daemon wait generation binding", () => {
	it("refuses an unbound wait immediately and leaves the ready daemon running", async () => {
		using tempDir = TempDir.createSync("@omp-wait-bind-");
		const projectDir = path.join(tempDir.path(), "project");
		const runtimeDir = path.join(tempDir.path(), "runtime");
		await fs.mkdir(projectDir);

		const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const previousTitle = process.title;
		const broker = startBroker(projectDir, runtimeDir);
		try {
			const started = await client.request({
				op: "start",
				spec: readySpec("shell", projectDir),
				owner: "session-a",
			});
			if (started.op !== "start") throw new Error("unexpected start result");

			const startedAt = Date.now();
			const error = await client.request({ op: "wait", name: "shell", for: "exit", timeoutMs: 60_000 }).then(
				() => null,
				(e: unknown) => e,
			);
			const elapsed = Date.now() - startedAt;

			expect(error).not.toBeNull();
			expect(rejectOf(error).code).toBe("missing-id");
			expect(elapsed).toBeLessThan(2_000);

			// The refused wait is a side-effect-free HOLD: the daemon survives.
			const listed = await client.request({ op: "list" });
			if (listed.op !== "list") throw new Error("unexpected list result");
			expect(listed.daemons.find(daemon => daemon.name === "shell")?.state).toBe("ready");
		} finally {
			await shutdown(client, broker, "shell");
			process.title = previousTitle;
		}
	}, 20_000);

	it("returns an already-ready daemon immediately when for is omitted", async () => {
		using tempDir = TempDir.createSync("@omp-wait-bind-");
		const projectDir = path.join(tempDir.path(), "project");
		const runtimeDir = path.join(tempDir.path(), "runtime");
		await fs.mkdir(projectDir);

		const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const previousTitle = process.title;
		const broker = startBroker(projectDir, runtimeDir);
		try {
			const started = await client.request({
				op: "start",
				spec: readySpec("shell", projectDir),
				owner: "session-a",
			});
			if (started.op !== "start") throw new Error("unexpected start result");

			// 60 s window: if the wait defaulted to exit, it would block and time
			// out; the auto condition must return the ready snapshot at once.
			const observed = await client.request({
				op: "wait",
				name: "shell",
				id: started.daemon.id,
				timeoutMs: 60_000,
			});
			if (observed.op !== "wait") throw new Error("unexpected wait result");
			expect(observed.timedOut).toBe(false);
			expect(observed.daemon.state).toBe("ready");
			expect(observed.daemon.id).toBe(started.daemon.id);
		} finally {
			await shutdown(client, broker, "shell");
			process.title = previousTitle;
		}
	}, 20_000);

	it("refuses a stale generation after restart and accepts the current one", async () => {
		using tempDir = TempDir.createSync("@omp-wait-bind-");
		const projectDir = path.join(tempDir.path(), "project");
		const runtimeDir = path.join(tempDir.path(), "runtime");
		await fs.mkdir(projectDir);

		const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const previousTitle = process.title;
		const broker = startBroker(projectDir, runtimeDir);
		try {
			const started = await client.request({
				op: "start",
				spec: readySpec("shell", projectDir),
				owner: "session-a",
			});
			if (started.op !== "start") throw new Error("unexpected start result");
			const oldId = started.daemon.id;

			const restarted = await client.request({ op: "restart", name: "shell" });
			if (restarted.op !== "restart") throw new Error("unexpected restart result");
			const newId = restarted.daemon.id;
			expect(newId).not.toBe(oldId);

			const staleError = await client.request({ op: "wait", name: "shell", id: oldId, timeoutMs: 60_000 }).then(
				() => null,
				(e: unknown) => e,
			);
			expect(staleError).not.toBeNull();
			expect(rejectOf(staleError).code).toBe("stale-id");
			expect(rejectOf(staleError).message).toContain(newId);

			const current = await client.request({
				op: "wait",
				name: "shell",
				id: newId,
				timeoutMs: 60_000,
			});
			if (current.op !== "wait") throw new Error("unexpected wait result");
			expect(current.timedOut).toBe(false);
			expect(current.daemon.state).toBe("ready");
		} finally {
			await shutdown(client, broker, "shell");
			process.title = previousTitle;
		}
	}, 20_000);

	it("refuses a wait from a non-owning session and accepts the owner", async () => {
		using tempDir = TempDir.createSync("@omp-wait-bind-");
		const projectDir = path.join(tempDir.path(), "project");
		const runtimeDir = path.join(tempDir.path(), "runtime");
		await fs.mkdir(projectDir);

		const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const previousTitle = process.title;
		const broker = startBroker(projectDir, runtimeDir);
		try {
			const started = await client.request({
				op: "start",
				spec: readySpec("shell", projectDir),
				owner: "session-a",
			});
			if (started.op !== "start") throw new Error("unexpected start result");

			const intruderError = await client
				.request({
					op: "wait",
					name: "shell",
					id: started.daemon.id,
					owner: "session-b",
					timeoutMs: 60_000,
				})
				.then(
					() => null,
					(e: unknown) => e,
				);
			expect(intruderError).not.toBeNull();
			expect(rejectOf(intruderError).code).toBe("wrong-owner");

			const ownerWait = await client.request({
				op: "wait",
				name: "shell",
				id: started.daemon.id,
				owner: "session-a",
				timeoutMs: 60_000,
			});
			if (ownerWait.op !== "wait") throw new Error("unexpected wait result");
			expect(ownerWait.timedOut).toBe(false);
			expect(ownerWait.daemon.state).toBe("ready");
		} finally {
			await shutdown(client, broker, "shell");
			process.title = previousTitle;
		}
	}, 20_000);

	it("waits for a one-shot exit when for is omitted", async () => {
		using tempDir = TempDir.createSync("@omp-wait-bind-");
		const projectDir = path.join(tempDir.path(), "project");
		const runtimeDir = path.join(tempDir.path(), "runtime");
		await fs.mkdir(projectDir);

		const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const previousTitle = process.title;
		const broker = startBroker(projectDir, runtimeDir);
		try {
			const started = await client.request({ op: "start", spec: oneShotSpec("tsc-api", projectDir) });
			if (started.op !== "start") throw new Error("unexpected start result");

			const startedAt = Date.now();
			const observed = await client.request({
				op: "wait",
				name: "tsc-api",
				id: started.daemon.id,
				timeoutMs: 5_000,
			});
			const elapsed = Date.now() - startedAt;
			if (observed.op !== "wait") throw new Error("unexpected wait result");

			expect(observed.timedOut).toBe(false);
			expect(observed.daemon.state).toBe("exited");
			expect(observed.daemon.exitCode).toBe(0);
			// It really waited for the process to exit rather than returning at once.
			expect(elapsed).toBeGreaterThanOrEqual(200);
		} finally {
			await shutdown(client, broker, "tsc-api");
			process.title = previousTitle;
		}
	}, 20_000);

	it("waits for an explicit for=exit even when the daemon is already ready", async () => {
		using tempDir = TempDir.createSync("@omp-wait-bind-");
		const projectDir = path.join(tempDir.path(), "project");
		const runtimeDir = path.join(tempDir.path(), "runtime");
		await fs.mkdir(projectDir);

		const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const previousTitle = process.title;
		const broker = startBroker(projectDir, runtimeDir);
		try {
			const started = await client.request({ op: "start", spec: readySpec("shell", projectDir) });
			if (started.op !== "start") throw new Error("unexpected start result");

			// The daemon is ready; an explicit exit wait must NOT return ready —
			// it blocks until the 1 s window elapses and reports timed out.
			const observed = await client.request({
				op: "wait",
				name: "shell",
				id: started.daemon.id,
				for: "exit",
				timeoutMs: 1_000,
			});
			if (observed.op !== "wait") throw new Error("unexpected wait result");
			expect(observed.timedOut).toBe(true);
			expect(observed.daemon.state).toBe("ready");
		} finally {
			await shutdown(client, broker, "shell");
			process.title = previousTitle;
		}
	}, 20_000);

	it("refuses an unknown daemon name immediately", async () => {
		using tempDir = TempDir.createSync("@omp-wait-bind-");
		const projectDir = path.join(tempDir.path(), "project");
		const runtimeDir = path.join(tempDir.path(), "runtime");
		await fs.mkdir(projectDir);

		const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const previousTitle = process.title;
		const broker = startBroker(projectDir, runtimeDir);
		try {
			const error = await client.request({ op: "wait", name: "tsc", id: "any-id", timeoutMs: 60_000 }).then(
				() => null,
				(e: unknown) => e,
			);
			expect(error).not.toBeNull();
			expect(rejectOf(error).code).toBe("missing-daemon");
		} finally {
			await shutdown(client, broker, "no-such-daemon");
			process.title = previousTitle;
		}
	}, 20_000);

	it("returns a settled daemon immediately instead of blocking", async () => {
		using tempDir = TempDir.createSync("@omp-wait-bind-");
		const projectDir = path.join(tempDir.path(), "project");
		const runtimeDir = path.join(tempDir.path(), "runtime");
		await fs.mkdir(projectDir);

		const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const previousTitle = process.title;
		const broker = startBroker(projectDir, runtimeDir);
		try {
			const started = await client.request({ op: "start", spec: oneShotSpec("settle", projectDir) });
			if (started.op !== "start") throw new Error("unexpected start result");
			const id = started.daemon.id;

			// First wait observes the exit…
			const first = await client.request({ op: "wait", name: "settle", id, timeoutMs: 5_000 });
			if (first.op !== "wait") throw new Error("unexpected wait result");
			expect(first.daemon.state).toBe("exited");

			// …and a second wait on the settled daemon returns at once, not a hang.
			const startedAt = Date.now();
			const second = await client.request({ op: "wait", name: "settle", id, timeoutMs: 60_000 });
			const elapsed = Date.now() - startedAt;
			if (second.op !== "wait") throw new Error("unexpected wait result");
			expect(second.timedOut).toBe(false);
			expect(second.daemon.state).toBe("exited");
			expect(elapsed).toBeLessThan(2_000);
		} finally {
			await shutdown(client, broker, "settle");
			process.title = previousTitle;
		}
	}, 20_000);

	it("refuses an in-flight exit wait when its bound generation enters restart", async () => {
		using tempDir = TempDir.createSync("@omp-wait-bind-");
		const projectDir = path.join(tempDir.path(), "project");
		const runtimeDir = path.join(tempDir.path(), "runtime");
		await fs.mkdir(projectDir);

		const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const previousTitle = process.title;
		const broker = startBroker(projectDir, runtimeDir);
		try {
			const started = await client.request({
				op: "start",
				spec: restartingReadySpec("proxy", projectDir),
				owner: "session-a",
			});
			if (started.op !== "start") throw new Error("unexpected start result");
			const boundId = started.daemon.id;

			// The bound generation exits ~350 ms later and the restart policy
			// re-launches it: the wait must refuse at that rotation instead of
			// spanning generations against the replacement process. Real child
			// exit + real socket round-trip — fake timers cannot drive them.
			const startedAt = Date.now();
			const error = await client
				.request({ op: "wait", name: "proxy", id: boundId, for: "exit", timeoutMs: 30_000 })
				.then(
					() => null,
					(e: unknown) => e,
				);
			const elapsed = Date.now() - startedAt;

			expect(error).not.toBeNull();
			expect(rejectOf(error).code).toBe("stale-id");
			// The refusal is the rotation, not the 30 s wait window.
			expect(elapsed).toBeLessThan(15_000);
		} finally {
			await shutdown(client, broker, "proxy");
			process.title = previousTitle;
		}
	}, 20_000);

	it("refuses an in-flight ready wait when its bound generation restarts instead of accepting the replacement", async () => {
		using tempDir = TempDir.createSync("@omp-wait-bind-");
		const projectDir = path.join(tempDir.path(), "project");
		const runtimeDir = path.join(tempDir.path(), "runtime");
		await fs.mkdir(projectDir);
		const markerPath = path.join(projectDir, "marker.txt");

		const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const previousTitle = process.title;
		const broker = startBroker(projectDir, runtimeDir);
		try {
			// Generation 1 never reaches readiness and exits; generation 2
			// (marker armed) becomes ready — the unbound-poller bug let the wait
			// succeed on the replacement's readiness and return its id.
			const startPending = client.request({
				op: "start",
				// The first generation must still be alive when the wait binds, so
				// the describe below races against its 600 ms exit.
				spec: markerDaemonSpec("gate", projectDir, markerPath, "READY\n", 600),
			});
			await Bun.sleep(100);
			const described = await client.request({ op: "describe", name: "gate" });
			if (described.op !== "describe") throw new Error("unexpected describe result");
			const boundId = described.daemon.id;

			const startedAt = Date.now();
			const waitPending = client
				.request({ op: "wait", name: "gate", id: boundId, for: "ready", timeoutMs: 10_000 })
				.then(
					() => null,
					(e: unknown) => e,
				);
			await Bun.write(markerPath, "ok\n");

			const error = await waitPending;
			const elapsed = Date.now() - startedAt;
			const started = await startPending;
			if (started.op !== "start") throw new Error("unexpected start result");

			// The bound generation really died and was replaced...
			expect(started.daemon.id).not.toBe(boundId);
			// ...and the wait refused at that rotation instead of accepting the
			// replacement generation's readiness.
			expect(error).not.toBeNull();
			expect(rejectOf(error).code).toBe("stale-id");
			expect(elapsed).toBeLessThan(5_000);
		} finally {
			await shutdown(client, broker, "gate");
			process.title = previousTitle;
		}
	}, 20_000);

	it("refuses an in-flight pattern wait when its bound generation restarts instead of matching the replacement's output", async () => {
		using tempDir = TempDir.createSync("@omp-wait-bind-");
		const projectDir = path.join(tempDir.path(), "project");
		const runtimeDir = path.join(tempDir.path(), "runtime");
		await fs.mkdir(projectDir);
		const markerPath = path.join(projectDir, "marker.txt");

		const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const previousTitle = process.title;
		const broker = startBroker(projectDir, runtimeDir);
		try {
			// Generation 1 prints READY and exits; generation 2 (marker armed)
			// prints the awaited VERSION 2 — the unbound-poller bug matched the
			// replacement's output and returned its id.
			const started = await client.request({
				op: "start",
				// The first generation prints READY (so `start` returns its id
				// quickly) but never the awaited pattern, then exits; the marker
				// makes the replacement print VERSION 2.
				spec: markerDaemonSpec("versioned", projectDir, markerPath, "VERSION 2\n", 400, "READY\n"),
			});
			if (started.op !== "start") throw new Error("unexpected start result");
			const boundId = started.daemon.id;

			const startedAt = Date.now();
			const waitPending = client
				.request({ op: "wait", name: "versioned", id: boundId, pattern: "VERSION 2", timeoutMs: 10_000 })
				.then(
					() => null,
					(e: unknown) => e,
				);
			await Bun.write(markerPath, "ok\n");

			const error = await waitPending;
			const elapsed = Date.now() - startedAt;

			expect(error).not.toBeNull();
			expect(rejectOf(error).code).toBe("stale-id");
			// The refusal happened at the rotation — before the replacement
			// generation could print the pattern it was waiting for.
			expect(elapsed).toBeLessThan(5_000);

			// Integrity: the restart really happened and rotated the id, so the
			// test would catch the old bug of matching the later generation.
			let rotated: DaemonSnapshot | undefined;
			const deadline = Date.now() + 5_000;
			while (Date.now() < deadline) {
				const listed = await client.request({ op: "list" });
				if (listed.op === "list") {
					const current = listed.daemons.find(daemon => daemon.name === "versioned");
					if (current && current.id !== boundId) {
						rotated = current;
						break;
					}
				}
				await Bun.sleep(100);
			}
			expect(rotated?.id).toBeDefined();
			expect(rotated?.id).not.toBe(boundId);
		} finally {
			await shutdown(client, broker, "versioned");
			process.title = previousTitle;
		}
	}, 20_000);

	it("negotiates the current protocol version with a real broker", async () => {
		using tempDir = TempDir.createSync("@omp-wait-bind-");
		const projectDir = path.join(tempDir.path(), "project");
		const runtimeDir = path.join(tempDir.path(), "runtime");
		await fs.mkdir(projectDir);

		const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const previousTitle = process.title;
		const broker = startBroker(projectDir, runtimeDir);
		try {
			const ping = await client.request({ op: "ping" });
			if (ping.op !== "ping") throw new Error("unexpected ping result");
			// The client handshake ran before the request; the broker announces
			// the protocol version the wait binding gate keys on.
			expect(ping.protocolVersion).toBe(DAEMON_PROTOCOL_VERSION);
		} finally {
			await client.request({ op: "shutdown" }).catch(() => undefined);
			client.close();
			await broker;
			process.title = previousTitle;
		}
	}, 20_000);
});
