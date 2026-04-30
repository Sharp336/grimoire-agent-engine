import { getOAuthProviders, type OAuthProviderInfo, type UsageLimit, type UsageReport } from "@oh-my-pi/pi-ai";
import { Container, matchesKey, Spacer, TruncatedText } from "@oh-my-pi/pi-tui";
import type { AccountInfo, AuthStorage, OAuthCredential } from "../../session/auth-storage";
import { theme } from "../theme/theme";
import { DynamicBorder } from "./dynamic-border";

const KEY_WIDTH = 18;
const BAR_WIDTH = 24;

const providerNames = new Map<string, string>(getOAuthProviders().map((p: OAuthProviderInfo) => [p.id, p.name]));

function padKey(label: string): string {
	return label.padEnd(KEY_WIDTH);
}

function formatTimestamp(ms: number): string {
	const d = new Date(ms);
	const yyyy = d.getFullYear();
	const mm = String(d.getMonth() + 1).padStart(2, "0");
	const dd = String(d.getDate()).padStart(2, "0");
	const hh = String(d.getHours()).padStart(2, "0");
	const min = String(d.getMinutes()).padStart(2, "0");
	return `${yyyy}-${mm}-${dd} ${hh}:${min}`;
}

function formatRelative(diffMs: number): string {
	const abs = Math.abs(diffMs);
	const totalMinutes = Math.floor(abs / 60_000);
	if (totalMinutes < 1) return `${Math.floor(abs / 1000)}s`;
	if (totalMinutes < 60) return `${totalMinutes}m`;
	const hours = Math.floor(totalMinutes / 60);
	const remainingMinutes = totalMinutes % 60;
	if (hours < 24) {
		return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
	}
	const days = Math.floor(hours / 24);
	const remainingHours = hours % 24;
	return remainingHours > 0 ? `${days}d ${remainingHours}h` : `${days}d`;
}

function getAccountLabel(info: AccountInfo): string {
	if (info.credential.type === "oauth") {
		const oauth = info.credential;
		if (oauth.email) return oauth.email;
		if (oauth.accountId) return oauth.accountId;
	}
	return `${info.provider} #${info.id}`;
}

function getStatus(info: AccountInfo): { label: string; color: "success" | "warning" | "error"; symbol: string } {
	if (info.blocked) {
		const resetIn = info.blockedUntil ? info.blockedUntil - Date.now() : undefined;
		const resetLabel = resetIn && resetIn > 0 ? ` (resets in ${formatRelative(resetIn)})` : "";
		return { label: `Rate Limited${resetLabel}`, color: "warning", symbol: theme.status.warning };
	}
	if (info.credential.type === "oauth") {
		const oauth = info.credential;
		if (oauth.expires && oauth.expires < Date.now()) {
			return { label: "Expired", color: "error", symbol: theme.status.error };
		}
	}
	return { label: "Active", color: "success", symbol: theme.status.success };
}

function resolveProviderName(providerId: string): string {
	return providerNames.get(providerId) ?? providerId;
}

function renderBar(fraction: number, status: "ok" | "warning" | "exhausted" | "unknown"): string {
	const clamped = Math.min(Math.max(fraction, 0), 1);
	const filled = Math.round(clamped * BAR_WIDTH);
	const filledBar = "█".repeat(filled);
	const emptyBar = "░".repeat(Math.max(0, BAR_WIDTH - filled));
	const color = status === "exhausted" ? "error" : status === "warning" ? "warning" : "success";
	return `${theme.fg("dim", "[")}${theme.fg(color, filledBar)}${theme.fg("dim", emptyBar)}${theme.fg("dim", "]")}`;
}

function getUsedFraction(amount: UsageLimit["amount"]): number {
	if (amount.usedFraction !== undefined) return amount.usedFraction;
	if (amount.used !== undefined && amount.limit !== undefined && amount.limit > 0) {
		return amount.used / amount.limit;
	}
	return 0;
}

function formatUsageNumbers(amount: UsageLimit["amount"]): string {
	if (amount.used !== undefined && amount.limit !== undefined) {
		const pct = Math.round(getUsedFraction(amount) * 100);
		return `${amount.used}/${amount.limit} (${pct}%)`;
	}
	if (amount.used !== undefined) return `${amount.used} ${amount.unit} used`;
	if (amount.remaining !== undefined) return `${amount.remaining} ${amount.unit} remaining`;
	return "--";
}

export class AccountDetailComponent extends Container {
	#contentContainer: Container;
	#authStorage: AuthStorage;
	#provider: string;
	#credentialIndex: number;
	#onRemove: () => void;
	#onBack: () => void;
	#onSwitch: () => void;
	#requestRender: () => void;
	#usageReport: UsageReport | null = null;
	#usageLoading = false;
	#error: string | undefined;

	constructor(
		authStorage: AuthStorage,
		provider: string,
		credentialIndex: number,
		onRemove: () => void,
		onSwitch: () => void,
		onBack: () => void,
		requestRender: () => void,
	) {
		super();

		this.#authStorage = authStorage;
		this.#provider = provider;
		this.#credentialIndex = credentialIndex;
		this.#onRemove = onRemove;
		this.#onSwitch = onSwitch;
		this.#onBack = onBack;
		this.#requestRender = requestRender;

		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));

		this.#contentContainer = new Container();
		this.addChild(this.#contentContainer);

		this.addChild(new Spacer(1));
		this.addChild(new TruncatedText(theme.fg("dim", "[esc] back  [d] remove  [r] refresh  [s] switch")));
		this.addChild(new DynamicBorder());

		this.#rebuild();
		this.#fetchUsage();
	}

	#getInfo(): AccountInfo | undefined {
		const infos = this.#authStorage.getAccountInfos(this.#provider);
		return infos[this.#credentialIndex];
	}

	#rebuild(): void {
		this.#contentContainer.clear();

		const info = this.#getInfo();
		if (!info) {
			this.#contentContainer.addChild(
				new TruncatedText(theme.fg("error", "Account not found (credential index out of bounds)")),
			);
			return;
		}

		// Title
		this.#contentContainer.addChild(
			new TruncatedText(theme.bold(theme.fg("accent", `Account: ${getAccountLabel(info)}`))),
		);
		this.#contentContainer.addChild(new Spacer(1));

		// Detail rows
		const status = getStatus(info);
		const isOAuth = info.credential.type === "oauth";
		const oauth = isOAuth ? (info.credential as OAuthCredential) : undefined;
		const now = Date.now();

		this.#addRow("Provider", resolveProviderName(info.provider));
		this.#addRow("Type", isOAuth ? "OAuth" : "API Key");
		this.#contentContainer.addChild(
			new TruncatedText(
				`  ${theme.fg("dim", padKey("Status"))}${theme.fg(status.color, `${status.symbol} ${status.label}`)}`,
			),
		);

		if (isOAuth && oauth) {
			if (oauth.expires && oauth.expires > 0) {
				const remaining = oauth.expires - now;
				const suffix = remaining > 0 ? `(${formatRelative(remaining)} remaining)` : theme.fg("error", "(expired)");
				this.#addRow("Token expires", `${formatTimestamp(oauth.expires)} ${suffix}`);
			} else {
				this.#addRow("Token expires", "--");
			}
			this.#addRow("Account ID", oauth.accountId || "--");
			this.#addRow("Email", oauth.email || "--");
			if (oauth.projectId) this.#addRow("Project ID", oauth.projectId);
			if (oauth.enterpriseUrl) this.#addRow("Enterprise URL", oauth.enterpriseUrl);
		} else {
			this.#addRow("Token expires", "N/A");
		}

		// Usage section
		this.#contentContainer.addChild(new Spacer(1));

		if (this.#usageLoading) {
			this.#contentContainer.addChild(new TruncatedText(`  ${theme.fg("dim", "Loading usage data...")}`));
		} else if (this.#error) {
			this.#contentContainer.addChild(new TruncatedText(`  ${theme.fg("error", this.#error)}`));
		} else if (this.#usageReport && this.#usageReport.limits.length > 0) {
			this.#contentContainer.addChild(new TruncatedText(`  ${theme.bold("Usage Limits")}`));
			const limits = this.#usageReport.limits;
			for (let i = 0; i < limits.length; i++) {
				const limit = limits[i]!;
				const isLast = i === limits.length - 1;
				const connector = isLast ? theme.tree.last : theme.tree.branch;
				const continuation = isLast ? "   " : "│  ";
				const limitStatus = limit.status ?? "unknown";

				const label = limit.window ? `${limit.label} (${limit.window.label})` : limit.label;

				// Line 1: tree connector + bold label
				this.#contentContainer.addChild(new TruncatedText(`  ${connector} ${theme.bold(label)}`));

				// Line 2: continuation + bar + numbers + reset
				const fraction = getUsedFraction(limit.amount);
				const bar = renderBar(fraction, limitStatus);
				const numbers = formatUsageNumbers(limit.amount);
				const resetMs = limit.window?.resetsAt ? limit.window.resetsAt - Date.now() : undefined;
				const resetPart = resetMs && resetMs > 0 ? `  resets in ${formatRelative(resetMs)}` : "";

				this.#contentContainer.addChild(
					new TruncatedText(`  ${continuation}${bar}  ${numbers}${theme.fg("dim", resetPart)}`),
				);
			}
		} else {
			this.#contentContainer.addChild(new TruncatedText(`  ${theme.fg("dim", "No usage data")}`));
		}
	}

	#addRow(key: string, value: string): void {
		this.#contentContainer.addChild(new TruncatedText(`  ${theme.fg("dim", padKey(key))}${value}`));
	}

	async #fetchUsage(): Promise<void> {
		this.#usageLoading = true;
		this.#error = undefined;
		this.#rebuild();
		this.invalidate();
		this.#requestRender();

		try {
			const reports = await this.#authStorage.fetchUsageReports();
			this.#usageReport = this.#matchReport(reports);
		} catch {
			this.#error = "Failed to fetch usage data";
		} finally {
			this.#usageLoading = false;
			this.#rebuild();
			this.invalidate();
			this.#requestRender();
		}
	}

	#matchReport(reports: UsageReport[] | null): UsageReport | null {
		if (!reports) return null;

		const providerReports = reports.filter(r => r.provider === this.#provider);
		if (providerReports.length <= 1) return providerReports[0] ?? null;

		const info = this.#getInfo();
		if (!info || info.credential.type !== "oauth") return providerReports[0] ?? null;

		const oauth = info.credential as OAuthCredential;
		for (const report of providerReports) {
			const meta = report.metadata;
			if (!meta) continue;
			if (oauth.email && meta.email === oauth.email) return report;
			if (oauth.accountId && meta.accountId === oauth.accountId) return report;
		}
		return providerReports[0] ?? null;
	}

	handleInput(keyData: string): void {
		if (matchesKey(keyData, "escape") || matchesKey(keyData, "esc") || matchesKey(keyData, "ctrl+c")) {
			this.#onBack();
		} else if (matchesKey(keyData, "d")) {
			this.#onRemove();
		} else if (matchesKey(keyData, "r")) {
			void this.#fetchUsage();
		} else if (matchesKey(keyData, "s")) {
			this.#onSwitch();
		}
	}
}
