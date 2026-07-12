import type { AuthGatewayAdminClient, AuthGatewayCredentialSummary } from "@oh-my-pi/pi-ai/auth-gateway";
import type { Component, Focusable, SgrMouseEvent, TUI } from "@oh-my-pi/pi-tui";
import {
	matchesKey,
	parseSgrMouse,
	replaceTabs,
	TabBar,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@oh-my-pi/pi-tui";
import type { AuthGatewayProfileStore, ResolvedAuthGatewayConnection } from "../../../auth-gateway/profiles";
import { copyToClipboard } from "../../../utils/clipboard";
import { getTabBarTheme } from "../../shared";
import { theme } from "../../theme/theme";
import { bottomBorder, divider, row, topBorder } from "../overlay-box";
import {
	AuthGatewayAccountLoginController,
	type AuthGatewayAccountLoginPromptState,
	uploadAcquiredAuthGatewayCredential,
} from "./account-login";
import { AuthGatewayConsoleController, type AuthGatewayConsoleTab } from "./console-controller";
import {
	type AuthGatewayOneTimeTokenDialog,
	closeOneTimeTokenDialog,
	copyOneTimeTokenDialogValue,
	createOneTimeTokenDialog,
} from "./dialogs";

export interface AuthGatewayConsoleHost {
	ui: TUI;
	openInBrowser(url: string): void;
	close(): void;
}

export interface AuthGatewayConsoleOptions {
	connection: ResolvedAuthGatewayConnection;
	profileStore: AuthGatewayProfileStore;
	createClient(connection: ResolvedAuthGatewayConnection): AuthGatewayAdminClient;
	host: AuthGatewayConsoleHost;
}

type ConsoleMode = "list" | "detail";
type PromptKind =
	| "filter"
	| "audit-user-filter"
	| "usage-since"
	| "create-user"
	| "edit-user"
	| "toggle-user"
	| "delete-user"
	| "create-token"
	| "revoke-token"
	| "rotate-user"
	| "add-acl"
	| "delete-acl"
	| "bind-pool"
	| "unbind-pool"
	| "create-pool"
	| "edit-pool"
	| "delete-pool"
	| "add-pool-account"
	| "remove-pool-account"
	| "remove-account"
	| "api-key-provider"
	| "api-key-value"
	| "login-provider"
	| "switch-connection";

interface PromptState {
	kind: PromptKind;
	label: string;
	value: string;
	masked: boolean;
	error: string | null;
	provider?: string;
}

const TABS: Array<{ id: AuthGatewayConsoleTab; label: string; short: string }> = [
	{ id: "overview", label: "Overview", short: "Ovr" },
	{ id: "users", label: "Users", short: "Usr" },
	{ id: "pools", label: "Pools", short: "Pool" },
	{ id: "accounts", label: "Accounts", short: "Acct" },
	{ id: "audit", label: "Audit", short: "Aud" },
];

const FOOTER = "1-5 tabs · ↑/↓ select · / filter · r refresh · ? help · Esc close";

export class AuthGatewayConsole implements Component, Focusable {
	focused = false;
	controller: AuthGatewayConsoleController;
	readonly ready: Promise<void>;
	readonly #host: AuthGatewayConsoleHost;
	readonly #profileStore: AuthGatewayProfileStore;
	readonly #createClient: (connection: ResolvedAuthGatewayConnection) => AuthGatewayAdminClient;
	#connection: ResolvedAuthGatewayConnection;
	#client: AuthGatewayAdminClient;
	#tabBar: TabBar;
	#mode: ConsoleMode = "list";
	#prompt: PromptState | null = null;
	#help = false;
	#oneTimeDialog: AuthGatewayOneTimeTokenDialog | null = null;
	#accountLogin: AuthGatewayAccountLoginController | null = null;
	#loginGeneration = 0;
	#disposed = false;
	#tabRowStart = 0;
	#tabRowCount = 0;
	#bodyRowStart = 0;
	#useTerminalCursor = false;

	constructor(options: AuthGatewayConsoleOptions) {
		this.#host = options.host;
		this.#profileStore = options.profileStore;
		this.#createClient = options.createClient;
		this.#connection = options.connection;
		this.#client = this.#createClient(options.connection);
		this.controller = this.#createController(options.connection, this.#client);
		this.#tabBar = new TabBar("", TABS, getTabBarTheme());
		this.#tabBar.showHint = false;
		this.#tabBar.onTabChange = tab => {
			void this.#switchTab(tab.id as AuthGatewayConsoleTab);
		};
		this.ready = this.controller.start();
	}

	setUseTerminalCursor(useTerminalCursor: boolean): void {
		this.#useTerminalCursor = useTerminalCursor;
	}

	invalidate(): void {
		this.#tabBar.invalidate();
	}

	dispose(): void {
		this.#disposed = true;
		this.#loginGeneration++;
		this.#accountLogin?.abort();
		this.#accountLogin = null;
		this.controller.close();
		if (this.#oneTimeDialog) closeOneTimeTokenDialog(this.#oneTimeDialog);
		this.#oneTimeDialog = null;
		this.#clearPrompt();
	}

	render(width: number): readonly string[] {
		const height = Math.max(14, process.stdout.rows ?? 24);
		const innerWidth = Math.max(1, width - 4);
		this.#tabBar.setTabs(
			TABS.map(tab => ({ ...tab, label: width < 60 ? tab.short : tab.label })),
			this.controller.state.activeTab,
		);
		const tabLines = this.#tabBar.render(innerWidth);
		const fixedRows = 1 + tabLines.length + 1 + 1 + 1 + 1;
		const contentRows = Math.max(6, height - fixedRows);
		const bodyLines = this.#bodyLines(innerWidth, contentRows, width);
		const out: string[] = [];
		out.push(topBorder(width, "Auth Gateway Console"));
		this.#tabRowStart = out.length;
		this.#tabRowCount = tabLines.length;
		for (const line of tabLines) out.push(row(line, width));
		out.push(divider(width));
		this.#bodyRowStart = out.length;
		for (let index = 0; index < contentRows; index++) out.push(row(bodyLines[index] ?? "", width));
		out.push(divider(width));
		out.push(row(theme.fg("dim", FOOTER), width));
		out.push(bottomBorder(width));
		return out;
	}

	handleInput(data: string): void {
		const isMouseInput = data.startsWith("\x1b[<");
		if (this.#oneTimeDialog) {
			if (!isMouseInput) void this.#handleTokenDialogInput(data);
			return;
		}
		if (this.#accountLogin?.state.prompt) {
			if (!isMouseInput) this.#accountLogin.handleInput(data);
			return;
		}
		if (this.#accountLogin) {
			if (data === "\x1b" || matchesKey(data, "ctrl+c")) this.#cancelAccountLogin();
			return;
		}
		if (this.#help) {
			if (data === "\x1b" || data === "?" || matchesKey(data, "ctrl+c")) this.#help = false;
			return;
		}
		if (this.#prompt) {
			if (!isMouseInput) this.#handlePromptInput(data);
			return;
		}
		if (this.controller.state.modalOpen) {
			if (!isMouseInput && (data === "\x1b" || matchesKey(data, "ctrl+c"))) this.#host.close();
			return;
		}
		if (isMouseInput) {
			this.#handleMouse(data);
			return;
		}
		if (matchesKey(data, "ctrl+c")) {
			this.#host.close();
			return;
		}
		if (data === "\x1b") {
			if (this.#mode === "detail") {
				this.#mode = "list";
				return;
			}
			this.#host.close();
			return;
		}
		if (data >= "1" && data <= "5") {
			const tab = TABS[Number(data) - 1]?.id;
			if (tab) void this.#switchTab(tab);
			return;
		}
		if (data === "s" && this.controller.state.activeTab === "overview") {
			this.#handleAction(data);
			return;
		}
		if (this.#tabBar.handleInput(data)) return;
		if (data === "?") {
			this.#help = true;
			return;
		}
		if (data === "/") {
			this.#prompt = {
				kind: this.controller.state.activeTab === "audit" ? "filter" : "filter",
				label: "Filter: ",
				value: "",
				masked: false,
				error: null,
			};
			this.controller.setModalOpen(true);
			return;
		}
		if (data === "r") {
			void this.controller.refresh();
			return;
		}
		if (data === "\x1b[B" || data === "j") {
			this.controller.selectNext();
			return;
		}
		if (data === "\x1b[A") {
			this.controller.selectPrevious();
			return;
		}
		if (data === "k") {
			if (this.controller.state.activeTab === "accounts") this.#startApiKeyPrompt();
			else this.controller.selectPrevious();
			return;
		}
		if (data === "\n" || data === "\r") {
			if (this.#narrowDetailAvailable()) this.#mode = "detail";
			return;
		}
		this.#handleAction(data);
	}

	#handleAction(data: string): void {
		const tab = this.controller.state.activeTab;
		if (tab === "overview" && data === "s") {
			this.#prompt = {
				kind: "switch-connection",
				label: "Connection name: ",
				value: "",
				masked: false,
				error: null,
			};
			this.controller.setModalOpen(true);
			return;
		}

		if (tab === "users") {
			this.#handleUserAction(data);
			return;
		}
		if (tab === "pools") {
			this.#handlePoolAction(data);
			return;
		}
		if (tab === "accounts") {
			this.#handleAccountAction(data);
			return;
		}
		if (tab === "audit" && data === "u") {
			this.#prompt = {
				kind: "audit-user-filter",
				label: "Audit user id (blank clears): ",
				value: "",
				masked: false,
				error: null,
			};
			this.controller.setModalOpen(true);
			return;
		}
		if (tab === "audit" && data === "n") {
			void this.controller.nextAuditPage();
			return;
		}
		if (tab === "audit" && data === "p") {
			void this.controller.previousAuditPage();
		}
	}

	#handleUserAction(data: string): void {
		const selected = this.controller.selectedUser();
		if (data === "c") {
			this.#prompt = {
				kind: "create-user",
				label: "Create user name|description|owner|role: ",
				value: "",
				masked: false,
				error: null,
			};
			this.controller.setModalOpen(true);
			return;
		}
		if (!selected) return;
		if (data === "e") {
			this.#prompt = {
				kind: "edit-user",
				label: "Edit description|owner|role: ",
				value: "",
				masked: false,
				error: null,
			};
			this.controller.setModalOpen(true);
			return;
		}
		if (data === "t") {
			const warning = selected.enabled ? this.controller.currentUserDisconnectWarning() : null;
			const confirmation = warning
				? ` ${warning}. Type disconnect ${sanitizeCell(selected.name)}: `
				: "Type y to toggle: ";
			this.#prompt = {
				kind: "toggle-user",
				label: `${selected.enabled ? "Disable" : "Enable"} user.${confirmation}`,
				value: "",
				masked: false,
				error: null,
			};
			this.controller.setModalOpen(true);
			return;
		}
		if (data === "d") {
			const warning = this.controller.currentUserDisconnectWarning();
			this.#prompt = {
				kind: "delete-user",
				label: warning
					? `${warning}. Type disconnect ${sanitizeCell(selected.name)} to delete: `
					: `Type ${sanitizeCell(selected.name)} to delete: `,
				value: "",
				masked: false,
				error: null,
			};
			this.controller.setModalOpen(true);
			return;
		}
		if (data === "T") {
			this.#prompt = { kind: "create-token", label: "Token label: ", value: "", masked: false, error: null };
			this.controller.setModalOpen(true);
			return;
		}
		if (data === "v") {
			const warning = this.controller.currentTokenDisconnectWarning();
			this.#prompt = {
				kind: "revoke-token",
				label: warning
					? `${warning.message}. Current token ${warning.tokenId} requires ${sanitizeCell(warning.publicId)}. Token id|confirmation: `
					: "Token id|confirmation: ",
				value: "",
				masked: false,
				error: null,
			};
			this.controller.setModalOpen(true);
			return;
		}
		if (data === "R") {
			this.#prompt = {
				kind: "rotate-user",
				label: `Type rotate ${sanitizeCell(selected.name)}: `,
				value: "",
				masked: false,
				error: null,
			};
			this.controller.setModalOpen(true);
			return;
		}
		if (data === "U") {
			this.#prompt = {
				kind: "usage-since",
				label: "Usage since timestamp (blank for all): ",
				value: "",
				masked: false,
				error: null,
			};
			this.controller.setModalOpen(true);
			return;
		}
		if (data === "a") {
			this.#prompt = { kind: "add-acl", label: "ACL effect|kind|pattern: ", value: "", masked: false, error: null };
			this.controller.setModalOpen(true);
			return;
		}
		if (data === "x") {
			this.#prompt = { kind: "delete-acl", label: "ACL rule id|y: ", value: "", masked: false, error: null };
			this.controller.setModalOpen(true);
			return;
		}
		if (data === "b") {
			this.#prompt = { kind: "bind-pool", label: "Pool id to bind: ", value: "", masked: false, error: null };
			this.controller.setModalOpen(true);
			return;
		}
		if (data === "u") {
			this.#prompt = { kind: "unbind-pool", label: "Pool id|y to unbind: ", value: "", masked: false, error: null };
			this.controller.setModalOpen(true);
		}
	}

	#handlePoolAction(data: string): void {
		const selected = this.controller.selectedPool();
		if (data === "c") {
			this.#prompt = {
				kind: "create-pool",
				label: "Create pool name|provider|model|strategy: ",
				value: "",
				masked: false,
				error: null,
			};
			this.controller.setModalOpen(true);
			return;
		}
		if (!selected) return;
		if (data === "e") {
			this.#prompt = { kind: "edit-pool", label: "Edit name|strategy: ", value: "", masked: false, error: null };
			this.controller.setModalOpen(true);
			return;
		}
		if (data === "d") {
			this.#prompt = {
				kind: "delete-pool",
				label: `Type ${sanitizeCell(selected.name)} to delete: `,
				value: "",
				masked: false,
				error: null,
			};
			this.controller.setModalOpen(true);
			return;
		}
		if (data === "a") {
			this.#prompt = {
				kind: "add-pool-account",
				label: "Credential id to add: ",
				value: "",
				masked: false,
				error: null,
			};
			this.controller.setModalOpen(true);
			return;
		}
		if (data === "x") {
			this.#prompt = {
				kind: "remove-pool-account",
				label: "Credential id|y to remove: ",
				value: "",
				masked: false,
				error: null,
			};
			this.controller.setModalOpen(true);
			return;
		}
		if (data === "]") {
			this.controller.selectPoolMember(this.controller.state.selectedPoolMemberIndex + 1);
			return;
		}
		if (data === "[") {
			this.controller.selectPoolMember(this.controller.state.selectedPoolMemberIndex - 1);
			return;
		}
		if (data === "+") {
			void this.controller.moveSelectedPoolCredential(1);
			return;
		}
		if (data === "-") {
			void this.controller.moveSelectedPoolCredential(-1);
		}
	}

	#handleAccountAction(data: string): void {
		if (data === "d") {
			const selected = this.controller.selectedCredential();
			if (!selected) return;
			this.#prompt = {
				kind: "remove-account",
				label: `Type ${selected.id} to remove: `,
				value: "",
				masked: false,
				error: null,
			};
			this.controller.setModalOpen(true);
			return;
		}
		if (data === "c") {
			const identifiers = this.controller.copySelectedCredentialIdentifiers();
			if (!identifiers) return;
			void copyToClipboard(identifiers)
				.then(() => this.controller.setErrorBanner("Copied account identifiers"))
				.catch(error => this.controller.setErrorBanner(error instanceof Error ? error.message : String(error)));
			return;
		}
		if (data === "o") {
			void this.controller.refreshSelectedCredential();
			return;
		}
		if (data === "l") {
			this.#prompt = { kind: "login-provider", label: "Provider id: ", value: "", masked: false, error: null };
			this.controller.setModalOpen(true);
			return;
		}
		if (data === "k") this.#startApiKeyPrompt();
	}

	#startApiKeyPrompt(): void {
		this.#prompt = { kind: "api-key-provider", label: "Provider id: ", value: "", masked: false, error: null };
		this.controller.setModalOpen(true);
	}

	#cancelAccountLogin(): void {
		this.#loginGeneration++;
		this.#accountLogin?.abort();
		this.#accountLogin = null;
		this.controller.setModalOpen(false);
	}

	async #switchTab(tab: AuthGatewayConsoleTab): Promise<void> {
		this.#mode = "list";
		this.#clearPrompt();
		await this.controller.switchTab(tab);
	}

	#handlePromptInput(data: string): void {
		const prompt = this.#prompt;
		if (!prompt) return;
		if (data === "\x1b" || data === "\x03") {
			this.#clearPrompt();
			return;
		}
		if (data === "\n" || data === "\r") {
			void this.#submitPrompt(prompt);
			return;
		}
		if (data === "\x7f" || data === "\b") {
			prompt.value = prompt.value.slice(0, -1);
			return;
		}
		if (data === "\x15") {
			prompt.value = "";
			return;
		}
		const printable = printablePromptInput(data);
		if (!printable) return;
		prompt.value += printable;
	}

	async #submitPrompt(prompt: PromptState): Promise<void> {
		if (prompt.kind === "filter") {
			if (this.controller.state.activeTab === "audit") this.controller.setAuditTextFilter(prompt.value);
			else this.controller.setFilter(prompt.value);
			this.#clearPrompt();
			return;
		}
		if (prompt.kind === "audit-user-filter") {
			const value = prompt.value.trim();
			if (value === "") {
				await this.controller.setAuditUserFilter(null);
				this.#clearPrompt();
				return;
			}
			const userId = Number(value);
			if (!Number.isInteger(userId) || userId <= 0) {
				prompt.error = "Invalid user id";
				return;
			}
			await this.controller.setAuditUserFilter(userId);
			this.#clearPrompt();
			return;
		}
		if (prompt.kind === "switch-connection") {
			const name = prompt.value.trim();
			if (!name) {
				prompt.error = "Connection name required";
				return;
			}
			prompt.value = "";
			this.#prompt = null;
			await this.#switchConnection(name);
			return;
		}
		if (prompt.kind === "usage-since") {
			const value = prompt.value.trim();
			const since = value === "" ? undefined : Number(value);
			const ok = await this.controller.reloadSelectedUserUsage(since);
			if (!ok) {
				prompt.error = "Invalid usage timestamp";
				return;
			}
			this.#clearPrompt();
			return;
		}
		if (prompt.kind === "create-user") {
			const ok = await this.controller.createUserFromInput(prompt.value);
			if (!ok) {
				prompt.error = "Invalid user input";
				return;
			}
			this.#oneTimeDialog = this.controller.state.oneTimeToken
				? createOneTimeTokenDialog(this.controller.state.oneTimeToken)
				: null;
			this.#prompt = null;
			return;
		}
		if (prompt.kind === "edit-user") {
			const ok = await this.controller.updateSelectedUserFromInput(prompt.value);
			if (!ok) {
				prompt.error = "Invalid user input";
				return;
			}
			this.#clearPrompt();
			return;
		}
		if (prompt.kind === "toggle-user") {
			const selected = this.controller.selectedUser();
			const ok = selected ? await this.controller.setSelectedUserEnabled(!selected.enabled, prompt.value) : false;
			if (!ok) {
				prompt.error = "Confirmation did not match";
				return;
			}
			this.#clearPrompt();
			return;
		}
		if (prompt.kind === "delete-user") {
			const ok = await this.controller.deleteSelectedUser(prompt.value);
			if (!ok) {
				prompt.error = "Confirmation did not match";
				return;
			}
			this.#clearPrompt();
			return;
		}
		if (prompt.kind === "create-token") {
			const ok = await this.controller.createSelectedUserToken(prompt.value.trim());
			if (!ok) {
				prompt.error = "No selected user";
				return;
			}
			this.#oneTimeDialog = this.controller.state.oneTimeToken
				? createOneTimeTokenDialog(this.controller.state.oneTimeToken)
				: null;
			this.#prompt = null;
			return;
		}
		if (prompt.kind === "revoke-token") {
			const [tokenId, confirmation] = prompt.value.split("|").map(item => item.trim());
			const ok = await this.controller.revokeSelectedUserToken(Number(tokenId), confirmation ?? "");
			if (!ok) {
				prompt.error = "Confirmation did not match";
				return;
			}
			this.#clearPrompt();
			return;
		}
		if (prompt.kind === "rotate-user") {
			const ok = await this.controller.rotateSelectedUserTokens(prompt.value);
			if (!ok) {
				prompt.error = "Confirmation did not match";
				return;
			}
			this.#oneTimeDialog = this.controller.state.oneTimeToken
				? createOneTimeTokenDialog(this.controller.state.oneTimeToken)
				: null;
			this.#prompt = null;
			return;
		}
		if (prompt.kind === "add-acl") {
			const ok = await this.controller.addSelectedUserAclFromInput(prompt.value);
			if (!ok) {
				prompt.error = "Invalid ACL input";
				return;
			}
			this.#clearPrompt();
			return;
		}
		if (prompt.kind === "delete-acl") {
			const [ruleId, confirmation] = prompt.value.split("|").map(item => item.trim());
			const ok = await this.controller.deleteSelectedUserAcl(Number(ruleId), confirmation ?? "");
			if (!ok) {
				prompt.error = "Confirmation did not match";
				return;
			}
			this.#clearPrompt();
			return;
		}
		if (prompt.kind === "bind-pool") {
			const ok = await this.controller.bindSelectedUserPool(Number(prompt.value.trim()));
			if (!ok) {
				prompt.error = "Invalid pool id";
				return;
			}
			this.#clearPrompt();
			return;
		}
		if (prompt.kind === "unbind-pool") {
			const [poolId, confirmation] = prompt.value.split("|").map(item => item.trim());
			const ok = await this.controller.unbindSelectedUserPool(Number(poolId), confirmation ?? "");
			if (!ok) {
				prompt.error = "Confirmation did not match";
				return;
			}
			this.#clearPrompt();
			return;
		}
		if (prompt.kind === "create-pool") {
			const ok = await this.controller.createPoolFromInput(prompt.value);
			if (!ok) {
				prompt.error = "Invalid pool input";
				return;
			}
			this.#clearPrompt();
			return;
		}
		if (prompt.kind === "edit-pool") {
			const ok = await this.controller.updateSelectedPoolFromInput(prompt.value);
			if (!ok) {
				prompt.error = "Invalid pool input";
				return;
			}
			this.#clearPrompt();
			return;
		}
		if (prompt.kind === "delete-pool") {
			const ok = await this.controller.deleteSelectedPool(prompt.value);
			if (!ok) {
				prompt.error = "Confirmation did not match";
				return;
			}
			this.#clearPrompt();
			return;
		}
		if (prompt.kind === "add-pool-account") {
			const ok = await this.controller.addSelectedPoolCredential(Number(prompt.value.trim()));
			if (!ok) {
				prompt.error = "Invalid credential id";
				return;
			}
			this.#clearPrompt();
			return;
		}
		if (prompt.kind === "remove-pool-account") {
			const [credentialId, confirmation] = prompt.value.split("|").map(item => item.trim());
			const ok = await this.controller.removeSelectedPoolCredential(Number(credentialId), confirmation ?? "");
			if (!ok) {
				prompt.error = "Confirmation did not match";
				return;
			}
			this.#clearPrompt();
			return;
		}
		if (prompt.kind === "remove-account") {
			const ok = await this.controller.removeSelectedCredential(prompt.value);
			if (!ok) prompt.error = this.controller.state.errorBanner ?? "Confirmation did not match";
			else this.#clearPrompt();
			return;
		}
		if (prompt.kind === "api-key-provider") {
			this.#prompt = {
				kind: "api-key-value",
				label: "API key: ",
				value: "",
				masked: true,
				error: null,
				provider: prompt.value.trim(),
			};
			return;
		}
		if (prompt.kind === "api-key-value") {
			const provider = prompt.provider ?? "";
			const key = prompt.value;
			prompt.value = "";
			await this.controller.uploadApiKey(provider, key);
			this.#clearPrompt();
			return;
		}
		if (prompt.kind === "login-provider") {
			const provider = prompt.value.trim();
			this.#prompt = null;
			await this.#runAccountLogin(provider);
		}
	}

	#clearPrompt(): void {
		if (this.#prompt) this.#prompt.value = "";
		this.#prompt = null;
		this.controller.setModalOpen(false);
	}

	async #runAccountLogin(provider: string): Promise<void> {
		const generation = ++this.#loginGeneration;
		const login = new AuthGatewayAccountLoginController({
			openInBrowser: url => {
				if (!this.#disposed && generation === this.#loginGeneration) this.#host.openInBrowser(url);
			},
			requestRender: () => {
				if (!this.#disposed && generation === this.#loginGeneration) this.#host.ui.requestRender();
			},
		});
		this.#accountLogin = login;
		this.controller.setModalOpen(true);
		const result = await uploadAcquiredAuthGatewayCredential({
			provider,
			client: this.#client,
			controller: login.oauthController,
		});
		if (this.#disposed || generation !== this.#loginGeneration || this.#accountLogin !== login) return;
		this.#accountLogin = null;
		if (result.ok) await this.controller.refresh();
		else this.controller.setErrorBanner(result.message);
		this.controller.setModalOpen(false);
	}

	#createController(
		connection: ResolvedAuthGatewayConnection,
		client: AuthGatewayAdminClient,
	): AuthGatewayConsoleController {
		return new AuthGatewayConsoleController({
			connection,
			client,
			requestRender: () => {
				if (!this.#disposed) this.#host.ui.requestRender();
			},
			onDisconnect: () => this.#host.close(),
		});
	}

	async #switchConnection(name: string): Promise<void> {
		let nextConnection: ResolvedAuthGatewayConnection | null = null;
		try {
			nextConnection = await this.#profileStore.resolve(name);
			if (this.#disposed) return;
			const nextClient = this.#createClient(nextConnection);
			await nextClient.status(new AbortController().signal);
			if (this.#disposed) return;
			this.#loginGeneration++;
			this.#accountLogin?.abort();
			this.#accountLogin = null;
			this.controller.close();
			this.#connection = nextConnection;
			this.#client = nextClient;
			this.controller = this.#createController(nextConnection, nextClient);
			this.#mode = "list";
			this.#help = false;
			await this.controller.start();
		} catch (error) {
			if (!this.#disposed) {
				this.controller.setErrorBanner(this.#switchConnectionError(error, nextConnection), {
					preserveHealth: true,
				});
				this.controller.setModalOpen(false);
			}
		}
	}

	#switchConnectionError(error: unknown, nextConnection: ResolvedAuthGatewayConnection | null): string {
		const secrets = [this.#connection.token, nextConnection?.token ?? ""];
		let message = error instanceof Error ? error.message : String(error);
		for (const secret of secrets) {
			if (secret) message = message.split(secret).join("[redacted]");
		}
		return `Switch connection failed: ${sanitizeCell(message)}`;
	}

	async #handleTokenDialogInput(data: string): Promise<void> {
		const dialog = this.#oneTimeDialog;
		if (!dialog) return;
		if (data === "y") await copyOneTimeTokenDialogValue(dialog);
		if (data === "\n" || data === "\r" || data === "\x1b") {
			closeOneTimeTokenDialog(dialog);
			this.#oneTimeDialog = null;
			this.controller.closeOneTimeToken();
		}
	}

	#handleMouse(data: string): void {
		const event = parseSgrMouse(data);
		if (!event) return;
		const innerCol = event.col - 2;
		const tabLine = event.row - this.#tabRowStart;
		if (tabLine >= 0 && tabLine < this.#tabRowCount && event.leftClick) {
			const tab = this.#tabBar.tabAt(tabLine, innerCol);
			if (tab) void this.#switchTab(tab.id as AuthGatewayConsoleTab);
			return;
		}
		this.#handleBodyMouse(event);
	}

	#handleBodyMouse(event: SgrMouseEvent): void {
		const line = event.row - this.#bodyRowStart;
		if (line < 0 || !event.leftClick) return;
		if (line >= 0) {
			if (this.controller.state.activeTab === "pools" && this.#mode === "detail") {
				const memberIndex = line - 9;
				if (memberIndex >= 0) {
					this.controller.selectPoolMember(memberIndex);
					return;
				}
			}
			if (this.controller.state.activeTab === "overview") return;
			const index = Math.max(0, line - 3);
			while (this.controller.state.selected[this.controller.state.activeTab] < index) this.controller.selectNext();
			while (this.controller.state.selected[this.controller.state.activeTab] > index)
				this.controller.selectPrevious();
		}
	}

	#bodyLines(width: number, rows: number, outerWidth: number): string[] {
		const lines: string[] = [];
		const state = this.controller.state;
		lines.push(this.#statusLine(width));
		if (state.errorBanner) lines.push(...wrapFreeform(state.errorBanner, width, "error"));
		if (this.#help) return fitRows([...lines, ...this.#helpLines(width)], rows, width);
		if (this.#oneTimeDialog) return fitRows([...lines, ...this.#tokenDialogLines(width)], rows, width);
		if (this.#prompt) return fitRows([...lines, ...this.#promptLines(width)], rows, width);
		if (this.#accountLogin) return fitRows([...lines, ...this.#accountLoginLines(width)], rows, width);
		const content = this.#contentLines(width, outerWidth);
		return fitRows([...lines, ...content], rows, width);
	}

	#statusLine(width: number): string {
		const state = this.controller.state;
		const status =
			state.health === "Connected"
				? theme.fg("success", `${theme.status.success} Connected`)
				: state.health === "Stale"
					? theme.fg("warning", `${theme.status.warning} Stale`)
					: theme.fg("error", `${theme.status.error} Error`);
		const detail = ` ${sanitizeCell(state.connectionName)} · ${state.activeTab} · ${status}`;
		return truncateToWidth(detail, width);
	}

	#contentLines(width: number, outerWidth: number): string[] {
		if (this.controller.state.activeTab === "overview") return this.#overviewLines(width);
		const list = this.#listLines(Math.max(24, Math.floor(width * 0.45)));
		const detail = this.#detailLines(Math.max(20, width - Math.floor(width * 0.45) - 3));
		if (outerWidth >= 100) return twoColumns(list, detail, width);
		if (outerWidth >= 60) {
			if (this.#mode === "detail")
				return [theme.bold("Detail view"), ...detail, theme.fg("dim", "Esc back to list")];
			return [...list, theme.fg("dim", "Press Enter for details")];
		}
		return list.map(line => truncateToWidth(line, width));
	}

	#overviewLines(width: number): string[] {
		const status = this.controller.state.overview.data;
		if (this.controller.state.overview.status === "loading" && !status) return ["Loading overview..."];
		if (!status) return ["No overview loaded."];
		return [
			theme.bold("Overview"),
			`Version: ${sanitizeCell(status.version)}`,
			`Server time: ${new Date(status.serverTime).toISOString()}`,
			`Principal: ${sanitizeCell(status.principal.name)} (${status.principal.role})`,
			`Counts: users ${status.counts.users} · tokens ${status.counts.activeTokens} · pools ${status.counts.pools} · accounts ${status.counts.credentials}`,
			`Active connection: ${sanitizeCell(this.controller.state.connectionName)}`,
			`Last refresh: ${formatTime(this.controller.state.overview.lastUpdatedAt)}`,
			theme.fg("dim", "r refresh · s switch connection"),
		].map(line => truncateToWidth(line, width));
	}

	#listLines(width: number): string[] {
		const tab = this.controller.state.activeTab;
		if (tab === "users") return this.#usersList(width);
		if (tab === "pools") return this.#poolsList(width);
		if (tab === "accounts") return this.#accountsList(width);
		return this.#auditList(width);
	}

	#usersList(width: number): string[] {
		const users = this.controller.filteredUsers();
		if (this.controller.state.users.status === "loading" && users.length === 0) return ["Loading users..."];
		if (users.length === 0) return ["No users found"];
		return [
			theme.bold("Users"),
			...users.map((item, index) =>
				selectedLine(
					index === this.controller.state.selected.users,
					`${item.name} · ${item.role} · ${item.enabled ? "enabled" : "disabled"}`,
					width,
				),
			),
			theme.fg(
				"dim",
				"c create · e edit · t enable/disable · T token · v revoke · a/x ACL · b/u pool · d delete · R rotate",
			),
		];
	}

	#poolsList(width: number): string[] {
		const pools = this.controller.filteredPools();
		if (this.controller.state.pools.status === "loading" && pools.length === 0) return ["Loading pools..."];
		if (pools.length === 0) return ["No pools found"];
		return [
			theme.bold("Pools"),
			...pools.map((item, index) =>
				selectedLine(
					index === this.controller.state.selected.pools,
					`${item.name} · ${item.provider}/${item.model ?? "all"} · ${item.strategy}`,
					width,
				),
			),
			theme.fg("dim", "c create · e edit · d delete · a/x account · [/]/+/- selected account"),
		];
	}

	#accountsList(width: number): string[] {
		const accounts = this.controller.filteredCredentials();
		if (this.controller.state.accounts.status === "loading" && accounts.length === 0) return ["Loading accounts..."];
		if (accounts.length === 0) return ["No accounts found"];
		return [
			theme.bold("Accounts"),
			...accounts.map((item, index) =>
				selectedLine(index === this.controller.state.selected.accounts, accountSummary(item), width),
			),
			theme.fg("dim", "l local login · k add API key · c copy identifiers · o refresh OAuth · d remove"),
		];
	}

	#auditList(width: number): string[] {
		const events = this.controller.filteredAuditEvents();
		if (this.controller.state.audit.status === "loading" && events.length === 0) return ["Loading audit..."];
		if (events.length === 0) return ["No audit events found"];
		return [
			theme.bold("Audit"),
			...events.map((item, index) =>
				selectedLine(
					index === this.controller.state.selected.audit,
					`${item.requestId} · ${item.method} ${item.path} · ${item.outcome}`,
					width,
				),
			),
			theme.fg("dim", "u user filter · n next page · p previous page · / local text filter · no delete/export"),
		];
	}

	#detailLines(width: number): string[] {
		const tab = this.controller.state.activeTab;
		if (tab === "users") return this.#userDetail(width);
		if (tab === "pools") return this.#poolDetail(width);
		if (tab === "accounts") return this.#accountDetail(width);
		return this.#auditDetail(width);
	}

	#userDetail(width: number): string[] {
		const selected = this.controller.selectedUser();
		if (!selected) return ["No user selected"];
		const details = this.controller.state.userDetails[selected.id];
		const usage = this.controller.state.userUsage[selected.id];
		const lines = [
			theme.bold("Details"),
			`Name: ${sanitizeCell(selected.name)}`,
			`Role: ${selected.role}`,
			`Owner: ${sanitizeCell(selected.owner ?? "-")}`,
			`Description: ${sanitizeCell(selected.description ?? "-")}`,
			`Tokens: ${details?.tokens.length ?? 0}`,
			...(details?.tokens.map(item => `  token ${item.id} · ${sanitizeCell(item.publicId)}`) ?? []),
			`ACL rules: ${details?.acl.length ?? 0}`,
			...(details?.acl.map(item => `  acl ${item.id} · ${item.effect} ${item.kind} ${sanitizeCell(item.pattern)}`) ??
				[]),
			`Pools: ${details?.pools.length ?? 0}`,
			...(details?.pools.map(item => `  pool ${item.id} · ${sanitizeCell(item.name)}`) ?? []),
			`Usage requests: ${usage?.totals.requests ?? 0}`,
		];
		return lines.map(line => truncateToWidth(line, width));
	}

	#poolDetail(width: number): string[] {
		const selected = this.controller.selectedPool();
		if (!selected) return ["No pool selected"];
		const users = this.controller.state.poolUsers[selected.id] ?? [];
		const members = [...selected.members].sort((left, right) => left.position - right.position);
		const lines = [
			theme.bold("Details"),
			`Name: ${sanitizeCell(selected.name)}`,
			`Provider: ${sanitizeCell(selected.provider)}`,
			`Model: ${sanitizeCell(selected.model ?? "all")}`,
			`Strategy: ${selected.strategy}`,
			"Create a replacement pool to change provider or model",
			"Accounts:",
			...(members.length === 0
				? ["  none"]
				: members.map((member, index) =>
						selectedLine(
							index === this.controller.state.selectedPoolMemberIndex,
							`${member.credentialId} · position ${member.position}`,
							width,
						),
					)),
			`Bound users: ${users.map(item => sanitizeCell(item.name)).join(", ") || "none"}`,
			theme.fg("dim", "[/] select account · +/- move selected account"),
		];
		return lines.map(line => truncateToWidth(line, width));
	}

	#accountDetail(width: number): string[] {
		const selected = this.controller.selectedCredential();
		if (!selected) return ["No account selected"];
		const lines = [
			theme.bold("Details"),
			`ID: ${selected.id}`,
			`Provider: ${sanitizeCell(selected.provider)}`,
			`Type: ${selected.type}`,
			`Identity: ${sanitizeCell(selected.identityKey ?? selected.email ?? selected.accountId ?? "-")}`,
			selected.type === "api_key" ? "Remove and add a new key to rotate" : "OAuth credentials can be refreshed",
			"Copyable: account id, email, project id, API endpoint",
		];
		return lines.map(line => truncateToWidth(line, width));
	}

	#auditDetail(width: number): string[] {
		const selected = this.controller.selectedAuditEvent();
		if (!selected) return ["No audit event selected"];
		const lines = [
			theme.bold("Details"),
			`Request: ${sanitizeCell(selected.requestId)}`,
			`User: ${sanitizeCell(selected.userName ?? "-")}`,
			`Path: ${sanitizeCell(selected.path)}`,
			`Outcome: ${selected.outcome}`,
			`Status: ${selected.statusCode}`,
			`Tokens: ${selected.totalTokens}`,
			`Cost: ${selected.costUsd}`,
		];
		return lines.map(line => truncateToWidth(line, width));
	}

	#helpLines(width: number): string[] {
		return [
			theme.bold("Help"),
			"Overview: status, principal, counts, switch connection, refresh",
			"Users: c create, e edit, t enable/disable, U usage since, T token, v revoke token, a/x ACL, b/u pools, d delete, R rotate",
			"Pools: c create, e edit, d delete, a add account, x remove account, [/] select account, +/- reorder",
			"Accounts: redacted list, c copy identifiers, local login, masked API-key add, OAuth refresh, remove",
			"Audit: newest-first pages, user filter, text filter, detail inspector",
			"Destructive actions require typed confirmation or y/N; self-disconnect uses disconnect <name>.",
		].map(line => truncateToWidth(line, width));
	}

	#promptLines(width: number): string[] {
		const prompt = this.#prompt;
		if (!prompt) return [];
		const value = prompt.masked ? "•".repeat([...prompt.value].length) : sanitizeCell(prompt.value);
		const cursor = this.focused && this.#useTerminalCursor ? "\x1b_pi:c\x07" : "";
		const lines = [
			prompt.error ? theme.fg("error", prompt.error) : "",
			`${prompt.label}${value}${cursor}`,
			theme.fg("dim", "Enter submit · Esc cancel"),
		].filter(line => line.length > 0);
		return lines.map(line => truncateToWidth(line, width));
	}

	#accountLoginLines(width: number): string[] {
		const login = this.#accountLogin;
		if (!login) return [];
		const state = login.state;
		const promptLines = state.prompt ? this.#oauthPromptLines(state.prompt, width) : [];
		return [
			theme.bold("Account login"),
			state.authUrl ? `Open: ${sanitizeCell(state.authUrl)}` : "Starting provider login...",
			state.instructions ? sanitizeCell(state.instructions) : "",
			...state.progress.map(line => sanitizeCell(line)),
			...promptLines,
		]
			.filter(line => line.length > 0)
			.map(line => truncateToWidth(line, width));
	}

	#oauthPromptLines(prompt: AuthGatewayAccountLoginPromptState, width: number): string[] {
		const value = prompt.masked ? "•".repeat([...prompt.value].length) : sanitizeCell(prompt.value);
		const placeholder = prompt.placeholder ? ` (${sanitizeCell(prompt.placeholder)})` : "";
		const cursor = this.focused && this.#useTerminalCursor ? "\x1b_pi:c\x07" : "";
		return [
			`${sanitizeCell(prompt.message)}${placeholder}`,
			`${value}${cursor}`,
			theme.fg("dim", "Enter submit · Esc cancel"),
		].map(line => truncateToWidth(line, width));
	}

	#tokenDialogLines(width: number): string[] {
		const dialog = this.#oneTimeDialog;
		if (!dialog) return [];
		return [
			theme.bold("One-time token"),
			"Copy or save this token now. It cannot be reopened.",
			dialog.value,
			dialog.copied ? "Copied" : "y copy · Enter/Esc close",
		].map(line => truncateToWidth(line, width));
	}

	#narrowDetailAvailable(): boolean {
		return this.controller.state.activeTab !== "overview";
	}
}

function sanitizeCell(value: string): string {
	return replaceTabs(value).replace(/[\r\n]/g, " ");
}

function printablePromptInput(data: string): string {
	const withoutPasteEnvelope = data.replaceAll("\x1b[200~", "").replaceAll("\x1b[201~", "");
	if (withoutPasteEnvelope.includes("\x1b")) return "";
	return Array.from(withoutPasteEnvelope)
		.filter(ch => {
			const code = ch.codePointAt(0);
			return code !== undefined && code >= 32 && code !== 0x7f;
		})
		.join("");
}

function accountSummary(account: AuthGatewayCredentialSummary): string {
	const identity = account.email ?? account.accountId ?? account.identityKey ?? `#${account.id}`;
	return `${account.id} · ${account.provider} · ${account.type} · ${identity}`;
}

function selectedLine(selected: boolean, text: string, width: number): string {
	const prefix = selected ? "> " : "  ";
	const line = truncateToWidth(`${prefix}${sanitizeCell(text)}`, width);
	return selected ? theme.bg("selectedBg", line) : line;
}

function twoColumns(left: string[], right: string[], width: number): string[] {
	const leftWidth = Math.floor(width * 0.45);
	const rightWidth = Math.max(1, width - leftWidth - 3);
	const count = Math.max(left.length, right.length);
	const separator = theme.fg("dim", ` ${theme.boxRound.vertical} `);
	const lines: string[] = [];
	for (let index = 0; index < count; index++) {
		const leftLine = truncateToWidth(left[index] ?? "", leftWidth);
		const padding = " ".repeat(Math.max(0, leftWidth - visibleWidth(leftLine)));
		lines.push(`${leftLine}${padding}${separator}${truncateToWidth(right[index] ?? "", rightWidth)}`);
	}
	return lines;
}

function wrapFreeform(text: string, width: number, color: "error" | "warning" | "success"): string[] {
	return wrapTextWithAnsi(sanitizeCell(text), Math.max(1, width)).map(line => theme.fg(color, line));
}

function fitRows(lines: string[], rows: number, width: number): string[] {
	const fitted = lines.slice(0, rows).map(line => truncateToWidth(line, width));
	while (fitted.length < rows) fitted.push("");
	return fitted;
}

function formatTime(value: number | null): string {
	if (value === null) return "never";
	return new Date(value).toISOString();
}
