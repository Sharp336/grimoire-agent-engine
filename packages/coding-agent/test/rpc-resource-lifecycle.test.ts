import { describe, expect, test } from "bun:test";
import {
	type RpcResourceLifecycleFrame,
	RpcResourceLifecycleManager,
	type RpcResourceLifecycleState,
	type RpcResourceManagerSource,
	RpcResourceNotFoundError,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-resource-lifecycle";

class FakeResourceSource implements RpcResourceManagerSource {
	readonly statuses = new Map<string, "connected" | "connecting" | "disconnected">([["alpha", "disconnected"]]);
	readonly tools = [{ name: "alpha_search", description: "Search", mcpServerName: "alpha" }];
	readonly resources = new Map([
		[
			"alpha",
			{
				resources: [{ uri: "docs://one", name: "One", mimeType: "text/plain" }],
				templates: [{ uriTemplate: "docs://{id}", name: "By id" }],
			},
		],
	]);
	readonly prompts = new Map([["alpha", [{ name: "summarize", description: "Summarize" }]]]);
	readonly failures = new Set<string>();
	readonly reconnects: string[] = [];
	readonly disconnected: string[] = [];
	reconnectGate: PromiseWithResolvers<object | null> | undefined;
	disconnectGate: PromiseWithResolvers<void> | undefined;

	getAllServerNames(): string[] {
		return [...this.statuses.keys()];
	}
	getConnectionStatus(name: string): "connected" | "connecting" | "disconnected" {
		return this.statuses.get(name) ?? "disconnected";
	}
	getConnection(name: string) {
		if (this.statuses.get(name) !== "connected") return undefined;
		return { capabilities: { tools: {}, resources: {}, prompts: {} } };
	}
	getTools() {
		return this.tools;
	}
	getServerResources(name: string) {
		return this.resources.get(name);
	}
	getServerPrompts(name: string) {
		return this.prompts.get(name);
	}
	async reconnectServer(name: string): Promise<object | null> {
		this.reconnects.push(name);
		if (this.failures.has("auth")) throw new Error("401 Unauthorized");
		if (this.failures.has("reconnect")) throw new Error("socket closed");
		const result = this.reconnectGate ? await this.reconnectGate.promise : {};
		if (result) this.statuses.set(name, "connected");
		return result;
	}
	async refreshServerTools(_name: string): Promise<void> {
		if (this.failures.has("tools")) throw new Error("tools failed");
	}
	async refreshServerResources(_name: string): Promise<void> {
		if (this.failures.has("resources")) throw new Error("resources failed");
	}
	async refreshServerPrompts(_name: string): Promise<void> {
		if (this.failures.has("prompts")) throw new Error("prompts failed");
	}
	async disconnectServer(name: string): Promise<void> {
		this.disconnected.push(name);
		if (this.disconnectGate) await this.disconnectGate.promise;
		if (this.failures.has("disconnect")) throw new Error("disconnect failed");
		this.statuses.delete(name);
	}
}

class FakeHostResourceSource extends FakeResourceSource {
	constructor() {
		super();
		this.statuses.clear();
		this.statuses.set("lsp:typescript", "disconnected");
		this.statuses.set("dap:gdb", "disconnected");
	}

	getResourceKind(serverId: string): "lsp" | "dap" {
		return serverId.startsWith("lsp:") ? "lsp" : "dap";
	}

	async refreshLifecycle(serverId: string): Promise<RpcResourceLifecycleState> {
		const state = serverId.startsWith("lsp:") ? "connected" : "discovered";
		this.statuses.set(serverId, state === "connected" ? "connected" : "disconnected");
		return state;
	}
}

async function settle(manager: RpcResourceLifecycleManager): Promise<void> {
	await manager.waitForIdle();
	await Promise.resolve();
}

describe("RPC resource lifecycle", () => {
	test("projects discovery, connection state, tools, resources, prompts, and capabilities", () => {
		const source = new FakeResourceSource();
		const manager = new RpcResourceLifecycleManager(source, () => {});

		expect(manager.snapshot()).toMatchObject({
			servers: [
				{
					serverId: "alpha",
					state: "discovered",
					capabilities: { tools: false, resources: false, prompts: false },
					tools: { total: 1, items: [{ name: "alpha_search", description: "Search" }] },
					resources: { total: 1, items: [{ uri: "docs://one", name: "One", mediaType: "text/plain" }] },
					resourceTemplates: { total: 1, items: [{ uriTemplate: "docs://{id}", name: "By id" }] },
					prompts: { total: 1, items: [{ name: "summarize", description: "Summarize" }] },
				},
			],
		});

		source.statuses.set("alpha", "connecting");
		expect(manager.snapshot().servers[0].state).toBe("connecting");
		source.statuses.set("alpha", "connected");
		expect(manager.snapshot().servers[0]).toMatchObject({
			state: "connected",
			capabilities: { tools: true, resources: true, prompts: true },
		});
	});

	test("reconnects disconnected servers and emits correlated lifecycle transitions", async () => {
		const source = new FakeResourceSource();
		const frames: RpcResourceLifecycleFrame[] = [];
		const manager = new RpcResourceLifecycleManager(source, frame => frames.push(frame));

		const started = manager.startRefresh("alpha", "request-1");
		expect(started.operationId).toStartWith("resource_");
		expect(manager.snapshot().servers[0].state).toBe("reconnecting");
		await settle(manager);

		expect(source.reconnects).toEqual(["alpha"]);
		expect(manager.snapshot().servers[0].state).toBe("connected");
		expect(frames).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "resource_lifecycle",
					operationId: started.operationId,
					state: "reconnecting",
				}),
				expect.objectContaining({
					type: "resource_lifecycle",
					operationId: started.operationId,
					state: "connected",
				}),
				expect.objectContaining({
					type: "resource_operation",
					operationId: started.operationId,
					outcome: "completed",
				}),
			]),
		);
	});

	test("isolates per-kind refresh failures and exposes secret-safe diagnostics", async () => {
		const source = new FakeResourceSource();
		source.statuses.set("alpha", "connected");
		source.failures.add("resources");
		const frames: RpcResourceLifecycleFrame[] = [];
		const manager = new RpcResourceLifecycleManager(source, frame => frames.push(frame));

		const operation = manager.startRefresh("alpha", "request-1");
		await settle(manager);

		expect(manager.snapshot().servers[0]).toMatchObject({
			state: "connected",
			diagnostics: [
				{
					severity: "error",
					code: "resource_refresh_failed",
					message: "Failed to refresh resource metadata",
				},
			],
		});
		expect(frames).toContainEqual(
			expect.objectContaining({
				type: "resource_operation",
				operationId: operation.operationId,
				outcome: "failed",
			}),
		);
	});

	test("distinguishes authentication-required and ordinary failures", async () => {
		const authSource = new FakeResourceSource();
		authSource.failures.add("auth");
		const authManager = new RpcResourceLifecycleManager(authSource, () => {});
		authManager.startRefresh("alpha", "auth-request");
		await settle(authManager);
		expect(authManager.snapshot().servers[0]).toMatchObject({
			state: "authentication_required",
			diagnostics: [{ code: "authentication_required", message: "Authentication is required" }],
		});

		const failedSource = new FakeResourceSource();
		failedSource.failures.add("reconnect");
		const failedManager = new RpcResourceLifecycleManager(failedSource, () => {});
		failedManager.startRefresh("alpha", "failed-request");
		await settle(failedManager);
		expect(failedManager.snapshot().servers[0]).toMatchObject({
			state: "failed",
			diagnostics: [{ code: "connection_failed", message: "Resource connection failed" }],
		});
	});

	test("cancels operations and disposes only resources owned by this manager", async () => {
		const source = new FakeResourceSource();
		source.reconnectGate = Promise.withResolvers<object | null>();
		const frames: RpcResourceLifecycleFrame[] = [];
		const manager = new RpcResourceLifecycleManager(source, frame => frames.push(frame));
		const started = manager.startRefresh("alpha", "request-1");
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();
		expect(source.reconnects).toEqual(["alpha"]);

		expect(manager.cancel(started.operationId)).toBe(true);
		expect(frames).not.toContainEqual(
			expect.objectContaining({
				type: "resource_operation",
				operationId: started.operationId,
			}),
		);
		source.reconnectGate.resolve({});
		await settle(manager);
		expect(source.disconnected).toEqual(["alpha"]);
		expect(frames).toContainEqual(
			expect.objectContaining({
				type: "resource_operation",
				operationId: started.operationId,
				outcome: "cancelled",
			}),
		);

		await expect(manager.disposeServer("unknown", "request-2")).rejects.toMatchObject({
			code: "resource_not_found",
		});
		await manager.disposeServer("alpha", "request-3");
		expect(source.disconnected).toEqual(["alpha", "alpha"]);
		expect(manager.snapshot().servers[0].state).toBe("disabled");
	});
	test("projects and refreshes OMP-owned LSP and DAP lifecycles without MCP metadata", async () => {
		const source = new FakeHostResourceSource();
		const manager = new RpcResourceLifecycleManager(source, () => {});

		expect(manager.snapshot().servers).toEqual([
			expect.objectContaining({
				serverId: "dap:gdb",
				kind: "dap",
				state: "discovered",
				capabilities: { tools: false, resources: false, prompts: false },
			}),
			expect.objectContaining({
				serverId: "lsp:typescript",
				kind: "lsp",
				state: "discovered",
				capabilities: { tools: false, resources: false, prompts: false },
			}),
		]);

		manager.startRefresh("lsp:typescript", "request-lsp");
		manager.startRefresh("dap:gdb", "request-dap");
		await settle(manager);

		expect(manager.snapshot().servers).toEqual([
			expect.objectContaining({ serverId: "dap:gdb", kind: "dap", state: "discovered" }),
			expect.objectContaining({ serverId: "lsp:typescript", kind: "lsp", state: "connected" }),
		]);
		expect(source.reconnects).toEqual([]);
	});
	test("serializes concurrent effects for the same server", async () => {
		const source = new FakeResourceSource();
		source.reconnectGate = Promise.withResolvers<object | null>();
		const manager = new RpcResourceLifecycleManager(source, () => {});

		manager.startRefresh("alpha", "first");
		manager.startRefresh("alpha", "second");
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();
		expect(source.reconnects).toEqual(["alpha"]);

		source.reconnectGate.resolve({});
		await settle(manager);
		expect(source.reconnects).toEqual(["alpha"]);
		expect(manager.snapshot().servers[0].state).toBe("connected");
	});

	test("settles targeted and aggregate refresh operations as failed when any requested server fails", async () => {
		const source = new FakeResourceSource();
		source.statuses.set("beta", "disconnected");
		source.failures.add("reconnect");
		const frames: RpcResourceLifecycleFrame[] = [];
		const manager = new RpcResourceLifecycleManager(source, frame => frames.push(frame));

		const targeted = manager.startRefresh("alpha", "targeted");
		await settle(manager);
		expect(frames).toContainEqual(
			expect.objectContaining({
				type: "resource_operation",
				operationId: targeted.operationId,
				outcome: "failed",
			}),
		);

		const aggregate = manager.startRefresh(undefined, "aggregate");
		await settle(manager);
		expect(frames).toContainEqual(
			expect.objectContaining({
				type: "resource_operation",
				operationId: aggregate.operationId,
				outcome: "failed",
				serverIds: ["alpha", "beta"],
			}),
		);
	});

	test("fences disposal before cancellation and waits for the physical reconnect effect", async () => {
		const source = new FakeResourceSource();
		source.reconnectGate = Promise.withResolvers<object | null>();
		const frames: RpcResourceLifecycleFrame[] = [];
		const manager = new RpcResourceLifecycleManager(source, frame => frames.push(frame));
		const refresh = manager.startRefresh("alpha", "refresh");
		const queuedRefresh = manager.startRefresh("alpha", "queued-refresh");
		let reloadRuns = 0;
		const queuedReload = manager.startReload(async () => {
			reloadRuns++;
		}, "queued-reload");
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();
		expect(source.reconnects).toEqual(["alpha"]);

		const disposal = manager.disposeServer("alpha", "dispose");
		await Promise.resolve();
		expect(source.disconnected).toEqual([]);
		source.reconnectGate.resolve({});
		await disposal;
		await settle(manager);

		expect(source.statuses.has("alpha")).toBe(false);
		expect(source.reconnects).toEqual(["alpha"]);
		expect(reloadRuns).toBe(0);
		expect(manager.snapshot().servers[0].state).toBe("disabled");
		expect(frames).toContainEqual(
			expect.objectContaining({
				type: "resource_operation",
				operationId: refresh.operationId,
				outcome: "cancelled",
			}),
		);
		expect(frames).toContainEqual(
			expect.objectContaining({
				type: "resource_operation",
				operationId: queuedRefresh.operationId,
				outcome: "cancelled",
			}),
		);
		expect(frames).toContainEqual(
			expect.objectContaining({
				type: "resource_operation",
				operationId: queuedReload.operationId,
				outcome: "cancelled",
			}),
		);
	});

	test("reports disposal failure and never claims the resource is disabled", async () => {
		const source = new FakeResourceSource();
		source.failures.add("disconnect");
		const frames: RpcResourceLifecycleFrame[] = [];
		const manager = new RpcResourceLifecycleManager(source, frame => frames.push(frame));

		await expect(manager.disposeServer("alpha", "dispose")).rejects.toThrow("disconnect failed");
		expect(manager.snapshot().servers[0].state).toBe("failed");
		expect(frames).toContainEqual(
			expect.objectContaining({
				type: "resource_operation",
				requestId: "dispose",
				kind: "dispose",
				outcome: "failed",
			}),
		);
	});

	test("reactivates a disposed server only when reload rediscovers it", async () => {
		const source = new FakeResourceSource();
		const manager = new RpcResourceLifecycleManager(source, () => {});
		await manager.disposeServer("alpha");
		expect(manager.snapshot().servers[0].state).toBe("disabled");
		expect(() => manager.startRefresh("alpha")).toThrow(RpcResourceNotFoundError);

		manager.startReload(async () => {
			source.statuses.set("alpha", "connected");
		});
		await settle(manager);
		expect(manager.snapshot().servers[0].state).toBe("connected");

		source.reconnects.length = 0;
		manager.startRefresh();
		await settle(manager);
		expect(source.reconnects).toEqual([]);
	});

	test("shares global disposal settlement and waits for every physical teardown", async () => {
		const source = new FakeResourceSource();
		source.statuses.set("beta", "connected");
		const manager = new RpcResourceLifecycleManager(source, () => {});

		const first = manager.dispose();
		const second = manager.dispose();
		expect(second).toBe(first);
		await first;
		expect(source.disconnected).toEqual(["alpha", "beta"]);
	});

	test("drain waits for an already-accepted physical server teardown", async () => {
		const source = new FakeResourceSource();
		source.disconnectGate = Promise.withResolvers<void>();
		const manager = new RpcResourceLifecycleManager(source, () => {});
		let disposed = false;
		const disposal = manager.disposeServer("alpha").finally(() => {
			disposed = true;
		});
		await Promise.resolve();
		await Promise.resolve();
		expect(source.disconnected).toEqual(["alpha"]);

		let drained = false;
		const drain = manager.drain().finally(() => {
			drained = true;
		});
		await Promise.resolve();
		expect(drained).toBe(false);

		source.disconnectGate.resolve();
		await drain;
		expect(disposed).toBe(true);
		expect(drained).toBe(true);
		await disposal;
	});

	test("drains accepted effects before replacing the source binding", async () => {
		const source = new FakeResourceSource();
		source.reconnectGate = Promise.withResolvers<object | null>();
		const manager = new RpcResourceLifecycleManager(source, () => {});
		manager.startRefresh("alpha");
		await Promise.resolve();

		const drain = manager.drain();
		expect(() => manager.startRefresh("alpha")).toThrow("draining");
		source.reconnectGate.resolve({});
		await drain;
		expect(() => manager.startRefresh("alpha")).toThrow("draining");

		const replacement = new FakeResourceSource();
		replacement.statuses.clear();
		replacement.statuses.set("beta", "connected");
		manager.rebind(replacement);
		expect(manager.snapshot().servers.map(server => server.serverId)).toEqual(["beta"]);
	});
});
