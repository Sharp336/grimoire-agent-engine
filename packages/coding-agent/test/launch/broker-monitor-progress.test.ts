// Integration test — real timers are required because this drives the actual broker and child process.
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { setProcessName, TempDir } from "@oh-my-pi/pi-utils";
import { type DaemonBrokerStartOptions, startDaemonBrokerFromEnvironment } from "../../src/launch/broker";
import { createDaemonBrokerClient } from "../../src/launch/client";
import {
	DAEMON_IDLE_GRACE_ENV,
	DAEMON_OUTPUT_MONITOR_CAPABILITY,
	DAEMON_PROJECT_DIR_ENV,
	DAEMON_RUNTIME_DIR_ENV,
	type DaemonMonitorNotification,
	type DaemonSpec,
} from "../../src/launch/protocol";

function restoreEnv(name: string, value: string | undefined): void {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}

function startBroker(projectDir: string, runtimeDir: string, options: DaemonBrokerStartOptions = {}): Promise<void> {
	const previousProjectDir = process.env[DAEMON_PROJECT_DIR_ENV];
	const previousRuntimeDir = process.env[DAEMON_RUNTIME_DIR_ENV];
	const previousGrace = process.env[DAEMON_IDLE_GRACE_ENV];
	process.env[DAEMON_PROJECT_DIR_ENV] = projectDir;
	process.env[DAEMON_RUNTIME_DIR_ENV] = runtimeDir;
	process.env[DAEMON_IDLE_GRACE_ENV] = "5000";
	const broker = startDaemonBrokerFromEnvironment(options);
	restoreEnv(DAEMON_PROJECT_DIR_ENV, previousProjectDir);
	restoreEnv(DAEMON_RUNTIME_DIR_ENV, previousRuntimeDir);
	restoreEnv(DAEMON_IDLE_GRACE_ENV, previousGrace);
	return broker;
}

async function waitForOutputCount(notifications: DaemonMonitorNotification[], count: number): Promise<void> {
	const deadline = Date.now() + 5_000;
	while (Date.now() < deadline) {
		if (notifications.filter(notification => notification.event === "daemon-output").length >= count) return;
		await Bun.sleep(10);
	}
	throw new Error(`Expected ${count} output notifications`);
}

describe("daemon broker live output monitoring", () => {
	it("captures immediate output, joins fragmented lines, flushes the final partial, then reports terminal state", async () => {
		using tempDir = TempDir.createSync("@omp-launch-monitor-");
		const projectDir = path.join(tempDir.path(), "project");
		const runtimeDir = path.join(tempDir.path(), "runtime");
		await fs.mkdir(projectDir);
		const scriptPath = path.join(projectDir, "service.ts");
		const monitorArtifactPath = path.join(tempDir.path(), "watched-progress.log");
		await Bun.write(
			scriptPath,
			`process.stdin.setEncoding("utf8");
process.stdin.resume();
process.stdout.write("IMMEDIATE\\n");
process.stdin.once("data", () => {
	process.stdout.write("par");
	process.stdout.write("tial\\n\\n");
	process.stdout.write("H".repeat(300) + "M".repeat(400) + "T".repeat(300) + "\\n");
	process.stdout.write("final");
	process.exit(0);
});
`,
		);

		const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const previousTitle = process.title;
		const broker = startBroker(projectDir, runtimeDir);

		const notifications: DaemonMonitorNotification[] = [];
		const completed = Promise.withResolvers<void>();
		const firstEntered = Promise.withResolvers<void>();
		const releaseFirst = Promise.withResolvers<void>();
		const entered: string[] = [];
		const unregister = client.onOutput?.(
			{ id: "monitor-1", name: "watched", owner: "owner-1", artifactPath: monitorArtifactPath },
			async notification => {
				entered.push(
					notification.event === "daemon-output"
						? `${notification.event}:${notification.seq}`
						: notification.event,
				);
				if (notification.event === "daemon-output" && notification.seq === 1) {
					firstEntered.resolve();
					await releaseFirst.promise;
				}
				notifications.push(notification);
				if (notification.event === "daemon-monitor-completed") completed.resolve();
			},
		);
		if (!unregister) throw new Error("Expected output monitoring support");

		try {
			// This ping publishes the subscription before start, closing the immediate-output race.
			const ping = await client.request({ op: "ping" });
			if (ping.op !== "ping") throw new Error("unexpected ping result");
			expect(ping.capabilities).toContain(DAEMON_OUTPUT_MONITOR_CAPABILITY);
			const started = await client.request({
				op: "start",
				owner: "owner-1",
				spec: {
					name: "watched",
					application: process.execPath,
					args: [scriptPath],
					env: {},
					cwd: projectDir,
					pty: false,
					restart: "no",
					persist: false,
					detached: false,
				},
			});
			if (started.op !== "start") throw new Error("unexpected start result");
			await firstEntered.promise;
			await client.request({ op: "send", name: "watched", data: "finish\n" });
			await client.request({ op: "wait", name: "watched", for: "exit", timeoutMs: 5_000 });
			await Bun.sleep(10);
			expect(entered).toEqual(["daemon-output:1"]);
			releaseFirst.resolve();
			await completed.promise;

			const output = notifications.filter(
				(notification): notification is Extract<DaemonMonitorNotification, { event: "daemon-output" }> =>
					notification.event === "daemon-output",
			);
			expect(output.map(notification => notification.text)).toEqual([
				"IMMEDIATE",
				`partial\n${"H".repeat(250)}${"T".repeat(250)}\nfinal`,
			]);
			expect(await Bun.file(monitorArtifactPath).text()).toBe(
				`IMMEDIATE\npartial\n\n${"H".repeat(300)}${"M".repeat(400)}${"T".repeat(300)}\nfinal`,
			);
			expect(output.map(notification => notification.truncated)).toEqual([false, true]);
			expect(output.map(notification => notification.seq)).toEqual([1, 2]);
			expect(notifications.at(-1)).toMatchObject({
				event: "daemon-monitor-completed",
				daemon: { name: "watched", state: "exited", exitCode: 0 },
			});
			expect(entered).toEqual(["daemon-output:1", "daemon-output:2", "daemon-monitor-completed"]);
		} finally {
			releaseFirst.resolve();
			unregister();
			await client.request({ op: "stop", name: "watched", timeoutMs: 2_000 }).catch(() => undefined);
			await client.request({ op: "shutdown" }).catch(() => undefined);
			client.close();
			await broker;
			setProcessName(previousTitle);
		}
	}, 20_000);

	it("starts an attached monitor at the current output boundary", async () => {
		using tempDir = TempDir.createSync("@omp-launch-monitor-attach-");
		const projectDir = path.join(tempDir.path(), "project");
		const runtimeDir = path.join(tempDir.path(), "runtime");
		await fs.mkdir(projectDir);
		const scriptPath = path.join(projectDir, "service.ts");
		await Bun.write(
			scriptPath,
			`process.stdin.setEncoding("utf8");
process.stdin.resume();
process.stdout.write("BEFORE_ATTACH\\n");
process.stdin.once("data", () => {
	process.stdout.write("AFTER_ATTACH\\n");
	process.exit(0);
});
`,
		);
		const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const previousTitle = process.title;
		const broker = startBroker(projectDir, runtimeDir);
		const notifications: DaemonMonitorNotification[] = [];
		const completed = Promise.withResolvers<void>();
		let unregister: (() => void) | undefined;
		try {
			const started = await client.request({
				op: "start",
				spec: {
					name: "attach",
					application: process.execPath,
					args: [scriptPath],
					env: {},
					cwd: projectDir,
					pty: false,
					restart: "no",
					persist: false,
					detached: false,
				},
			});
			if (started.op !== "start") throw new Error("unexpected start result");
			await client.request({
				op: "logs",
				name: "attach",
				lines: 20,
				head: false,
				follow: true,
				cursor: 0,
				timeoutMs: 5_000,
			});
			unregister = client.onOutput?.(
				{
					id: "attach-monitor",
					name: "attach",
					owner: "owner",
					artifactPath: path.join(tempDir.path(), "attach-progress.log"),
				},
				notification => {
					notifications.push(notification);
					if (notification.event === "daemon-monitor-completed") completed.resolve();
				},
			);
			if (!unregister) throw new Error("Expected output monitoring support");
			await client.request({ op: "ping" });
			await client.request({ op: "send", name: "attach", data: "finish\n" });
			await completed.promise;

			const output = notifications.filter(notification => notification.event === "daemon-output");
			expect(output.map(notification => notification.text)).toEqual(["AFTER_ATTACH"]);
		} finally {
			unregister?.();
			await client.request({ op: "stop", name: "attach", timeoutMs: 2_000 }).catch(() => undefined);
			await client.request({ op: "shutdown" }).catch(() => undefined);
			client.close();
			await broker;
			setProcessName(previousTitle);
		}
	}, 20_000);

	it("does not deliver a replaced subscription's pending preview to the new client", async () => {
		using tempDir = TempDir.createSync("@omp-launch-monitor-replace-");
		const projectDir = path.join(tempDir.path(), "project");
		const runtimeDir = path.join(tempDir.path(), "runtime");
		await fs.mkdir(projectDir);
		const scriptPath = path.join(projectDir, "service.ts");
		await Bun.write(
			scriptPath,
			`process.stdin.setEncoding("utf8");
process.stdin.resume();
process.stdin.on("data", chunk => process.stdout.write(chunk));
`,
		);
		const firstArtifactPath = path.join(tempDir.path(), "first-progress.log");
		const secondArtifactPath = path.join(tempDir.path(), "second-progress.log");
		const firstClient = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const secondClient = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const previousTitle = process.title;
		const broker = startBroker(projectDir, runtimeDir, { progressBatchIntervalMs: 5_000 });
		const firstNotifications: DaemonMonitorNotification[] = [];
		const secondNotifications: DaemonMonitorNotification[] = [];
		const completed = Promise.withResolvers<void>();
		const firstUnregister = firstClient.onOutput?.(
			{
				id: "shared-monitor",
				name: "replace",
				owner: "first-owner",
				artifactPath: firstArtifactPath,
			},
			notification => {
				firstNotifications.push(notification);
			},
		);
		if (!firstUnregister) throw new Error("Expected output monitoring support");
		let secondUnregister: (() => void) | undefined;
		try {
			await firstClient.request({ op: "ping" });
			await firstClient.request({
				op: "start",
				spec: {
					name: "replace",
					application: process.execPath,
					args: [scriptPath],
					env: {},
					cwd: projectDir,
					pty: false,
					restart: "no",
					persist: false,
					detached: false,
				},
			});
			await firstClient.request({ op: "send", name: "replace", data: "OLD_SUBSCRIPTION\n" });
			await firstClient.request({
				op: "logs",
				name: "replace",
				lines: 20,
				head: false,
				follow: true,
				cursor: 0,
				timeoutMs: 5_000,
			});
			expect(firstNotifications).toEqual([]);

			secondUnregister = secondClient.onOutput?.(
				{
					id: "shared-monitor",
					name: "replace",
					owner: "second-owner",
					artifactPath: secondArtifactPath,
				},
				notification => {
					secondNotifications.push(notification);
					if (notification.event === "daemon-monitor-completed") completed.resolve();
				},
			);
			if (!secondUnregister) throw new Error("Expected output monitoring support");
			await secondClient.request({ op: "ping" });
			await secondClient.request({ op: "send", name: "replace", data: "NEW_SUBSCRIPTION\n" });
			const observed = await secondClient.request({
				op: "wait",
				name: "replace",
				for: "exit",
				pattern: "NEW_SUBSCRIPTION",
				timeoutMs: 5_000,
			});
			if (observed.op !== "wait") throw new Error("unexpected wait result");
			expect(observed.timedOut).toBeFalse();
			await secondClient.request({ op: "stop", name: "replace", timeoutMs: 2_000 });
			await completed.promise;

			const output = secondNotifications.filter(notification => notification.event === "daemon-output");
			expect(output.map(notification => notification.text)).toEqual(["NEW_SUBSCRIPTION"]);
			expect(output.map(notification => notification.seq)).toEqual([1]);
			expect(await Bun.file(firstArtifactPath).text()).toBe("OLD_SUBSCRIPTION\n");
			expect(await Bun.file(secondArtifactPath).text()).toBe("NEW_SUBSCRIPTION\n");
		} finally {
			firstUnregister();
			secondUnregister?.();
			await secondClient.request({ op: "stop", name: "replace", timeoutMs: 2_000 }).catch(() => undefined);
			await secondClient.request({ op: "shutdown" }).catch(() => undefined);
			firstClient.close();
			secondClient.close();
			await broker;
			setProcessName(previousTitle);
		}
	}, 20_000);

	it("treats a re-registered subscription id with new metadata as a replacement", async () => {
		using tempDir = TempDir.createSync("@omp-launch-monitor-rebind-");
		const projectDir = path.join(tempDir.path(), "project");
		const runtimeDir = path.join(tempDir.path(), "runtime");
		await fs.mkdir(projectDir);
		const scriptPath = path.join(projectDir, "service.ts");
		await Bun.write(
			scriptPath,
			`process.stdin.setEncoding("utf8");
process.stdin.resume();
process.stdin.on("data", chunk => process.stdout.write(chunk));
`,
		);
		const oldArtifactPath = path.join(tempDir.path(), "old-progress.log");
		const newArtifactPath = path.join(tempDir.path(), "new-progress.log");
		const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const previousTitle = process.title;
		const broker = startBroker(projectDir, runtimeDir, { progressBatchIntervalMs: 5_000 });
		const oldNotifications: DaemonMonitorNotification[] = [];
		const newNotifications: DaemonMonitorNotification[] = [];
		const completed = Promise.withResolvers<void>();
		const oldUnregister = client.onOutput?.(
			{ id: "rebound-monitor", name: "old", owner: "owner-1", artifactPath: oldArtifactPath },
			notification => {
				oldNotifications.push(notification);
			},
		);
		if (!oldUnregister) throw new Error("Expected output monitoring support");
		let newUnregister: (() => void) | undefined;
		const spec = (name: string): DaemonSpec => ({
			name,
			application: process.execPath,
			args: [scriptPath],
			env: {},
			cwd: projectDir,
			pty: false,
			restart: "no",
			persist: false,
			detached: false,
		});
		try {
			await client.request({ op: "ping" });
			await client.request({ op: "start", spec: spec("old") });
			await client.request({ op: "send", name: "old", data: "OLD_OUTPUT\n" });
			const oldObserved = await client.request({
				op: "wait",
				name: "old",
				for: "exit",
				pattern: "OLD_OUTPUT",
				timeoutMs: 5_000,
			});
			if (oldObserved.op !== "wait") throw new Error("unexpected wait result");
			expect(oldObserved.timedOut).toBeFalse();
			expect(oldNotifications).toEqual([]);

			// Re-register the same subscription id against a different daemon and
			// artifact path without unregistering first: the broker must replace the
			// registration instead of mutating it in place.
			newUnregister = client.onOutput?.(
				{ id: "rebound-monitor", name: "new", owner: "owner-1", artifactPath: newArtifactPath },
				notification => {
					newNotifications.push(notification);
					if (notification.event === "daemon-monitor-completed") completed.resolve();
				},
			);
			if (!newUnregister) throw new Error("Expected output monitoring support");
			await client.request({ op: "ping" });
			await client.request({ op: "start", spec: spec("new") });
			await client.request({ op: "send", name: "new", data: "NEW_OUTPUT\n" });
			const newObserved = await client.request({
				op: "wait",
				name: "new",
				for: "exit",
				pattern: "NEW_OUTPUT",
				timeoutMs: 5_000,
			});
			if (newObserved.op !== "wait") throw new Error("unexpected wait result");
			expect(newObserved.timedOut).toBeFalse();
			await client.request({ op: "stop", name: "new", timeoutMs: 2_000 });
			await completed.promise;

			const output = newNotifications.filter(notification => notification.event === "daemon-output");
			expect(output.map(notification => notification.text)).toEqual(["NEW_OUTPUT"]);
			expect(await Bun.file(oldArtifactPath).text()).toBe("OLD_OUTPUT\n");
			expect(await Bun.file(newArtifactPath).text()).toBe("NEW_OUTPUT\n");
		} finally {
			oldUnregister();
			newUnregister?.();
			await client.request({ op: "stop", name: "old", timeoutMs: 2_000 }).catch(() => undefined);
			await client.request({ op: "stop", name: "new", timeoutMs: 2_000 }).catch(() => undefined);
			await client.request({ op: "shutdown" }).catch(() => undefined);
			client.close();
			await broker;
			setProcessName(previousTitle);
		}
	}, 20_000);

	it("keeps a mid-line attach preview aligned with the monitor's own artifact", async () => {
		using tempDir = TempDir.createSync("@omp-launch-monitor-midline-");
		const projectDir = path.join(tempDir.path(), "project");
		const runtimeDir = path.join(tempDir.path(), "runtime");
		await fs.mkdir(projectDir);
		const scriptPath = path.join(projectDir, "service.ts");
		await Bun.write(
			scriptPath,
			`process.stdin.setEncoding("utf8");
process.stdin.resume();
process.stdout.write("abc");
process.stdin.once("data", () => {
	process.stdout.write("def\\n");
	process.exit(0);
});
`,
		);
		const artifactPath = path.join(tempDir.path(), "midline-progress.log");
		const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const previousTitle = process.title;
		const broker = startBroker(projectDir, runtimeDir);
		const notifications: DaemonMonitorNotification[] = [];
		const completed = Promise.withResolvers<void>();
		let unregister: (() => void) | undefined;
		try {
			const started = await client.request({
				op: "start",
				spec: {
					name: "midline",
					application: process.execPath,
					args: [scriptPath],
					env: {},
					cwd: projectDir,
					pty: false,
					restart: "no",
					persist: false,
					detached: false,
				},
			});
			if (started.op !== "start") throw new Error("unexpected start result");
			// Ensure the unterminated "abc" prefix was consumed before the monitor attaches.
			await client.request({
				op: "logs",
				name: "midline",
				lines: 20,
				head: false,
				follow: true,
				cursor: 0,
				timeoutMs: 5_000,
			});
			unregister = client.onOutput?.(
				{ id: "midline-monitor", name: "midline", owner: "owner", artifactPath },
				notification => {
					notifications.push(notification);
					if (notification.event === "daemon-monitor-completed") completed.resolve();
				},
			);
			if (!unregister) throw new Error("Expected output monitoring support");
			await client.request({ op: "ping" });
			await client.request({ op: "send", name: "midline", data: "finish\n" });
			await completed.promise;

			const output = notifications.filter(notification => notification.event === "daemon-output");
			// The pre-attach "abc" prefix belongs to the record, not this monitor:
			// its preview and artifact must share the same attach boundary.
			expect(output.map(notification => notification.text)).toEqual(["def"]);
			expect(await Bun.file(artifactPath).text()).toBe("def\n");
		} finally {
			unregister?.();
			await client.request({ op: "stop", name: "midline", timeoutMs: 2_000 }).catch(() => undefined);
			await client.request({ op: "shutdown" }).catch(() => undefined);
			client.close();
			await broker;
			setProcessName(previousTitle);
		}
	}, 20_000);

	it("bounds socket previews while preserving the complete broker-written artifact", async () => {
		using tempDir = TempDir.createSync("@omp-launch-monitor-preview-");
		const projectDir = path.join(tempDir.path(), "project");
		const runtimeDir = path.join(tempDir.path(), "runtime");
		const artifactPath = path.join(tempDir.path(), "complete-progress.log");
		await fs.mkdir(projectDir);
		const scriptPath = path.join(projectDir, "service.ts");
		await Bun.write(
			scriptPath,
			`for (let index = 0; index < 20; index++) process.stdout.write(\`LINE\${String(index).padStart(2, "0")}:\${"x".repeat(400)}\\n\`);\n`,
		);
		const expected = Array.from(
			{ length: 20 },
			(_, index) => `LINE${String(index).padStart(2, "0")}:${"x".repeat(400)}\n`,
		).join("");
		const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const previousTitle = process.title;
		const broker = startBroker(projectDir, runtimeDir);
		const notifications: DaemonMonitorNotification[] = [];
		const completed = Promise.withResolvers<void>();
		const unregister = client.onOutput?.(
			{ id: "bounded-monitor", name: "bounded", owner: "owner", artifactPath },
			notification => {
				notifications.push(notification);
				if (notification.event === "daemon-monitor-completed") completed.resolve();
			},
		);
		if (!unregister) throw new Error("Expected output monitoring support");
		try {
			await client.request({ op: "ping" });
			await client.request({
				op: "start",
				spec: {
					name: "bounded",
					application: process.execPath,
					args: [scriptPath],
					env: {},
					cwd: projectDir,
					pty: false,
					restart: "no",
					persist: false,
					detached: false,
				},
			});
			await completed.promise;

			const output = notifications.filter(
				(notification): notification is Extract<DaemonMonitorNotification, { event: "daemon-output" }> =>
					notification.event === "daemon-output",
			);
			expect(output).toHaveLength(1);
			expect(Buffer.byteLength(output[0]?.text ?? "", "utf8")).toBeLessThanOrEqual(3_000);
			expect(output[0]).toMatchObject({ truncated: true });
			expect(output[0]?.text).toStartWith("LINE00:");
			expect(output[0]?.text).toEndWith(`LINE19:${"x".repeat(400)}`);
			expect(await Bun.file(artifactPath).text()).toBe(expected);
		} finally {
			unregister();
			await client.request({ op: "stop", name: "bounded", timeoutMs: 2_000 }).catch(() => undefined);
			await client.request({ op: "shutdown" }).catch(() => undefined);
			client.close();
			await broker;
			setProcessName(previousTitle);
		}
	}, 20_000);

	it("keeps one monitor across an explicit process restart", async () => {
		using tempDir = TempDir.createSync("@omp-launch-monitor-restart-");
		const projectDir = path.join(tempDir.path(), "project");
		const runtimeDir = path.join(tempDir.path(), "runtime");
		await fs.mkdir(projectDir);
		const scriptPath = path.join(projectDir, "service.ts");
		await Bun.write(
			scriptPath,
			`process.stdin.setEncoding("utf8");
process.stdin.resume();
process.stdout.write("GENERATION_STARTED\\n");
`,
		);
		const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const previousTitle = process.title;
		const broker = startBroker(projectDir, runtimeDir);
		const notifications: DaemonMonitorNotification[] = [];
		const completed = Promise.withResolvers<void>();
		const unregister = client.onOutput?.(
			{
				id: "restart-monitor",
				name: "restart",
				owner: "owner",
				artifactPath: path.join(tempDir.path(), "restart-progress.log"),
			},
			notification => {
				notifications.push(notification);
				if (notification.event === "daemon-monitor-completed") completed.resolve();
			},
		);
		if (!unregister) throw new Error("Expected output monitoring support");
		try {
			await client.request({ op: "ping" });
			const started = await client.request({
				op: "start",
				spec: {
					name: "restart",
					application: process.execPath,
					args: [scriptPath],
					env: {},
					cwd: projectDir,
					pty: false,
					restart: "no",
					persist: false,
					detached: false,
				},
			});
			if (started.op !== "start") throw new Error("unexpected start result");
			await waitForOutputCount(notifications, 1);
			await client.request({ op: "restart", name: "restart" });
			await waitForOutputCount(notifications, 2);
			expect(notifications.some(notification => notification.event === "daemon-monitor-completed")).toBe(false);

			await client.request({ op: "stop", name: "restart", timeoutMs: 2_000 });
			await completed.promise;
			const output = notifications.filter(notification => notification.event === "daemon-output");
			expect(output.map(notification => notification.text)).toEqual(["GENERATION_STARTED", "GENERATION_STARTED"]);
			expect(output.map(notification => notification.seq)).toEqual([1, 2]);
			expect(notifications.at(-1)?.event).toBe("daemon-monitor-completed");
		} finally {
			unregister();
			await client.request({ op: "stop", name: "restart", timeoutMs: 2_000 }).catch(() => undefined);
			await client.request({ op: "shutdown" }).catch(() => undefined);
			client.close();
			await broker;
			setProcessName(previousTitle);
		}
	}, 20_000);

	it("settles a monitor once when an explicit restart cannot relaunch", async () => {
		using tempDir = TempDir.createSync("@omp-launch-monitor-restart-failure-");
		const projectDir = path.join(tempDir.path(), "project");
		const serviceDir = path.join(projectDir, "service");
		const runtimeDir = path.join(tempDir.path(), "runtime");
		const scriptPath = path.join(tempDir.path(), "service.ts");
		const artifactPath = path.join(tempDir.path(), "restart-failure-progress.log");
		await fs.mkdir(serviceDir, { recursive: true });
		await Bun.write(
			scriptPath,
			`process.stdin.setEncoding("utf8");
process.stdin.resume();
process.stdout.write("GENERATION_STARTED\\n");
`,
		);
		const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const previousTitle = process.title;
		const broker = startBroker(projectDir, runtimeDir);
		const notifications: DaemonMonitorNotification[] = [];
		const completed = Promise.withResolvers<void>();
		const unregister = client.onOutput?.(
			{ id: "failed-restart-monitor", name: "failed-restart", owner: "owner", artifactPath },
			notification => {
				notifications.push(notification);
				if (notification.event === "daemon-monitor-completed") completed.resolve();
			},
		);
		if (!unregister) throw new Error("Expected output monitoring support");
		try {
			await client.request({ op: "ping" });
			const started = await client.request({
				op: "start",
				spec: {
					name: "failed-restart",
					application: process.execPath,
					args: [scriptPath],
					env: {},
					cwd: serviceDir,
					pty: false,
					restart: "no",
					persist: false,
					detached: false,
				},
			});
			if (started.op !== "start") throw new Error("unexpected start result");
			await waitForOutputCount(notifications, 1);

			await fs.rm(serviceDir, { recursive: true });
			const restarted = await client.request({ op: "restart", name: "failed-restart" });
			if (restarted.op !== "restart") throw new Error("unexpected restart result");
			expect(restarted.daemon.state).toBe("failed");
			await completed.promise;
			await client.request({ op: "ping" });

			const terminal = notifications.filter(notification => notification.event === "daemon-monitor-completed");
			expect(terminal).toHaveLength(1);
			expect(terminal[0]?.daemon.state).toBe("failed");
			expect(await Bun.file(artifactPath).text()).toBe("GENERATION_STARTED\n");
		} finally {
			unregister();
			await client.request({ op: "stop", name: "failed-restart", timeoutMs: 2_000 }).catch(() => undefined);
			await client.request({ op: "shutdown" }).catch(() => undefined);
			client.close();
			await broker;
			setProcessName(previousTitle);
		}
	}, 20_000);
});
