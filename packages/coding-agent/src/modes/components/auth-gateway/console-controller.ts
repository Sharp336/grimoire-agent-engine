import type {
	AuthGatewayAclEffect,
	AuthGatewayAclKind,
	AuthGatewayAdminClient,
	AuthGatewayAdminStatus,
	AuthGatewayAuditEvent,
	AuthGatewayCredentialSummary,
	AuthGatewayIssuedTokenValue,
	AuthGatewayPool,
	AuthGatewayUsageSummary,
	AuthGatewayUser,
	AuthGatewayUserDetails,
} from "@oh-my-pi/pi-ai/auth-gateway";
import type { ResolvedAuthGatewayConnection } from "../../../auth-gateway/profiles";

export const ACTIVE_POLL_MS = 3_000;
export const POLL_ERROR_BACKOFF_MS = [3_000, 6_000, 12_000, 30_000] as const;
export type AuthGatewayConsoleTab = "overview" | "users" | "pools" | "accounts" | "audit";

type ResourceStatus = "idle" | "loading" | "ready" | "error";

interface ResourceState<T> {
	data: T;
	status: ResourceStatus;
	error: string | null;
	stale: boolean;
	lastUpdatedAt: number | null;
}

export interface AuthGatewayConsoleState {
	activeTab: AuthGatewayConsoleTab;
	connectionName: string;
	health: "Connected" | "Stale" | "Error";
	errorBanner: string | null;
	busyAction: string | null;
	modalOpen: boolean;
	selected: Record<AuthGatewayConsoleTab, number>;
	selectedPoolMemberIndex: number;
	filter: string;
	overview: ResourceState<AuthGatewayAdminStatus | null>;
	users: ResourceState<AuthGatewayUser[]>;
	userDetails: Record<number, AuthGatewayUserDetails>;
	userUsage: Record<number, AuthGatewayUsageSummary>;
	pools: ResourceState<AuthGatewayPool[]>;
	poolUsers: Record<number, AuthGatewayUser[]>;
	accounts: ResourceState<AuthGatewayCredentialSummary[]>;
	audit: ResourceState<AuthGatewayAuditEvent[]> & {
		nextBefore: number | null;
		pages: Array<{ before: number | undefined; events: AuthGatewayAuditEvent[]; nextBefore: number | null }>;
		pageIndex: number;
		userFilter: number | null;
		textFilter: string;
	};
	oneTimeToken: AuthGatewayIssuedTokenValue | null;
}

export interface AuthGatewayConsoleControllerOptions {
	connection: ResolvedAuthGatewayConnection;
	client: AuthGatewayAdminClient;
	requestRender(): void;
	onDisconnect?(): void;
}

type LoadReason = "manual" | "poll" | "mutation" | "switch";

const POOL_STRATEGIES: Record<AuthGatewayPool["strategy"], true> = {
	"sticky-session": true,
	"least-used": true,
	"round-robin": true,
	failover: true,
};

function parsePoolStrategy(value: string): AuthGatewayPool["strategy"] | null | undefined {
	if (!value) return undefined;
	if (Object.hasOwn(POOL_STRATEGIES, value)) return value as AuthGatewayPool["strategy"];
	return null;
}

function emptyResource<T>(data: T): ResourceState<T> {
	return { data, status: "idle", error: null, stale: false, lastUpdatedAt: null };
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function nowMs(): number {
	return Date.now();
}

export class AuthGatewayConsoleController {
	readonly #connection: ResolvedAuthGatewayConnection;
	readonly #client: AuthGatewayAdminClient;
	readonly #requestRender: () => void;
	readonly #onDisconnect: (() => void) | undefined;
	#state: AuthGatewayConsoleState;
	#generation = 0;
	#activeAbort: AbortController | null = null;
	#detailAbort: AbortController | null = null;
	#mutationAbort: AbortController | null = null;
	#auditPageAbort: AbortController | null = null;
	#pollTimer: Timer | null = null;
	#inFlight = false;
	#closed = false;
	#errorBackoffIndex = 0;

	constructor(options: AuthGatewayConsoleControllerOptions) {
		this.#connection = options.connection;
		this.#client = options.client;
		this.#onDisconnect = options.onDisconnect;
		this.#requestRender = options.requestRender;
		this.#state = {
			activeTab: "overview",
			connectionName: options.connection.profile.name,
			health: "Connected",
			errorBanner: null,
			busyAction: null,
			modalOpen: false,
			selected: { overview: 0, users: 0, pools: 0, accounts: 0, audit: 0 },
			selectedPoolMemberIndex: 0,
			filter: "",
			overview: emptyResource<AuthGatewayAdminStatus | null>(null),
			users: emptyResource<AuthGatewayUser[]>([]),
			userDetails: {},
			userUsage: {},
			pools: emptyResource<AuthGatewayPool[]>([]),
			poolUsers: {},
			accounts: emptyResource<AuthGatewayCredentialSummary[]>([]),
			audit: {
				...emptyResource<AuthGatewayAuditEvent[]>([]),
				nextBefore: null,
				pages: [],
				pageIndex: 0,
				userFilter: null,
				textFilter: "",
			},
			oneTimeToken: null,
		};
	}

	get state(): AuthGatewayConsoleState {
		return this.#state;
	}

	async start(): Promise<void> {
		await this.refresh("switch");
	}

	close(): void {
		this.#closed = true;
		this.#generation++;
		this.#clearPollTimer();
		this.#activeAbort?.abort();
		this.#activeAbort = null;
		this.#detailAbort?.abort();
		this.#detailAbort = null;
		this.#mutationAbort?.abort();
		this.#auditPageAbort?.abort();
		this.#auditPageAbort = null;
		this.#mutationAbort = null;
		this.#inFlight = false;
		this.#state = {
			...this.#state,
			health: "Connected",
			errorBanner: null,
			busyAction: null,
			modalOpen: false,
			oneTimeToken: null,
			selectedPoolMemberIndex: 0,
			overview: emptyResource<AuthGatewayAdminStatus | null>(null),
			users: emptyResource<AuthGatewayUser[]>([]),
			userDetails: {},
			userUsage: {},
			pools: emptyResource<AuthGatewayPool[]>([]),
			poolUsers: {},
			accounts: emptyResource<AuthGatewayCredentialSummary[]>([]),
			audit: {
				...emptyResource<AuthGatewayAuditEvent[]>([]),
				nextBefore: null,
				pages: [],
				pageIndex: 0,
				userFilter: null,
				textFilter: "",
			},
		};
		this.#requestRender();
	}

	setModalOpen(open: boolean): void {
		if (this.#closed) return;
		this.#state.modalOpen = open;
		if (open) this.#clearPollTimer();
		else this.#schedulePoll(ACTIVE_POLL_MS);
		this.#requestRender();
	}

	async switchTab(tab: AuthGatewayConsoleTab): Promise<void> {
		if (this.#state.activeTab === tab) return;
		this.#generation++;
		this.#activeAbort?.abort();
		this.#activeAbort = null;
		this.#detailAbort?.abort();
		this.#detailAbort = null;
		this.#auditPageAbort?.abort();
		this.#auditPageAbort = null;
		this.#inFlight = false;
		this.#state.activeTab = tab;
		this.#state.filter = "";
		this.#state.errorBanner = null;
		await this.refresh("switch");
	}

	async refresh(reason: LoadReason = "manual"): Promise<void> {
		if (this.#closed) return;
		if (reason === "manual") this.#errorBackoffIndex = 0;
		await this.#loadVisible(reason);
	}

	selectNext(): void {
		const items = this.#visibleItemsLength();
		const tab = this.#state.activeTab;
		this.#state.selected[tab] = Math.min(Math.max(0, items - 1), this.#state.selected[tab] + 1);
		void this.#loadSelectedDetail(tab);
		this.#requestRender();
	}

	selectPrevious(): void {
		const tab = this.#state.activeTab;
		this.#state.selected[tab] = Math.max(0, this.#state.selected[tab] - 1);
		void this.#loadSelectedDetail(tab);
		this.#requestRender();
	}

	setFilter(value: string): void {
		this.#state.filter = value;
		this.#state.selected[this.#state.activeTab] = 0;
		this.#requestRender();
	}

	setAuditTextFilter(value: string): void {
		this.#state.audit.textFilter = value;
		this.#state.selected.audit = 0;
		this.#requestRender();
	}

	async setAuditUserFilter(userId: number | null): Promise<void> {
		this.#state.audit.userFilter = userId;
		this.#state.audit.pages = [];
		this.#state.audit.pageIndex = 0;
		this.#state.audit.nextBefore = null;
		this.#state.selected.audit = 0;
		await this.refresh("manual");
	}

	hasActiveFilters(): boolean {
		const tab = this.#state.activeTab;
		if (tab === "audit") {
			return this.#state.audit.textFilter.length > 0 || this.#state.audit.userFilter !== null;
		}
		return (tab === "users" || tab === "pools" || tab === "accounts") && this.#state.filter.length > 0;
	}

	clearActiveFilters(): boolean {
		const tab = this.#state.activeTab;
		if (tab === "audit") {
			const hadUserFilter = this.#state.audit.userFilter !== null;
			if (this.#state.audit.textFilter.length === 0 && !hadUserFilter) return false;
			this.#state.audit.textFilter = "";
			this.#state.audit.userFilter = null;
			this.#state.audit.pages = [];
			this.#state.audit.pageIndex = 0;
			this.#state.audit.nextBefore = null;
			this.#state.selected.audit = 0;
			if (hadUserFilter) void this.refresh("manual");
			else this.#requestRender();
			return true;
		}
		if (tab !== "users" && tab !== "pools" && tab !== "accounts") return false;
		if (this.#state.filter.length === 0) return false;
		this.#state.filter = "";
		this.#state.selected[tab] = 0;
		void this.#loadSelectedDetail(tab);
		this.#requestRender();
		return true;
	}

	async reloadSelectedUserUsage(since: number | undefined): Promise<boolean> {
		const selected = this.selectedUser();
		if (!selected || (since !== undefined && !Number.isFinite(since))) return false;
		this.#detailAbort?.abort();
		const abort = new AbortController();
		this.#detailAbort = abort;
		const generation = this.#generation;
		try {
			const usage = await this.#client.getUserUsage(selected.id, since, abort.signal);
			if (!this.#isCurrent(generation, abort.signal)) return false;
			this.#state.userUsage[selected.id] = usage;
			this.#requestRender();
			return true;
		} finally {
			if (this.#detailAbort === abort) this.#detailAbort = null;
		}
	}

	setErrorBanner(message: string, options?: { preserveHealth?: boolean }): void {
		if (this.#closed) return;
		this.#state.errorBanner = message;
		if (!options?.preserveHealth) this.#state.health = "Error";
		this.#requestRender();
	}

	async nextAuditPage(): Promise<void> {
		const nextBefore = this.#state.audit.nextBefore;
		if (nextBefore === null) return;
		this.#auditPageAbort?.abort();
		const abort = new AbortController();
		this.#auditPageAbort = abort;
		const generation = this.#generation;
		try {
			await this.#loadAuditPage(nextBefore, "manual", abort.signal, generation);
		} finally {
			if (this.#auditPageAbort === abort) this.#auditPageAbort = null;
			if (this.#isCurrent(generation, abort.signal)) this.#requestRender();
		}
	}

	async previousAuditPage(): Promise<void> {
		if (this.#state.audit.pageIndex <= 0) return;
		const nextIndex = this.#state.audit.pageIndex - 1;
		const page = this.#state.audit.pages[nextIndex];
		if (!page) return;
		this.#state.audit.pageIndex = nextIndex;
		this.#state.audit.data = page.events;
		this.#state.audit.nextBefore = page.nextBefore;
		this.#state.audit.status = "ready";
		this.#state.audit.error = null;
		this.#state.audit.stale = false;
		this.#state.audit.lastUpdatedAt = nowMs();
		this.#schedulePoll(ACTIVE_POLL_MS);
		this.#requestRender();
	}

	async deleteSelectedUser(confirmation: string): Promise<boolean> {
		const selected = this.selectedUser();
		if (!selected || confirmation !== this.#deleteUserConfirmation(selected)) return false;
		return await this.#mutate(
			"delete-user",
			async signal => {
				await this.#client.deleteUser(selected.id, signal);
			},
			"users",
			{ disconnectOnSuccess: this.#isCurrentUser(selected) },
		);
	}

	async createUserFromInput(value: string): Promise<boolean> {
		const [name, description, owner, role] = splitFields(value);
		if (!name) return false;
		return await this.#mutateIssuedToken(
			"create-user",
			async signal => {
				const result = await this.#client.createUser(
					{
						name,
						...(description ? { description } : {}),
						...(owner ? { owner } : {}),
						...(role === "admin" || role === "user" ? { role } : {}),
					},
					signal,
				);
				return result.token;
			},
			"users",
		);
	}

	async updateSelectedUserFromInput(value: string): Promise<boolean> {
		const selected = this.selectedUser();
		const [description, owner, role] = splitFields(value);
		if (!selected) return false;
		return await this.#mutate(
			"edit-user",
			async signal => {
				await this.#client.updateUser(
					selected.id,
					{
						description: description || null,
						owner: owner || null,
						...(role === "admin" || role === "user" ? { role } : {}),
					},
					signal,
				);
			},
			"users",
		);
	}

	async setSelectedUserEnabled(enabled: boolean, confirmation: string): Promise<boolean> {
		const selected = this.selectedUser();
		if (!selected) return false;
		const disconnects = !enabled && this.#isCurrentUser(selected);
		if (disconnects && confirmation !== `disconnect ${selected.name}`) return false;
		if (!disconnects && confirmation.toLowerCase() !== "y") return false;
		return await this.#mutate(
			enabled ? "enable-user" : "disable-user",
			async signal => {
				await this.#client.updateUser(selected.id, { enabled }, signal);
			},
			"users",
			{ disconnectOnSuccess: disconnects },
		);
	}

	async createSelectedUserToken(label: string): Promise<boolean> {
		const selected = this.selectedUser();
		if (!selected) return false;
		return await this.#mutateIssuedToken(
			"create-token",
			signal => this.#client.addUserToken(selected.id, label || undefined, signal),
			"users",
		);
	}

	async revokeSelectedUserToken(tokenId: number, confirmation: string): Promise<boolean> {
		const selected = this.selectedUser();
		if (!selected || !Number.isInteger(tokenId)) return false;
		const details = this.#state.userDetails[selected.id];
		const revoked = details?.tokens.find(item => item.id === tokenId);
		const disconnects = tokenId === this.#state.overview.data?.principal.tokenId;
		if (disconnects && (!revoked?.publicId || confirmation !== revoked.publicId)) return false;
		if (!disconnects && confirmation.toLowerCase() !== "y") return false;
		return await this.#mutate(
			"revoke-token",
			async signal => {
				await this.#client.revokeUserToken(selected.id, tokenId, signal);
			},
			"users",
			{ disconnectOnSuccess: disconnects },
		);
	}

	async addSelectedUserAcl(input: {
		effect: AuthGatewayAclEffect;
		kind: AuthGatewayAclKind;
		pattern: string;
	}): Promise<boolean> {
		const selected = this.selectedUser();
		const pattern = input.pattern.trim();
		if (
			!selected ||
			(input.effect !== "allow" && input.effect !== "deny") ||
			(input.kind !== "route" && input.kind !== "model" && input.kind !== "provider") ||
			!pattern
		)
			return false;
		return await this.#mutate(
			"add-acl",
			async signal => {
				await this.#client.addAclRule(selected.id, { effect: input.effect, kind: input.kind, pattern }, signal);
			},
			"users",
		);
	}

	async deleteSelectedUserAcl(ruleId: number): Promise<boolean> {
		const selected = this.selectedUser();
		if (!selected || !Number.isInteger(ruleId)) return false;
		return await this.#mutate(
			"delete-acl",
			async signal => {
				await this.#client.deleteAclRule(selected.id, ruleId, signal);
			},
			"users",
		);
	}

	async bindSelectedUserPool(poolId: number): Promise<boolean> {
		const selected = this.selectedUser();
		if (!selected || !Number.isInteger(poolId)) return false;
		return await this.#mutate(
			"bind-pool",
			async signal => {
				await this.#client.bindUserPool(selected.id, poolId, signal);
			},
			"users",
		);
	}

	async unbindSelectedUserPool(poolId: number, confirmation: string): Promise<boolean> {
		const selected = this.selectedUser();
		if (!selected || !Number.isInteger(poolId) || confirmation.toLowerCase() !== "y") return false;
		return await this.#mutate(
			"unbind-pool",
			async signal => {
				await this.#client.unbindUserPool(selected.id, poolId, signal);
			},
			"users",
		);
	}

	async rotateSelectedUserTokens(confirmation: string): Promise<boolean> {
		const selected = this.selectedUser();
		if (!selected || confirmation !== `rotate ${selected.name}`) return false;
		return await this.#mutateIssuedToken(
			"rotate-tokens",
			signal => this.#client.rotateUserTokens(selected.id, undefined, signal),
			"users",
		);
	}

	closeOneTimeToken(): void {
		if (this.#state.oneTimeToken) this.#state.oneTimeToken = null;
		this.setModalOpen(false);
	}

	async removeSelectedCredential(confirmation: string): Promise<boolean> {
		const selected = this.selectedCredential();
		if (!selected || confirmation !== String(selected.id)) return false;
		return await this.#mutate(
			"remove-credential",
			async signal => {
				await this.#client.removeCredential(selected.id, signal);
			},
			"accounts",
		);
	}

	async uploadApiKey(provider: string, key: string): Promise<boolean> {
		let secret = key;
		try {
			return await this.#mutate(
				"upload-api-key",
				async signal => {
					await this.#client.uploadCredential(provider, { type: "api_key", key: secret }, signal);
				},
				"accounts",
			);
		} finally {
			secret = "";
		}
	}

	async createPoolFromInput(value: string): Promise<boolean> {
		const [name, provider, model, strategy] = splitFields(value);
		if (!name || !provider) return false;
		const parsedStrategy = parsePoolStrategy(strategy);
		if (parsedStrategy === null) return false;
		return await this.#mutate(
			"create-pool",
			async signal => {
				await this.#client.createPool(
					{
						name,
						provider,
						...(model ? { model } : {}),
						...(parsedStrategy ? { strategy: parsedStrategy } : {}),
					},
					signal,
				);
			},
			"pools",
		);
	}

	async updateSelectedPoolFromInput(value: string): Promise<boolean> {
		const selected = this.selectedPool();
		const [name, strategy] = splitFields(value);
		if (!selected) return false;
		const parsedStrategy = parsePoolStrategy(strategy);
		if (parsedStrategy === null) return false;
		return await this.#mutate(
			"edit-pool",
			async signal => {
				await this.#client.updatePool(
					selected.id,
					{
						...(name ? { name } : {}),
						...(parsedStrategy ? { strategy: parsedStrategy } : {}),
					},
					signal,
				);
			},
			"pools",
		);
	}

	async deleteSelectedPool(confirmation: string): Promise<boolean> {
		const selected = this.selectedPool();
		if (!selected || confirmation !== selected.name) return false;
		return await this.#mutate(
			"delete-pool",
			async signal => {
				await this.#client.deletePool(selected.id, signal);
			},
			"pools",
		);
	}

	async addSelectedPoolCredential(credentialId: number): Promise<boolean> {
		const selected = this.selectedPool();
		if (!selected || !Number.isInteger(credentialId)) return false;
		return await this.#mutate(
			"add-pool-account",
			async signal => {
				await this.#client.addPoolCredential(selected.id, credentialId, signal);
			},
			"pools",
		);
	}

	async removeSelectedPoolCredential(credentialId: number, confirmation: string): Promise<boolean> {
		const selected = this.selectedPool();
		if (!selected || !Number.isInteger(credentialId) || confirmation.toLowerCase() !== "y") return false;
		return await this.#mutate(
			"remove-pool-account",
			async signal => {
				await this.#client.removePoolCredential(selected.id, credentialId, signal);
			},
			"pools",
		);
	}

	async moveSelectedPoolCredential(delta: -1 | 1): Promise<boolean> {
		const selected = this.selectedPool();
		if (!selected) return false;
		const members = [...selected.members].sort((a, b) => a.position - b.position);
		const currentIndex = this.#state.selectedPoolMemberIndex;
		const nextIndex = currentIndex + delta;
		if (currentIndex < 0 || nextIndex < 0 || currentIndex >= members.length || nextIndex >= members.length)
			return false;
		const order = members.map(member => member.credentialId);
		const [moved] = order.splice(currentIndex, 1);
		if (moved === undefined) return false;
		order.splice(nextIndex, 0, moved);
		return await this.#mutate(
			"reorder-pool",
			async signal => {
				await this.#client.setPoolCredentialOrder(selected.id, order, signal);
			},
			"pools",
		);
	}

	selectPoolMember(index: number): void {
		const selected = this.selectedPool();
		const max = Math.max(0, (selected?.members.length ?? 1) - 1);
		this.#state.selectedPoolMemberIndex = Math.max(0, Math.min(index, max));
		this.#requestRender();
	}

	async refreshSelectedCredential(): Promise<boolean> {
		const selected = this.selectedCredential();
		if (selected?.type !== "oauth") return false;
		return await this.#mutate(
			"refresh-credential",
			async signal => {
				await this.#client.refreshCredential(selected.id, signal);
			},
			"accounts",
		);
	}

	copySelectedCredentialIdentifiers(): string | null {
		const selected = this.selectedCredential();
		if (!selected) return null;
		return [
			`id=${selected.id}`,
			`provider=${selected.provider}`,
			`type=${selected.type}`,
			selected.identityKey ? `identity=${selected.identityKey}` : null,
			selected.email ? `email=${selected.email}` : null,
			selected.accountId ? `account=${selected.accountId}` : null,
			selected.projectId ? `project=${selected.projectId}` : null,
			selected.enterpriseUrl ? `enterprise=${selected.enterpriseUrl}` : null,
			selected.apiEndpoint ? `api=${selected.apiEndpoint}` : null,
		]
			.filter((item): item is string => item !== null)
			.join("\n");
	}

	currentUserDisconnectWarning(): string | null {
		const selected = this.selectedUser();
		return selected && this.#isCurrentUser(selected) ? "This will disconnect the current console" : null;
	}

	currentTokenDisconnectWarning(): { tokenId: number; publicId: string; message: string } | null {
		const selected = this.selectedUser();
		const tokenId = this.#state.overview.data?.principal.tokenId;
		if (!selected || !this.#isCurrentUser(selected) || tokenId === undefined || tokenId === null) return null;
		const publicId = this.#state.userDetails[selected.id]?.tokens.find(item => item.id === tokenId)?.publicId;
		return publicId ? { tokenId, publicId, message: "This will disconnect the current console" } : null;
	}

	selectedUser(): AuthGatewayUser | null {
		const users = this.filteredUsers();
		return users[this.#state.selected.users] ?? null;
	}

	selectedPool(): AuthGatewayPool | null {
		const pools = this.filteredPools();
		return pools[this.#state.selected.pools] ?? null;
	}

	selectedCredential(): AuthGatewayCredentialSummary | null {
		const credentials = this.filteredCredentials();
		return credentials[this.#state.selected.accounts] ?? null;
	}

	selectedAuditEvent(): AuthGatewayAuditEvent | null {
		const events = this.filteredAuditEvents();
		return events[this.#state.selected.audit] ?? null;
	}

	filteredUsers(): AuthGatewayUser[] {
		return filterRows(
			this.#state.users.data,
			this.#state.filter,
			user => `${user.name} ${user.description ?? ""} ${user.owner ?? ""} ${user.role}`,
		);
	}

	filteredPools(): AuthGatewayPool[] {
		return filterRows(
			this.#state.pools.data,
			this.#state.filter,
			pool => `${pool.name} ${pool.provider} ${pool.model ?? ""} ${pool.strategy}`,
		);
	}

	filteredCredentials(): AuthGatewayCredentialSummary[] {
		return filterRows(
			this.#state.accounts.data,
			this.#state.filter,
			account =>
				`${account.id} ${account.provider} ${account.type} ${account.email ?? ""} ${account.accountId ?? ""} ${account.identityKey ?? ""}`,
		);
	}

	filteredAuditEvents(): AuthGatewayAuditEvent[] {
		return filterRows(
			this.#state.audit.data,
			this.#state.audit.textFilter || this.#state.filter,
			event =>
				`${event.requestId} ${event.userName ?? ""} ${event.method} ${event.path} ${event.outcome} ${event.errorCode ?? ""}`,
		);
	}

	#visibleItemsLength(): number {
		if (this.#state.activeTab === "users") return this.filteredUsers().length;
		if (this.#state.activeTab === "pools") return this.filteredPools().length;
		if (this.#state.activeTab === "accounts") return this.filteredCredentials().length;
		if (this.#state.activeTab === "audit") return this.filteredAuditEvents().length;
		return 1;
	}

	async #loadVisible(reason: LoadReason): Promise<void> {
		if (this.#inFlight || this.#closed || this.#shouldPausePolling(reason)) return;
		this.#inFlight = true;
		this.#clearPollTimer();
		const generation = this.#generation;
		const abort = new AbortController();
		this.#activeAbort = abort;
		try {
			await this.#loadTab(this.#state.activeTab, abort.signal, reason);
			if (!this.#isCurrent(generation, abort.signal)) return;
			this.#state.health = "Connected";
			this.#state.errorBanner = null;
			this.#errorBackoffIndex = 0;
			this.#schedulePoll(ACTIVE_POLL_MS);
		} catch (error) {
			if (!this.#isCurrent(generation, abort.signal)) return;
			this.#markVisibleError(errorText(error));
			const delay = POLL_ERROR_BACKOFF_MS[Math.min(this.#errorBackoffIndex, POLL_ERROR_BACKOFF_MS.length - 1)];
			this.#errorBackoffIndex++;
			this.#schedulePoll(delay);
		} finally {
			if (this.#activeAbort === abort) {
				this.#activeAbort = null;
				this.#inFlight = false;
				this.#requestRender();
			}
		}
	}

	async #loadTab(tab: AuthGatewayConsoleTab, signal: AbortSignal, reason: LoadReason): Promise<void> {
		if (tab === "overview") {
			this.#state.overview.status = reason === "poll" && this.#state.overview.data ? "ready" : "loading";
			const status = await this.#client.status(signal);
			if (signal.aborted || this.#closed) return;
			this.#state.overview = { data: status, status: "ready", error: null, stale: false, lastUpdatedAt: nowMs() };
			return;
		}
		if (tab === "users") {
			this.#state.users.status = reason === "poll" && this.#state.users.data.length > 0 ? "ready" : "loading";
			const users = await this.#client.listUsers(signal);
			if (signal.aborted || this.#closed) return;
			this.#state.users = { data: users, status: "ready", error: null, stale: false, lastUpdatedAt: nowMs() };
			this.#state.userDetails = {};
			this.#state.userUsage = {};
			this.#clampSelection("users", users.length);
			await this.#loadSelectedUserDetail(signal);
			return;
		}
		if (tab === "pools") {
			this.#state.pools.status = reason === "poll" && this.#state.pools.data.length > 0 ? "ready" : "loading";
			const pools = await this.#client.listPools(signal);
			if (signal.aborted || this.#closed) return;
			this.#state.pools = { data: pools, status: "ready", error: null, stale: false, lastUpdatedAt: nowMs() };
			this.#state.poolUsers = {};
			this.#clampSelection("pools", pools.length);
			this.#state.selectedPoolMemberIndex = 0;
			await this.#loadSelectedPoolUsers(signal);
			return;
		}
		if (tab === "accounts") {
			this.#state.accounts.status = reason === "poll" && this.#state.accounts.data.length > 0 ? "ready" : "loading";
			const accounts = await this.#client.listCredentials(signal);
			if (signal.aborted || this.#closed) return;
			this.#state.accounts = { data: accounts, status: "ready", error: null, stale: false, lastUpdatedAt: nowMs() };
			this.#clampSelection("accounts", accounts.length);
			return;
		}
		await this.#loadAuditPage(undefined, reason, signal, this.#generation);
	}

	async #loadSelectedDetail(tab: AuthGatewayConsoleTab): Promise<void> {
		if (this.#closed) return;
		this.#detailAbort?.abort();
		const abort = new AbortController();
		this.#detailAbort = abort;
		const generation = this.#generation;
		try {
			if (tab === "users") await this.#loadSelectedUserDetail(abort.signal, generation);
			if (tab === "pools") await this.#loadSelectedPoolUsers(abort.signal, generation);
		} finally {
			if (this.#detailAbort === abort) this.#detailAbort = null;
			if (this.#isCurrent(generation, abort.signal)) this.#requestRender();
		}
	}

	async #loadSelectedUserDetail(signal: AbortSignal, generation = this.#generation): Promise<void> {
		const selected = this.selectedUser();
		if (!selected || this.#state.userDetails[selected.id]) return;
		const [details, usage] = await Promise.all([
			this.#client.getUser(selected.id, signal),
			this.#client.getUserUsage(selected.id, undefined, signal),
		]);
		if (!this.#isCurrent(generation, signal)) return;
		this.#state.userDetails[selected.id] = details;
		this.#state.userUsage[selected.id] = usage;
	}

	async #loadSelectedPoolUsers(signal: AbortSignal, generation = this.#generation): Promise<void> {
		const selected = this.selectedPool();
		if (!selected || this.#state.poolUsers[selected.id]) return;
		const users = await this.#client.listPoolUsers(selected.id, signal);
		if (!this.#isCurrent(generation, signal)) return;
		this.#state.poolUsers[selected.id] = users;
	}

	async #loadAuditPage(
		before: number | undefined,
		reason: LoadReason,
		signal?: AbortSignal,
		generation = this.#generation,
	): Promise<void> {
		if (reason === "poll" && this.#state.audit.pageIndex > 0) return;
		this.#state.audit.status = reason === "poll" && this.#state.audit.data.length > 0 ? "ready" : "loading";
		const query: { userId?: number; limit: number; before?: number } = { limit: 50 };
		if (this.#state.audit.userFilter !== null) query.userId = this.#state.audit.userFilter;
		if (before !== undefined) query.before = before;
		const page = await this.#client.listAudit(query, signal);
		if ((signal && !this.#isCurrent(generation, signal)) || (!signal && this.#closed)) return;
		const pageEntry = { before, events: page.events, nextBefore: page.nextBefore };
		if (before === undefined) {
			this.#state.audit.pages = [pageEntry];
			this.#state.audit.pageIndex = 0;
		} else {
			this.#state.audit.pages = this.#state.audit.pages.slice(0, this.#state.audit.pageIndex + 1);
			this.#state.audit.pages.push(pageEntry);
			this.#state.audit.pageIndex = this.#state.audit.pages.length - 1;
		}
		this.#state.audit.data = page.events;
		this.#state.audit.nextBefore = page.nextBefore;
		this.#state.audit.status = "ready";
		this.#state.audit.error = null;
		this.#state.audit.stale = false;
		this.#state.audit.lastUpdatedAt = nowMs();
	}

	async #mutateIssuedToken(
		action: string,
		run: (signal: AbortSignal) => Promise<AuthGatewayIssuedTokenValue>,
		refreshTab: AuthGatewayConsoleTab,
	): Promise<boolean> {
		if (this.#state.busyAction) return false;
		this.#abortVisibleLoads();
		this.#state.busyAction = action;
		this.#state.oneTimeToken = null;
		this.#requestRender();
		const generation = this.#generation;
		const abort = new AbortController();
		this.#mutationAbort = abort;
		try {
			const token = await run(abort.signal);
			if (!this.#isCurrent(generation, abort.signal)) {
				this.#state.oneTimeToken = null;
				return false;
			}
			this.#state.oneTimeToken = { ...token };
			this.#state.modalOpen = true;
			this.#state.activeTab = refreshTab;
			void this.refresh("mutation");
			return true;
		} catch (error) {
			if (!this.#isCurrent(generation, abort.signal)) return false;
			this.#state.oneTimeToken = null;
			this.#state.errorBanner = formatMutationError(error);
			this.#state.health = "Error";
			return false;
		} finally {
			if (this.#mutationAbort === abort) this.#mutationAbort = null;
			if (this.#isCurrent(generation, abort.signal)) {
				this.#state.busyAction = null;
				this.#requestRender();
			}
		}
	}

	async #mutate(
		action: string,
		run: (signal: AbortSignal) => Promise<void>,
		refreshTab: AuthGatewayConsoleTab,
		options: { disconnectOnSuccess?: boolean } = {},
	): Promise<boolean> {
		if (this.#state.busyAction) return false;
		this.#abortVisibleLoads();
		this.#state.busyAction = action;
		this.#requestRender();
		const generation = this.#generation;
		const abort = new AbortController();
		this.#mutationAbort = abort;
		try {
			await run(abort.signal);
			if (!this.#isCurrent(generation, abort.signal)) return false;
			if (options.disconnectOnSuccess) {
				this.close();
				this.#onDisconnect?.();
				return true;
			}
			this.#state.activeTab = refreshTab;
			await this.refresh("mutation");
			return this.#isCurrent(generation, abort.signal);
		} catch (error) {
			if (!this.#isCurrent(generation, abort.signal)) return false;
			this.#state.errorBanner = formatMutationError(error);
			this.#state.health = "Error";
			return false;
		} finally {
			if (this.#mutationAbort === abort) this.#mutationAbort = null;
			if (this.#isCurrent(generation, abort.signal)) {
				this.#state.busyAction = null;
				this.#requestRender();
			}
		}
	}

	#abortVisibleLoads(): void {
		this.#generation++;
		this.#clearPollTimer();
		this.#activeAbort?.abort();
		this.#activeAbort = null;
		this.#detailAbort?.abort();
		this.#detailAbort = null;
		this.#auditPageAbort?.abort();
		this.#auditPageAbort = null;
		this.#inFlight = false;
	}

	#markVisibleError(message: string): void {
		this.#state.errorBanner = message;
		this.#state.health = this.#hasSnapshot(this.#state.activeTab) ? "Stale" : "Error";
		const tab = this.#state.activeTab;
		const resource = this.#resourceFor(tab);
		resource.error = message;
		resource.status = "error";
		resource.stale = this.#hasSnapshot(tab);
	}

	#hasSnapshot(tab: AuthGatewayConsoleTab): boolean {
		if (tab === "overview") return this.#state.overview.data !== null;
		if (tab === "users") return this.#state.users.data.length > 0;
		if (tab === "pools") return this.#state.pools.data.length > 0;
		if (tab === "accounts") return this.#state.accounts.data.length > 0;
		return this.#state.audit.data.length > 0;
	}

	#resourceFor(tab: AuthGatewayConsoleTab): ResourceState<unknown> {
		if (tab === "overview") return this.#state.overview;
		if (tab === "users") return this.#state.users;
		if (tab === "pools") return this.#state.pools;
		if (tab === "accounts") return this.#state.accounts;
		return this.#state.audit;
	}

	#shouldPausePolling(reason: LoadReason): boolean {
		return (
			reason === "poll" &&
			(this.#state.modalOpen || (this.#state.activeTab === "audit" && this.#state.audit.pageIndex > 0))
		);
	}

	#schedulePoll(delay: number): void {
		this.#clearPollTimer();
		if (
			this.#closed ||
			this.#state.modalOpen ||
			(this.#state.activeTab === "audit" && this.#state.audit.pageIndex > 0)
		)
			return;
		this.#pollTimer = setTimeout(() => {
			void this.refresh("poll");
		}, delay);
	}

	#clearPollTimer(): void {
		if (this.#pollTimer) clearTimeout(this.#pollTimer);
		this.#pollTimer = null;
	}

	#isCurrent(generation: number, signal: AbortSignal): boolean {
		return !this.#closed && generation === this.#generation && !signal.aborted;
	}

	#isCurrentUser(user: AuthGatewayUser): boolean {
		return this.#state.overview.data?.principal.userId === user.id;
	}

	#deleteUserConfirmation(user: AuthGatewayUser): string {
		return this.#isCurrentUser(user) ? `disconnect ${user.name}` : user.name;
	}

	#clampSelection(tab: AuthGatewayConsoleTab, length: number): void {
		this.#state.selected[tab] = Math.max(0, Math.min(this.#state.selected[tab], Math.max(0, length - 1)));
	}
}

function filterRows<T>(rows: T[], query: string, toText: (row: T) => string): T[] {
	const needle = query.trim().toLowerCase();
	if (!needle) return rows;
	return rows.filter(row => toText(row).toLowerCase().includes(needle));
}

function splitFields(value: string): string[] {
	return value.split("|").map(item => item.trim());
}

function formatMutationError(error: unknown): string {
	const maybeError = error as Partial<Error> & { details?: { pools?: Array<{ name: string }> } };
	const pools = maybeError.details?.pools;
	if (Array.isArray(pools) && pools.length > 0)
		return `${maybeError.message ?? "Credential is in use"}: ${pools.map(pool => pool.name).join(", ")}`;
	return errorText(error);
}
