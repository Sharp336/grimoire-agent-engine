import type { MCPServerConfig } from "./types";

const OFFICIAL_MCP_REGISTRY_URL = "https://registry.modelcontextprotocol.io/v0.1/servers";

type RegistryHeader = {
	name?: string;
	value?: string;
	isRequired?: boolean;
	isSecret?: boolean;
};

type RegistryRemote = {
	type?: string;
	url?: string;
	headers?: RegistryHeader[];
};

type RegistryPackageTransport = {
	type?: string;
};

type RegistryPackage = {
	registryType?: string;
	identifier?: string;
	version?: string;
	transport?: RegistryPackageTransport;
};

type RegistryServer = {
	name?: string;
	title?: string;
	description?: string;
	version?: string;
	remotes?: RegistryRemote[];
	packages?: RegistryPackage[];
};

type RegistryServerRecord = {
	server?: RegistryServer;
};

type RegistrySearchResponse = {
	servers?: RegistryServerRecord[];
};

export type OfficialRegistrySearchResult = {
	name: string;
	title?: string;
	description?: string;
	version?: string;
	sourceType: "remote" | "package";
	config: MCPServerConfig;
	requiredHeaders: Array<{
		name: string;
		template?: string;
		placeholder?: string;
	}>;
	warnings: string[];
};

export interface OfficialRegistrySearchOptions {
	limit?: number;
}

function hasTemplatePlaceholder(value: string): boolean {
	return /\{[^}]+\}/.test(value);
}

function normalizeRemoteType(remoteType: string | undefined): "http" | undefined {
	if (!remoteType) return undefined;
	const normalized = remoteType.toLowerCase();
	if (normalized === "streamable-http" || normalized === "http") return "http";
	return undefined;
}

function toRemoteConfig(server: RegistryServer): OfficialRegistrySearchResult | null {
	const remotes = server.remotes ?? [];
	for (const remote of remotes) {
		const transportType = normalizeRemoteType(remote.type);
		if (!transportType || !remote.url) continue;

		const headers: Record<string, string> = {};
		const requiredHeaders: Array<{ name: string; template?: string; placeholder?: string }> = [];
		const warnings: string[] = [];

		for (const header of remote.headers ?? []) {
			if (!header.name) continue;
			const value = header.value?.trim();
			if (!value) {
				if (header.isRequired) {
					warnings.push(`Requires header "${header.name}"`);
					requiredHeaders.push({ name: header.name });
				}
				continue;
			}
			if (hasTemplatePlaceholder(value)) {
				const match = /\{([^}]+)\}/.exec(value);
				requiredHeaders.push({
					name: header.name,
					template: value,
					placeholder: match?.[1],
				});
				warnings.push(`Provide value for header "${header.name}" at deploy time`);
				continue;
			}
			headers[header.name] = value;
		}

		return {
			name: server.name ?? "",
			title: server.title,
			description: server.description,
			version: server.version,
			sourceType: "remote",
			config: {
				type: transportType,
				url: remote.url,
				headers: Object.keys(headers).length > 0 ? headers : undefined,
			},
			requiredHeaders,
			warnings,
		};
	}

	return null;
}

function toPackageConfig(server: RegistryServer): OfficialRegistrySearchResult | null {
	const packages = server.packages ?? [];
	for (const pkg of packages) {
		if (!pkg.identifier) continue;
		if (pkg.transport?.type !== "stdio") continue;

		const registryType = (pkg.registryType ?? "").toLowerCase();
		if (registryType === "npm") {
			const spec = pkg.version ? `${pkg.identifier}@${pkg.version}` : pkg.identifier;
			return {
				name: server.name ?? "",
				title: server.title,
				description: server.description,
				version: server.version ?? pkg.version,
				sourceType: "package",
				config: {
					type: "stdio",
					command: "npx",
					args: ["-y", spec],
				},
				requiredHeaders: [],
				warnings: [],
			};
		}
		if (registryType === "pypi") {
			const spec = pkg.version ? `${pkg.identifier}==${pkg.version}` : pkg.identifier;
			return {
				name: server.name ?? "",
				title: server.title,
				description: server.description,
				version: server.version ?? pkg.version,
				sourceType: "package",
				config: {
					type: "stdio",
					command: "uvx",
					args: [spec],
				},
				requiredHeaders: [],
				warnings: ['Requires "uvx" installed in PATH'],
			};
		}
		if (registryType === "oci") {
			return {
				name: server.name ?? "",
				title: server.title,
				description: server.description,
				version: server.version ?? pkg.version,
				sourceType: "package",
				config: {
					type: "stdio",
					command: "docker",
					args: ["run", "--rm", "-i", pkg.identifier],
				},
				requiredHeaders: [],
				warnings: ['Requires "docker" installed and running'],
			};
		}
	}
	return null;
}

function clampLimit(limit: number | undefined): number {
	if (!limit || Number.isNaN(limit)) return 20;
	if (limit < 1) return 1;
	if (limit > 100) return 100;
	return Math.trunc(limit);
}

function toSearchResult(record: RegistryServerRecord): OfficialRegistrySearchResult | null {
	const server = record.server;
	if (!server?.name) return null;
	return toRemoteConfig(server) ?? toPackageConfig(server);
}

export async function searchOfficialRegistry(
	keyword: string,
	options?: OfficialRegistrySearchOptions,
): Promise<OfficialRegistrySearchResult[]> {
	const query = keyword.trim();
	if (!query) return [];

	const url = new URL(OFFICIAL_MCP_REGISTRY_URL);
	url.searchParams.set("search", query);
	url.searchParams.set("limit", String(clampLimit(options?.limit)));

	const response = await fetch(url.toString());
	if (!response.ok) {
		throw new Error(`Registry search failed with status ${response.status}`);
	}

	const payload = (await response.json()) as RegistrySearchResponse;
	const records = payload.servers ?? [];
	const converted = records
		.map(toSearchResult)
		.filter((result): result is OfficialRegistrySearchResult => result !== null);

	return converted.sort((a, b) => a.name.localeCompare(b.name));
}

export function toConfigName(candidate: string): string {
	const normalized = candidate
		.toLowerCase()
		.replace(/[^a-z0-9_.-]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-+|-+$/g, "");
	return normalized.length > 0 ? normalized : "mcp-server";
}
