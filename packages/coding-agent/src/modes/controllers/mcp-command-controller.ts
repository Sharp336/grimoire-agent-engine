/**
 * MCP Command Controller
 *
 * Handles /mcp subcommands for managing MCP servers.
 */
import { type SelectItem, SelectList, Spacer, Text } from "@oh-my-pi/pi-tui";
import { analyzeAuthError, discoverOAuthEndpoints, MCPManager } from "../../mcp";
import { connectToServer, disconnectServer, listTools } from "../../mcp/client";
import {
	addMCPServer,
	getMCPConfigPath,
	readMCPConfigFile,
	removeMCPServer,
	updateMCPServer,
	validateServerName,
} from "../../mcp/config-writer";
import { MCPOAuthFlow } from "../../mcp/oauth-flow";
import { type OfficialRegistrySearchResult, searchOfficialRegistry, toConfigName } from "../../mcp/official-registry";
import type { MCPServerConfig, MCPServerConnection } from "../../mcp/types";
import type { OAuthCredential } from "../../session/auth-storage";
import { DynamicBorder } from "../components/dynamic-border";
import { MCPAddWizard } from "../components/mcp-add-wizard";
import { getSelectListTheme, theme } from "../theme/theme";
import type { InteractiveModeContext } from "../types";

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
	const { promise: timeoutPromise, reject } = Promise.withResolvers<T>();
	const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
	return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timer));
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
	error?: string;
};

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
			case "reload":
				await this.#handleReload();
				break;
			case "search":
				await this.#handleSearch(text);
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
			"  /mcp reauth <name>    Reauthorize OAuth for an MCP server",
			"  /mcp unauth <name>    Remove OAuth auth from an MCP server",
			"  /mcp enable <name>    Enable an MCP server",
			"  /mcp disable <name>   Disable an MCP server",
			"  /mcp search <keyword> [--scope project|user] [--limit <1-100>]",
			"                        Search official MCP registry and deploy from picker",
			"  /mcp reload           Force reload and rediscover MCP runtime tools",
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
		const prefixMatch = text.match(/^\/mcp\s+search\b\s*(.*)$/i);
		const rest = prefixMatch?.[1]?.trim() ?? "";
		const tokens = parseCommandArgs(rest);
		if (tokens.length === 0) {
			return {
				keyword: "",
				scope: "project",
				limit: 20,
				error: "Keyword required. Usage: /mcp search <keyword> [--scope project|user] [--limit <1-100>]",
			};
		}

		const keywordParts: string[] = [];
		let scope: MCPAddScope = "project";
		let limit = 20;

		for (let i = 0; i < tokens.length; i++) {
			const token = tokens[i];
			if (token === "--scope") {
				const value = tokens[i + 1];
				if (!value || (value !== "project" && value !== "user")) {
					return { keyword: "", scope, limit, error: "Invalid --scope value. Use project or user." };
				}
				scope = value;
				i++;
				continue;
			}
			if (token === "--limit") {
				const value = tokens[i + 1];
				if (!value) {
					return { keyword: "", scope, limit, error: "Missing value for --limit." };
				}
				const parsed = Number(value);
				if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
					return { keyword: "", scope, limit, error: "Invalid --limit value. Use an integer between 1 and 100." };
				}
				limit = parsed;
				i++;
				continue;
			}
			if (token.startsWith("--")) {
				return { keyword: "", scope, limit, error: `Unknown option: ${token}` };
			}
			keywordParts.push(token);
		}

		const keyword = keywordParts.join(" ").trim();
		if (!keyword) {
			return {
				keyword: "",
				scope,
				limit,
				error: "Keyword required. Usage: /mcp search <keyword> [--scope project|user] [--limit <1-100>]",
			};
		}

		return { keyword, scope, limit };
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

		const resolvedClientId = clientId.trim() || parsedAuthUrl.searchParams.get("client_id") || undefined;

		try {
			// Create OAuth flow
			const flow = new MCPOAuthFlow(
				{
					authorizationUrl: authUrl,
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
			this.ctx.chatContainer.addChild(new Text(theme.fg("success", "✓ Authorization completed in browser."), 1, 0));
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

			// Provide helpful error messages based on failure type
			if (errorMsg.includes("timeout") || errorMsg.includes("timed out")) {
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
			oauth = await discoverOAuthEndpoints(config.url);
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
			const state = this.ctx.mcpManager.getConnectionStatus(name);
			if (state === "connected") {
				// Connection may complete after initial reload; rebind runtime MCP tools now.
				await this.ctx.session.refreshMCPTools(this.ctx.mcpManager.getTools());
			}
			if (state === "connected") {
				statusText.setText(theme.fg("success", `✓ Connected to "${name}"`));
			} else if (state === "connecting") {
				statusText.setText(theme.fg("muted", `◌ "${name}" is still connecting...`));
			} else {
				statusText.setText(
					options?.suppressDisconnectedWarning
						? theme.fg("muted", `◌ Connection check complete for "${name}"`)
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
			await this.#reloadMCP();
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

	async #pickRegistryResult(
		results: OfficialRegistrySearchResult[],
		keyword: string,
	): Promise<OfficialRegistrySearchResult | null> {
		return await this.ctx.showHookCustom<OfficialRegistrySearchResult | null>((_tui, _theme, _keys, done) => {
			const items: SelectItem[] = results.map((result, index) => {
				const transport = result.config.type ?? "stdio";
				const source = result.sourceType === "remote" ? "remote" : "package";
				return {
					value: String(index),
					label: result.name,
					description: `[${transport}/${source}] ${result.description ?? "No description"}`,
				};
			});

			const selectList = new SelectList(items, Math.min(items.length, 10), getSelectListTheme());
			selectList.onSelect = item => {
				const index = Number(item.value);
				done(results[index] ?? null);
			};
			selectList.onCancel = () => {
				done(null);
			};

			this.#showMessage(
				[
					"",
					theme.bold(`Registry results for "${keyword}"`),
					theme.fg("dim", "Use arrows to navigate, Enter to deploy, Esc to cancel."),
					"",
				].join("\n"),
			);

			return selectList;
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

	async #deployRegistryResult(result: OfficialRegistrySearchResult, scope: MCPAddScope): Promise<void> {
		const baseName = toConfigName(result.name);
		const defaultName = await this.#nextAvailableServerName(scope, baseName);
		const serverName = await this.#promptDeploymentServerName(scope, defaultName);
		if (!serverName) {
			this.ctx.showStatus("MCP deploy cancelled.");
			return;
		}

		const config = await this.#resolveRegistryConfig(result);
		if (!config) {
			this.ctx.showStatus("MCP deploy cancelled.");
			return;
		}

		try {
			await this.#deployConfig({
				serverName,
				scope,
				config,
				prepareAuth: true,
				hasManualCredentials: Boolean(config.type === "http" && config.headers?.Authorization),
			});
		} catch (authError) {
			this.ctx.showError(authError instanceof Error ? authError.message : String(authError));
			return;
		}

		if (result.warnings.length > 0) {
			const warningLines = ["", theme.fg("warning", `Post-deploy steps for "${serverName}":`), ""];
			for (const warning of result.warnings) {
				warningLines.push(`  • ${warning}`);
			}
			warningLines.push("");
			warningLines.push(
				theme.fg(
					"muted",
					`Update settings with ${theme.fg("accent", `/mcp remove ${serverName}`)} and re-add manually if needed.`,
				),
			);
			warningLines.push("");
			this.#showMessage(warningLines.join("\n"));
		}
	}

	async #deployConfig(options: {
		serverName: string;
		scope: MCPAddScope;
		config: MCPServerConfig;
		prepareAuth: boolean;
		hasManualCredentials: boolean;
	}): Promise<void> {
		let config = options.config;
		if (options.prepareAuth) {
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
				const fallbackConfig = await this.#promptBearerFallback(
					serverName,
					config,
					`OAuth flow failed: ${oauthError instanceof Error ? oauthError.message : String(oauthError)}`,
				);
				if (fallbackConfig) return fallbackConfig;
				throw oauthError;
			}
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

	async #resolveRegistryConfig(result: OfficialRegistrySearchResult): Promise<MCPServerConfig | null> {
		if (result.config.type !== "http") {
			return result.config;
		}

		if (result.requiredHeaders.length === 0) {
			return result.config;
		}

		const resolvedHeaders: Record<string, string> = {};
		for (const header of result.requiredHeaders) {
			const promptLabel = header.placeholder
				? `Value for ${header.name} (${header.placeholder})`
				: `Value for required header ${header.name}`;
			const promptDefault = header.template?.includes("{") ? "" : (header.template ?? "");
			const input = await this.ctx.showHookInput(promptLabel, promptDefault);
			if (input === undefined) return null;
			const value = input.trim();
			if (!value) {
				this.ctx.showError(`Header "${header.name}" value cannot be empty.`);
				return null;
			}
			if (header.template && header.placeholder) {
				const token = `{${header.placeholder}}`;
				resolvedHeaders[header.name] = header.template.replace(token, value);
			} else {
				resolvedHeaders[header.name] = value;
			}
		}

		return {
			...result.config,
			headers: {
				...(result.config.headers ?? {}),
				...resolvedHeaders,
			},
		};
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

	async #handleSearch(text: string): Promise<void> {
		const parsed = this.#parseSearchCommand(text);
		if (parsed.error) {
			this.ctx.showError(parsed.error);
			return;
		}

		try {
			this.#showMessage(
				["", theme.fg("muted", `Searching official MCP registry for "${parsed.keyword}"...`), ""].join("\n"),
			);
			const results = await searchOfficialRegistry(parsed.keyword, { limit: parsed.limit });
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

			if (userServers.length === 0 && projectServers.length === 0) {
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
				this.ctx.showError(`Server "${name}" not found.`);
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

			const currentAuth = (
				found.config as MCPServerConfig & { auth?: { type: "oauth" | "apikey"; credentialId?: string } }
			).auth;
			if (currentAuth?.type === "oauth") {
				await this.#removeManagedOAuthCredential(currentAuth.credentialId);
			}

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
			this.ctx.showError("Server name required. Usage: /mcp reauth <name>");
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
				oauth.clientId ?? "",
				"",
				oauth.scopes ?? "",
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
	async #reloadMCP(): Promise<void> {
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
			const errorLines = ["", theme.fg("warning", "Some servers failed to connect:"), ""];
			for (const [serverName, error] of result.errors.entries()) {
				errorLines.push(`  ${serverName}: ${error}`);
			}
			errorLines.push("");
			this.#showMessage(errorLines.join("\n"));
		}
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
