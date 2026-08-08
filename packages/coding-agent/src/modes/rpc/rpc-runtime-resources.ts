import { getAvailableAdapters } from "../../dap/config";
import { dapSessionManager } from "../../dap/session";
import type { DapSessionStatus } from "../../dap/types";
import { getActiveClients, getOrCreateClient, shutdownClient } from "../../lsp/client";
import { getConfig, getLspServers } from "../../lsp/servers";
import type { ServerConfig } from "../../lsp/types";
import type {
	RpcResourceItemSource,
	RpcResourceKind,
	RpcResourceLifecycleState,
	RpcResourceManagerSource,
	RpcResourcePromptSource,
	RpcResourceTemplateSource,
	RpcResourceToolSource,
} from "./rpc-resource-lifecycle";
import { RpcResourceAuthenticationRequiredError } from "./rpc-resource-lifecycle";

const MCP_PREFIX = "mcp:";
const LSP_PREFIX = "lsp:";
const DAP_PREFIX = "dap:";

export interface RpcRuntimeMcpSource {
	getAllServerNames(): string[];
	getConnectionStatus(name: string): "connected" | "connecting" | "disconnected";
	getConnection(name: string):
		| {
				capabilities: {
					tools?: unknown;
					resources?: unknown;
					prompts?: unknown;
				};
		  }
		| undefined;
	getTools(): RpcResourceToolSource[];
	getServerResources(
		name: string,
	): { resources: RpcResourceItemSource[]; templates: RpcResourceTemplateSource[] } | undefined;
	getServerPrompts(name: string): RpcResourcePromptSource[] | undefined;
	reconnectServer(name: string, options?: { manual?: boolean }): Promise<unknown | null>;
	getReconnectFailure?(name: string): "authentication_required" | "failed" | undefined;
	refreshServerTools(name: string): Promise<void>;
	refreshServerResources(name: string): Promise<void>;
	refreshServerPrompts(name: string): Promise<void>;
	disconnectServer(name: string): Promise<void>;
}

export interface RpcRuntimeResourceServices {
	getLspServers(cwd: string): Array<[string, ServerConfig]>;
	getActiveLspClients(): Array<{
		serverId?: string;
		status: "connecting" | "ready" | "error";
	}>;
	startLsp(config: ServerConfig, cwd: string, signal: AbortSignal): Promise<void>;
	shutdownLsp(serverId: string): Promise<boolean>;
	getDapAdapters(cwd: string): Array<{ name: string }>;
	getDapSessions(): Array<{ adapter: string; cwd: string; status: DapSessionStatus }>;
	terminateDapAdapter(adapterName: string, cwd: string, signal?: AbortSignal): Promise<number>;
}

const runtimeServices: RpcRuntimeResourceServices = {
	getLspServers: cwd => getLspServers(getConfig(cwd)),
	getActiveLspClients: getActiveClients,
	async startLsp(config, cwd, signal) {
		await getOrCreateClient(config, cwd, config.warmupTimeoutMs, signal);
	},
	shutdownLsp: shutdownClient,
	getDapAdapters: getAvailableAdapters,
	getDapSessions: () => dapSessionManager.listSessions(),
	terminateDapAdapter: (adapterName, cwd, signal) =>
		dapSessionManager.terminateAdapter(adapterName, signal, undefined, cwd),
};

interface RuntimeEffectToken {
	bindingGeneration: number;
	serverGeneration: number;
}

/** Projects every OMP-owned MCP, LSP, and DAP process through one lifecycle boundary. */
export class RpcRuntimeResourceSource implements RpcResourceManagerSource {
	#getCwd: () => string;
	#mcp: RpcRuntimeMcpSource | undefined;
	readonly #services: RpcRuntimeResourceServices;
	readonly #serverGenerations = new Map<string, number>();
	#bindingGeneration = 0;

	constructor(
		cwd: string | (() => string),
		mcp?: RpcRuntimeMcpSource,
		services: RpcRuntimeResourceServices = runtimeServices,
	) {
		this.#getCwd = typeof cwd === "string" ? () => cwd : cwd;
		this.#mcp = mcp;
		this.#services = services;
	}

	/**
	 * Invalidate every captured effect. A replacement binding may supply both
	 * the active-session cwd getter and its MCP authority.
	 */
	rebind(binding?: { getCwd: () => string; mcp?: RpcRuntimeMcpSource }): void {
		this.#bindingGeneration++;
		this.#serverGenerations.clear();
		if (binding) {
			this.#getCwd = binding.getCwd;
			this.#mcp = binding.mcp;
		}
	}

	getAllServerNames(): string[] {
		const cwd = this.#getCwd();
		const mcp = (this.#mcp?.getAllServerNames() ?? []).map(name => `${MCP_PREFIX}${name}`);
		const lsp = this.#services.getLspServers(cwd).map(([name]) => `${LSP_PREFIX}${name}`);
		const dap = this.#services.getDapAdapters(cwd).map(adapter => `${DAP_PREFIX}${adapter.name}`);
		return [...mcp, ...lsp, ...dap];
	}

	getResourceKind(serverId: string): RpcResourceKind {
		if (serverId.startsWith(MCP_PREFIX)) return "mcp";
		if (serverId.startsWith(LSP_PREFIX)) return "lsp";
		if (serverId.startsWith(DAP_PREFIX)) return "dap";
		throw new Error(`Invalid resource server identifier: ${serverId}`);
	}

	getConnectionStatus(serverId: string): "connected" | "connecting" | "disconnected" {
		const kind = this.getResourceKind(serverId);
		if (kind === "lsp") {
			const cwd = this.#getCwd();
			const config = this.#findLspConfig(serverId, cwd);
			if (!config) return "disconnected";
			const status = this.#services
				.getActiveLspClients()
				.find(client => client.serverId === `${config.command}:${cwd}`)?.status;
			if (status === "ready") return "connected";
			if (status === "connecting") return "connecting";
			return "disconnected";
		}
		if (kind === "dap") {
			const cwd = this.#getCwd();
			const adapter = serverId.slice(DAP_PREFIX.length);
			const statuses = this.#services
				.getDapSessions()
				.filter(session => session.cwd === cwd && session.adapter === adapter)
				.map(session => session.status);
			if (statuses.some(status => status === "running" || status === "stopped")) return "connected";
			if (statuses.some(status => status === "launching" || status === "configuring")) return "connecting";
			return "disconnected";
		}
		return this.#mcp?.getConnectionStatus(serverId.slice(MCP_PREFIX.length)) ?? "disconnected";
	}

	async refreshLifecycle(serverId: string, signal: AbortSignal): Promise<RpcResourceLifecycleState | undefined> {
		const kind = this.getResourceKind(serverId);
		if (kind === "lsp") {
			const token = this.#captureToken(serverId);
			const cwd = this.#getCwd();
			const config = this.#findLspConfig(serverId, cwd);
			if (!config) return "failed";
			const clientId = `${config.command}:${cwd}`;
			this.#throwIfStale(serverId, token, signal);
			const stopped = await this.#services.shutdownLsp(clientId);
			if (!stopped) throw new Error(`LSP server ${serverId} did not terminate`);
			this.#throwIfStale(serverId, token, signal);
			await this.#services.startLsp(config, cwd, signal);
			if (!this.#isCurrent(serverId, token) || signal.aborted) {
				const compensated = await this.#services.shutdownLsp(clientId);
				if (!compensated) throw new Error(`Stale LSP server ${serverId} did not terminate`);
				this.#throwIfStale(serverId, token, signal);
			}
			return "connected";
		}
		if (kind === "dap") {
			const status = this.getConnectionStatus(serverId);
			return status === "connected" ? "connected" : status === "connecting" ? "connecting" : "discovered";
		}
		return undefined;
	}

	getConnection(serverId: string) {
		return this.getResourceKind(serverId) === "mcp"
			? this.#mcp?.getConnection(serverId.slice(MCP_PREFIX.length))
			: undefined;
	}

	getTools(): RpcResourceToolSource[] {
		return (this.#mcp?.getTools() ?? []).map(tool => ({
			...tool,
			...(tool.mcpServerName === undefined ? {} : { mcpServerName: `${MCP_PREFIX}${tool.mcpServerName}` }),
		}));
	}

	getServerResources(serverId: string) {
		return this.getResourceKind(serverId) === "mcp"
			? this.#mcp?.getServerResources(serverId.slice(MCP_PREFIX.length))
			: undefined;
	}

	getServerPrompts(serverId: string) {
		return this.getResourceKind(serverId) === "mcp"
			? this.#mcp?.getServerPrompts(serverId.slice(MCP_PREFIX.length))
			: undefined;
	}

	async reconnectServer(
		serverId: string,
		options?: { manual?: boolean; signal?: AbortSignal },
	): Promise<unknown | null> {
		const mcp = this.#mcp;
		if (!mcp || this.getResourceKind(serverId) !== "mcp") return null;
		const token = this.#captureToken(serverId);
		const name = serverId.slice(MCP_PREFIX.length);
		this.#throwIfStale(serverId, token, options?.signal);
		const connection = await mcp.reconnectServer(name, { manual: options?.manual });
		if (!this.#isCurrent(serverId, token) || options?.signal?.aborted) {
			if (connection) await mcp.disconnectServer(name);
			this.#throwIfStale(serverId, token, options?.signal);
		}
		if (!connection && mcp.getReconnectFailure?.(name) === "authentication_required") {
			throw new RpcResourceAuthenticationRequiredError();
		}
		return connection;
	}

	async refreshServerTools(serverId: string, signal?: AbortSignal): Promise<void> {
		if (!this.#mcp || this.getResourceKind(serverId) !== "mcp") return;
		const token = this.#captureToken(serverId);
		this.#throwIfStale(serverId, token, signal);
		await this.#mcp.refreshServerTools(serverId.slice(MCP_PREFIX.length));
		this.#throwIfStale(serverId, token, signal);
	}

	async refreshServerResources(serverId: string, signal?: AbortSignal): Promise<void> {
		if (!this.#mcp || this.getResourceKind(serverId) !== "mcp") return;
		const token = this.#captureToken(serverId);
		this.#throwIfStale(serverId, token, signal);
		await this.#mcp.refreshServerResources(serverId.slice(MCP_PREFIX.length));
		this.#throwIfStale(serverId, token, signal);
	}

	async refreshServerPrompts(serverId: string, signal?: AbortSignal): Promise<void> {
		if (!this.#mcp || this.getResourceKind(serverId) !== "mcp") return;
		const token = this.#captureToken(serverId);
		this.#throwIfStale(serverId, token, signal);
		await this.#mcp.refreshServerPrompts(serverId.slice(MCP_PREFIX.length));
		this.#throwIfStale(serverId, token, signal);
	}

	async disconnectServer(serverId: string): Promise<void> {
		const generation = (this.#serverGenerations.get(serverId) ?? 0) + 1;
		this.#serverGenerations.set(serverId, generation);
		const kind = this.getResourceKind(serverId);
		if (kind === "lsp") {
			const cwd = this.#getCwd();
			const config = this.#findLspConfig(serverId, cwd);
			if (!config) return;
			const stopped = await this.#services.shutdownLsp(`${config.command}:${cwd}`);
			if (!stopped) throw new Error(`LSP server ${serverId} did not terminate`);
			return;
		}
		if (kind === "dap") {
			await this.#services.terminateDapAdapter(serverId.slice(DAP_PREFIX.length), this.#getCwd());
			return;
		}
		if (this.#mcp) await this.#mcp.disconnectServer(serverId.slice(MCP_PREFIX.length));
	}

	#findLspConfig(serverId: string, cwd: string): ServerConfig | undefined {
		const name = serverId.slice(LSP_PREFIX.length);
		return this.#services.getLspServers(cwd).find(([candidate]) => candidate === name)?.[1];
	}

	#captureToken(serverId: string): RuntimeEffectToken {
		return {
			bindingGeneration: this.#bindingGeneration,
			serverGeneration: this.#serverGenerations.get(serverId) ?? 0,
		};
	}

	#isCurrent(serverId: string, token: RuntimeEffectToken): boolean {
		return (
			token.bindingGeneration === this.#bindingGeneration &&
			token.serverGeneration === (this.#serverGenerations.get(serverId) ?? 0)
		);
	}

	#throwIfStale(serverId: string, token: RuntimeEffectToken, signal?: AbortSignal): void {
		if (this.#isCurrent(serverId, token) && !signal?.aborted) return;
		if (signal?.reason instanceof Error) throw signal.reason;
		throw new Error("Resource effect authority changed");
	}
}
