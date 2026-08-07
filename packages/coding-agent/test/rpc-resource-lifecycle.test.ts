import { describe, expect, test } from "bun:test";
import {
	type RpcResourceLifecycleFrame,
	RpcResourceLifecycleManager,
	type RpcResourceManagerSource,
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
		this.statuses.delete(name);
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
		const manager = new RpcResourceLifecycleManager(source, () => {});

		manager.startRefresh("alpha", "request-1");
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

		expect(manager.cancel(started.operationId)).toBe(true);
		source.reconnectGate.resolve({});
		await settle(manager);
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
		expect(source.disconnected).toEqual(["alpha"]);
		expect(manager.snapshot().servers[0].state).toBe("disabled");
	});
});
