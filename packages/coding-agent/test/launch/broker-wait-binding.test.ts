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

	it("aborting an in-flight bound wait never kills the daemon", async () => {
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

			const controller = new AbortController();
			const pending = client.request(
				{
					op: "wait",
					name: "shell",
					id: started.daemon.id,
					for: "exit",
					timeoutMs: 30_000,
				},
				controller.signal,
			);
			setTimeout(() => controller.abort(), 150);
			await expect(pending).rejects.toThrow(/aborted/);

			// The abort interrupted only the wait: the daemon is still alive.
			const listed = await client.request({ op: "list" });
			if (listed.op !== "list") throw new Error("unexpected list result");
			const shell = listed.daemons.find(daemon => daemon.name === "shell") as DaemonSnapshot | undefined;
			expect(shell?.state).toBe("ready");
		} finally {
			await shutdown(client, broker, "shell");
			process.title = previousTitle;
		}
	}, 20_000);
});
