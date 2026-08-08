import { getAvailableAdapters } from "../../dap/config";
import { dapSessionManager } from "../../dap/session";
import { getActiveClients, getOrCreateClient, shutdownClient } from "../../lsp/client";
import { getConfig, getLspServers } from "../../lsp/servers";
import type { MCPManager } from "../../mcp";
import type { RpcResourceKind, RpcResourceLifecycleState, RpcResourceManagerSource } from "./rpc-resource-lifecycle";

const LSP_PREFIX = "lsp:";
const DAP_PREFIX = "dap:";

/** Projects every OMP-owned MCP, LSP, and DAP process through one lifecycle boundary. */
export class RpcRuntimeResourceSource implements RpcResourceManagerSource {
	readonly #cwd: string;
	readonly #mcp: MCPManager | undefined;

	constructor(cwd: string, mcp?: MCPManager) {
		this.#cwd = cwd;
		this.#mcp = mcp;
	}

	getAllServerNames(): string[] {
		const mcp = this.#mcp?.getAllServerNames() ?? [];
		const lsp = getLspServers(getConfig(this.#cwd)).map(([name]) => `${LSP_PREFIX}${name}`);
		const dap = getAvailableAdapters(this.#cwd).map(adapter => `${DAP_PREFIX}${adapter.name}`);
		return [...mcp, ...lsp, ...dap];
	}

	getResourceKind(serverId: string): RpcResourceKind {
		if (serverId.startsWith(LSP_PREFIX)) return "lsp";
		if (serverId.startsWith(DAP_PREFIX)) return "dap";
		return "mcp";
	}

	getConnectionStatus(serverId: string): "connected" | "connecting" | "disconnected" {
		if (serverId.startsWith(LSP_PREFIX)) {
			const name = serverId.slice(LSP_PREFIX.length);
			const server = getLspServers(getConfig(this.#cwd)).find(([candidate]) => candidate === name);
			if (!server) return "disconnected";
			const [, config] = server;
			const status = getActiveClients().find(client => client.serverId === `${config.command}:${this.#cwd}`)?.status;
			if (status === "ready") return "connected";
			if (status === "connecting") return "connecting";
			return "disconnected";
		}
		if (serverId.startsWith(DAP_PREFIX)) {
			const adapter = serverId.slice(DAP_PREFIX.length);
			return dapSessionManager
				.listSessions()
				.some(session => session.adapter === adapter && session.status !== "terminated")
				? "connected"
				: "disconnected";
		}
		return this.#mcp?.getConnectionStatus(serverId) ?? "disconnected";
	}

	async refreshLifecycle(serverId: string): Promise<RpcResourceLifecycleState | undefined> {
		if (serverId.startsWith(LSP_PREFIX)) {
			const name = serverId.slice(LSP_PREFIX.length);
			const server = getLspServers(getConfig(this.#cwd)).find(([candidate]) => candidate === name);
			if (!server) return "failed";
			const [, config] = server;
			await shutdownClient(`${config.command}:${this.#cwd}`);
			try {
				await getOrCreateClient(config, this.#cwd, config.warmupTimeoutMs);
				return "connected";
			} catch {
				return "failed";
			}
		}
		if (serverId.startsWith(DAP_PREFIX)) {
			return this.getConnectionStatus(serverId) === "connected" ? "connected" : "discovered";
		}
		return undefined;
	}

	getConnection(serverId: string) {
		return this.getResourceKind(serverId) === "mcp" ? this.#mcp?.getConnection(serverId) : undefined;
	}

	getTools() {
		return this.#mcp?.getTools() ?? [];
	}

	getServerResources(serverId: string) {
		return this.getResourceKind(serverId) === "mcp" ? this.#mcp?.getServerResources(serverId) : undefined;
	}

	getServerPrompts(serverId: string) {
		return this.getResourceKind(serverId) === "mcp" ? this.#mcp?.getServerPrompts(serverId) : undefined;
	}

	reconnectServer(serverId: string, options?: { manual?: boolean }): Promise<unknown | null> {
		if (!this.#mcp || this.getResourceKind(serverId) !== "mcp") return Promise.resolve(null);
		return this.#mcp.reconnectServer(serverId, options);
	}

	async refreshServerTools(serverId: string): Promise<void> {
		if (this.#mcp && this.getResourceKind(serverId) === "mcp") await this.#mcp.refreshServerTools(serverId);
	}

	async refreshServerResources(serverId: string): Promise<void> {
		if (this.#mcp && this.getResourceKind(serverId) === "mcp") await this.#mcp.refreshServerResources(serverId);
	}

	async refreshServerPrompts(serverId: string): Promise<void> {
		if (this.#mcp && this.getResourceKind(serverId) === "mcp") await this.#mcp.refreshServerPrompts(serverId);
	}

	async disconnectServer(serverId: string): Promise<void> {
		if (serverId.startsWith(LSP_PREFIX)) {
			const name = serverId.slice(LSP_PREFIX.length);
			const server = getLspServers(getConfig(this.#cwd)).find(([candidate]) => candidate === name);
			if (server) await shutdownClient(`${server[1].command}:${this.#cwd}`);
			return;
		}
		if (serverId.startsWith(DAP_PREFIX)) {
			await dapSessionManager.terminateAdapter(serverId.slice(DAP_PREFIX.length));
			return;
		}
		if (this.#mcp) await this.#mcp.disconnectServer(serverId);
	}
}
