import { getOAuthProviders, type OAuthProviderInfo, type UsageReport } from "@oh-my-pi/pi-ai";
import { Container, matchesKey, Spacer, TruncatedText } from "@oh-my-pi/pi-tui";
import type { AccountInfo, AuthStorage, OAuthCredential } from "../../session/auth-storage";
import { theme } from "../theme/theme";
import { DynamicBorder } from "./dynamic-border";

type ProviderRow = {
	kind: "provider";
	provider: string;
	providerName: string;
	count: number;
};

type AccountRow = {
	kind: "account";
	provider: string;
	credentialIndex: number;
	info: AccountInfo;
	label: string;
	active: boolean;
	expired: boolean;
	blocked: boolean;
	blockedUntil?: number;
	usageFraction?: number;
	usageStatus: "ok" | "warning" | "exhausted";
	statusText: string;
	resetText?: string;
};

type AddRow = {
	kind: "add";
};

type Row = ProviderRow | AccountRow | AddRow;

const BAR_WIDTH = 16;
const LABEL_WIDTH = 24;

const PROVIDER_NAMES = new Map<string, string>(getOAuthProviders().map((p: OAuthProviderInfo) => [p.id, p.name]));

function formatDuration(ms: number): string {
	const seconds = Math.floor(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	const remainingMinutes = minutes % 60;
	if (hours < 24) {
		return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
	}
	const days = Math.floor(hours / 24);
	return `${days}d`;
}

function renderBar(fraction: number, status: "ok" | "warning" | "exhausted"): string {
	const clamped = Math.min(Math.max(fraction, 0), 1);
	const filled = Math.round(clamped * BAR_WIDTH);
	const filledBar = "█".repeat(filled);
	const emptyBar = "░".repeat(Math.max(0, BAR_WIDTH - filled));
	const color = status === "exhausted" ? "error" : status === "warning" ? "warning" : "success";
	return `${theme.fg("dim", "[")}${theme.fg(color, filledBar)}${theme.fg("dim", emptyBar)}${theme.fg("dim", "]")}`;
}

function isExpired(info: AccountInfo): boolean {
	if (info.credential.type !== "oauth") return false;
	const oauth = info.credential as OAuthCredential;
	return oauth.expires > 0 && oauth.expires < Date.now();
}

function resolveLabel(info: AccountInfo, index: number, report?: UsageReport): string {
	const cred = info.credential;

	// Prefer provider-reported identity (from usage API) over credential email,
	// since OAuth login email may differ from the actual account email.
	if (report?.metadata) {
		const metaEmail = report.metadata.email;
		if (typeof metaEmail === "string" && metaEmail) return metaEmail;
		const metaAccountId = report.metadata.accountId;
		if (typeof metaAccountId === "string" && metaAccountId) return metaAccountId;
	}

	if (cred.type === "oauth") {
		const oauth = cred as OAuthCredential;
		if (oauth.email) return oauth.email;
		if (oauth.accountId) return oauth.accountId;
	}

	if (cred.type === "api_key") {
		const key = cred.key;
		const last4 = key.length >= 4 ? key.slice(-4) : key;
		return `API Key ···${last4}`;
	}

	return `Account ${index + 1}`;
}

function truncateOrPad(text: string, width: number): string {
	if (text.length > width) return `${text.slice(0, width - 1)}…`;
	return text.padEnd(width);
}

export class AccountsSelectorComponent extends Container {
	#authStorage: AuthStorage;
	#sessionId: string;
	#onAddAccount: (providerId: string) => void;
	#onViewDetail: (provider: string, credentialIndex: number) => void;
	#onRemoveAccount: (provider: string, credentialIndex: number) => void;
	#onSwitchAccount: (provider: string, credentialIndex: number) => void;
	#onCancel: () => void;
	#requestRender: () => void;
	#listContainer: Container;
	#rows: Row[] = [];
	#selectedIndex = 0;
	#usageReports: UsageReport[] | null = null;
	#loading = true;
	#destroyed = false;

	constructor(
		authStorage: AuthStorage,
		sessionId: string,
		onAddAccount: (providerId: string) => void,
		onViewDetail: (provider: string, credentialIndex: number) => void,
		onRemoveAccount: (provider: string, credentialIndex: number) => void,
		onSwitchAccount: (provider: string, credentialIndex: number) => void,
		onCancel: () => void,
		requestRender: () => void,
	) {
		super();

		this.#authStorage = authStorage;
		this.#sessionId = sessionId;
		this.#onAddAccount = onAddAccount;
		this.#onViewDetail = onViewDetail;
		this.#onRemoveAccount = onRemoveAccount;
		this.#onSwitchAccount = onSwitchAccount;
		this.#onCancel = onCancel;
		this.#requestRender = requestRender;
		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));
		this.addChild(new TruncatedText(`  ${theme.bold(theme.fg("accent", "Accounts"))}`));
		this.addChild(new Spacer(1));

		this.#listContainer = new Container();
		this.addChild(this.#listContainer);

		this.addChild(new Spacer(1));
		this.addChild(
			new TruncatedText(theme.fg("dim", "  [esc] back  [enter] details  [d] remove  [r] refresh  [s] switch")),
		);
		this.addChild(new DynamicBorder());

		// Don't build rows yet — show loading state until usage arrives
		this.#renderList();

		if (this.#authStorage.list().length === 0) {
			queueMicrotask(() => onAddAccount(""));
		}

		this.#fetchUsage();
	}

	#fetchUsage(): void {
		this.#authStorage
			.fetchUsageReports()
			.then(reports => {
				if (this.#destroyed) return;
				this.#usageReports = reports;
				this.#loading = false;
				this.#buildRows();
				this.#renderList();
				this.invalidate();
				this.#requestRender();
			})
			.catch(() => {
				if (this.#destroyed) return;
				this.#loading = false;
				this.#buildRows();
				this.#renderList();
				this.invalidate();
				this.#requestRender();
			});
	}

	#buildRows(): void {
		const rows: Row[] = [];
		const providers = this.#authStorage.list();
		let hasAnyAccount = false;

		for (const provider of providers) {
			const infos = this.#authStorage.getAccountInfos(provider);
			if (infos.length === 0) continue;

			hasAnyAccount = true;
			const providerName = PROVIDER_NAMES.get(provider) ?? provider;
			const activeStatus = this.#authStorage.getAccountStatus(provider, this.#sessionId);

			rows.push({
				kind: "provider",
				provider,
				providerName,
				count: infos.length,
			});

			for (let i = 0; i < infos.length; i++) {
				const info = infos[i]!;
				const expired = isExpired(info);
				const blocked = info.blocked;
				const report = this.#matchReport(info);
				const label = resolveLabel(info, i, report);
				const usage = this.#resolveUsage(info, expired, blocked, report);
				const active = activeStatus?.activeIndex === i;

				rows.push({
					kind: "account",
					provider,
					credentialIndex: i,
					info,
					label,
					active,
					expired,
					blocked,
					blockedUntil: info.blockedUntil,
					...usage,
				});
			}
		}

		if (!hasAnyAccount) {
			rows.push({ kind: "add" });
			this.#rows = rows;
			this.#selectedIndex = 0;
			return;
		}

		rows.push({ kind: "add" });
		this.#rows = rows;

		if (this.#selectedIndex >= rows.length) {
			this.#selectedIndex = rows.length - 1;
		}
		this.#snapToSelectable(1);
	}

	#resolveUsage(
		info: AccountInfo,
		expired: boolean,
		blocked: boolean,
		report: UsageReport | undefined,
	): { usageFraction?: number; usageStatus: "ok" | "warning" | "exhausted"; statusText: string; resetText?: string } {
		if (expired) {
			return { usageFraction: 1, usageStatus: "exhausted", statusText: `${theme.status.error} token expired` };
		}

		if (blocked) {
			let resetText: string | undefined;
			if (info.blockedUntil) {
				const resetIn = info.blockedUntil - Date.now();
				resetText = resetIn > 0 ? formatDuration(resetIn) : undefined;
			}
			return {
				usageStatus: "warning",
				statusText: `${theme.status.warning} rate limited`,
				resetText,
			};
		}

		if (!this.#usageReports || !report || report.limits.length === 0) {
			return { usageStatus: "ok", statusText: "--" };
		}

		const worstStatus = this.#aggregateStatus(report);

		// Find the worst (highest) usage fraction across all limits
		let worstFraction = 0;
		let worstLimit = report.limits[0]!;
		for (const limit of report.limits) {
			const f = limit.amount.usedFraction ?? 0;
			if (f > worstFraction) {
				worstFraction = f;
				worstLimit = limit;
			}
		}

		if (worstStatus === "exhausted") {
			let resetText: string | undefined;
			if (worstLimit.window) {
				const resetInMs = worstLimit.window.resetsAt ? worstLimit.window.resetsAt - Date.now() : undefined;
				if (typeof resetInMs === "number" && resetInMs > 0) {
					resetText = `resets in ${formatDuration(resetInMs)}`;
				}
			}
			return { usageFraction: 1, usageStatus: "exhausted", statusText: "100%", resetText };
		}

		const pct = Math.round(worstFraction * 100);
		const status = pct >= 100 ? ("exhausted" as const) : pct >= 90 ? ("warning" as const) : ("ok" as const);
		let resetText: string | undefined;
		if (worstLimit.window) {
			const resetInMs = worstLimit.window.resetsAt ? worstLimit.window.resetsAt - Date.now() : undefined;
			if (typeof resetInMs === "number" && resetInMs > 0) {
				resetText = `resets in ${formatDuration(resetInMs)}`;
			}
		}
		return { usageFraction: worstFraction, usageStatus: status, statusText: `${pct}%`, resetText };
	}

	#matchReport(info: AccountInfo): UsageReport | undefined {
		if (!this.#usageReports) return undefined;

		const cred = info.credential;
		if (cred.type !== "oauth") {
			return this.#usageReports.find(r => r.provider === info.provider);
		}

		const oauth = cred as OAuthCredential;
		const email = oauth.email;
		const accountId = oauth.accountId;

		return this.#usageReports.find(r => {
			if (r.provider !== info.provider) return false;
			if (email && r.metadata?.email === email) return true;
			if (accountId && r.metadata?.accountId === accountId) return true;
			if (!email && !accountId) return true;
			return false;
		});
	}

	#aggregateStatus(report: UsageReport): string {
		let worst = "ok";
		for (const limit of report.limits) {
			if (limit.status === "exhausted") return "exhausted";
			if (limit.status === "warning") worst = "warning";
		}
		return worst;
	}

	#renderList(): void {
		this.#listContainer.clear();

		if (this.#loading) {
			this.#listContainer.addChild(new TruncatedText(theme.fg("dim", "  Loading accounts...")));
			return;
		}
		if (this.#rows.length === 1 && this.#rows[0]?.kind === "add") {
			this.#listContainer.addChild(new TruncatedText(theme.fg("muted", "  No accounts configured")));
			this.#listContainer.addChild(new Spacer(1));
		}

		for (let i = 0; i < this.#rows.length; i++) {
			const row = this.#rows[i]!;
			const selected = i === this.#selectedIndex;

			if (row.kind === "provider") {
				this.#renderProviderRow(row);
			} else if (row.kind === "account") {
				this.#listContainer.addChild(new TruncatedText(this.#renderAccountRow(row, selected)));
			} else {
				const prefix = selected ? theme.fg("accent", `  ${theme.nav.cursor} `) : "    ";
				this.#listContainer.addChild(new TruncatedText(prefix + theme.fg("accent", "+ Add account")));
			}
		}
	}

	#renderProviderRow(row: ProviderRow): void {
		const name = theme.bold(theme.fg("accent", `  ${row.providerName}`));
		const countText = theme.fg("dim", `${row.count} account${row.count === 1 ? "" : "s"}`);
		this.#listContainer.addChild(new Spacer(1));
		this.#listContainer.addChild(new TruncatedText(`${name}  ${countText}`));
	}

	#renderAccountRow(row: AccountRow, selected: boolean): string {
		const cursor = selected ? theme.fg("accent", theme.nav.cursor) : " ";
		const prefix = `  ${cursor} `;

		const paddedLabel = truncateOrPad(`${row.label}${row.active ? " [active]" : ""}`, LABEL_WIDTH);

		const barColor = row.usageStatus;
		const fraction = row.usageFraction;
		let bar: string;
		if (fraction !== undefined) {
			bar = renderBar(fraction, barColor);
		} else {
			// No fraction data — dim empty bar
			bar = `${theme.fg("dim", "[")}${theme.fg("dim", "░".repeat(BAR_WIDTH))}${theme.fg("dim", "]")}`;
		}

		const statusColor =
			barColor === "exhausted"
				? ("error" as const)
				: barColor === "warning"
					? ("warning" as const)
					: ("muted" as const);

		const statusText = theme.fg(statusColor, row.statusText);
		const resetPart = row.resetText ? ` ${theme.fg("dim", `· ${row.resetText}`)}` : "";

		const labelColor =
			barColor === "exhausted"
				? ("error" as const)
				: barColor === "warning"
					? ("warning" as const)
					: ("text" as const);
		const labelText = theme.fg(labelColor, paddedLabel);

		return `${prefix}${labelText}${bar} ${statusText}${resetPart}`;
	}

	handleInput(keyData: string): void {
		// Allow esc even while loading
		if (matchesKey(keyData, "escape") || matchesKey(keyData, "esc") || matchesKey(keyData, "ctrl+c")) {
			this.#onCancel();
			return;
		}
		if (this.#loading) return;
		if (matchesKey(keyData, "up")) {
			this.#moveSelection(-1);
		} else if (matchesKey(keyData, "down")) {
			this.#moveSelection(1);
		} else if (matchesKey(keyData, "enter") || matchesKey(keyData, "return") || keyData === "\n") {
			this.#handleEnter();
		} else if (keyData === "d") {
			this.#handleDelete();
		} else if (keyData === "r") {
			this.#fetchUsage();
		} else if (keyData === "s") {
			this.#handleSwitch();
		}
	}

	#snapToSelectable(direction: number): void {
		const start = this.#selectedIndex;
		while (this.#rows[this.#selectedIndex]?.kind === "provider") {
			this.#selectedIndex += direction > 0 ? 1 : -1;
			if (this.#selectedIndex < 0) this.#selectedIndex = this.#rows.length - 1;
			if (this.#selectedIndex >= this.#rows.length) this.#selectedIndex = 0;
			if (this.#selectedIndex === start) break;
		}
	}

	#moveSelection(delta: number): void {
		if (this.#rows.length === 0) return;
		let next = this.#selectedIndex + delta;
		if (next < 0) next = this.#rows.length - 1;
		if (next >= this.#rows.length) next = 0;
		this.#selectedIndex = next;
		this.#snapToSelectable(delta);
		this.#renderList();
		this.invalidate();
	}

	#handleEnter(): void {
		const row = this.#rows[this.#selectedIndex];
		if (!row) return;

		if (row.kind === "account") {
			this.#onViewDetail(row.provider, row.credentialIndex);
		} else if (row.kind === "add") {
			this.#onAddAccount("");
		}
	}

	#handleDelete(): void {
		const row = this.#rows[this.#selectedIndex];
		if (row?.kind === "account") {
			this.#onRemoveAccount(row.provider, row.credentialIndex);
		}
	}

	#handleSwitch(): void {
		const row = this.#rows[this.#selectedIndex];
		if (row?.kind === "account") {
			this.#onSwitchAccount(row.provider, row.credentialIndex);
		}
	}

	destroy(): void {
		this.#destroyed = true;
	}
}
