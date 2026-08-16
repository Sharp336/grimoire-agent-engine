import { describe, expect, it, vi } from "bun:test";
import type { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import {
	AgentRegistry,
	type RemoteAgentIdentity,
	type RemoteRegistryBackend,
} from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { executeCancel } from "@oh-my-pi/pi-coding-agent/tools/hub/jobs";

const IDENTITY: RemoteAgentIdentity = {
	controllerId: "controller-a",
	executionId: "execution-a",
	generation: 7,
};

function backend(overrides: Partial<RemoteRegistryBackend> = {}): RemoteRegistryBackend {
	return {
		status: async identity => ({ identity: { ...identity }, value: "running" }),
		progress: async identity => ({ identity: { ...identity }, value: { sequence: 1, message: "working" } }),
		cancel: async identity => ({ identity: { ...identity }, value: "cancelled" }),
		result: async identity => ({ identity: { ...identity }, value: { outcome: "completed", output: "done" } }),
		...overrides,
	};
}

function registerRemote(registry: AgentRegistry, id = "RemoteChild"): void {
	registry.registerRemote({
		id,
		displayName: "remote child",
		kind: "sub",
		parentId: "Main",
		status: "running",
		identity: IDENTITY,
	});
}
function cancelHarness(registry: AgentRegistry): { session: ToolSession; manager: AsyncJobManager } {
	const session: ToolSession = {
		cwd: "/tmp",
		hasUI: false,
		settings: Settings.isolated(),
		agentRegistry: registry,
		getAgentId: () => "Main",
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
	};
	const manager = {
		getJob: () => undefined,
		getAllJobs: () => [],
		getRunningJobs: () => [],
		cancel: () => false,
		acknowledgeDeliveries: () => {},
	} as unknown as AsyncJobManager;
	return { session, manager };
}

describe("remote agent registry", () => {
	it("keeps existing local registrations local and generation-bound", () => {
		const registry = new AgentRegistry();
		const first = registry.register({ id: "Local", displayName: "local", kind: "sub", session: null });
		const second = registry.register({ id: "Local", displayName: "local", kind: "sub", session: null });

		expect(first.locality).toBe("local");
		expect(second.locality).toBe("local");
		expect(second.generation).toBe(first.generation + 1);
	});

	it("rejects local/remote overlap and never admits a remote ref to local revival", async () => {
		const registry = new AgentRegistry({ remoteBackend: backend() });
		registerRemote(registry);
		const lifecycle = new AgentLifecycleManager(registry);
		const revive = vi.fn(async () => {
			throw new Error("must not run");
		});

		lifecycle.adopt("RemoteChild", { idleTtlMs: 0, revive });
		expect(lifecycle.has("RemoteChild")).toBe(false);
		expect(registry.attachSession("RemoteChild", {} as never)).toBe(false);
		await expect(lifecycle.ensureLive("RemoteChild")).rejects.toThrow("cannot be resumed");
		expect(revive).not.toHaveBeenCalled();
		expect(() => registry.register({ id: "RemoteChild", displayName: "local", kind: "sub", session: null })).toThrow(
			/cannot register local agent/i,
		);
	});

	it("applies only exact-generation controller status and monotonic progress", async () => {
		let progressSequence = 2;
		const registry = new AgentRegistry({
			remoteBackend: backend({
				status: async identity => ({ identity: { ...identity }, value: "idle" }),
				progress: async identity => ({
					identity: { ...identity },
					value: { sequence: progressSequence, message: "controller progress" },
				}),
			}),
		});
		registerRemote(registry);

		const refreshed = await registry.refreshRemote("RemoteChild");
		expect(refreshed.status).toBe("idle");
		expect(registry.setStatus("RemoteChild", "running")).toBe(false);

		progressSequence = 1;
		await expect(registry.refreshRemote("RemoteChild")).rejects.toThrow("stale sequence");
	});

	it("fails closed for missing backends, stale generations, outages, and malformed results", async () => {
		const missing = new AgentRegistry();
		registerRemote(missing);
		await expect(missing.refreshRemote("RemoteChild")).rejects.toThrow("backend is unavailable");

		const stale = new AgentRegistry({
			remoteBackend: backend({
				status: async identity => ({
					identity: { ...identity, generation: identity.generation + 1 },
					value: "idle",
				}),
			}),
		});
		registerRemote(stale);
		await expect(stale.refreshRemote("RemoteChild")).rejects.toThrow("stale or malformed identity");

		const outage = new AgentRegistry({
			remoteBackend: backend({ status: async () => Promise.reject(new Error("controller offline")) }),
		});
		registerRemote(outage);
		await expect(outage.refreshRemote("RemoteChild")).rejects.toThrow("controller offline");

		const malformed = new AgentRegistry({
			remoteBackend: backend({
				result: async identity => ({ identity: { ...identity }, value: { outcome: "failed" } as never }),
			}),
		});
		registerRemote(malformed);
		await expect(malformed.resultRemote("RemoteChild")).rejects.toThrow("malformed value");
	});

	it("installs one global backend closure idempotently and rejects replacement", () => {
		AgentRegistry.resetGlobalForTests();
		try {
			const first = backend();
			AgentRegistry.installGlobalRemoteBackend(first);
			expect(() => AgentRegistry.installGlobalRemoteBackend(first)).not.toThrow();
			expect(() => AgentRegistry.installGlobalRemoteBackend(backend())).toThrow("already installed");
		} finally {
			AgentRegistry.resetGlobalForTests();
		}
	});

	it("makes controller identity fields runtime-immutable and uniquely indexed", () => {
		const registry = new AgentRegistry({ remoteBackend: backend() });
		const ref = registry.registerRemote({
			id: "RemoteChild",
			displayName: "remote child",
			kind: "sub",
			status: "running",
			identity: IDENTITY,
		});

		expect(Reflect.set(ref, "generation", 99)).toBe(false);
		expect(Reflect.set(ref, "remote", { ...IDENTITY, executionId: "other" })).toBe(false);
		expect(Reflect.set(ref, "id", "Alias")).toBe(false);
		expect(Reflect.set(ref, "locality", "local")).toBe(false);
		expect(Reflect.set(ref, "session", {})).toBe(false);
		expect(Reflect.set(ref, "sessionFile", "/tmp/local.jsonl")).toBe(false);
		expect(ref.generation).toBe(IDENTITY.generation);
		expect(ref.remote).toEqual(IDENTITY);
		expect(ref.id).toBe("RemoteChild");
		expect(ref.locality).toBe("remote");
		expect(ref.session).toBeNull();
		expect(ref.sessionFile).toBeNull();
		expect(() =>
			registry.registerRemote({
				id: "Alias",
				displayName: "alias",
				kind: "sub",
				status: "running",
				identity: { ...IDENTITY },
			}),
		).toThrow("already registered");
	});

	it("accepts identical progress replay, rejects conflicting duplicates, and clears identity watermarks on removal", async () => {
		let sequence = 2;
		let message = "same";
		const registry = new AgentRegistry({
			remoteBackend: backend({
				progress: async identity => ({ identity: { ...identity }, value: { sequence, message } }),
			}),
		});
		registerRemote(registry);
		await registry.refreshRemote("RemoteChild");
		await registry.refreshRemote("RemoteChild");

		message = "conflict";
		await expect(registry.refreshRemote("RemoteChild")).rejects.toThrow("conflicting duplicate");

		const ref = registry.get("RemoteChild");
		expect(ref).toBeDefined();
		registry.unregister("RemoteChild", ref);
		sequence = 0;
		message = "new registration";
		registerRemote(registry, "Replacement");
		await expect(registry.refreshRemote("Replacement")).resolves.toMatchObject({ id: "Replacement" });
	});

	it("routes hub cancellation through the remote backend without local abort, dispose, or lifecycle release", async () => {
		const cancel = vi.fn(async (identity: Readonly<RemoteAgentIdentity>) => ({
			identity: { ...identity },
			value: "cancelled" as const,
		}));
		const registry = new AgentRegistry({ remoteBackend: backend({ cancel }) });
		registerRemote(registry);
		const lifecycle = new AgentLifecycleManager(registry);
		const release = vi.spyOn(lifecycle, "release");
		const session: ToolSession = {
			cwd: "/tmp",
			hasUI: false,
			settings: Settings.isolated(),
			agentRegistry: registry,
			getAgentId: () => "Main",
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			agentLifecycle: () => lifecycle,
		};
		const manager = {
			getJob: () => undefined,
			getAllJobs: () => [],
			getRunningJobs: () => [],
			cancel: () => false,
			acknowledgeDeliveries: () => {},
		} as unknown as AsyncJobManager;

		const result = await executeCancel(session, manager, "Main", ["RemoteChild"]);

		expect(result.details?.cancelled).toEqual([{ id: "RemoteChild", status: "cancelled" }]);
		expect(cancel).toHaveBeenCalledTimes(1);
		expect(release).not.toHaveBeenCalled();
		expect(registry.get("RemoteChild")?.status).toBe("aborted");
	});
	it("surfaces remote cancellation rejection and deadline expiry as failed hub results", async () => {
		const rejectedRegistry = new AgentRegistry({
			remoteBackend: backend({ cancel: async () => Promise.reject(new Error("controller rejected")) }),
		});
		registerRemote(rejectedRegistry);
		const rejectedHarness = cancelHarness(rejectedRegistry);
		const rejected = await executeCancel(rejectedHarness.session, rejectedHarness.manager, "Main", ["RemoteChild"]);
		expect(rejected.isError).toBe(true);
		expect(rejected.details?.cancelled).toEqual([{ id: "RemoteChild", status: "failed" }]);
		expect(rejectedRegistry.get("RemoteChild")?.status).toBe("running");

		vi.useFakeTimers();
		try {
			const hangingRegistry = new AgentRegistry({
				remoteBackend: backend({
					cancel: async () => Promise.withResolvers<never>().promise,
				}),
			});
			registerRemote(hangingRegistry);
			const hangingHarness = cancelHarness(hangingRegistry);
			const timedOut = executeCancel(hangingHarness.session, hangingHarness.manager, "Main", ["RemoteChild"]);
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();
			vi.advanceTimersByTime(5_000);
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();
			const result = await timedOut;
			expect(result.isError).toBe(true);
			expect(result.details?.cancelled).toEqual([{ id: "RemoteChild", status: "failed" }]);
			expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("timed out") });
		} finally {
			vi.useRealTimers();
		}
	});
});
