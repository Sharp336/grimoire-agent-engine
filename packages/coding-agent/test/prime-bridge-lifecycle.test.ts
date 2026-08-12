import { describe, expect, it } from "bun:test";
import { ensurePrimeBridge, type PrimeBridgeLifecycleSettings } from "../src/integrations/prime-bridge/lifecycle";
import type { DaemonBrokerClient } from "../src/launch/client";
import type { DaemonOperation, DaemonRpcResult, DaemonSnapshot, DaemonSpec } from "../src/launch/protocol";

const settings: PrimeBridgeLifecycleSettings = {
	enabled: true,
	autoStart: true,
	url: "http://127.0.0.1:4123",
};

function snapshot(spec: DaemonSpec, state: DaemonSnapshot["state"] = "ready"): DaemonSnapshot {
	return {
		name: spec.name,
		id: "prime-bridge-id",
		state,
		createdAt: 1,
		startedAt: 1,
		readyAt: state === "ready" ? 1 : undefined,
		restartCount: 0,
		outputBytes: 0,
		persist: spec.persist,
		detached: spec.detached,
	};
}

class FakeBroker implements DaemonBrokerClient {
	readonly projectDir = "/global/prime-bridge";
	readonly operations: DaemonOperation[] = [];
	currentSpec: DaemonSpec | undefined;
	currentState: DaemonSnapshot["state"] = "ready";
	listDelay: Promise<void> | undefined;
	waitTimedOut = false;

	onCompletion(): () => void {
		return () => undefined;
	}

	async request(operation: DaemonOperation): Promise<DaemonRpcResult> {
		this.operations.push(operation);
		if (this.listDelay !== undefined && operation.op === "list") await this.listDelay;
		switch (operation.op) {
			case "list":
				return {
					op: "list",
					daemons: this.currentSpec === undefined ? [] : [snapshot(this.currentSpec, this.currentState)],
				};
			case "describe":
				if (this.currentSpec === undefined) throw new Error(`Daemon ${operation.name} not found`);
				return {
					op: "describe",
					daemon: snapshot(this.currentSpec, this.currentState),
					spec: this.currentSpec,
				};
			case "start":
				this.currentSpec = operation.spec;
				this.currentState = "ready";
				return { op: "start", daemon: snapshot(operation.spec, "ready"), readyTimedOut: false };
			case "restart":
				if (this.currentSpec === undefined) throw new Error(`Daemon ${operation.name} not found`);
				this.currentState = "starting";
				return { op: "restart", daemon: snapshot(this.currentSpec, "starting") };
			case "wait": {
				if (this.currentSpec === undefined) throw new Error(`Daemon ${operation.name} not found`);
				if (!this.waitTimedOut) this.currentState = "ready";
				return {
					op: "wait",
					daemon: snapshot(this.currentSpec, this.currentState),
					timedOut: this.waitTimedOut,
				};
			}
			default:
				throw new Error(`Unexpected operation ${operation.op}`);
		}
	}

	close(): void {}
}

function dependencies(
	broker: FakeBroker,
	calls: string[],
): { daemonClientForGlobal: (scope: string) => Promise<DaemonBrokerClient> } {
	return {
		daemonClientForGlobal: async scope => {
			calls.push(scope);
			return broker;
		},
	};
}

function startOperations(broker: FakeBroker): Extract<DaemonOperation, { op: "start" }>[] {
	return broker.operations.filter(
		(operation): operation is Extract<DaemonOperation, { op: "start" }> => operation.op === "start",
	);
}
function waitOperations(broker: FakeBroker): Extract<DaemonOperation, { op: "wait" }>[] {
	return broker.operations.filter(
		(operation): operation is Extract<DaemonOperation, { op: "wait" }> => operation.op === "wait",
	);
}
function matchingSpec(broker: FakeBroker, tokenPath?: string): DaemonSpec {
	return {
		name: "prime-bridge",
		application: "omp-prime-bridge",
		args: tokenPath === undefined ? ["--port", "4123"] : ["--port", "4123", "--token-file", tokenPath],
		env: {},
		cwd: broker.projectDir,
		pty: false,
		ready: { host: "127.0.0.1", port: 4123, timeoutMs: 30_000 },
		restart: "always",
		persist: true,
		detached: true,
	};
}

describe("ensurePrimeBridge", () => {
	it("starts the machine-global detached bridge with the exact supervision contract", async () => {
		const broker = new FakeBroker();
		const scopes: string[] = [];

		await ensurePrimeBridge(settings, dependencies(broker, scopes));

		expect(scopes).toEqual(["prime-bridge"]);
		expect(startOperations(broker)).toEqual([
			{
				op: "start",
				spec: {
					name: "prime-bridge",
					application: "omp-prime-bridge",
					args: ["--port", "4123"],
					env: {},
					cwd: "/global/prime-bridge",
					pty: false,
					ready: { host: "127.0.0.1", port: 4123, timeoutMs: 30_000 },
					restart: "always",
					persist: true,
					detached: true,
				},
			},
		]);
	});

	it("restarts a matching failed daemon and waits for readiness", async () => {
		const broker = new FakeBroker();
		const scopes: string[] = [];
		broker.currentSpec = matchingSpec(broker);
		broker.currentState = "failed";

		await ensurePrimeBridge(settings, dependencies(broker, scopes));

		expect(startOperations(broker)).toHaveLength(0);
		expect(broker.operations.map(operation => operation.op)).toEqual(["list", "describe", "restart", "wait"]);
		expect(waitOperations(broker)).toEqual([{ op: "wait", name: "prime-bridge", for: "ready", timeoutMs: 30_000 }]);
		expect(broker.currentState as DaemonSnapshot["state"]).toBe("ready");
	});

	it("restarts a matching exited daemon and waits for readiness", async () => {
		const broker = new FakeBroker();
		const scopes: string[] = [];
		broker.currentSpec = matchingSpec(broker);
		broker.currentState = "exited";

		await ensurePrimeBridge(settings, dependencies(broker, scopes));

		expect(startOperations(broker)).toHaveLength(0);
		expect(broker.operations.map(operation => operation.op)).toEqual(["list", "describe", "restart", "wait"]);
		expect(broker.currentState as DaemonSnapshot["state"]).toBe("ready");
	});

	it("waits for matching starting and restarting daemons instead of starting another", async () => {
		for (const state of ["starting", "restarting"] as const) {
			const broker = new FakeBroker();
			const scopes: string[] = [];
			broker.currentSpec = matchingSpec(broker);
			broker.currentState = state;

			await ensurePrimeBridge(settings, dependencies(broker, scopes));

			expect(startOperations(broker)).toHaveLength(0);
			expect(broker.operations.map(operation => operation.op)).toEqual(["list", "describe", "wait"]);
			expect(broker.currentState as DaemonSnapshot["state"]).toBe("ready");
		}
	});

	it("does not deduplicate concurrent ensures with conflicting token paths", async () => {
		const broker = new FakeBroker();
		const scopes: string[] = [];
		const gate = Promise.withResolvers<void>();
		broker.currentSpec = matchingSpec(broker, "/tmp/prime-a");
		broker.listDelay = gate.promise;

		const first = ensurePrimeBridge({ ...settings, tokenPath: "/tmp/prime-a" }, dependencies(broker, scopes));
		const second = ensurePrimeBridge({ ...settings, tokenPath: "/tmp/prime-b" }, dependencies(broker, scopes));
		gate.resolve();
		const results = await Promise.allSettled([first, second]);

		expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
		expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
		expect(startOperations(broker)).toHaveLength(0);
		expect(broker.operations.filter(operation => operation.op === "describe")).toHaveLength(2);
		expect(results.find(result => result.status === "rejected")).toMatchObject({
			status: "rejected",
			reason: expect.objectContaining({ message: expect.stringContaining("conflicting") }),
		});
	});

	it("forwards a configured token file to the bridge command", async () => {
		const broker = new FakeBroker();
		const scopes: string[] = [];

		await ensurePrimeBridge({ ...settings, tokenPath: "/tmp/prime-bridge-token" }, dependencies(broker, scopes));

		expect(startOperations(broker)[0]?.spec.args).toEqual([
			"--port",
			"4123",
			"--token-file",
			"/tmp/prime-bridge-token",
		]);
	});

	it("is idempotent across concurrent and sequential ensures", async () => {
		const broker = new FakeBroker();
		const scopes: string[] = [];
		const gate = Promise.withResolvers<void>();
		broker.listDelay = gate.promise;

		const first = ensurePrimeBridge(settings, dependencies(broker, scopes));
		const second = ensurePrimeBridge(settings, dependencies(broker, scopes));
		gate.resolve();
		await Promise.all([first, second]);
		await ensurePrimeBridge(settings, dependencies(broker, scopes));

		expect(scopes).toEqual(["prime-bridge", "prime-bridge"]);
		expect(broker.operations.filter(operation => operation.op === "describe")).toHaveLength(1);
	});

	it("does not contact the broker when disabled or auto-start is off", async () => {
		const broker = new FakeBroker();
		const scopes: string[] = [];

		await ensurePrimeBridge({ ...settings, enabled: false }, dependencies(broker, scopes));
		await ensurePrimeBridge({ ...settings, autoStart: false }, dependencies(broker, scopes));

		expect(scopes).toEqual([]);
		expect(broker.operations).toEqual([]);
	});

	it("rejects enabled configurations that are not loopback HTTP URLs", async () => {
		const broker = new FakeBroker();
		const scopes: string[] = [];
		await expect(
			ensurePrimeBridge({ ...settings, url: "http://127.0.0.1:4123/bridge" }, dependencies(broker, scopes)),
		).rejects.toThrow("path, query, or fragment");
		await expect(
			ensurePrimeBridge({ ...settings, url: "http://127.0.0.1:4123?tenant=omp" }, dependencies(broker, scopes)),
		).rejects.toThrow("path, query, or fragment");
		await expect(
			ensurePrimeBridge({ ...settings, url: "http://127.0.0.1:4123#health" }, dependencies(broker, scopes)),
		).rejects.toThrow("path, query, or fragment");
		await expect(
			ensurePrimeBridge({ ...settings, url: "http://[::1]:4123" }, dependencies(broker, scopes)),
		).rejects.toThrow("loopback HTTP URL");
		await expect(
			ensurePrimeBridge({ ...settings, url: "https://127.0.0.1:4123" }, dependencies(broker, scopes)),
		).rejects.toThrow("loopback HTTP URL");
		await expect(
			ensurePrimeBridge({ ...settings, url: "http://example.com:4123" }, dependencies(broker, scopes)),
		).rejects.toThrow("loopback HTTP URL");
		expect(scopes).toEqual([]);
	});

	it("rejects an existing daemon with a conflicting launch specification", async () => {
		const broker = new FakeBroker();
		const scopes: string[] = [];
		broker.currentSpec = {
			name: "prime-bridge",
			application: "omp-prime-bridge",
			args: ["--port", "4123"],
			env: {},
			cwd: broker.projectDir,
			pty: false,
			ready: { host: "127.0.0.1", port: 4123, timeoutMs: 30_000 },
			restart: "always",
			persist: true,
			detached: true,
		};

		await expect(
			ensurePrimeBridge({ ...settings, tokenPath: "/tmp/prime-bridge-token" }, dependencies(broker, scopes)),
		).rejects.toThrow("conflicting");
		expect(startOperations(broker)).toHaveLength(0);
		expect(broker.operations.map(operation => operation.op)).toEqual(["list", "describe"]);
	});
});
