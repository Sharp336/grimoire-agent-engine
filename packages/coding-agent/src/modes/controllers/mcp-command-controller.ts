/**
 * MCP Command Controller
 *
 * Handles /mcp subcommands for managing MCP servers.
 */
import { Spacer, Text } from "@oh-my-pi/pi-tui";
import { getMCPConfigPath, getProjectDir } from "@oh-my-pi/pi-utils";
import * as path from "node:path";
import { type Component, matchesKey, replaceTabs, Spacer, Text, truncateToWidth } from "@oh-my-pi/pi-tui";
import { getConfigRootDir, getProjectAgentDir, getProjectDir } from "@oh-my-pi/pi-utils/dirs";
import type { SourceMeta } from "../../capability/types";
import { analyzeAuthError, discoverOAuthEndpoints, MCPManager } from "../../mcp";
import { connectToServer, disconnectServer, listTools } from "../../mcp/client";
import {
	addMCPServer,
	readDisabledServers,
	readMCPConfigFile,
	removeMCPServer,
	setServerDisabled,
	updateMCPServer,
	validateServerName,
} from "../../mcp/config-writer";
import { MCPOAuthFlow } from "../../mcp/oauth-flow";
import {
	clearSmitheryApiKey,
	createSmitheryCliAuthSession,
	getSmitheryApiKey,
	getSmitheryLoginUrl,
	pollSmitheryCliAuthSession,
	saveSmitheryApiKey,
} from "../../mcp/smithery-auth";
import {
	createSmitheryConnection,
	deleteSmitheryConnection,
	getSmitheryApiBaseUrl,
	getSmitheryConnection,
	listSmitheryConnectionsByUrl,
	resolveSmitheryNamespace,
	SmitheryConnectError,
	type SmitheryConnection,
} from "../../mcp/smithery-connect";
import {
	SmitheryRegistryError,
	type SmitherySearchResult,
	searchSmitheryRegistry,
	toConfigName,
} from "../../mcp/smithery-registry";
import type { MCPServerConfig, MCPServerConnection } from "../../mcp/types";
import type { OAuthCredential } from "../../session/auth-storage";
import { shortenPath } from "../../tools/render-utils";
import { openPath } from "../../utils/open";
import { DynamicBorder } from "../components/dynamic-border";
import { MCPAddWizard } from "../components/mcp-add-wizard";
import { parseCommandArgs } from "../shared";
import { theme } from "../theme/theme";
import type { InteractiveModeContext } from "../types";

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
	const { promise: timeoutPromise, reject } = Promise.withResolvers<T>();
	const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
	return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timer));
}

function getMCPConfigPath(scope: "user" | "project", cwd: string): string {
	return scope === "user" ? path.join(getConfigRootDir(), "mcp.json") : path.join(getProjectAgentDir(cwd), "mcp.json");
}

function parseCommandArgs(argsString: string): string[] {
	const args: string[] = [];
	let current = "";
	let inQuote: string | null = null;

	for (let i = 0; i < argsString.length; i++) {
		const char = argsString[i];

		if (inQuote) {
			if (char === inQuote) {
				inQuote = null;
			} else {
				current += char;
			}
		} else if (char === '"' || char === "'") {
			inQuote = char;
		} else if (char === " " || char === "\t") {
			if (current) {
				args.push(current);
				current = "";
			}
		} else {
			current += char;
		}
	}

	if (current) {
		args.push(current);
	}

	return args;
}

function sanitizeSelectText(text: string): string {
	return replaceTabs(text)
		.replace(/[\r\n]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function formatUseCount(value: number | undefined): string {
	if (typeof value !== "number" || Number.isNaN(value)) return "0";
	return value.toLocaleString("en-US");
}

type MCPAddScope = "user" | "project";

type MCPAddParsed = {
	initialName?: string;
	scope: MCPAddScope;
	quickConfig?: MCPServerConfig;
	isCommandQuickAdd?: boolean;
	hasAuthToken?: boolean;
	error?: string;
};

type MCPSearchParsed = {
	keyword: string;
	scope: MCPAddScope;
	limit: number;
	semantic: boolean;
	error?: string;
};

type RegistryPickerItem = {
	index: number;
	name: string;
	displayName: string;
	description: string;
	useCount: number;
	verified: boolean;
	deployed: boolean;
	transport: string;
	connectionType: string;
	createdAt?: string;
	homepage?: string;
	schemaParams: string[];
	tools: Array<{
		name: string;
		description?: string;
		params: string[];
	}>;
};

class RegistryResultPicker implements Component {
	#selectedIndex = 0;
	#expanded = new Set<number>();
	#maxVisible: number;

	onSelect?: (index: number) => void;
	onCancel?: () => void;

	constructor(
		private readonly items: RegistryPickerItem[],
		maxVisible = 8,
	) {
		this.#maxVisible = Math.max(4, maxVisible);
	}

	invalidate(): void {
		// No cached state to invalidate.
	}

	render(width: number): string[] {
		if (this.items.length === 0) {
			return [theme.fg("muted", "  No registry results")];
		}

		const lines: string[] = [];
		const startIndex = Math.max(
			0,
			Math.min(this.#selectedIndex - Math.floor(this.#maxVisible / 2), this.items.length - this.#maxVisible),
		);
		const endIndex = Math.min(startIndex + this.#maxVisible, this.items.length);

		for (let i = startIndex; i < endIndex; i++) {
			const item = this.items[i];
			if (!item) continue;
			const isSelected = i === this.#selectedIndex;
			const isExpanded = this.#expanded.has(i);
			const cursor = isSelected ? theme.fg("accent", `${theme.nav.cursor} `) : "  ";
			const chevron = isExpanded ? "▾ " : "▸ ";
			const base = `${cursor}${chevron}${item.name} ${theme.fg("muted", `[${item.transport}]`)}`;
			lines.push(truncateToWidth(base, width));

			if (!isExpanded) continue;
			const indent = "    ";
			const boolLabel = (value: boolean): string => (value ? theme.fg("success", "✓") : theme.fg("error", "✗"));
			const rows: Array<[string, string]> = [
				["displayedname", item.displayName],
				["description", item.description],
				["usecount", formatUseCount(item.useCount)],
				["verified", boolLabel(item.verified)],
				["deployed", boolLabel(item.deployed)],
				["transport", item.transport],
				["connectiontype", item.connectionType],
				["createdate", item.createdAt ?? "n/a"],
				["homepage", item.homepage ?? "n/a"],
				["schemaparams", item.schemaParams.length > 0 ? `[${item.schemaParams.join(", ")}]` : "[0 params]"],
			];
			for (let j = 0; j < rows.length; j++) {
				const [key, rawValue] = rows[j] ?? ["", ""];
				const isLastMeta = j === rows.length - 1 && item.tools.length === 0;
				const branch = theme.fg("dim", `${indent}${isLastMeta ? theme.tree.last : theme.tree.branch} `);
				const value = /^https?:\/\//i.test(rawValue) ? `\x1b]8;;${rawValue}\x07${rawValue}\x1b]8;;\x07` : rawValue;
				lines.push(truncateToWidth(`${branch}${theme.fg("dim", `${key}:`)} ${theme.fg("muted", value)}`, width));
			}
			const toolsBranch = theme.fg("dim", `${indent}${theme.tree.last} `);
			lines.push(truncateToWidth(`${toolsBranch}${theme.fg("dim", "tools:")}`, width));
			const toolIndent = `${indent}  `;
			if (item.tools.length === 0) {
				lines.push(truncateToWidth(`${toolIndent}${theme.fg("muted", "none")}`, width));
			} else {
				for (const tool of item.tools) {
					const params = `[${tool.params.length} params]`;
					const toolDescription = tool.description ? sanitizeSelectText(tool.description) : "No description";
					const toolLine = `${tool.name}: ${toolDescription} ${params}`;
					lines.push(truncateToWidth(`${toolIndent}${theme.fg("muted", toolLine)}`, width));
				}
			}
		}

		if (startIndex > 0 || endIndex < this.items.length) {
			lines.push(theme.fg("muted", `  (${this.#selectedIndex + 1}/${this.items.length})`));
		}

		return lines;
	}

	handleInput(keyData: string): void {
		if (matchesKey(keyData, "up")) {
			this.#selectedIndex = this.#selectedIndex === 0 ? this.items.length - 1 : this.#selectedIndex - 1;
			return;
		}
		if (matchesKey(keyData, "down")) {
			this.#selectedIndex = this.#selectedIndex === this.items.length - 1 ? 0 : this.#selectedIndex + 1;
			return;
		}
		if (matchesKey(keyData, "right")) {
			this.#expanded.add(this.#selectedIndex);
			return;
		}
		if (matchesKey(keyData, "left")) {
			this.#expanded.delete(this.#selectedIndex);
			return;
		}
		if (matchesKey(keyData, "enter") || matchesKey(keyData, "return") || keyData === "\n") {
			this.onSelect?.(this.#selectedIndex);
			return;
		}
		if (matchesKey(keyData, "escape") || matchesKey(keyData, "esc") || matchesKey(keyData, "ctrl+c")) {
			this.onCancel?.();
		}
	}
}

export class MCPCommandController {
	constructor(private ctx: InteractiveModeContext) {}

	/**
	 * Handle /mcp command and route to subcommands
	 */
	async handle(text: string): Promise<void> {
		const parts = text.trim().split(/\s+/);
		const subcommand = parts[1]?.toLowerCase();

		if (!subcommand || subcommand === "help") {
			this.#showHelp();
			return;
		}

		switch (subcommand) {
			case "add":
				await this.#handleAdd(text);
				break;
			case "list":
				await this.#handleList();
				break;
			case "remove":
			case "rm":
				await this.#handleRemove(text);
				break;
			case "test":
				await this.#handleTest(parts[2]);
				break;
			case "auth":
			case "reauth":
				await this.#handleReauth(parts[2]);
				break;
			case "unauth":
				await this.#handleUnauth(parts[2]);
				break;
			case "enable":
				await this.#handleSetEnabled(parts[2], true);
				break;
			case "disable":
				await this.#handleSetEnabled(parts[2], false);
				break;
			case "resources":
				await this.#handleResources();
				break;
			case "prompts":
				await this.#handlePrompts();
				break;
			case "notifications":
				await this.#handleNotifications();
				break;
			case "reload":
				await this.#handleReload();
				break;
			case "registry":
			case "registery":
				await this.#handleRegistry(text);
				break;
			default:
				this.ctx.showError(`Unknown subcommand: ${subcommand}. Type /mcp help for usage.`);
		}
	}

	/**
	 * Show help text
	 */
	#showHelp(): void {
		const helpText = [
			"",
			theme.bold("MCP Server Management"),
			"",
			"Manage Model Context Protocol (MCP) servers for external tool integrations.",
			"",
			theme.fg("accent", "Commands:"),
			"  /mcp add              Add a new MCP server (interactive wizard)",
			"  /mcp add <name> [--scope project|user] [--url <url> --token <token>] [-- <command...>]",
			"  /mcp list             List all configured MCP servers",
			"  /mcp remove <name> [--scope project|user]    Remove an MCP server (default: project)",
			"  /mcp test <name>      Test connection to an MCP server",
			"  /mcp auth <name>      Reauthorize OAuth for an MCP server",
			"  /mcp unauth <name>    Remove OAuth auth from an MCP server",
			"  /mcp enable <name>    Enable an MCP server",
			"  /mcp disable <name>   Disable an MCP server",
			"  /mcp registry search <keyword> [--scope project|user] [--limit <1-100>] [--semantic]",
			"                        Search Smithery registry and deploy from picker",
			"                        Use --semantic to keep raw Smithery ranking/results (no local filtering)",
			"  /mcp registry login   Configure cached Smithery API key",
			"  /mcp registry logout  Remove cached Smithery API key",
			"  /mcp reload           Force reload and rediscover MCP runtime tools",
			"  /mcp resources        List available resources from connected servers",
			"  /mcp prompts          List available prompts from connected servers",
			"  /mcp notifications    Show notification capabilities and subscription state",
			"  /mcp help             Show this help message",
			"",
		].join("\n");

		this.#showMessage(helpText);
	}

	#parseAddCommand(text: string): MCPAddParsed {
		const prefixMatch = text.match(/^\/mcp\s+add\b\s*(.*)$/i);
		const rest = prefixMatch?.[1]?.trim() ?? "";
		if (!rest) {
			return { scope: "project" };
		}

		const tokens = parseCommandArgs(rest);
		if (tokens.length === 0) {
			return { scope: "project" };
		}

		let name: string | undefined;
		let scope: MCPAddScope = "project";
		let url: string | undefined;
		let authToken: string | undefined;
		let commandTokens: string[] | undefined;

		let i = 0;
		if (!tokens[0].startsWith("-")) {
			name = tokens[0];
			i = 1;
		}

		while (i < tokens.length) {
			const argToken = tokens[i];
			if (argToken === "--") {
				commandTokens = tokens.slice(i + 1);
				break;
			}
			if (argToken === "--scope") {
				const value = tokens[i + 1];
				if (!value || (value !== "project" && value !== "user")) {
					return { scope, error: "Invalid --scope value. Use project or user." };
				}
				scope = value;
				i += 2;
				continue;
			}
			if (argToken === "--url") {
				const value = tokens[i + 1];
				if (!value) {
					return { scope, error: "Missing value for --url." };
				}
				url = value;
				i += 2;
				continue;
			}
			if (argToken === "--transport") {
				return { scope, error: "--transport is no longer supported. Use HTTP endpoints only." };
			}
			if (argToken === "--token") {
				const value = tokens[i + 1];
				if (!value) {
					return { scope, error: "Missing value for --token." };
				}
				authToken = value;
				i += 2;
				continue;
			}
			return { scope, error: `Unknown option: ${argToken}` };
		}

		const hasQuick = Boolean(url) || Boolean(commandTokens && commandTokens.length > 0);
		if (!hasQuick) {
			return { scope, initialName: name };
		}
		if (!name) {
			return { scope, error: "Server name required for quick add. Usage: /mcp add <name> ..." };
		}
		if (url && commandTokens && commandTokens.length > 0) {
			return { scope, error: "Use either --url or -- <command...>, not both." };
		}
		if (authToken && !url) {
			return { scope, error: "--token requires --url (HTTP transport)." };
		}

		if (commandTokens && commandTokens.length > 0) {
			const [command, ...args] = commandTokens;
			const config: MCPServerConfig = {
				type: "stdio",
				command,
				args: args.length > 0 ? args : undefined,
			};
			return { scope, initialName: name, quickConfig: config, isCommandQuickAdd: true };
		}

		let normalizedUrl = url!;
		if (!/^https?:\/\//i.test(normalizedUrl)) {
			normalizedUrl = `https://${normalizedUrl}`;
		}
		const config: MCPServerConfig = {
			type: "http",
			url: normalizedUrl,
			headers: authToken ? { Authorization: `Bearer ${authToken}` } : undefined,
		};
		return {
			scope,
			initialName: name,
			quickConfig: config,
			isCommandQuickAdd: false,
			hasAuthToken: Boolean(authToken),
		};
	}

	#parseSearchCommand(text: string): MCPSearchParsed {
		const prefixMatch = text.match(/^\/mcp\s+(?:registry\s+)?search\b\s*(.*)$/i);
		const rest = prefixMatch?.[1]?.trim() ?? "";
		const tokens = parseCommandArgs(rest);
		if (tokens.length === 0) {
			return {
				keyword: "",
				scope: "project",
				limit: 20,
				semantic: false,
				error: "Keyword required. Usage: /mcp registry search <keyword> [--scope project|user] [--limit <1-100>] [--semantic]",
			};
		}

		const keywordParts: string[] = [];
		let scope: MCPAddScope = "project";
		let limit = 20;
		let semantic = false;

		for (let i = 0; i < tokens.length; i++) {
			const token = tokens[i];
			if (token === "--scope") {
				const value = tokens[i + 1];
				if (!value || (value !== "project" && value !== "user")) {
					return { keyword: "", scope, limit, semantic, error: "Invalid --scope value. Use project or user." };
				}
				scope = value;
				i++;
				continue;
			}
			if (token === "--limit") {
				const value = tokens[i + 1];
				if (!value) {
					return { keyword: "", scope, limit, semantic, error: "Missing value for --limit." };
				}
				const parsed = Number(value);
				if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
					return {
						keyword: "",
						scope,
						limit,
						semantic,
						error: "Invalid --limit value. Use an integer between 1 and 100.",
					};
				}
				limit = parsed;
				i++;
				continue;
			}
			if (token === "--semantic") {
				semantic = true;
				continue;
			}
			if (token.startsWith("--")) {
				return { keyword: "", scope, limit, semantic, error: `Unknown option: ${token}` };
			}
			keywordParts.push(token);
		}

		const keyword = keywordParts.join(" ").trim();
		if (!keyword) {
			return {
				keyword: "",
				scope,
				limit,
				semantic,
				error: "Keyword required. Usage: /mcp registry search <keyword> [--scope project|user] [--limit <1-100>] [--semantic]",
			};
		}

		return { keyword, scope, limit, semantic };
	}

	async #handleRegistry(text: string): Promise<void> {
		const prefixMatch = text.match(/^\/mcp\s+(?:registry|registery)\b\s*(.*)$/i);
		const rest = prefixMatch?.[1]?.trim() ?? "";
		if (!rest || rest === "help") {
			this.#showMessage(
				[
					"",
					theme.bold("MCP Registry Commands"),
					"",
					theme.fg("muted", "Registry provider: Smithery (registry.smithery.ai + api.smithery.ai)."),
					theme.fg(
						"muted",
						"Remote HTTP-based providers require Smithery API access. Run /mcp registry login before search/deploy.",
					),
					"",
					"  /mcp registry search <keyword> [--scope project|user] [--limit <1-100>] [--semantic]",
					"    --semantic: keep raw Smithery ranking/results (no local filtering)",
					"  /mcp registry login",
					"  /mcp registry logout",
					"",
				].join("\n"),
			);
			return;
		}

		const firstSpace = rest.indexOf(" ");
		const action = (firstSpace === -1 ? rest : rest.slice(0, firstSpace)).toLowerCase();
		const tail = firstSpace === -1 ? "" : rest.slice(firstSpace + 1);

		if (action === "search") {
			await this.#handleSearch(`/mcp search ${tail}`.trimEnd());
			return;
		}
		if (action === "login") {
			await this.#handleSmitheryLogin();
			return;
		}
		if (action === "logout") {
			await this.#handleSmitheryLogout();
			return;
		}

		this.ctx.showError(`Unknown registry subcommand: ${action}. Use /mcp registry help.`);
	}

	/**
	 * Handle /mcp add - Launch interactive wizard or quick-add from args
	 */
	async #handleAdd(text: string): Promise<void> {
		const parsed = this.#parseAddCommand(text);
		if (parsed.error) {
			this.ctx.showError(parsed.error);
			return;
		}
		if (parsed.quickConfig && parsed.initialName) {
			let finalConfig = parsed.quickConfig;

			// Quick-add with URL should still perform auth detection and OAuth flow,
			// matching wizard behavior. Command quick-add intentionally skips this.
			if (!parsed.isCommandQuickAdd && (finalConfig.type === "http" || finalConfig.type === "sse")) {
				try {
					await this.#handleTestConnection(finalConfig);
				} catch (error) {
					if (parsed.hasAuthToken) {
						this.ctx.showError(
							`Authentication failed for "${parsed.initialName}": ${error instanceof Error ? error.message : String(error)}`,
						);
						return;
					}
					const authResult = analyzeAuthError(error as Error);
					if (authResult.requiresAuth) {
						let oauth = authResult.authType === "oauth" ? (authResult.oauth ?? null) : null;
						if (!oauth && finalConfig.url) {
							try {
								oauth = await discoverOAuthEndpoints(finalConfig.url, authResult.authServerUrl);
							} catch {
								// Ignore discovery error and handle below.
							}
						}

						if (!oauth) {
							this.ctx.showError(
								`Authentication required for "${parsed.initialName}", but OAuth endpoints could not be discovered. ` +
									`Use /mcp add ${parsed.initialName} (wizard) or configure auth manually.`,
							);
							return;
						}

						try {
							const credentialId = await this.#handleOAuthFlow(
								oauth.authorizationUrl,
								oauth.tokenUrl,
								oauth.clientId ?? finalConfig.oauth?.clientId ?? "",
								"",
								oauth.scopes ?? "",
								finalConfig.oauth?.callbackPort,
							);
							finalConfig = {
								...finalConfig,
								auth: {
									type: "oauth",
									credentialId,
								},
							};
						} catch (oauthError) {
							this.ctx.showError(
								`OAuth flow failed for "${parsed.initialName}": ${oauthError instanceof Error ? oauthError.message : String(oauthError)}`,
							);
							return;
						}
					}
				}
			try {
				await this.#deployConfig({
					serverName: parsed.initialName,
					scope: parsed.scope,
					config: parsed.quickConfig,
					prepareAuth: !parsed.isCommandQuickAdd,
					hasManualCredentials: Boolean(parsed.hasAuthToken),
				});
			} catch (authError) {
				this.ctx.showError(authError instanceof Error ? authError.message : String(authError));
			}
			return;
		}

		// Save current editor state
		const done = () => {
			this.ctx.editorContainer.clear();
			this.ctx.editorContainer.addChild(this.ctx.editor);
			this.ctx.ui.setFocus(this.ctx.editor);
		};

		// Create wizard with OAuth handler and connection test
		const wizard = new MCPAddWizard(
			async (name: string, config: MCPServerConfig, scope: "user" | "project") => {
				done();
				await this.#handleWizardComplete(name, config, scope);
			},
			() => {
				done();
				this.#handleWizardCancel();
			},
			async (authUrl: string, tokenUrl: string, clientId: string, clientSecret: string, scopes: string) => {
				return await this.#handleOAuthFlow(authUrl, tokenUrl, clientId, clientSecret, scopes);
			},
			async (config: MCPServerConfig) => {
				return await this.#handleTestConnection(config);
			},
			() => {
				this.ctx.ui.requestRender();
			},
			parsed.initialName,
		);

		// Replace editor with wizard
		this.ctx.editorContainer.clear();
		this.ctx.editorContainer.addChild(wizard);
		this.ctx.ui.setFocus(wizard);
		this.ctx.ui.requestRender();
	}

	/**
	 * Handle OAuth authentication flow for MCP server
	 */
	async #handleOAuthFlow(
		authUrl: string,
		tokenUrl: string,
		clientId: string,
		clientSecret: string,
		scopes: string,
		callbackPort?: number,
	): Promise<string> {
		const authStorage = this.ctx.session.modelRegistry.authStorage;
		let parsedAuthUrl: URL;

		// Validate OAuth URLs
		try {
			parsedAuthUrl = new URL(authUrl);
			new URL(tokenUrl);
		} catch (_error) {
			throw new Error(
				`Invalid OAuth URLs. Please check:\n  Authorization URL: ${authUrl}\n  Token URL: ${tokenUrl}`,
			);
		}

		let resolvedClientId = clientId.trim() || parsedAuthUrl.searchParams.get("client_id") || undefined;
		let promptedForClientId = false;

		try {
			// Create OAuth flow
			const flow = new MCPOAuthFlow(
				{
					authorizationUrl: authUrl,
					tokenUrl: tokenUrl,
					clientId: resolvedClientId,
					clientSecret: clientSecret || undefined,
					scopes: scopes || undefined,
					callbackPort,
				},
				{
					onAuth: (info: { url: string; instructions?: string }) => {
						// Show auth URL prominently in chat
						this.ctx.chatContainer.addChild(new Spacer(1));
						this.ctx.chatContainer.addChild(
							new Text(theme.fg("accent", "━━━ OAuth Authorization Required ━━━"), 1, 0),
						);
						this.ctx.chatContainer.addChild(new Spacer(1));
						this.ctx.chatContainer.addChild(
							new Text(theme.fg("muted", "Preparing browser authorization..."), 1, 0),
						);
						this.ctx.chatContainer.addChild(new Spacer(1));
						this.ctx.chatContainer.addChild(
							new Text(
								theme.fg("muted", "Waiting for authorization... (Press Ctrl+C to cancel, 5 minute timeout)"),
								1,
								0,
							),
						);
						this.ctx.chatContainer.addChild(new Spacer(1));
						this.ctx.chatContainer.addChild(
							new Text(theme.fg("accent", "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"), 1, 0),
						);
						this.ctx.ui.requestRender();
						const isWindows = process.platform === "win32";
		for (;;) {
			try {
				const authUrlForFlow = new URL(parsedAuthUrl.toString());
				if (resolvedClientId) {
					authUrlForFlow.searchParams.set("client_id", resolvedClientId);
				}

				// Create OAuth flow
				const flow = new MCPOAuthFlow(
					{
						authorizationUrl: authUrlForFlow.toString(),
						tokenUrl: tokenUrl,
						clientId: resolvedClientId,
						clientSecret: clientSecret || undefined,
						scopes: scopes || undefined,
					},
					{
						onAuth: (info: { url: string; instructions?: string }) => {
							// Show auth URL prominently in chat
							this.ctx.chatContainer.addChild(new Spacer(1));
							this.ctx.chatContainer.addChild(
								new Text(theme.fg("accent", "━━━ OAuth Authorization Required ━━━"), 1, 0),
							);
							this.ctx.chatContainer.addChild(new Spacer(1));
							this.ctx.chatContainer.addChild(
								new Text(theme.fg("muted", "Preparing browser authorization..."), 1, 0),
							);
							this.ctx.chatContainer.addChild(new Spacer(1));
							this.ctx.chatContainer.addChild(
								new Text(
									theme.fg("muted", "Waiting for authorization... (Press Ctrl+C to cancel, 5 minute timeout)"),
									1,
									0,
								),
							);
							this.ctx.chatContainer.addChild(new Spacer(1));
							this.ctx.chatContainer.addChild(
								new Text(theme.fg("accent", "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"), 1, 0),
							);
							this.ctx.ui.requestRender();
							const isWindows = process.platform === "win32";
							const isMac = process.platform === "darwin";
							const isLinux = process.platform === "linux";

							// Try to open browser automatically
							try {
								if (isWindows) {
									// Windows: use URL protocol handler directly to avoid cmd quoting issues.
									Bun.spawn(["rundll32.exe", "url.dll,FileProtocolHandler", info.url], {
										stdout: "ignore",
										stderr: "ignore",
										stdin: "ignore",
									});
								} else if (isMac) {
									// macOS: Use 'open' command
									Bun.spawn(["open", info.url], {
										stdout: "ignore",
										stderr: "ignore",
										stdin: "ignore",
									});
								} else if (isLinux) {
									// Linux: Try xdg-open
									Bun.spawn(["xdg-open", info.url], {
										stdout: "ignore",
										stderr: "ignore",
										stdin: "ignore",
									});
								}

								// Show confirmation that browser should open
								this.ctx.chatContainer.addChild(new Spacer(1));
								this.ctx.chatContainer.addChild(
									new Text(theme.fg("success", "→ Opening browser automatically..."), 1, 0),
								);
								this.ctx.chatContainer.addChild(new Spacer(1));
								this.ctx.chatContainer.addChild(
									new Text(theme.fg("muted", "Alternative if browser did not open:"), 1, 0),
								);
								this.ctx.chatContainer.addChild(
									new Text(theme.fg("success", "Copy this exact URL in your browser:"), 1, 0),
								);
								this.ctx.chatContainer.addChild(new Text(theme.fg("accent", info.url), 1, 0));
								if (isWindows) {
									const openCmd = `rundll32.exe url.dll,FileProtocolHandler "${info.url.replace(/"/g, '""')}"`;
									this.ctx.chatContainer.addChild(new Spacer(1));
									this.ctx.chatContainer.addChild(new Text("Windows manual open command:", 1, 0));
									this.ctx.chatContainer.addChild(new Text(openCmd, 1, 0));
								}
								this.ctx.ui.requestRender();
							} catch (_error) {
								// Show error if browser doesn't open
								this.ctx.chatContainer.addChild(new Spacer(1));
								this.ctx.chatContainer.addChild(
									new Text(theme.fg("warning", "→ Could not open browser automatically"), 1, 0),
								);
								this.ctx.chatContainer.addChild(
									new Text(theme.fg("success", "Copy this exact URL in your browser:"), 1, 0),
								);
								this.ctx.chatContainer.addChild(new Text(theme.fg("accent", info.url), 1, 0));
								if (isWindows) {
									const openCmd = `rundll32.exe url.dll,FileProtocolHandler "${info.url.replace(/"/g, '""')}"`;
									this.ctx.chatContainer.addChild(new Spacer(1));
									this.ctx.chatContainer.addChild(new Text("Windows manual open command:", 1, 0));
									this.ctx.chatContainer.addChild(new Text(openCmd, 1, 0));
								}
								this.ctx.ui.requestRender();
							}
						},
						onProgress: (message: string) => {
							this.ctx.chatContainer.addChild(new Spacer(1));
							this.ctx.chatContainer.addChild(new Text(theme.fg("muted", message), 1, 0));
							this.ctx.ui.requestRender();
						},
					},
				);

				// Execute OAuth flow with 5 minute timeout
				const credentials = await withTimeout(flow.login(), 5 * 60 * 1000, "OAuth flow timed out after 5 minutes");

				this.ctx.chatContainer.addChild(new Spacer(1));
				this.ctx.chatContainer.addChild(
					new Text(theme.fg("success", "✓ Authorization completed in browser."), 1, 0),
				);
				this.ctx.ui.requestRender();

				// Generate a unique credential ID
				const credentialId = `mcp_oauth_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;

				// Store credentials in auth storage
				const oauthCredential: OAuthCredential = {
					type: "oauth",
					...credentials,
				};

				// Store under a synthetic provider name
				await authStorage.set(credentialId, oauthCredential);

				return credentialId;
			} catch (error) {
				const errorMsg = error instanceof Error ? error.message : String(error);
				const isTimeoutError = /timeout|timed out/i.test(errorMsg);
				const requiresClientId =
					/client[_-]?id/i.test(errorMsg) && /(required|missing|invalid_request|must be provided)/i.test(errorMsg);
				const shouldPromptForClientId =
					!resolvedClientId && !promptedForClientId && (requiresClientId || isTimeoutError);
				if (shouldPromptForClientId) {
					promptedForClientId = true;
					const manualClientId = await this.ctx.showHookInput(
						'OAuth may require "client_id". Enter client ID to retry (Esc to cancel)',
					);
					if (manualClientId === undefined) {
						throw new Error("OAuth cancelled. Provider requires a client_id.");
					}
					const trimmedClientId = manualClientId.trim();
					if (!trimmedClientId) {
						throw new Error("OAuth cancelled. Provider requires a non-empty client_id.");
					}
					resolvedClientId = trimmedClientId;
					this.#showMessage(["", theme.fg("muted", 'Retrying OAuth with provided "client_id"...'), ""].join("\n"));
					continue;
				}

				// Provide helpful error messages based on failure type
				if (isTimeoutError) {
					throw new Error("OAuth flow timed out. Please try again.");
				} else if (errorMsg.includes("403") || errorMsg.includes("unauthorized")) {
					throw new Error("OAuth authorization failed. Please check your client credentials.");
				} else if (errorMsg.includes("invalid_grant")) {
					throw new Error("OAuth authorization code is invalid or expired. Please try again.");
				} else if (errorMsg.includes("ECONNREFUSED") || errorMsg.includes("fetch failed")) {
					throw new Error("Could not connect to OAuth server. Please check the URLs and your network connection.");
				} else {
					throw new Error(`OAuth authentication failed: ${errorMsg}`);
				}
			}
		}
	}

	/**
	 * Test connection to an MCP server.
	 * Throws an error if connection fails (used for auto-detection).
	 */
	async #handleTestConnection(config: MCPServerConfig): Promise<void> {
		// Create temporary connection using a test name
		const testName = `test_${Date.now()}`;
		let resolvedConfig: MCPServerConfig;
		if (this.ctx.mcpManager) {
			resolvedConfig = await this.ctx.mcpManager.prepareConfig(config);
		} else {
			const tempManager = new MCPManager(process.cwd());
			tempManager.setAuthStorage(this.ctx.session.modelRegistry.authStorage);
			resolvedConfig = await tempManager.prepareConfig(config);
		}

		const connection = await connectToServer(testName, resolvedConfig);
		await disconnectServer(connection);
	}

	async #findConfiguredServer(
		name: string,
	): Promise<{ filePath: string; scope: "user" | "project"; config: MCPServerConfig } | null> {
		const cwd = process.cwd();
		const userPath = getMCPConfigPath("user", cwd);
		const projectPath = getMCPConfigPath("project", cwd);

		const [userConfig, projectConfig] = await Promise.all([
			readMCPConfigFile(userPath),
			readMCPConfigFile(projectPath),
		]);

		if (userConfig.mcpServers?.[name]) {
			return { filePath: userPath, scope: "user", config: userConfig.mcpServers[name] };
		}
		if (projectConfig.mcpServers?.[name]) {
			return { filePath: projectPath, scope: "project", config: projectConfig.mcpServers[name] };
		}
		return null;
	}

	async #removeManagedOAuthCredential(credentialId: string | undefined): Promise<void> {
		if (!credentialId || !credentialId.startsWith("mcp_oauth_")) return;
		await this.ctx.session.modelRegistry.authStorage.remove(credentialId);
	}

	#stripOAuthAuth(config: MCPServerConfig): MCPServerConfig {
		const next = { ...config } as MCPServerConfig & { auth?: { type: "oauth" | "apikey"; credentialId?: string } };
		delete next.auth;
		return next;
	}

	#extractSmitheryConnectionRef(config: MCPServerConfig): { namespace: string; connectionId: string } | null {
		if (config.type !== "http" && config.type !== "sse") return null;
		let parsedConfigUrl: URL;
		let parsedSmitheryApiUrl: URL;
		try {
			parsedConfigUrl = new URL(config.url);
			parsedSmitheryApiUrl = new URL(getSmitheryApiBaseUrl());
		} catch {
			return null;
		}
		if (parsedConfigUrl.origin !== parsedSmitheryApiUrl.origin) return null;
		const pathMatch = parsedConfigUrl.pathname.match(/^\/connect\/([^/]+)\/([^/]+)\/mcp\/?$/);
		if (!pathMatch) return null;
		const namespace = decodeURIComponent(pathMatch[1] ?? "");
		const connectionId = decodeURIComponent(pathMatch[2] ?? "");
		if (!namespace || !connectionId) return null;
		return { namespace, connectionId };
	}

	async #cleanupSmitheryConnection(name: string, config: MCPServerConfig): Promise<void> {
		const reference = this.#extractSmitheryConnectionRef(config);
		if (!reference) return;

		const deleteWithKey = async (apiKey: string): Promise<void> => {
			await deleteSmitheryConnection(apiKey, reference.namespace, reference.connectionId);
		};

		try {
			await this.#runSmitheryOperationWithAuthRetry(
				deleteWithKey,
				`required to remove Smithery connection for "${name}"`,
			);
		} catch (error) {
			if (error instanceof Error && error.message.includes("cancelled")) {
				this.ctx.showWarning(`Skipped Smithery connection cleanup for "${name}" (not authenticated).`);
				return;
			}
			const status = this.#getSmitheryErrorStatus(error);
			if (status === 404) {
				return;
			}
			this.ctx.showWarning(
				`Failed to remove Smithery connection for "${name}": ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	async #cleanupServerAuthArtifacts(name: string, config: MCPServerConfig): Promise<void> {
		const authConfig = (config as MCPServerConfig & { auth?: { type: "oauth" | "apikey"; credentialId?: string } })
			.auth;
		if (authConfig?.type === "oauth") {
			await this.#removeManagedOAuthCredential(authConfig.credentialId);
		}
		await this.#cleanupSmitheryConnection(name, config);
	}

	async #resolveOAuthEndpointsFromServer(config: MCPServerConfig): Promise<{
		authorizationUrl: string;
		tokenUrl: string;
		clientId?: string;
		scopes?: string;
	}> {
		// First test if server actually needs auth by connecting without OAuth
		let connectionSucceeded = false;
		let connectionError: Error | undefined;
		try {
			await this.#handleTestConnection(this.#stripOAuthAuth(config));
			connectionSucceeded = true;
		} catch (error) {
			connectionError = error as Error;
		}

		// Server connected fine without auth — reauth is not needed
		if (connectionSucceeded) {
			throw new Error("Server connection succeeded without OAuth; reauthorization is not required.");
		}

		// Analyze the connection error to extract OAuth endpoints
		const authResult = analyzeAuthError(connectionError!);
		let oauth = authResult.authType === "oauth" ? (authResult.oauth ?? null) : null;

		if (!oauth && (config.type === "http" || config.type === "sse") && config.url) {
			oauth = await discoverOAuthEndpoints(config.url, authResult.authServerUrl);
		}

		if (!oauth) {
			throw new Error("Could not discover OAuth endpoints from server response.");
		}

		return oauth;
	}

	async #waitForServerConnectionWithAnimation(
		name: string,
		options?: { suppressDisconnectedWarning?: boolean },
	): Promise<"connected" | "connecting" | "disconnected"> {
		if (!this.ctx.mcpManager) return "disconnected";

		this.ctx.chatContainer.addChild(new Spacer(1));
		const statusText = new Text(theme.fg("muted", `| Connecting to "${name}"...`), 1, 0);
		this.ctx.chatContainer.addChild(statusText);
		this.ctx.ui.requestRender();

		const frames = ["|", "/", "-", "\\"];
		let frame = 0;
		const interval = setInterval(() => {
			statusText.setText(theme.fg("muted", `${frames[frame % frames.length]} Connecting to "${name}"...`));
			frame++;
			this.ctx.ui.requestRender();
		}, 120);

		try {
			try {
				await withTimeout(this.ctx.mcpManager.waitForConnection(name), 10_000, "Connection still pending");
			} catch {
				// Ignore timeout/errors here and use status check below.
			}
			const settleDeadline = Date.now() + 12_000;
			let hadConnectingState = false;
			let state = this.ctx.mcpManager.getConnectionStatus(name);
			while (Date.now() < settleDeadline) {
				state = this.ctx.mcpManager.getConnectionStatus(name);
				if (state === "connected") {
					break;
				}
				if (state === "connecting") {
					hadConnectingState = true;
				}
				await Bun.sleep(400);
			}
			if (state === "connected") {
				// Connection may complete after initial reload; rebind runtime MCP tools now.
				await this.ctx.session.refreshMCPTools(this.ctx.mcpManager.getTools());
			}
			if (state === "connected") {
				statusText.setText(theme.fg("success", `✓ Connected to "${name}"`));
			} else if (state === "connecting") {
				statusText.setText(theme.fg("muted", `◌ "${name}" is still connecting...`));
			} else if (hadConnectingState) {
				state = "connecting";
				statusText.setText(theme.fg("muted", `◌ "${name}" is still connecting...`));
			} else {
				statusText.setText(
					options?.suppressDisconnectedWarning
						? theme.fg("muted", `◌ "${name}" is still initializing in the background`)
						: theme.fg("warning", `⚠ Could not connect to "${name}" yet`),
				);
			}
			this.ctx.ui.requestRender();
			return state;
		} finally {
			clearInterval(interval);
		}
	}

	async #syncManagerConnection(name: string, config: MCPServerConfig): Promise<void> {
		if (!this.ctx.mcpManager) return;
		if (this.ctx.mcpManager.getConnectionStatus(name) !== "disconnected") return;
		await this.ctx.mcpManager.connectServers({ [name]: config }, {});
		if (this.ctx.mcpManager.getConnectionStatus(name) === "connected") {
			await this.ctx.session.refreshMCPTools(this.ctx.mcpManager.getTools());
		}
	}

	async #handleWizardComplete(name: string, config: MCPServerConfig, scope: "user" | "project"): Promise<void> {
		try {
			// Determine file path
			const cwd = process.cwd();
			const filePath = getMCPConfigPath(scope, cwd);

			// Add server to config
			await addMCPServer(filePath, name, config);

			// Reload MCP manager
			await this.#reloadMCP({ suppressedErrorServers: new Set([name]) });
			const hasApiLikeEnv =
				config.type === "stdio" &&
				Object.keys(config.env ?? {}).some(key => /API[_-]?KEY|ACCESS[_-]?TOKEN|TOKEN/i.test(key));
			if (hasApiLikeEnv && this.ctx.mcpManager) {
				try {
					if (this.ctx.mcpManager.getConnectionStatus(name) !== "disconnected") {
						await this.ctx.mcpManager.disconnectServer(name);
					}
					await this.ctx.mcpManager.connectServers({ [name]: config }, {});
					await this.ctx.session.refreshMCPTools(this.ctx.mcpManager.getTools());
				} catch {
					// Keep default reload state; connection status handling below will report outcome.
				}
			}
			const state =
				config.enabled === false
					? "disconnected"
					: await this.#waitForServerConnectionWithAnimation(name, { suppressDisconnectedWarning: true });
			let isConnected = state === "connected";
			const isConnecting = state === "connecting";

			// Fallback: if manager state is still disconnected but direct test works,
			// report as connected to avoid false-negative messaging.
			if (!isConnected && !isConnecting && config.enabled !== false) {
				try {
					await this.#handleTestConnection(config);
					isConnected = true;
					await this.#syncManagerConnection(name, config);
				} catch {
					// Keep disconnected status
				}
			}

			// Show success message
			const scopeLabel = scope === "user" ? "user" : "project";
			const lines = ["", theme.fg("success", `✓ Added server "${name}" to ${scopeLabel} config`), ""];

			if (isConnected) {
				lines.push(theme.fg("success", `✓ Successfully connected to server`));
				lines.push("");
			} else if (isConnecting) {
				lines.push(theme.fg("muted", `◌ Server is connecting in background...`));
				lines.push(theme.fg("muted", `  Run ${theme.fg("accent", `/mcp test ${name}`)} in a few seconds.`));
				lines.push("");
			} else {
				lines.push(theme.fg("warning", `⚠ Server added but not yet connected`));
				lines.push(theme.fg("muted", `  Run ${theme.fg("accent", `/mcp test ${name}`)} to test the connection.`));
				lines.push("");
			}

			lines.push(theme.fg("muted", `Run ${theme.fg("accent", "/mcp list")} to see all configured servers.`));
			lines.push("");

			this.#showMessage(lines.join("\n"));
		} catch (error) {
			const errorMsg = error instanceof Error ? error.message : String(error);

			// Provide helpful error messages
			let helpText = "";
			if (errorMsg.includes("EACCES") || errorMsg.includes("permission denied")) {
				helpText = "\n\nTip: Check file permissions for the config directory.";
			} else if (errorMsg.includes("ENOSPC")) {
				helpText = "\n\nTip: Insufficient disk space.";
			} else if (errorMsg.includes("already exists")) {
				helpText = `\n\nTip: Use ${theme.fg("accent", "/mcp list")} to see existing servers.`;
			}

			this.ctx.showError(`Failed to add server: ${errorMsg}${helpText}`);
		}
	}

	async #pickRegistryResult(results: SmitherySearchResult[], keyword: string): Promise<SmitherySearchResult | null> {
		const items: RegistryPickerItem[] = results.map((result, index) => {
			const transport = sanitizeSelectText(result.display.transport);
			return {
				index,
				name: sanitizeSelectText(result.name),
				displayName: sanitizeSelectText(result.display.displayName),
				description: sanitizeSelectText(result.display.description),
				useCount: result.display.useCount,
				verified: result.display.verified,
				deployed: result.display.deployed,
				transport,
				connectionType: sanitizeSelectText(result.display.connectionType),
				createdAt: result.display.createdAt ? sanitizeSelectText(result.display.createdAt) : undefined,
				homepage: result.display.homepage ? sanitizeSelectText(result.display.homepage) : undefined,
				schemaParams: result.requiredInputs.map(input => sanitizeSelectText(input.key)),
				tools: result.display.tools.map(tool => ({
					name: sanitizeSelectText(tool.name),
					description: tool.description ? sanitizeSelectText(tool.description) : undefined,
					params: tool.params.map(param => sanitizeSelectText(param)),
				})),
			};
		});

		this.#showMessage(
			[
				"",
				theme.bold(`Registry results for "${keyword}"`),
				theme.fg(
					"dim",
					"Use Up/Down to navigate, Right to expand, Left to collapse, Enter to deploy, Esc to cancel.",
				),
				"",
			].join("\n"),
		);

		return await this.ctx.showHookCustom<SmitherySearchResult | null>((_tui, _theme, _keys, done) => {
			const selector = new RegistryResultPicker(items, Math.min(items.length, 10));
			selector.onSelect = index => {
				done(results[index] ?? null);
			};
			selector.onCancel = () => {
				done(null);
			};

			return selector;
		});
	}

	async #nextAvailableServerName(scope: MCPAddScope, baseName: string): Promise<string> {
		const filePath = getMCPConfigPath(scope, process.cwd());
		const config = await readMCPConfigFile(filePath);
		const existingNames = new Set(Object.keys(config.mcpServers ?? {}));
		if (!existingNames.has(baseName)) return baseName;
		for (let i = 2; i <= 999; i++) {
			const candidate = `${baseName}-${i}`;
			if (!existingNames.has(candidate)) {
				return candidate;
			}
		}
		return `${baseName}-${Date.now()}`;
	}

	async #deployRegistryResult(result: SmitherySearchResult, scope: MCPAddScope): Promise<void> {
		const baseName = toConfigName(result.name);
		const defaultName = await this.#nextAvailableServerName(scope, baseName);
		const serverName = await this.#promptDeploymentServerName(scope, defaultName);
		if (!serverName) {
			this.ctx.showStatus("MCP deploy cancelled.");
			return;
		}
		try {
			const smitheryConfig = await this.#createSmitheryRuntimeConfig(result, serverName);
			await this.#deployConfig({
				serverName,
				scope,
				config: smitheryConfig,
				prepareAuth: false,
				hasManualCredentials: true,
			});
		} catch (authError) {
			this.ctx.showError(authError instanceof Error ? authError.message : String(authError));
			return;
		}
	}

	async #ensureSmitheryConnectedConnection(
		apiKey: string,
		mcpUrl: string,
		connectionName: string,
	): Promise<{ namespace: string; connection: SmitheryConnection }> {
		const namespace = await resolveSmitheryNamespace(apiKey);
		const existingConnections = await listSmitheryConnectionsByUrl(apiKey, namespace, mcpUrl);
		let connection = existingConnections[0];
		if (!connection) {
			connection = await createSmitheryConnection(apiKey, namespace, {
				mcpUrl,
				name: connectionName,
			});
		}

		const connectionStatus = connection.status;
		if (connectionStatus?.state !== "auth_required") {
			return { namespace, connection };
		}

		const authUrl =
			typeof connectionStatus.authorizationUrl === "string" ? connectionStatus.authorizationUrl : undefined;
		if (authUrl) {
			this.#showMessage(
				[
					"",
					theme.bold(`Smithery authorization required for "${connectionName}"`),
					theme.fg("dim", "Complete authorization in your browser to continue."),
					theme.fg("accent", authUrl),
					"",
				].join("\n"),
			);
			await this.#openExternalUrl(authUrl);
		}

		const timeoutMs = 300_000;
		const pollMs = 2_000;
		const startedAt = Date.now();
		for (;;) {
			if (Date.now() - startedAt >= timeoutMs) {
				throw new Error(`Timed out waiting for Smithery authorization for "${connectionName}".`);
			}

			const nextConnection = await getSmitheryConnection(apiKey, namespace, connection.connectionId);
			const nextStatus = nextConnection.status?.state;
			if (nextStatus === "connected") {
				return { namespace, connection: nextConnection };
			}
			if (nextStatus === "error") {
				const message =
					nextConnection.status && "message" in nextConnection.status
						? String(nextConnection.status.message)
						: "Unknown error";
				throw new Error(`Smithery connection error for "${connectionName}": ${message}`);
			}

			await Bun.sleep(pollMs);
		}
	}

	async #createSmitheryRuntimeConfig(result: SmitherySearchResult, connectionName: string): Promise<MCPServerConfig> {
		const mcpUrl = `https://server.smithery.ai/${result.name}`;
		const getConfig = async (apiKey: string): Promise<MCPServerConfig> => {
			const { namespace, connection } = await this.#ensureSmitheryConnectedConnection(
				apiKey,
				mcpUrl,
				connectionName,
			);
			const runtimeUrl = `${getSmitheryApiBaseUrl()}/connect/${encodeURIComponent(namespace)}/${encodeURIComponent(connection.connectionId)}/mcp`;
			return {
				type: "http",
				url: runtimeUrl,
				headers: {
					Authorization: `Bearer ${apiKey}`,
				},
			};
		};
		return await this.#runSmitheryOperationWithAuthRetry(getConfig, "required for Smithery connect");
	}

	async #deployConfig(options: {
		serverName: string;
		scope: MCPAddScope;
		config: MCPServerConfig;
		prepareAuth: boolean;
		hasManualCredentials: boolean;
	}): Promise<void> {
		let config = options.config;
		if (options.prepareAuth && config.type !== "stdio") {
			config = await this.#prepareHttpConfigAuth(options.serverName, config, {
				hasManualCredentials: options.hasManualCredentials,
			});
		}
		await this.#handleWizardComplete(options.serverName, config, options.scope);
	}

	async #prepareHttpConfigAuth(
		serverName: string,
		config: MCPServerConfig,
		options: { hasManualCredentials: boolean },
	): Promise<MCPServerConfig> {
		if (config.type !== "http" && config.type !== "sse") {
			return config;
		}

		try {
			await this.#handleTestConnection(config);
			return config;
		} catch (error) {
			if (options.hasManualCredentials) {
				throw new Error(
					`Authentication failed for "${serverName}": ${error instanceof Error ? error.message : String(error)}`,
				);
			}

			const authResult = analyzeAuthError(error as Error);
			if (!authResult.requiresAuth) {
				return config;
			}

			let oauth = authResult.authType === "oauth" ? (authResult.oauth ?? null) : null;
			if (!oauth && config.url) {
				try {
					oauth = await discoverOAuthEndpoints(config.url);
				} catch {
					// Ignore discovery failure and throw below.
				}
			}

			if (!oauth) {
				const fallbackConfig = await this.#promptBearerFallback(serverName, config, "OAuth endpoints unavailable");
				if (fallbackConfig) return fallbackConfig;
				throw new Error(
					`Authentication required for "${serverName}", but OAuth endpoints could not be discovered. ` +
						`Use /mcp add ${serverName} (wizard) or configure auth manually.`,
				);
			}

			try {
				const credentialId = await this.#handleOAuthFlow(
					oauth.authorizationUrl,
					oauth.tokenUrl,
					oauth.clientId ?? "",
					"",
					oauth.scopes ?? "",
				);

				const oauthConfig: MCPServerConfig = {
					...config,
					auth: {
						type: "oauth",
						credentialId,
					},
				};

				try {
					await this.#handleTestConnection(oauthConfig);
				} catch {
					const fallbackConfig = await this.#promptBearerFallback(
						serverName,
						config,
						"OAuth completed but server token validation failed",
					);
					if (fallbackConfig) return fallbackConfig;
				}

				return oauthConfig;
			} catch (oauthError) {
				const oauthErrorMessage = oauthError instanceof Error ? oauthError.message : String(oauthError);
				const shouldTryClientIdFallback =
					this.#isClientIdRequiredError(oauthErrorMessage) ||
					(!oauth.clientId && /timeout|timed out/i.test(oauthErrorMessage));
				if (shouldTryClientIdFallback) {
					const clientIdFallback = await this.#promptClientIdFallback(serverName, config, oauth);
					if (clientIdFallback) return clientIdFallback;
				}

				const fallbackConfig = await this.#promptBearerFallback(
					serverName,
					config,
					`OAuth flow failed: ${oauthErrorMessage}`,
				);
				if (fallbackConfig) return fallbackConfig;
				throw oauthError;
			}
		}
	}

	#isClientIdRequiredError(message: string): boolean {
		const hasClientIdSignal = (value: string): boolean => /(?:^|[^a-z])client(?:[_\-\s]?id)(?:[^a-z]|$)/i.test(value);
		const hasMissingSignal = (value: string): boolean =>
			/(required|requires|missing|not provided|must be provided|absent|mandatory|expected)/i.test(value);
		const hasInvalidSignal = (value: string): boolean => /(invalid_request|invalid_client|invalid)/i.test(value);
		const decode = (value: string): string => {
			try {
				return decodeURIComponent(value.replace(/\+/g, "%20"));
			} catch {
				return value;
			}
		};
		const combineSignals = (value: string): boolean =>
			hasClientIdSignal(value) && (hasMissingSignal(value) || hasInvalidSignal(value));
		if (combineSignals(message)) return true;
		if (combineSignals(decode(message))) return true;

		// Parse inline JSON error payloads when present.
		const jsonMatch = message.match(/\{[\s\S]*\}/);
		if (jsonMatch) {
			try {
				const data = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
				const fields = [
					data.error,
					data.error_description,
					data.error_uri,
					data.message,
					data.detail,
					data.title,
					data.hint,
				]
					.filter((value): value is string => typeof value === "string")
					.join(" ");
				if (combineSignals(fields)) return true;
				if ((data.error === "invalid_request" || data.error === "invalid_client") && hasClientIdSignal(fields)) {
					return true;
				}
			} catch {
				// Ignore JSON parse failures and continue with other strategies.
			}
		}

		// Parse WWW-Authenticate style key/value pairs.
		const challengePairs = Array.from(message.matchAll(/([a-zA-Z_][a-zA-Z0-9_-]*)="([^"]+)"/g));
		if (challengePairs.length > 0) {
			const challenge = new Map<string, string>();
			for (const [, key, value] of challengePairs) {
				challenge.set(key.toLowerCase(), decode(value));
			}
			const errorText = `${challenge.get("error") ?? ""} ${challenge.get("error_description") ?? ""} ${
				challenge.get("message") ?? ""
			}`.trim();
			if (combineSignals(errorText)) return true;
		}

		// Parse URLs with query params that may encode OAuth errors.
		const urls = Array.from(message.matchAll(/https?:\/\/[^\s)\]]+/g)).map(match => match[0]);
		for (const rawUrl of urls) {
			try {
				const parsedUrl = new URL(rawUrl);
				const queryText = [
					parsedUrl.searchParams.get("error"),
					parsedUrl.searchParams.get("error_description"),
					parsedUrl.searchParams.get("message"),
				]
					.filter((value): value is string => typeof value === "string")
					.map(decode)
					.join(" ");
				if (combineSignals(queryText)) return true;
			} catch {
				// Ignore malformed URL-like strings.
			}
		}

		return false;
	}

	async #promptClientIdFallback(
		serverName: string,
		config: MCPServerConfig,
		oauth: { authorizationUrl: string; tokenUrl: string; scopes?: string },
	): Promise<MCPServerConfig | null> {
		const clientIdInput = await this.ctx.showHookInput(
			`OAuth provider for ${serverName} requires client_id. Enter client_id (Esc to skip)`,
		);
		if (clientIdInput === undefined) return null;

		const clientId = clientIdInput.trim();
		if (!clientId) {
			this.ctx.showError("client_id cannot be empty.");
			return null;
		}

		try {
			const credentialId = await this.#handleOAuthFlow(
				oauth.authorizationUrl,
				oauth.tokenUrl,
				clientId,
				"",
				oauth.scopes ?? "",
			);
			const oauthConfig: MCPServerConfig = {
				...config,
				auth: {
					type: "oauth",
					credentialId,
				},
			};
			await this.#handleTestConnection(oauthConfig);
			return oauthConfig;
		} catch (error) {
			this.ctx.showError(
				`OAuth retry with client_id failed for "${serverName}": ${error instanceof Error ? error.message : String(error)}`,
			);
			return null;
		}
	}

	async #promptBearerFallback(
		serverName: string,
		config: MCPServerConfig,
		reason: string,
	): Promise<MCPServerConfig | null> {
		if (config.type !== "http" && config.type !== "sse") return null;

		this.#showMessage(
			[
				"",
				theme.fg("warning", `OAuth fallback for "${serverName}"`),
				theme.fg("muted", reason),
				theme.fg("muted", "You can provide a bearer token manually."),
				"",
			].join("\n"),
		);

		for (;;) {
			const tokenInput = await this.ctx.showHookInput(`Bearer token for ${serverName} (Esc to cancel)`);
			if (tokenInput === undefined) return null;
			const trimmed = tokenInput.trim();
			if (trimmed.length === 0) {
				this.ctx.showError("Bearer token cannot be empty.");
				continue;
			}

			const authorization = /^bearer\s+/i.test(trimmed) ? trimmed : `Bearer ${trimmed}`;
			const candidateConfig: MCPServerConfig = {
				...config,
				headers: {
					...(config.headers ?? {}),
					Authorization: authorization,
				},
			};

			try {
				await this.#handleTestConnection(candidateConfig);
				return candidateConfig;
			} catch (error) {
				this.ctx.showError(
					`Bearer token validation failed for "${serverName}": ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
	}

	async #promptDeploymentServerName(scope: MCPAddScope, defaultName: string): Promise<string | null> {
		for (;;) {
			const input = await this.ctx.showHookInput(`Server name for deploy (default: ${defaultName})`, defaultName);
			if (input === undefined) return null;
			const proposed = input.trim().length > 0 ? input.trim() : defaultName;
			const validationError = validateServerName(proposed);
			if (validationError) {
				this.ctx.showError(validationError);
				continue;
			}

			const filePath = getMCPConfigPath(scope, process.cwd());
			const config = await readMCPConfigFile(filePath);
			if (config.mcpServers?.[proposed]) {
				this.ctx.showError(`Server "${proposed}" already exists in ${scope} config.`);
				continue;
			}
			return proposed;
		}
	}

	async #openExternalUrl(url: string): Promise<void> {
		const isWindows = process.platform === "win32";
		const isMac = process.platform === "darwin";
		const isLinux = process.platform === "linux";
		if (isWindows) {
			Bun.spawn(["rundll32.exe", "url.dll,FileProtocolHandler", url], {
				stdout: "ignore",
				stderr: "ignore",
				stdin: "ignore",
			});
			return;
		}
		if (isMac) {
			Bun.spawn(["open", url], {
				stdout: "ignore",
				stderr: "ignore",
				stdin: "ignore",
			});
			return;
		}
		if (isLinux) {
			Bun.spawn(["xdg-open", url], {
				stdout: "ignore",
				stderr: "ignore",
				stdin: "ignore",
			});
		}
	}

	async #validateSmitheryApiKey(apiKey: string): Promise<void> {
		await searchSmitheryRegistry("mcp", { limit: 1, apiKey });
	}

	async #promptSmitheryApiKey(promptLabel: string): Promise<string | null> {
		for (;;) {
			const input = await this.ctx.showHookInput(promptLabel);
			if (input === undefined) return null;
			const apiKey = input.trim();
			if (!apiKey) {
				this.ctx.showError("Smithery API key cannot be empty.");
				continue;
			}
			try {
				await this.#validateSmitheryApiKey(apiKey);
				return apiKey;
			} catch (error) {
				this.ctx.showError(
					`Smithery API key validation failed: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
	}

	async #handleSmitheryLoginWithApiKey(): Promise<boolean> {
		const apiKey = await this.#promptSmitheryApiKey("Smithery API key (Esc to cancel)");
		if (!apiKey) return false;
		await saveSmitheryApiKey(apiKey);
		this.ctx.showStatus("Smithery API key saved.");
		return true;
	}

	async #waitForSmitheryCliApiKey(sessionId: string, signal: AbortSignal): Promise<string> {
		const pollIntervalMs = 2_000;
		const timeoutMs = 300_000;
		const startedAt = Date.now();

		while (!signal.aborted) {
			if (Date.now() - startedAt >= timeoutMs) {
				throw new Error("Smithery authorization timed out after 5 minutes.");
			}

			const response = await pollSmitheryCliAuthSession(sessionId, signal);
			if (response.status === "success" && response.apiKey) {
				return response.apiKey;
			}
			if (response.status === "error") {
				throw new Error(response.message ?? "Smithery authorization failed.");
			}
			await Bun.sleep(pollIntervalMs);
		}

		throw new Error("Smithery authorization cancelled.");
	}

	async #handleSmitheryBrowserLogin(): Promise<boolean> {
		const session = await createSmitheryCliAuthSession();
		const fallbackLoginUrl = getSmitheryLoginUrl();
		this.#showMessage(
			[
				"",
				theme.bold("Smithery Login"),
				theme.fg(
					"muted",
					"Browser authorization started. You can also paste an API key; whichever completes first is used.",
				),
				theme.fg("dim", "Authorize URL:"),
				theme.fg("accent", session.authUrl),
				theme.fg("dim", `Fallback: ${fallbackLoginUrl}`),
				"",
			].join("\n"),
		);
		try {
			await this.#openExternalUrl(session.authUrl);
		} catch {
			// URL is shown in chat as fallback.
		}

		const abortController = new AbortController();
		const { promise, resolve, reject } = Promise.withResolvers<string | null>();
		let settled = false;
		let manualDone = false;
		let browserDone = false;
		let browserError: unknown;

		const settleResolve = (value: string | null) => {
			if (settled) return;
			settled = true;
			resolve(value);
		};
		const settleReject = (error: unknown) => {
			if (settled) return;
			settled = true;
			reject(error);
		};

		void (async () => {
			try {
				const apiKey = await this.#promptSmitheryApiKey(
					"Paste Smithery API key (or wait for browser auth). Esc skips manual entry.",
				);
				manualDone = true;
				if (apiKey) {
					abortController.abort();
					settleResolve(apiKey);
					return;
				}
				if (browserDone && !settled) {
					if (browserError) {
						settleReject(browserError);
						return;
					}
					settleResolve(null);
				}
			} catch (error) {
				manualDone = true;
				settleReject(error);
			}
		})();

		void (async () => {
			try {
				const apiKey = await this.#waitForSmitheryCliApiKey(session.sessionId, abortController.signal);
				browserDone = true;
				this.ctx.hideHookInput();
				settleResolve(apiKey);
			} catch (error) {
				browserDone = true;
				browserError = error;
				if (manualDone && !settled) {
					settleReject(error);
				}
			}
		})();

		const apiKey = await promise;
		if (!apiKey) return false;
		await this.#validateSmitheryApiKey(apiKey);
		await saveSmitheryApiKey(apiKey);
		this.ctx.showStatus("Smithery API key saved.");
		return true;
	}

	async #promptSmitheryLogin(reason: string): Promise<boolean> {
		this.#showMessage(["", theme.fg("muted", `Smithery authentication required (${reason}).`), ""].join("\n"));
		try {
			return await this.#handleSmitheryBrowserLogin();
		} catch (error) {
			this.ctx.showWarning(
				`Browser authorization failed: ${error instanceof Error ? error.message : String(error)}. Falling back to API key.`,
			);
			return await this.#handleSmitheryLoginWithApiKey();
		}
	}

	#getSmitheryErrorStatus(error: unknown): number | undefined {
		if (error instanceof SmitheryRegistryError || error instanceof SmitheryConnectError) {
			return error.status;
		}
		return undefined;
	}

	#toSmitheryAuthReason(status: number): string {
		return status === 429 ? "rate limited by Smithery" : "forbidden/unauthorized with Smithery";
	}

	async #requireSmitheryApiKey(reason: string): Promise<string> {
		let apiKey = await getSmitheryApiKey();
		if (apiKey) return apiKey;

		const loggedIn = await this.#promptSmitheryLogin(reason);
		if (!loggedIn) {
			throw new Error("Smithery authentication was cancelled.");
		}

		apiKey = await getSmitheryApiKey();
		if (!apiKey) {
			throw new Error("Smithery API key not found after login.");
		}
		return apiKey;
	}

	async #runSmitheryOperationWithAuthRetry<T>(operation: (apiKey: string) => Promise<T>, reason: string): Promise<T> {
		const apiKey = await this.#requireSmitheryApiKey(reason);
		try {
			return await operation(apiKey);
		} catch (error) {
			const status = this.#getSmitheryErrorStatus(error);
			if (status === undefined || ![401, 403, 429].includes(status)) {
				throw error;
			}
			const loggedIn = await this.#promptSmitheryLogin(this.#toSmitheryAuthReason(status));
			if (!loggedIn) {
				throw error;
			}
			const retryApiKey = await this.#requireSmitheryApiKey(reason);
			return await operation(retryApiKey);
		}
	}

	async #handleSmitheryLogin(): Promise<void> {
		const ok = await this.#promptSmitheryLogin("login");
		if (!ok) {
			this.ctx.showStatus("Smithery login cancelled.");
		}
	}

	async #handleSmitheryLogout(): Promise<void> {
		const removed = await clearSmitheryApiKey();
		this.ctx.showStatus(removed ? "Smithery API key removed." : "No cached Smithery API key found.");
	}

	async #handleSearch(text: string): Promise<void> {
		const parsed = this.#parseSearchCommand(text);
		if (parsed.error) {
			this.ctx.showError(parsed.error);
			return;
		}

		try {
			this.#showMessage(
				["", theme.fg("muted", `Searching Smithery registry for "${parsed.keyword}"...`), ""].join("\n"),
			);
			const results = await this.#runSmitheryOperationWithAuthRetry(
				apiKey =>
					searchSmitheryRegistry(parsed.keyword, {
						limit: parsed.limit,
						apiKey,
						includeSemantic: parsed.semantic,
					}),
				"required for registry search",
			);
			if (results.length === 0) {
				this.#showMessage(
					["", theme.fg("warning", `No registry results found for "${parsed.keyword}".`), ""].join("\n"),
				);
				return;
			}

			const selected = await this.#pickRegistryResult(results, parsed.keyword);
			if (!selected) {
				this.ctx.showStatus("MCP registry selection cancelled.");
				return;
			}

			await this.#deployRegistryResult(selected, parsed.scope);
		} catch (error) {
			this.ctx.showError(`Registry search failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	#handleWizardCancel(): void {
		this.#showMessage(
			[
				"",
				theme.fg("muted", "Server creation cancelled."),
				"",
				theme.fg("dim", "Tip: Press Ctrl+C or Esc anytime to cancel"),
				"",
			].join("\n"),
		);
	}

	/**
	 * Handle /mcp list - Show all configured servers
	 */
	async #handleList(): Promise<void> {
		try {
			const cwd = process.cwd();

			// Load from both user and project configs
			const userPath = getMCPConfigPath("user", cwd);
			const projectPath = getMCPConfigPath("project", cwd);

			const [userConfig, projectConfig] = await Promise.all([
				readMCPConfigFile(userPath),
				readMCPConfigFile(projectPath),
			]);

			const userServers = Object.keys(userConfig.mcpServers ?? {});
			const projectServers = Object.keys(projectConfig.mcpServers ?? {});

			// Collect runtime-discovered servers not in config files
			const configServerNames = new Set([...userServers, ...projectServers]);
			const disabledServerNames = new Set(await readDisabledServers(userPath));
			const discoveredServers: { name: string; source: SourceMeta }[] = [];
			if (this.ctx.mcpManager) {
				for (const name of this.ctx.mcpManager.getAllServerNames()) {
					if (configServerNames.has(name)) continue;
					if (disabledServerNames.has(name)) continue;
					const source = this.ctx.mcpManager.getSource(name);
					if (source) {
						discoveredServers.push({ name, source });
					}
				}
			}

			if (
				userServers.length === 0 &&
				projectServers.length === 0 &&
				discoveredServers.length === 0 &&
				disabledServerNames.size === 0
			) {
				this.#showMessage(
					[
						"",
						theme.fg("muted", "No MCP servers configured."),
						"",
						`Use ${theme.fg("accent", "/mcp add")} to add a server.`,
						"",
					].join("\n"),
				);
				return;
			}

			const lines: string[] = ["", theme.bold("Configured MCP Servers"), ""];

			// Show user-level servers
			if (userServers.length > 0) {
				lines.push(theme.fg("accent", "User level") + theme.fg("muted", ` (~/.omp/mcp.json):`));
				for (const name of userServers) {
					const config = userConfig.mcpServers![name];
					const type = config.type ?? "stdio";
					const state =
						config.enabled === false
							? "inactive"
							: (this.ctx.mcpManager?.getConnectionStatus(name) ?? "disconnected");
					const status =
						state === "inactive"
							? theme.fg("warning", " ◌ inactive")
							: state === "connected"
								? theme.fg("success", " ● connected")
								: state === "connecting"
									? theme.fg("muted", " ◌ connecting")
									: theme.fg("muted", " ○ not connected");
					lines.push(`  ${theme.fg("accent", name)}${status} ${theme.fg("dim", `[${type}]`)}`);
				}
				lines.push("");
			}

			// Show project-level servers
			if (projectServers.length > 0) {
				lines.push(theme.fg("accent", "Project level") + theme.fg("muted", ` (.omp/mcp.json):`));
				for (const name of projectServers) {
					const config = projectConfig.mcpServers![name];
					const type = config.type ?? "stdio";
					const state =
						config.enabled === false
							? "inactive"
							: (this.ctx.mcpManager?.getConnectionStatus(name) ?? "disconnected");
					const status =
						state === "inactive"
							? theme.fg("warning", " ◌ inactive")
							: state === "connected"
								? theme.fg("success", " ● connected")
								: state === "connecting"
									? theme.fg("muted", " ◌ connecting")
									: theme.fg("muted", " ○ not connected");
					lines.push(`  ${theme.fg("accent", name)}${status} ${theme.fg("dim", `[${type}]`)}`);
				}
				lines.push("");
			}

			// Show discovered servers (from .claude.json, .cursor/mcp.json, .vscode/mcp.json, etc.)
			if (discoveredServers.length > 0) {
				// Group by source display name + path
				const bySource = new Map<string, typeof discoveredServers>();
				for (const entry of discoveredServers) {
					const key = `${entry.source.providerName}|${entry.source.path}`;
					let group = bySource.get(key);
					if (!group) {
						group = [];
						bySource.set(key, group);
					}
					group.push(entry);
				}

				for (const [key, entries] of bySource) {
					const sepIdx = key.indexOf("|");
					const providerName = key.slice(0, sepIdx);
					const sourcePath = key.slice(sepIdx + 1);
					const shortPath = shortenPath(sourcePath);
					lines.push(theme.fg("accent", providerName) + theme.fg("muted", ` (${shortPath}):`));
					for (const { name } of entries) {
						const state = this.ctx.mcpManager!.getConnectionStatus(name);
						const status =
							state === "connected"
								? theme.fg("success", " ● connected")
								: state === "connecting"
									? theme.fg("muted", " ◌ connecting")
									: theme.fg("muted", " ○ not connected");
						lines.push(`  ${theme.fg("accent", name)}${status}`);
					}
					lines.push("");
				}
			}

			// Show servers disabled via /mcp disable (from third-party configs)
			const relevantDisabled = [...disabledServerNames].filter(n => !configServerNames.has(n));
			if (relevantDisabled.length > 0) {
				lines.push(theme.fg("accent", "Disabled") + theme.fg("muted", " (discovered servers):"));
				for (const name of relevantDisabled) {
					lines.push(`  ${theme.fg("accent", name)}${theme.fg("warning", " ◌ disabled")}`);
				}
				lines.push("");
			}
			this.#showMessage(lines.join("\n"));
		} catch (error) {
			this.ctx.showError(`Failed to list servers: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	/**
	 * Handle /mcp remove <name> - Remove a server
	 */
	async #handleRemove(text: string): Promise<void> {
		const match = text.match(/^\/mcp\s+(?:remove|rm)\b\s*(.*)$/i);
		const rest = match?.[1]?.trim() ?? "";
		const tokens = parseCommandArgs(rest);

		let name: string | undefined;
		let scope: "project" | "user" = "project";
		let i = 0;

		if (tokens.length > 0 && !tokens[0].startsWith("-")) {
			name = tokens[0];
			i = 1;
		}

		while (i < tokens.length) {
			const token = tokens[i];
			if (token === "--scope") {
				const value = tokens[i + 1];
				if (!value || (value !== "project" && value !== "user")) {
					this.ctx.showError("Invalid --scope value. Use project or user.");
					return;
				}
				scope = value;
				i += 2;
				continue;
			}
			this.ctx.showError(`Unknown option: ${token}`);
			return;
		}

		if (!name) {
			this.ctx.showError("Server name required. Usage: /mcp remove <name> [--scope project|user]");
			return;
		}

		try {
			const cwd = process.cwd();
			const userPath = getMCPConfigPath("user", cwd);
			const projectPath = getMCPConfigPath("project", cwd);
			const filePath = scope === "user" ? userPath : projectPath;
			const config = await readMCPConfigFile(filePath);
			if (!config.mcpServers?.[name]) {
				this.ctx.showError(`Server "${name}" not found in ${scope} config.`);
				return;
			}

			// Disconnect if connected
			if (this.ctx.mcpManager?.getConnection(name)) {
				await this.ctx.mcpManager.disconnectServer(name);
			}

			await this.#cleanupServerAuthArtifacts(name, config.mcpServers[name]);

			// Remove from config
			await removeMCPServer(filePath, name);

			// Reload MCP manager
			await this.#reloadMCP();

			this.#showMessage(["", theme.fg("success", `✓ Removed server "${name}" from ${scope} config`), ""].join("\n"));
		} catch (error) {
			this.ctx.showError(`Failed to remove server: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	/**
	 * Handle /mcp test <name> - Test connection to a server
	 */
	async #handleTest(name: string | undefined): Promise<void> {
		if (!name) {
			this.ctx.showError("Server name required. Usage: /mcp test <name>");
			return;
		}

		const originalOnEscape = this.ctx.editor.onEscape;
		const abortController = new AbortController();
		this.ctx.editor.onEscape = () => {
			abortController.abort();
		};

		let connection: MCPServerConnection | undefined;
		try {
			const cwd = process.cwd();
			const userPath = getMCPConfigPath("user", cwd);
			const projectPath = getMCPConfigPath("project", cwd);

			// Find the server config
			const [userConfig, projectConfig] = await Promise.all([
				readMCPConfigFile(userPath),
				readMCPConfigFile(projectPath),
			]);

			const config = userConfig.mcpServers?.[name] ?? projectConfig.mcpServers?.[name];

			if (!config) {
				this.ctx.showError(
					`Server "${name}" not found.\n\nTip: Run ${theme.fg("accent", "/mcp list")} to see available servers.`,
				);
				return;
			}
			if (config.enabled === false) {
				this.ctx.showError(`Server "${name}" is disabled. Run /mcp enable ${name} first.`);
				return;
			}

			this.#showMessage(
				["", theme.fg("muted", `Testing connection to "${name}"... (esc to cancel)`), ""].join("\n"),
			);

			// Resolve auth config if needed
			let resolvedConfig: MCPServerConfig;
			if (this.ctx.mcpManager) {
				resolvedConfig = await this.ctx.mcpManager.prepareConfig(config);
			} else {
				const tempManager = new MCPManager(process.cwd());
				tempManager.setAuthStorage(this.ctx.session.modelRegistry.authStorage);
				resolvedConfig = await tempManager.prepareConfig(config);
			}

			// Create temporary connection
			connection = await connectToServer(name, resolvedConfig, { signal: abortController.signal });

			// List tools to verify connection
			const tools = await listTools(connection, { signal: abortController.signal });

			const lines = [
				"",
				theme.fg("success", `✓ Successfully connected to "${name}"`),
				"",
				`  Server: ${connection.serverInfo.name} v${connection.serverInfo.version}`,
				`  Tools: ${tools.length}`,
			];

			// Show tool names if there are any
			if (tools.length > 0 && tools.length <= 10) {
				lines.push("");
				lines.push("  Available tools:");
				for (const tool of tools) {
					lines.push(`    • ${tool.name}`);
				}
			}

			lines.push("");
			await this.#syncManagerConnection(name, config);
			this.#showMessage(lines.join("\n"));
		} catch (error) {
			if (abortController.signal.aborted || (error instanceof Error && error.name === "AbortError")) {
				this.ctx.showStatus(`Cancelled MCP test for "${name}"`);
				return;
			}

			const errorMsg = error instanceof Error ? error.message : String(error);

			// Provide helpful error messages
			let helpText = "";
			if (errorMsg.includes("ENOENT") || errorMsg.includes("not found")) {
				helpText = "\n\nTip: Check that the command or URL is correct.";
			} else if (errorMsg.includes("EACCES")) {
				helpText = "\n\nTip: Check file/command permissions.";
			} else if (errorMsg.includes("ECONNREFUSED")) {
				helpText = "\n\nTip: Check that the server is running and the URL/port is correct.";
			} else if (errorMsg.includes("timeout")) {
				helpText = "\n\nTip: The server may be slow or unresponsive. Try increasing the timeout.";
			} else if (errorMsg.includes("401") || errorMsg.includes("403")) {
				helpText = "\n\nTip: Check your authentication credentials.";
			}

			this.ctx.showError(`Failed to connect to "${name}": ${errorMsg}${helpText}`);
		} finally {
			this.ctx.editor.onEscape = originalOnEscape;
			if (connection) {
				// Best-effort: don't block UI on cleanup.
				void disconnectServer(connection);
			}
		}
	}

	async #handleSetEnabled(name: string | undefined, enabled: boolean): Promise<void> {
		if (!name) {
			this.ctx.showError(`Server name required. Usage: /mcp ${enabled ? "enable" : "disable"} <name>`);
			return;
		}

		try {
			const found = await this.#findConfiguredServer(name);
			if (!found) {
				// Check if this is a discovered server from a third-party config
				const userConfigPath = getMCPConfigPath("user", getProjectDir());
				const disabledServers = new Set(await readDisabledServers(userConfigPath));
				const isDiscovered = this.ctx.mcpManager?.getSource(name);
				const isCurrentlyDisabled = disabledServers.has(name);
				if (!isDiscovered && !isCurrentlyDisabled) {
					this.ctx.showError(`Server "${name}" not found.`);
					return;
				}
				if (isCurrentlyDisabled === !enabled) {
					this.#showMessage(
						["", theme.fg("muted", `Server "${name}" is already ${enabled ? "enabled" : "disabled"}.`), ""].join(
							"\n",
						),
					);
					return;
				}
				await setServerDisabled(userConfigPath, name, !enabled);
				if (enabled) {
					await this.#reloadMCP();
					const state = await this.#waitForServerConnectionWithAnimation(name);
					const status =
						state === "connected"
							? theme.fg("success", "Connected")
							: state === "connecting"
								? theme.fg("muted", "Connecting")
								: theme.fg("warning", "Not connected yet");
					this.#showMessage(
						["", theme.fg("success", `\u2713 Enabled "${name}"`), "", `  Status: ${status}`, ""].join("\n"),
					);
				} else {
					await this.ctx.mcpManager?.disconnectServer(name);
					await this.ctx.session.refreshMCPTools(this.ctx.mcpManager?.getTools() ?? []);
					this.#showMessage(["", theme.fg("success", `\u2713 Disabled "${name}"`), ""].join("\n"));
				}
				return;
			}

			if ((found.config.enabled ?? true) === enabled) {
				this.#showMessage(
					["", theme.fg("muted", `Server "${name}" is already ${enabled ? "enabled" : "disabled"}.`), ""].join(
						"\n",
					),
				);
				return;
			}

			const updated: MCPServerConfig = { ...found.config, enabled };
			await updateMCPServer(found.filePath, name, updated);
			await this.#reloadMCP();

			let status = "";
			if (enabled) {
				const state = await this.#waitForServerConnectionWithAnimation(name);
				status =
					state === "connected"
						? theme.fg("success", "Connected")
						: state === "connecting"
							? theme.fg("muted", "Connecting")
							: theme.fg("warning", "Not connected yet");
			}

			const lines = [
				"",
				theme.fg("success", `✓ ${enabled ? "Enabled" : "Disabled"} "${name}" (${found.scope} config)`),
			];
			if (status) {
				lines.push("");
				lines.push(`  Status: ${status}`);
			}
			lines.push("");
			this.#showMessage(lines.join("\n"));
		} catch (error) {
			this.ctx.showError(
				`Failed to ${enabled ? "enable" : "disable"} server: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	async #handleUnauth(name: string | undefined): Promise<void> {
		if (!name) {
			this.ctx.showError("Server name required. Usage: /mcp unauth <name>");
			return;
		}

		try {
			const found = await this.#findConfiguredServer(name);
			if (!found) {
				this.ctx.showError(`Server "${name}" not found.`);
				return;
			}

			await this.#cleanupServerAuthArtifacts(name, found.config);

			const updated = this.#stripOAuthAuth(found.config);
			await updateMCPServer(found.filePath, name, updated);
			await this.#reloadMCP();

			this.#showMessage(
				["", theme.fg("success", `✓ Cleared auth for "${name}" (${found.scope} config)`), ""].join("\n"),
			);
		} catch (error) {
			this.ctx.showError(`Failed to clear auth: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	async #handleReauth(name: string | undefined): Promise<void> {
		if (!name) {
			this.ctx.showError("Server name required. Usage: /mcp auth <name>");
			return;
		}

		try {
			const found = await this.#findConfiguredServer(name);
			if (!found) {
				this.ctx.showError(`Server "${name}" not found.`);
				return;
			}

			if (found.config.enabled === false) {
				this.ctx.showError(`Server "${name}" is disabled. Run /mcp enable ${name} first.`);
				return;
			}

			const currentAuth = (
				found.config as MCPServerConfig & { auth?: { type: "oauth" | "apikey"; credentialId?: string } }
			).auth;
			if (currentAuth?.type === "oauth") {
				await this.#removeManagedOAuthCredential(currentAuth.credentialId);
			}

			const baseConfig = this.#stripOAuthAuth(found.config);
			const oauth = await this.#resolveOAuthEndpointsFromServer(baseConfig);

			this.#showMessage(["", theme.fg("muted", `Reauthorizing "${name}"...`), ""].join("\n"));

			const credentialId = await this.#handleOAuthFlow(
				oauth.authorizationUrl,
				oauth.tokenUrl,
				oauth.clientId ?? found.config.oauth?.clientId ?? "",
				"",
				oauth.scopes ?? "",
				found.config.oauth?.callbackPort,
			);

			const updated: MCPServerConfig = {
				...baseConfig,
				auth: {
					type: "oauth",
					credentialId,
				},
			};
			await updateMCPServer(found.filePath, name, updated);
			await this.#reloadMCP();
			const state = await this.#waitForServerConnectionWithAnimation(name);

			const lines = [
				"",
				theme.fg("success", `✓ Reauthorized "${name}" (${found.scope} config)`),
				"",
				`  Status: ${
					state === "connected"
						? theme.fg("success", "connected")
						: state === "connecting"
							? theme.fg("muted", "connecting")
							: theme.fg("warning", "not connected")
				}`,
				"",
			];
			this.#showMessage(lines.join("\n"));
		} catch (error) {
			this.ctx.showError(`Failed to reauthorize server: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	async #handleReload(): Promise<void> {
		try {
			this.#showMessage(["", theme.fg("muted", "Reloading MCP servers and runtime tools..."), ""].join("\n"));
			await this.#reloadMCP();
			const connectedCount = this.ctx.mcpManager?.getConnectedServers().length ?? 0;
			this.#showMessage(
				["", theme.fg("success", "✓ MCP reload complete"), `  Connected servers: ${connectedCount}`, ""].join("\n"),
			);
		} catch (error) {
			this.ctx.showError(`Failed to reload MCP: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	/**
	 * Reload MCP manager with new configs
	 */
	async #reloadMCP(options?: { suppressedErrorServers?: Set<string> }): Promise<void> {
		if (!this.ctx.mcpManager) {
			return;
		}

		// Disconnect all existing servers
		await this.ctx.mcpManager.disconnectAll();

		// Rediscover and connect
		const result = await this.ctx.mcpManager.discoverAndConnect();
		await this.ctx.session.refreshMCPTools(this.ctx.mcpManager.getTools());

		// Show any connection errors
		if (result.errors.size > 0) {
			const visibleErrors = [...result.errors.entries()].filter(([serverName]) => {
				return !options?.suppressedErrorServers?.has(serverName);
			});
			if (visibleErrors.length === 0) {
				return;
			}
			const errorLines = ["", theme.fg("warning", "Some servers failed to connect:"), ""];
			for (const [serverName, error] of visibleErrors) {
				errorLines.push(`  ${serverName}: ${error}`);
			}
			errorLines.push("");
			this.#showMessage(errorLines.join("\n"));
		}
	}

	/**
	 * Handle /mcp resources - Show available resources from connected servers
	 */
	async #handleResources(): Promise<void> {
		if (!this.ctx.mcpManager) {
			this.ctx.showError("No MCP manager available.");
			return;
		}

		const servers = this.ctx.mcpManager.getConnectedServers();
		const lines: string[] = ["", theme.bold("MCP Resources"), ""];
		let hasAny = false;

		for (const name of servers) {
			const data = this.ctx.mcpManager.getServerResources(name);
			if (!data) continue;
			const { resources, templates } = data;
			if (resources.length === 0 && templates.length === 0) continue;
			hasAny = true;

			lines.push(`${theme.fg("accent", name)}:`);
			for (const r of resources) {
				const desc = r.description ? ` ${theme.fg("dim", r.description)}` : "";
				const mime = r.mimeType ? ` ${theme.fg("dim", `[${r.mimeType}]`)}` : "";
				lines.push(`  ${theme.fg("success", r.uri)}${mime}${desc}`);
			}
			if (templates.length > 0) {
				lines.push(`  ${theme.fg("muted", "Templates:")}`);
				for (const t of templates) {
					const desc = t.description ? ` ${theme.fg("dim", t.description)}` : "";
					lines.push(`    ${theme.fg("accent", t.uriTemplate)}${desc}`);
				}
			}
			lines.push("");
		}

		if (!hasAny) {
			lines.push(theme.fg("muted", "No resources available on connected servers."));
			lines.push("");
		}
		this.#showMessage(lines.join("\n"));
	}

	/**
	 * Handle /mcp prompts - Show available prompts from connected servers
	 */
	async #handlePrompts(): Promise<void> {
		if (!this.ctx.mcpManager) {
			this.ctx.showError("No MCP manager available.");
			return;
		}

		const servers = this.ctx.mcpManager.getConnectedServers();
		const lines: string[] = ["", theme.bold("MCP Prompts"), ""];
		let hasAny = false;

		for (const name of servers) {
			const prompts = this.ctx.mcpManager.getServerPrompts(name);
			if (!prompts?.length) continue;
			hasAny = true;

			lines.push(`${theme.fg("accent", name)}:`);
			for (const p of prompts) {
				const commandName = `${name}:${p.name}`;
				const desc = p.description ? ` ${theme.fg("dim", p.description)}` : "";
				lines.push(`  ${theme.fg("success", `/${commandName}`)}${desc}`);
				if (p.arguments?.length) {
					for (const arg of p.arguments) {
						const required = arg.required ? theme.fg("warning", " *") : "";
						const argDesc = arg.description ? ` - ${arg.description}` : "";
						lines.push(`    ${arg.name}=${required}${theme.fg("dim", argDesc)}`);
					}
				}
			}
			lines.push("");
		}

		if (!hasAny) {
			lines.push(theme.fg("muted", "No prompts available on connected servers."));
			lines.push("");
		}
		this.#showMessage(lines.join("\n"));
	}

	/**
	 * Handle /mcp notifications - Show notification and subscription state
	 */
	async #handleNotifications(): Promise<void> {
		if (!this.ctx.mcpManager) {
			this.ctx.showError("No MCP manager available.");
			return;
		}

		const { enabled, subscriptions } = this.ctx.mcpManager.getNotificationState();
		const servers = this.ctx.mcpManager.getConnectedServers();
		const statusIcon = enabled ? theme.fg("success", "enabled") : theme.fg("warning", "disabled");
		const lines: string[] = ["", theme.bold("MCP Notifications"), ""];
		lines.push(`  Status: ${statusIcon}  ${theme.fg("dim", "(mcp.notifications setting)")}`);
		lines.push("");

		let hasAny = false;
		for (const name of servers) {
			const connection = this.ctx.mcpManager.getConnection(name);
			if (!connection) continue;
			const caps = connection.capabilities;
			const supportsResources = caps.resources !== undefined;
			const supportsSubscribe = caps.resources?.subscribe === true;
			const supportsToolsChanged = caps.tools?.listChanged === true;
			const supportsPromptsChanged = caps.prompts?.listChanged === true;
			const supportsResourcesChanged = caps.resources?.listChanged === true;

			const hasNotifications =
				supportsToolsChanged || supportsPromptsChanged || supportsResourcesChanged || supportsSubscribe;
			if (!hasNotifications) continue;
			hasAny = true;

			lines.push(`${theme.fg("accent", name)}:`);
			const check = theme.fg("success", "\u2713");
			const cross = theme.fg("dim", "\u2717");
			if (supportsToolsChanged) lines.push(`  ${check} tools/list_changed`);
			if (supportsResourcesChanged) lines.push(`  ${check} resources/list_changed`);
			if (supportsPromptsChanged) lines.push(`  ${check} prompts/list_changed`);

			if (supportsSubscribe) {
				const subscribedUris = subscriptions.get(name);
				const subCount = subscribedUris?.size ?? 0;
				const subStatus =
					enabled && subCount > 0
						? theme.fg("success", `subscribed (${subCount} URI${subCount !== 1 ? "s" : ""})`)
						: enabled
							? theme.fg("muted", "no active subscriptions")
							: theme.fg("dim", "inactive (notifications disabled)");
				lines.push(`  ${check} resources/subscribe  ${subStatus}`);
				if (enabled && subscribedUris && subscribedUris.size > 0) {
					for (const uri of subscribedUris) {
						lines.push(`    ${theme.fg("success", "\u2713")} ${theme.fg("dim", uri)}`);
					}
				}
			} else if (supportsResources) {
				lines.push(`  ${cross} resources/subscribe  ${theme.fg("dim", "not supported")}`);
			}
			lines.push("");
		}

		if (!hasAny) {
			lines.push(theme.fg("muted", "No servers support notifications."));
			lines.push("");
		}
		this.#showMessage(lines.join("\n"));
	}

	/**
	 * Show a message in the chat
	 */
	#showMessage(text: string): void {
		this.ctx.chatContainer.addChild(new Spacer(1));
		this.ctx.chatContainer.addChild(new DynamicBorder());
		this.ctx.chatContainer.addChild(new Text(text, 1, 1));
		this.ctx.chatContainer.addChild(new DynamicBorder());
		this.ctx.ui.requestRender();
	}
}
