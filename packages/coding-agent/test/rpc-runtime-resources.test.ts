import { describe, expect, test } from "bun:test";
import type { DapSessionStatus } from "@oh-my-pi/pi-coding-agent/dap/types";
import type { ServerConfig } from "@oh-my-pi/pi-coding-agent/lsp/types";
import {
	type RpcResourceLifecycleFrame,
	RpcResourceLifecycleManager,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-resource-lifecycle";
import {
	type RpcRuntimeMcpSource,
	type RpcRuntimeResourceServices,
	RpcRuntimeResourceSource,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-runtime-resources";

const LSP_CONFIG_A: ServerConfig = { command: "lsp-a", fileTypes: [".ts"], rootMarkers: [] };
const LSP_CONFIG_B: ServerConfig = { command: "lsp-b", fileTypes: [".ts"], rootMarkers: [] };

class FakeRuntimeMcp implements RpcRuntimeMcpSource {
	readonly statuses = new Map<string, "connected" | "connecting" | "disconnected">();
	readonly disconnects: string[] = [];
	readonly reconnects: string[] = [];
	reconnectGate: PromiseWithResolvers<unknown | null> | undefined;
	reconnectFailure: "authentication_required" | "failed" | undefined;

	getAllServerNames(): string[] {
		return [...this.statuses.keys()];
	}

	getConnectionStatus(name: string): "connected" | "connecting" | "disconnected" {
		return this.statuses.get(name) ?? "disconnected";
	}

	getConnection(name: string) {
		return this.statuses.get(name) === "connected" ? { capabilities: { tools: {} } } : undefined;
	}

	getTools() {
		return [...this.statuses.keys()].map(name => ({ name: `${name}_tool`, mcpServerName: name }));
	}

	getServerResources(_name: string) {
		return undefined;
	}

	getServerPrompts(_name: string) {
		return undefined;
	}

	async reconnectServer(name: string): Promise<unknown | null> {
		this.reconnects.push(name);
		const connection = this.reconnectGate ? await this.reconnectGate.promise : {};
		if (connection) this.statuses.set(name, "connected");
		return connection;
	}

	getReconnectFailure(_name: string): "authentication_required" | "failed" | undefined {
		return this.reconnectFailure;
	}

	async refreshServerTools(_name: string): Promise<void> {}
	async refreshServerResources(_name: string): Promise<void> {}
	async refreshServerPrompts(_name: string): Promise<void> {}

	async disconnectServer(name: string): Promise<void> {
		this.disconnects.push(name);
		this.statuses.delete(name);
	}
}

class FakeRuntimeServices implements RpcRuntimeResourceServices {
	readonly lspByCwd = new Map<string, Array<[string, ServerConfig]>>();
	readonly activeLspClients: Array<{
		serverId?: string;
		status: "connecting" | "ready" | "error";
	}> = [];
	readonly dapByCwd = new Map<string, Array<{ name: string }>>();
	readonly dapSessions: Array<{ adapter: string; cwd: string; status: DapSessionStatus }> = [];
	readonly lspStarts: Array<{ config: ServerConfig; cwd: string; signal: AbortSignal }> = [];
	readonly lspShutdowns: string[] = [];
	readonly dapTerminations: Array<{ adapterName: string; cwd: string; signal?: AbortSignal }> = [];
	lspStartGate: PromiseWithResolvers<void> | undefined;
	shutdownResult = true;

	getLspServers(cwd: string): Array<[string, ServerConfig]> {
		return this.lspByCwd.get(cwd) ?? [];
	}

	getActiveLspClients() {
		return this.activeLspClients;
	}

	async startLsp(config: ServerConfig, cwd: string, signal: AbortSignal): Promise<void> {
		this.lspStarts.push({ config, cwd, signal });
		if (this.lspStartGate) await this.lspStartGate.promise;
	}

	async shutdownLsp(serverId: string): Promise<boolean> {
		this.lspShutdowns.push(serverId);
		return this.shutdownResult;
	}

	getDapAdapters(cwd: string): Array<{ name: string }> {
		return this.dapByCwd.get(cwd) ?? [];
	}

	getDapSessions() {
		return this.dapSessions;
	}

	async terminateDapAdapter(adapterName: string, cwd: string, signal?: AbortSignal): Promise<number> {
		this.dapTerminations.push({ adapterName, cwd, signal });
		return this.dapSessions.filter(session => session.adapter === adapterName && session.cwd === cwd).length;
	}
}

async function settle(manager: RpcResourceLifecycleManager): Promise<void> {
	await manager.waitForIdle();
	await Promise.resolve();
}

describe("RPC runtime resource source", () => {
	test("keeps prefixed MCP identifiers distinct from colliding LSP identifiers and routes disposal", async () => {
		const mcp = new FakeRuntimeMcp();
		mcp.statuses.set("lsp:foo", "connected");
		const services = new FakeRuntimeServices();
		services.lspByCwd.set("/workspace", [["foo", LSP_CONFIG_A]]);
		const source = new RpcRuntimeResourceSource("/workspace", mcp, services);
		const manager = new RpcResourceLifecycleManager(source, () => {});

		const snapshot = manager.snapshot();
		expect(snapshot.servers.map(server => [server.serverId, server.kind])).toEqual([
			["lsp:foo", "lsp"],
			["mcp:lsp:foo", "mcp"],
		]);
		expect(snapshot.servers.find(server => server.serverId === "mcp:lsp:foo")?.tools.total).toBe(1);
		await manager.disposeServer("mcp:lsp:foo");
		expect(mcp.disconnects).toEqual(["lsp:foo"]);
		expect(services.lspShutdowns).toEqual([]);
	});

	test("resolves the active cwd at every effect boundary", async () => {
		let cwd = "/workspace-a";
		const services = new FakeRuntimeServices();
		services.lspByCwd.set(cwd, [["alpha", LSP_CONFIG_A]]);
		services.lspByCwd.set("/workspace-b", [["beta", LSP_CONFIG_B]]);
		services.dapByCwd.set("/workspace-a", [{ name: "a-debug" }]);
		services.dapByCwd.set("/workspace-b", [{ name: "b-debug" }]);
		const source = new RpcRuntimeResourceSource(() => cwd, undefined, services);

		expect(source.getAllServerNames()).toEqual(["lsp:alpha", "dap:a-debug"]);
		cwd = "/workspace-b";
		expect(source.getAllServerNames()).toEqual(["lsp:beta", "dap:b-debug"]);
		await source.disconnectServer("lsp:beta");
		expect(services.lspShutdowns).toEqual(["lsp-b:/workspace-b"]);
	});

	test("propagates LSP shutdown failure, fails the operation, and never starts a replacement", async () => {
		const services = new FakeRuntimeServices();
		services.lspByCwd.set("/workspace", [["foo", LSP_CONFIG_A]]);
		services.shutdownResult = false;
		const frames: RpcResourceLifecycleFrame[] = [];
		const manager = new RpcResourceLifecycleManager(
			new RpcRuntimeResourceSource("/workspace", undefined, services),
			frame => frames.push(frame),
		);

		const refresh = manager.startRefresh("lsp:foo", "refresh");
		await settle(manager);
		expect(services.lspStarts).toEqual([]);
		expect(frames).toContainEqual(
			expect.objectContaining({
				type: "resource_operation",
				operationId: refresh.operationId,
				outcome: "failed",
			}),
		);
		await expect(manager.disposeServer("lsp:foo", "dispose")).rejects.toThrow("did not terminate");
		expect(frames).toContainEqual(
			expect.objectContaining({
				type: "resource_operation",
				requestId: "dispose",
				outcome: "failed",
			}),
		);
	});

	test("rejects an already-aborted LSP refresh before shutdown", async () => {
		const services = new FakeRuntimeServices();
		services.lspByCwd.set("/workspace", [["foo", LSP_CONFIG_A]]);
		const source = new RpcRuntimeResourceSource("/workspace", undefined, services);
		const controller = new AbortController();
		controller.abort(new Error("cancelled"));

		await expect(source.refreshLifecycle("lsp:foo", controller.signal)).rejects.toThrow("cancelled");
		expect(services.lspShutdowns).toEqual([]);
		expect(services.lspStarts).toEqual([]);
	});

	test("passes cancellation to LSP initialization and compensates stale rebind completion", async () => {
		const services = new FakeRuntimeServices();
		services.lspByCwd.set("/workspace", [["foo", LSP_CONFIG_A]]);
		services.lspStartGate = Promise.withResolvers<void>();
		const source = new RpcRuntimeResourceSource("/workspace", undefined, services);
		const controller = new AbortController();

		const refresh = source.refreshLifecycle("lsp:foo", controller.signal);
		await Promise.resolve();
		await Promise.resolve();
		expect(services.lspStarts[0]?.signal).toBe(controller.signal);
		source.rebind();
		services.lspStartGate.resolve();
		await expect(refresh).rejects.toThrow("authority changed");
		expect(services.lspShutdowns).toEqual(["lsp-a:/workspace", "lsp-a:/workspace"]);
	});

	test("compensates stale MCP reconnects through the captured authority", async () => {
		const oldMcp = new FakeRuntimeMcp();
		oldMcp.statuses.set("alpha", "disconnected");
		oldMcp.reconnectGate = Promise.withResolvers<unknown | null>();
		const newMcp = new FakeRuntimeMcp();
		newMcp.statuses.set("alpha", "connected");
		const source = new RpcRuntimeResourceSource("/old-workspace", oldMcp, new FakeRuntimeServices());

		const reconnect = source.reconnectServer("mcp:alpha");
		await Promise.resolve();
		source.rebind({ getCwd: () => "/new-workspace", mcp: newMcp });
		oldMcp.reconnectGate.resolve({});

		await expect(reconnect).rejects.toThrow("authority changed");
		expect(oldMcp.disconnects).toEqual(["alpha"]);
		expect(newMcp.disconnects).toEqual([]);
	});

	test("compensates an MCP reconnect that finishes after lifecycle disposal", async () => {
		const mcp = new FakeRuntimeMcp();
		mcp.statuses.set("alpha", "disconnected");
		mcp.reconnectGate = Promise.withResolvers<unknown | null>();
		const manager = new RpcResourceLifecycleManager(
			new RpcRuntimeResourceSource("/workspace", mcp, new FakeRuntimeServices()),
			() => {},
		);

		manager.startRefresh("mcp:alpha", "refresh");
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();
		expect(mcp.reconnects).toEqual(["alpha"]);
		const disposal = manager.disposeServer("mcp:alpha", "dispose");
		mcp.reconnectGate.resolve({});
		await disposal;
		await settle(manager);

		expect(mcp.disconnects).toEqual(["alpha", "alpha"]);
		expect(mcp.getConnectionStatus("alpha")).toBe("disconnected");
		expect(manager.snapshot().servers[0].state).toBe("disabled");
	});

	test("maps DAP launching and configuring to connecting within the active cwd", async () => {
		const services = new FakeRuntimeServices();
		services.dapByCwd.set("/workspace", [{ name: "gdb" }]);
		const activeSession: { adapter: string; cwd: string; status: DapSessionStatus } = {
			adapter: "gdb",
			cwd: "/workspace",
			status: "launching",
		};
		services.dapSessions.push({ adapter: "gdb", cwd: "/old-workspace", status: "running" }, activeSession);
		const source = new RpcRuntimeResourceSource("/workspace", undefined, services);
		const manager = new RpcResourceLifecycleManager(source, () => {});

		expect(manager.snapshot().servers[0].state).toBe("connecting");
		activeSession.status = "configuring";
		expect(manager.snapshot().servers[0].state).toBe("connecting");
		activeSession.status = "running";
		expect(manager.snapshot().servers[0].state).toBe("connected");
		await source.disconnectServer("dap:gdb");
		expect(services.dapTerminations).toEqual([expect.objectContaining({ adapterName: "gdb", cwd: "/workspace" })]);
	});

	test("projects MCP authentication-required reconnect classification and failed operation truthfully", async () => {
		const mcp = new FakeRuntimeMcp();
		mcp.statuses.set("auth", "disconnected");
		mcp.reconnectFailure = "authentication_required";
		mcp.reconnectGate = Promise.withResolvers<unknown | null>();
		mcp.reconnectGate.resolve(null);
		const services = new FakeRuntimeServices();
		const frames: RpcResourceLifecycleFrame[] = [];
		const manager = new RpcResourceLifecycleManager(
			new RpcRuntimeResourceSource("/workspace", mcp, services),
			frame => frames.push(frame),
		);

		const operation = manager.startRefresh("mcp:auth", "auth");
		await settle(manager);
		expect(manager.snapshot().servers[0]).toMatchObject({
			serverId: "mcp:auth",
			state: "authentication_required",
			diagnostics: [{ code: "authentication_required" }],
		});
		expect(frames).toContainEqual(
			expect.objectContaining({
				type: "resource_operation",
				operationId: operation.operationId,
				outcome: "failed",
			}),
		);
	});
});
