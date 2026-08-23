import { afterEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import type { DaemonBrokerClient } from "../../../src/launch/client";
import * as daemonClient from "../../../src/launch/client";
import type {
	DaemonCompletionNotification,
	DaemonMonitorNotification,
	DaemonOperation,
	DaemonOutputSubscription,
	DaemonRpcResult,
	DaemonSnapshot,
	DaemonSpec,
} from "../../../src/launch/protocol";
import { DAEMON_OUTPUT_MONITOR_CAPABILITY } from "../../../src/launch/protocol";
import type { ToolSession } from "../../../src/tools";
import { executeLaunch } from "../../../src/tools/hub/launch";

const OWNER = "owner-session";

const daemon: DaemonSnapshot = {
	name: "web",
	id: "daemon-id",
	state: "running",
	pid: 123,
	createdAt: 1,
	startedAt: 2,
	restartCount: 0,
	outputBytes: 0,
	owner: OWNER,
	persist: true,
	detached: false,
};

const spec: DaemonSpec = {
	name: daemon.name,
	application: process.execPath,
	args: [],
	env: {},
	cwd: process.cwd(),
	pty: false,
	restart: "no",
	persist: true,
	detached: false,
};

interface MonitorHarness {
	client: DaemonBrokerClient;
	session: ToolSession;
	requests: DaemonOperation[];
	progress: Array<{
		notification: Extract<DaemonMonitorNotification, { event: "daemon-output" }>;
		delivery: string;
		artifactId?: string;
	}>;
	completions: DaemonCompletionNotification[];
	active: Array<{ monitorId: string; delivery: string; active: boolean }>;
	disposeCallbacks: Array<() => void>;
	getOutputSink(): ((notification: DaemonMonitorNotification) => void | Promise<void>) | undefined;
	getSubscription(): DaemonOutputSubscription | undefined;
	unregisterCount(): number;
	registrationCount(): number;
}

function createHarness(
	artifact?: { id: string; path: string },
	outputReady: Promise<void> = Promise.resolve(),
): MonitorHarness {
	const allocatedArtifact =
		artifact ??
		({
			id: `hub-progress-${crypto.randomUUID()}`,
			path: path.join(process.cwd(), `.hub-progress-${crypto.randomUUID()}.log`),
		} satisfies { id: string; path: string });
	const requests: DaemonOperation[] = [];
	const progress: MonitorHarness["progress"] = [];
	const completions: DaemonCompletionNotification[] = [];
	const active: MonitorHarness["active"] = [];
	const disposeCallbacks: Array<() => void> = [];
	let outputSink: ((notification: DaemonMonitorNotification) => void | Promise<void>) | undefined;
	let subscription: DaemonOutputSubscription | undefined;
	let unregisters = 0;
	const registrations = new Set<string>();
	const client = {
		projectDir: process.cwd(),
		onCompletion: () => () => {},
		onOutput: (
			registered: DaemonOutputSubscription,
			sink: (notification: DaemonMonitorNotification) => void | Promise<void>,
		) => {
			subscription = registered;
			outputSink = sink;
			registrations.add(registered.id);
			const unregister = (): void => {
				unregisters++;
				registrations.delete(registered.id);
				if (outputSink === sink) outputSink = undefined;
			};
			return Object.assign(unregister, { ready: outputReady });
		},
		request: async (operation: DaemonOperation): Promise<DaemonRpcResult> => {
			requests.push(operation);
			if (operation.op === "ping") {
				return { op: "ping", projectDir: process.cwd(), capabilities: [DAEMON_OUTPUT_MONITOR_CAPABILITY] };
			}
			if (operation.op === "start") {
				// Starts subscribe before the launch so no early lines are missed.
				expect(subscription).toMatchObject({ name: daemon.name, owner: OWNER });
				return { op: "start", daemon, readyTimedOut: false };
			}
			if (operation.op === "describe") return { op: "describe", daemon, spec };
			throw new Error(`Unexpected operation: ${operation.op}`);
		},
		close() {},
	} as DaemonBrokerClient;
	const session = {
		cwd: process.cwd(),
		settings: { get: () => undefined },
		allocateOutputArtifact: async () => allocatedArtifact,
		getSessionId: () => OWNER,
		isDisposed: () => false,
		queueLaunchProgress: (
			notification: Extract<DaemonMonitorNotification, { event: "daemon-output" }>,
			delivery: string,
			_startedAt: number,
			artifactId?: string,
		) => {
			progress.push({ notification, delivery, artifactId });
		},
		queueLaunchCompletion: async (notification: DaemonCompletionNotification) => {
			completions.push(notification);
		},
		setLaunchMonitorActive: (monitorId: string, delivery: string, isActive: boolean) => {
			active.push({ monitorId, delivery, active: isActive });
		},
		registerDisposeCallback: (callback: () => void) => {
			disposeCallbacks.push(callback);
		},
		registerSessionChangeCallback: () => {},
	} as unknown as ToolSession;
	return {
		client,
		session,
		requests,
		progress,
		completions,
		active,
		disposeCallbacks,
		getOutputSink: () => outputSink,
		getSubscription: () => subscription,
		unregisterCount: () => unregisters,
		registrationCount: () => registrations.size,
	};
}

/** Settle the speculative-flush promise chain deterministically — microtasks only, no timers. */
async function drainMicrotasks(): Promise<void> {
	for (let i = 0; i < 16; i++) await Promise.resolve();
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("hub process output monitoring", () => {
	it("advertises the output subscription before starting and routes live output", async () => {
		const harness = createHarness();
		vi.spyOn(daemonClient, "daemonClientForProject").mockResolvedValue(harness.client);

		await executeLaunch(harness.session, {
			op: "start",
			name: daemon.name,
			application: process.execPath,
			pty: false,
			persist: true,
			progress: "wake",
		});

		expect(harness.requests.map(operation => operation.op)).toEqual(["ping", "start"]);
		const subscription = harness.getSubscription();
		if (!subscription) throw new Error("Expected output subscription");
		await harness.getOutputSink()?.({
			event: "daemon-output",
			monitorId: subscription.id,
			name: daemon.name,
			daemonId: daemon.id,
			seq: 1,
			text: "ready",
			batchKind: "progress",
			suppressedEvents: 0,
		});

		expect(harness.progress).toEqual([
			{
				notification: {
					event: "daemon-output",
					monitorId: subscription.id,
					name: daemon.name,
					daemonId: daemon.id,
					seq: 1,
					text: "ready",
					batchKind: "progress",
					suppressedEvents: 0,
				},
				delivery: "wake",
				artifactId: expect.stringContaining("hub-progress-"),
			},
		]);
		expect(harness.active).toEqual([{ monitorId: subscription.id, delivery: "wake", active: true }]);
	});

	it("validates a monitored start before advertising its subscription", async () => {
		const harness = createHarness();
		vi.spyOn(daemonClient, "daemonClientForProject").mockResolvedValue(harness.client);

		await expect(
			executeLaunch(harness.session, {
				op: "start",
				name: daemon.name,
				application: process.execPath,
				ready: { log: "(" },
				progress: "wake",
			}),
		).rejects.toThrow("Invalid readiness regex");

		expect(harness.requests).toEqual([]);
		expect(harness.getSubscription()).toBeUndefined();
		expect(harness.getOutputSink()).toBeUndefined();
		expect(harness.unregisterCount()).toBe(0);
		expect(harness.active).toEqual([]);
	});

	it("never replays output that predates a successful monitor attach", async () => {
		const harness = createHarness();
		vi.spyOn(daemonClient, "daemonClientForProject").mockResolvedValue(harness.client);
		const request = harness.client.request;
		vi.spyOn(harness.client, "request").mockImplementation(async operation => {
			// Output produced while the attach is still validating must never
			// reach the session: the sink may only exist after the describe
			// result confirms the attach.
			if (operation.op === "describe") expect(harness.getOutputSink()).toBeUndefined();
			return request(operation);
		});

		await executeLaunch(harness.session, { op: "monitor", name: daemon.name, progress: "wake" });

		expect(harness.progress).toHaveLength(0);
		expect(harness.getSubscription()).toMatchObject({ name: daemon.name, owner: OWNER });
		expect(harness.getOutputSink()).toBeDefined();
	});

	it("waits for broker publication before confirming an existing-process attach", async () => {
		const publication = Promise.withResolvers<void>();
		const harness = createHarness(undefined, publication.promise);
		vi.spyOn(daemonClient, "daemonClientForProject").mockResolvedValue(harness.client);
		let resolved = false;
		const attach = executeLaunch(harness.session, {
			op: "monitor",
			name: daemon.name,
			progress: "wake",
		}).then(result => {
			resolved = true;
			return result;
		});

		await drainMicrotasks();
		expect(harness.getSubscription()).toBeDefined();
		expect(resolved).toBeFalse();

		publication.resolve();
		await attach;
		const subscription = harness.getSubscription();
		if (!subscription) throw new Error("Expected output subscription");
		await harness.getOutputSink()?.({
			event: "daemon-output",
			monitorId: subscription.id,
			name: daemon.name,
			daemonId: daemon.id,
			seq: 1,
			text: "after attach",
			batchKind: "progress",
			suppressedEvents: 0,
		});

		expect(harness.progress.map(item => item.notification.text)).toEqual(["after attach"]);
	});

	it("attaches to an existing process and updates its delivery mode in place", async () => {
		const harness = createHarness();
		vi.spyOn(daemonClient, "daemonClientForProject").mockResolvedValue(harness.client);

		await executeLaunch(harness.session, { op: "monitor", name: daemon.name, progress: "wake" });
		const subscription = harness.getSubscription();
		if (!subscription) throw new Error("Expected output subscription");
		await executeLaunch(harness.session, { op: "monitor", name: daemon.name, progress: "ambient" });
		await harness.getOutputSink()?.({
			event: "daemon-output",
			monitorId: subscription.id,
			name: daemon.name,
			daemonId: daemon.id,
			seq: 1,
			text: "after mode update",
			batchKind: "progress",
			suppressedEvents: 0,
		});

		expect(harness.requests.map(operation => operation.op)).toEqual(["ping", "describe", "ping", "describe"]);
		expect(harness.getSubscription()?.id).toBe(subscription.id);
		expect(harness.unregisterCount()).toBe(0);
		expect(harness.progress.map(item => item.delivery)).toEqual(["ambient"]);
		expect(harness.active).toEqual([
			{ monitorId: subscription.id, delivery: "wake", active: true },
			{ monitorId: subscription.id, delivery: "wake", active: false },
			{ monitorId: subscription.id, delivery: "ambient", active: true },
		]);
	});

	it("detaches with progress off without stopping the process", async () => {
		const harness = createHarness();
		vi.spyOn(daemonClient, "daemonClientForProject").mockResolvedValue(harness.client);

		await executeLaunch(harness.session, { op: "monitor", name: daemon.name, progress: "wake" });
		const subscription = harness.getSubscription();
		if (!subscription) throw new Error("Expected output subscription");
		const detached = await executeLaunch(harness.session, { op: "monitor", name: daemon.name, progress: "off" });
		const alreadyDetached = await executeLaunch(harness.session, {
			op: "monitor",
			name: daemon.name,
			progress: "off",
		});

		expect(harness.unregisterCount()).toBe(1);
		expect(harness.requests.map(operation => operation.op)).toEqual(["ping", "describe", "describe", "describe"]);
		expect(harness.requests.some(operation => operation.op === "stop")).toBeFalse();
		expect(harness.active.at(-1)).toEqual({ monitorId: subscription.id, delivery: "wake", active: false });
		expect(detached.content).toEqual([
			expect.objectContaining({ type: "text", text: expect.stringContaining("Stopped monitoring web:") }),
		]);
		expect(alreadyDetached.content).toEqual([
			expect.objectContaining({ type: "text", text: expect.stringContaining("No active monitor for web:") }),
		]);
	});

	it("keeps monitoring attached when an off request fails validation", async () => {
		const harness = createHarness();
		vi.spyOn(daemonClient, "daemonClientForProject").mockResolvedValue(harness.client);

		await executeLaunch(harness.session, { op: "monitor", name: daemon.name, progress: "wake" });
		vi.spyOn(harness.client, "request").mockRejectedValue(new Error("broker unavailable"));
		await expect(
			executeLaunch(harness.session, { op: "monitor", name: daemon.name, progress: "off" }),
		).rejects.toThrow("broker unavailable");

		expect(harness.unregisterCount()).toBe(0);
		expect(harness.getOutputSink()).toBeDefined();
		expect(harness.active.at(-1)?.active).toBe(true);
	});

	it("rejects a broker that cannot provide recoverable raw monitor output", async () => {
		const harness = createHarness();
		vi.spyOn(daemonClient, "daemonClientForProject").mockResolvedValue(harness.client);
		vi.spyOn(harness.client, "request").mockResolvedValue({
			op: "ping",
			projectDir: process.cwd(),
			capabilities: ["output-monitor-v1"],
		});

		await expect(
			executeLaunch(harness.session, { op: "monitor", name: daemon.name, progress: "wake" }),
		).rejects.toThrow("restart it with this omp build");
		// The capability check fails before the attach, so no subscription was
		// ever registered and no monitor state was touched.
		expect(harness.unregisterCount()).toBe(0);
		expect(harness.getOutputSink()).toBeUndefined();
		expect(harness.active).toHaveLength(0);
	});

	it("does not resurrect wake state when terminal cleanup races a retune", async () => {
		const harness = createHarness();
		vi.spyOn(daemonClient, "daemonClientForProject").mockResolvedValue(harness.client);

		await executeLaunch(harness.session, { op: "monitor", name: daemon.name, progress: "wake" });
		const subscription = harness.getSubscription();
		const sink = harness.getOutputSink();
		if (!subscription || !sink) throw new Error("Expected output subscription");
		vi.spyOn(harness.client, "request").mockImplementation(async operation => {
			if (operation.op === "ping") {
				return { op: "ping", projectDir: process.cwd(), capabilities: [DAEMON_OUTPUT_MONITOR_CAPABILITY] };
			}
			await sink({
				event: "daemon-monitor-completed",
				monitorId: subscription.id,
				daemon: { ...daemon, state: "exited", pid: undefined, exitedAt: 3, exitCode: 0 },
			});
			throw new Error("process exited during retune");
		});

		await expect(
			executeLaunch(harness.session, { op: "monitor", name: daemon.name, progress: "ambient" }),
		).rejects.toThrow("process exited during retune");

		expect(harness.unregisterCount()).toBe(1);
		// The retune fails before its registration exists, so the last state
		// change is the terminal cleanup of the original wake monitor - never
		// a resurrected active entry.
		expect(harness.active.at(-1)).toEqual({
			monitorId: subscription.id,
			delivery: "wake",
			active: false,
		});
	});

	it("session disposal removes monitoring but leaves process lifecycle untouched", async () => {
		const harness = createHarness();
		vi.spyOn(daemonClient, "daemonClientForProject").mockResolvedValue(harness.client);

		await executeLaunch(harness.session, { op: "monitor", name: daemon.name, progress: "wake" });
		expect(harness.disposeCallbacks).toHaveLength(2);
		for (const dispose of harness.disposeCallbacks) dispose();

		expect(harness.unregisterCount()).toBe(1);
		expect(harness.requests.some(operation => operation.op === "stop")).toBeFalse();
	});

	it("terminal monitor notification cleans up without duplicating owner completion", async () => {
		const harness = createHarness();
		vi.spyOn(daemonClient, "daemonClientForProject").mockResolvedValue(harness.client);

		await executeLaunch(harness.session, { op: "monitor", name: daemon.name, progress: "wake" });
		const subscription = harness.getSubscription();
		if (!subscription) throw new Error("Expected output subscription");
		await harness.getOutputSink()?.({
			event: "daemon-monitor-completed",
			monitorId: subscription.id,
			daemon: { ...daemon, state: "exited", pid: undefined, exitedAt: 3, exitCode: 0 },
		});

		expect(harness.unregisterCount()).toBe(1);
		expect(harness.active.at(-1)).toEqual({ monitorId: subscription.id, delivery: "wake", active: false });
		expect(harness.completions).toEqual([]);
	});

	it("suppresses the synthesized completion when the broker confirmed the owner was notified", async () => {
		const harness = createHarness();
		vi.spyOn(daemonClient, "daemonClientForProject").mockResolvedValue(harness.client);

		await executeLaunch(harness.session, { op: "monitor", name: daemon.name, progress: "wake" });
		const subscription = harness.getSubscription();
		if (!subscription) throw new Error("Expected output subscription");
		await harness.getOutputSink()?.({
			event: "daemon-monitor-completed",
			monitorId: subscription.id,
			daemon: { ...daemon, state: "exited", pid: undefined, exitedAt: 3, exitCode: 0 },
			ownerNotified: true,
		});

		expect(harness.unregisterCount()).toBe(1);
		expect(harness.active.at(-1)).toEqual({ monitorId: subscription.id, delivery: "wake", active: false });
		expect(harness.completions).toEqual([]);
	});

	it("delivers a terminal completion when a stop bypassed the owner notification", async () => {
		const harness = createHarness();
		vi.spyOn(daemonClient, "daemonClientForProject").mockResolvedValue(harness.client);

		await executeLaunch(harness.session, { op: "monitor", name: daemon.name, progress: "wake" });
		const subscription = harness.getSubscription();
		if (!subscription) throw new Error("Expected output subscription");
		// Another client stopped the daemon: the broker skipped the owner
		// completion (stopRequested) and this monitor notification is the only
		// terminal signal the owning session will ever receive.
		const stopped: DaemonSnapshot = { ...daemon, state: "exited", pid: undefined, exitedAt: 3, exitCode: 143 };
		await harness.getOutputSink()?.({
			event: "daemon-monitor-completed",
			monitorId: subscription.id,
			daemon: stopped,
			ownerNotified: false,
		});

		expect(harness.unregisterCount()).toBe(1);
		expect(harness.active.at(-1)).toEqual({ monitorId: subscription.id, delivery: "wake", active: false });
		expect(harness.completions).toEqual([
			{
				event: "daemon-completed",
				completionId: `monitor:${subscription.id}:${stopped.id}:3`,
				owner: OWNER,
				daemon: stopped,
			},
		]);
	});

	it("suppresses the synthesized completion when the monitoring session stopped the process itself", async () => {
		const harness = createHarness();
		vi.spyOn(daemonClient, "daemonClientForProject").mockResolvedValue(harness.client);
		const stopped: DaemonSnapshot = { ...daemon, state: "exited", pid: undefined, exitedAt: 3, exitCode: 143 };
		vi.spyOn(harness.client, "request").mockImplementation(async operation => {
			if (operation.op === "ping") {
				return { op: "ping", projectDir: process.cwd(), capabilities: [DAEMON_OUTPUT_MONITOR_CAPABILITY] };
			}
			if (operation.op === "describe") return { op: "describe", daemon, spec };
			if (operation.op !== "stop") throw new Error(`Unexpected operation: ${operation.op}`);
			// A stop settlement skips the owner completion (stopRequested), and
			// the terminal monitor notification (ownerNotified=false) can race
			// ahead of the RPC response — the local-stop marker must already be
			// set when it arrives.
			const subscription = harness.getSubscription();
			if (!subscription) throw new Error("Expected output subscription");
			await harness.getOutputSink()?.({
				event: "daemon-monitor-completed",
				monitorId: subscription.id,
				daemon: stopped,
				ownerNotified: false,
			});
			return { op: "stop", daemon: stopped };
		});

		await executeLaunch(harness.session, { op: "monitor", name: daemon.name, progress: "wake" });
		const result = await executeLaunch(harness.session, { op: "stop", name: daemon.name, timeout: 1 });
		await drainMicrotasks();

		// The in-flight stop call's own result is the single terminal surface.
		expect(harness.unregisterCount()).toBe(1);
		expect(harness.completions).toEqual([]);
		expect(result.content).toEqual([
			expect.objectContaining({ type: "text", text: expect.stringContaining("Stopped") }),
		]);
	});

	it("buffers speculative progress until the start is retained, then flushes it", async () => {
		const harness = createHarness();
		vi.spyOn(daemonClient, "daemonClientForProject").mockResolvedValue(harness.client);
		vi.spyOn(harness.client, "request").mockImplementation(async operation => {
			if (operation.op === "ping") {
				return { op: "ping", projectDir: process.cwd(), capabilities: [DAEMON_OUTPUT_MONITOR_CAPABILITY] };
			}
			if (operation.op !== "start") throw new Error(`Unexpected operation: ${operation.op}`);
			// The subscription advertised ahead of the start request is marked
			// start-pending so the broker defers stale terminal replay.
			expect(harness.getSubscription()?.startPending).toBeTrue();
			const subscription = harness.getSubscription();
			if (!subscription) throw new Error("Expected output subscription");
			await harness.getOutputSink()?.({
				event: "daemon-output",
				monitorId: subscription.id,
				name: daemon.name,
				daemonId: daemon.id,
				seq: 1,
				text: "early",
				batchKind: "progress",
				suppressedEvents: 0,
			});
			// Still speculative: nothing may wake the session before validation.
			expect(harness.progress).toEqual([]);
			return { op: "start", daemon, readyTimedOut: false };
		});

		await executeLaunch(harness.session, {
			op: "start",
			name: daemon.name,
			application: process.execPath,
			pty: false,
			persist: true,
			progress: "wake",
		});
		await drainMicrotasks();

		expect(harness.progress.map(item => item.notification.text)).toEqual(["early"]);
		expect(harness.getSubscription()?.startPending).toBeUndefined();
		expect(harness.unregisterCount()).toBe(0);
	});

	it("drains every speculative batch before resolving a fast-terminal start", async () => {
		const harness = createHarness();
		vi.spyOn(daemonClient, "daemonClientForProject").mockResolvedValue(harness.client);
		const order: string[] = [];
		const terminalReceipt = Promise.withResolvers<void>();
		vi.spyOn(harness.session, "queueLaunchProgress").mockImplementation(notification => {
			order.push(notification.text);
		});
		vi.spyOn(harness.session, "queueLaunchCompletion").mockImplementation(notification => {
			order.push(`terminal:${notification.daemon.state}`);
			return terminalReceipt.promise;
		});
		const exited: DaemonSnapshot = {
			...daemon,
			state: "exited",
			pid: undefined,
			exitedAt: 3,
			exitCode: 0,
		};
		vi.spyOn(harness.client, "request").mockImplementation(async operation => {
			if (operation.op === "ping") {
				return { op: "ping", projectDir: process.cwd(), capabilities: [DAEMON_OUTPUT_MONITOR_CAPABILITY] };
			}
			if (operation.op !== "start") throw new Error(`Unexpected operation: ${operation.op}`);
			const subscription = harness.getSubscription();
			const sink = harness.getOutputSink();
			if (!subscription || !sink) throw new Error("Expected output subscription");
			for (const [index, text] of ["first", "second", "third", "fourth"].entries()) {
				await sink({
					event: "daemon-output",
					monitorId: subscription.id,
					name: daemon.name,
					daemonId: daemon.id,
					seq: index + 1,
					text,
					batchKind: "progress",
					suppressedEvents: 0,
				});
			}
			await sink({
				event: "daemon-monitor-completed",
				monitorId: subscription.id,
				daemon: exited,
				ownerNotified: false,
			});
			return { op: "start", daemon: exited, readyTimedOut: false };
		});

		await executeLaunch(harness.session, {
			op: "start",
			name: daemon.name,
			application: process.execPath,
			pty: false,
			persist: true,
			progress: "wake",
		});
		order.push("resolved");

		expect(order).toEqual(["first", "second", "third", "fourth", "terminal:exited", "resolved"]);
		expect(harness.unregisterCount()).toBe(1);
		// A terminal receipt may wait for the current tool step to finish; it
		// must not deadlock retention after the completion has been queued.
		terminalReceipt.resolve();
		await terminalReceipt.promise;
	});

	it("discards speculative progress when the start fails", async () => {
		const harness = createHarness();
		vi.spyOn(daemonClient, "daemonClientForProject").mockResolvedValue(harness.client);
		vi.spyOn(harness.client, "request").mockImplementation(async operation => {
			if (operation.op === "ping") {
				return { op: "ping", projectDir: process.cwd(), capabilities: [DAEMON_OUTPUT_MONITOR_CAPABILITY] };
			}
			if (operation.op !== "start") throw new Error(`Unexpected operation: ${operation.op}`);
			const subscription = harness.getSubscription();
			if (!subscription) throw new Error("Expected output subscription");
			// An already-running process emits during the validation window.
			await harness.getOutputSink()?.({
				event: "daemon-output",
				monitorId: subscription.id,
				name: daemon.name,
				daemonId: daemon.id,
				seq: 1,
				text: "leaked",
				batchKind: "progress",
				suppressedEvents: 0,
			});
			throw new Error(`Daemon ${daemon.name} is already running`);
		});

		await expect(
			executeLaunch(harness.session, {
				op: "start",
				name: daemon.name,
				application: process.execPath,
				pty: false,
				persist: true,
				progress: "wake",
			}),
		).rejects.toThrow("already running");
		await drainMicrotasks();

		expect(harness.progress).toEqual([]);
		expect(harness.completions).toEqual([]);
		expect(harness.unregisterCount()).toBe(1);
		expect(harness.active.at(-1)?.active).toBe(false);
	});

	it("does not mark monitor-op subscriptions as start-pending", async () => {
		const harness = createHarness();
		vi.spyOn(daemonClient, "daemonClientForProject").mockResolvedValue(harness.client);

		await executeLaunch(harness.session, { op: "monitor", name: daemon.name, progress: "wake" });

		expect(harness.getSubscription()?.startPending).toBeUndefined();
	});

	it("replaces a stale registration when a monitored start reuses the name", async () => {
		const harness = createHarness();
		vi.spyOn(daemonClient, "daemonClientForProject").mockResolvedValue(harness.client);

		await executeLaunch(harness.session, { op: "monitor", name: daemon.name, progress: "ambient" });
		const stale = harness.getSubscription();
		if (!stale) throw new Error("Expected output subscription");

		vi.spyOn(harness.client, "request").mockImplementation(async operation => {
			if (operation.op === "ping") {
				return { op: "ping", projectDir: process.cwd(), capabilities: [DAEMON_OUTPUT_MONITOR_CAPABILITY] };
			}
			if (operation.op !== "start") throw new Error(`Unexpected operation: ${operation.op}`);
			// The start must advertise a fresh start-pending subscription — never
			// the stale one — so the broker cannot replay the old daemon's
			// terminal notification and tear the monitor down before launch.
			const advertised = harness.getSubscription();
			expect(advertised?.id).not.toBe(stale.id);
			expect(advertised?.startPending).toBeTrue();
			return { op: "start", daemon, readyTimedOut: false };
		});

		await executeLaunch(harness.session, {
			op: "start",
			name: daemon.name,
			application: process.execPath,
			pty: false,
			persist: true,
			progress: "wake",
		});
		await drainMicrotasks();

		// The stale registration was torn down; the new one carries the start.
		expect(harness.unregisterCount()).toBe(1);
		const replacement = harness.getSubscription();
		if (!replacement) throw new Error("Expected replacement subscription");
		expect(replacement.startPending).toBeUndefined();
		await harness.getOutputSink()?.({
			event: "daemon-output",
			monitorId: replacement.id,
			name: daemon.name,
			daemonId: daemon.id,
			seq: 1,
			text: "fresh output",
			batchKind: "progress",
			suppressedEvents: 0,
		});
		expect(harness.progress.map(item => ({ text: item.notification.text, delivery: item.delivery }))).toEqual([
			{ text: "fresh output", delivery: "wake" },
		]);
		expect(harness.active.at(-1)).toEqual({ monitorId: replacement.id, delivery: "wake", active: true });
	});

	it("restores the prior monitor mode when a replacement start fails", async () => {
		const harness = createHarness();
		vi.spyOn(daemonClient, "daemonClientForProject").mockResolvedValue(harness.client);

		await executeLaunch(harness.session, { op: "monitor", name: daemon.name, progress: "ambient" });
		const prior = harness.getSubscription();
		if (!prior) throw new Error("Expected output subscription");
		vi.spyOn(harness.client, "request").mockImplementation(async operation => {
			if (operation.op === "ping") {
				return { op: "ping", projectDir: process.cwd(), capabilities: [DAEMON_OUTPUT_MONITOR_CAPABILITY] };
			}
			if (operation.op !== "start") throw new Error(`Unexpected operation: ${operation.op}`);
			const advertised = harness.getSubscription();
			if (!advertised) throw new Error("Expected output subscription");
			expect(advertised.id).not.toBe(prior.id);
			// Output emitted while the failing start is still validating belongs
			// only to the speculative replacement and must be discarded.
			await harness.getOutputSink()?.({
				event: "daemon-output",
				monitorId: advertised.id,
				name: daemon.name,
				daemonId: daemon.id,
				seq: 1,
				text: "speculative",
				batchKind: "progress",
				suppressedEvents: 0,
			});
			throw new Error(`Daemon ${daemon.name} is already running`);
		});

		await expect(
			executeLaunch(harness.session, {
				op: "start",
				name: daemon.name,
				application: process.execPath,
				pty: false,
				persist: true,
				progress: "wake",
			}),
		).rejects.toThrow("already running");
		await drainMicrotasks();

		const restored = harness.getSubscription();
		if (!restored) throw new Error("Expected restored output subscription");
		expect(restored.id).not.toBe(prior.id);
		expect(restored.startPending).toBeUndefined();
		expect(harness.progress).toEqual([]);
		expect(harness.active.at(-1)).toEqual({ monitorId: restored.id, delivery: "ambient", active: true });

		await harness.getOutputSink()?.({
			event: "daemon-output",
			monitorId: restored.id,
			name: daemon.name,
			daemonId: daemon.id,
			seq: 1,
			text: "still monitored",
			batchKind: "progress",
			suppressedEvents: 0,
		});
		expect(harness.progress.map(item => ({ text: item.notification.text, delivery: item.delivery }))).toEqual([
			{ text: "still monitored", delivery: "ambient" },
		]);
		expect(harness.unregisterCount()).toBe(2);
	});

	it("does not restore a monitor that completed during replacement artifact allocation", async () => {
		const harness = createHarness();
		vi.spyOn(daemonClient, "daemonClientForProject").mockResolvedValue(harness.client);

		await executeLaunch(harness.session, { op: "monitor", name: daemon.name, progress: "ambient" });
		const prior = harness.getSubscription();
		const priorSink = harness.getOutputSink();
		if (!prior || !priorSink) throw new Error("Expected output subscription");

		const allocationStarted = Promise.withResolvers<void>();
		const artifact = Promise.withResolvers<{ id: string; path: string }>();
		vi.spyOn(harness.session, "allocateOutputArtifact").mockImplementation(() => {
			allocationStarted.resolve();
			return artifact.promise;
		});
		vi.spyOn(harness.client, "request").mockImplementation(async operation => {
			if (operation.op === "ping") {
				return { op: "ping", projectDir: process.cwd(), capabilities: [DAEMON_OUTPUT_MONITOR_CAPABILITY] };
			}
			if (operation.op === "start") throw new Error(`Daemon ${daemon.name} is already running`);
			throw new Error(`Unexpected operation: ${operation.op}`);
		});

		const replacement = executeLaunch(harness.session, {
			op: "start",
			name: daemon.name,
			application: process.execPath,
			pty: false,
			persist: true,
			progress: "wake",
		});
		const settlement = replacement.then(
			() => ({ ok: true as const }),
			(error: unknown) => ({ ok: false as const, error }),
		);
		await allocationStarted.promise;
		try {
			await priorSink({
				event: "daemon-monitor-completed",
				monitorId: prior.id,
				daemon: { ...daemon, state: "exited", pid: undefined, exitedAt: 3, exitCode: 0 },
				ownerNotified: false,
			});
		} finally {
			artifact.resolve({
				id: `hub-progress-${crypto.randomUUID()}`,
				path: path.join(process.cwd(), `.hub-progress-${crypto.randomUUID()}.log`),
			});
		}

		expect(await settlement).toEqual({
			ok: false,
			error: expect.objectContaining({ message: expect.stringContaining("already running") }),
		});
		await drainMicrotasks();

		expect(harness.completions).toHaveLength(1);
		expect(harness.registrationCount()).toBe(0);
		expect(harness.getOutputSink()).toBeUndefined();
		expect(harness.active.at(-1)?.active).toBeFalse();
	});

	it("keeps the prior delivery mode when a monitor retune fails validation", async () => {
		const harness = createHarness();
		vi.spyOn(daemonClient, "daemonClientForProject").mockResolvedValue(harness.client);

		await executeLaunch(harness.session, { op: "monitor", name: daemon.name, progress: "wake" });
		const subscription = harness.getSubscription();
		const sink = harness.getOutputSink();
		if (!subscription || !sink) throw new Error("Expected output subscription");
		vi.spyOn(harness.client, "request").mockImplementation(async operation => {
			if (operation.op === "ping") {
				return { op: "ping", projectDir: process.cwd(), capabilities: [DAEMON_OUTPUT_MONITOR_CAPABILITY] };
			}
			// Output arrives while the retune is still validating, then the
			// describe fails: it must have been delivered under the prior mode.
			await sink({
				event: "daemon-output",
				monitorId: subscription.id,
				name: daemon.name,
				daemonId: daemon.id,
				seq: 1,
				text: "mid-retune",
				batchKind: "progress",
				suppressedEvents: 0,
			});
			throw new Error("broker unavailable");
		});

		await expect(
			executeLaunch(harness.session, { op: "monitor", name: daemon.name, progress: "ambient" }),
		).rejects.toThrow("broker unavailable");

		expect(harness.progress.map(item => item.delivery)).toEqual(["wake"]);
		expect(harness.unregisterCount()).toBe(0);
		expect(harness.active.at(-1)).toEqual({ monitorId: subscription.id, delivery: "wake", active: true });
	});
});
