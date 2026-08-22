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
}

function createHarness(artifact?: { id: string; path: string }): MonitorHarness {
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
	const client = {
		projectDir: process.cwd(),
		onCompletion: () => () => {},
		onOutput: (
			registered: DaemonOutputSubscription,
			sink: (notification: DaemonMonitorNotification) => void | Promise<void>,
		) => {
			subscription = registered;
			outputSink = sink;
			return () => {
				unregisters++;
				outputSink = undefined;
			};
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

	it("delivers nothing under the new mode when a start over an existing monitor fails", async () => {
		const harness = createHarness();
		vi.spyOn(daemonClient, "daemonClientForProject").mockResolvedValue(harness.client);

		await executeLaunch(harness.session, { op: "monitor", name: daemon.name, progress: "ambient" });
		vi.spyOn(harness.client, "request").mockImplementation(async operation => {
			if (operation.op === "ping") {
				return { op: "ping", projectDir: process.cwd(), capabilities: [DAEMON_OUTPUT_MONITOR_CAPABILITY] };
			}
			if (operation.op !== "start") throw new Error(`Unexpected operation: ${operation.op}`);
			const advertised = harness.getSubscription();
			if (!advertised) throw new Error("Expected output subscription");
			// Output emitted while the failing start is still validating.
			await harness.getOutputSink()?.({
				event: "daemon-output",
				monitorId: advertised.id,
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

		// Nothing was queued as wake progress during the failed start: the
		// replacement registration buffers speculatively and discards on reject.
		expect(harness.progress).toEqual([]);
		expect(harness.active.at(-1)?.active).toBe(false);
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
