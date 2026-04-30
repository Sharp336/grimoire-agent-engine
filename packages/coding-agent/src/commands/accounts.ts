/**
 * CLI command to list accounts, show usage stats, and manage credentials.
 */

import { getOAuthProviders, type OAuthProviderInfo, type UsageReport } from "@oh-my-pi/pi-ai";
import { Command, Flags } from "@oh-my-pi/pi-utils/cli";
import chalk from "chalk";
import { discoverAuthStorage } from "../sdk";
import type { AccountInfo, OAuthCredential } from "../session/auth-storage";

const PROVIDER_NAMES = new Map<string, string>(getOAuthProviders().map((p: OAuthProviderInfo) => [p.id, p.name]));

function resolveProviderName(provider: string): string {
	return PROVIDER_NAMES.get(provider) ?? provider;
}

function resolveLabel(info: AccountInfo): string {
	if (info.credential.type === "oauth") {
		const oauth = info.credential as OAuthCredential;
		if (oauth.email) return oauth.email;
		if (oauth.accountId) return oauth.accountId;
	}
	if (info.credential.type === "api_key") {
		const key = info.credential.key;
		return `API Key ···${key.slice(-4)}`;
	}
	return `Account ${info.id}`;
}

function isExpired(info: AccountInfo): boolean {
	if (info.credential.type !== "oauth") return false;
	const oauth = info.credential as OAuthCredential;
	return oauth.expires > 0 && oauth.expires < Date.now();
}

function renderBar(fraction: number, width: number): string {
	const clamped = Math.min(Math.max(fraction, 0), 1);
	const filled = Math.round(clamped * width);
	return "█".repeat(filled) + "░".repeat(Math.max(0, width - filled));
}

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

function matchReport(info: AccountInfo, reports: UsageReport[]): UsageReport | undefined {
	const providerReports = reports.filter(r => r.provider === info.provider);
	if (providerReports.length <= 1) return providerReports[0];

	if (info.credential.type !== "oauth") return providerReports[0];
	const oauth = info.credential as OAuthCredential;

	for (const report of providerReports) {
		const meta = report.metadata;
		if (!meta) continue;
		if (oauth.email && meta.email === oauth.email) return report;
		if (oauth.accountId && meta.accountId === oauth.accountId) return report;
	}
	return providerReports[0];
}

function printAccountLine(info: AccountInfo, _index: number, report: UsageReport | undefined): void {
	const label = resolveLabel(info).padEnd(28);
	const expired = isExpired(info);

	if (expired) {
		const bar = chalk.red(renderBar(1, 16));
		process.stdout.write(`    ${chalk.red(label)}[${bar}] ${chalk.red("token expired")}\n`);
		return;
	}

	if (info.blocked) {
		const resetStr = info.blockedUntil ? `resets in ${formatDuration(info.blockedUntil - Date.now())}` : "";
		const bar = chalk.yellow(renderBar(0, 16));
		process.stdout.write(
			`    ${chalk.yellow(label)}[${bar}] ${chalk.yellow(`rate limited${resetStr ? ` · ${resetStr}` : ""}`)}\n`,
		);
		return;
	}

	if (!report || report.limits.length === 0) {
		const bar = chalk.dim(renderBar(0, 16));
		process.stdout.write(`    ${label}[${bar}] ${chalk.dim("no usage data")}\n`);
		return;
	}

	// Show the highest usage limit
	let worstFraction = 0;
	let worstStatus: "ok" | "warning" | "exhausted" = "ok";
	for (const limit of report.limits) {
		const fraction = limit.amount.usedFraction ?? 0;
		if (fraction > worstFraction) worstFraction = fraction;
		if (limit.status === "exhausted") worstStatus = "exhausted";
		else if (limit.status === "warning" && worstStatus !== "exhausted") worstStatus = "warning";
	}

	const pct = Math.round(worstFraction * 100);
	const colorFn = worstStatus === "exhausted" ? chalk.red : worstStatus === "warning" ? chalk.yellow : chalk.green;
	const bar = colorFn(renderBar(worstFraction, 16));
	const pctStr = colorFn(`${pct}%`);

	// Find earliest reset
	const resets = report.limits
		.map(l => l.window?.resetsAt)
		.filter((v): v is number => v !== undefined && v > 0)
		.map(v => v - Date.now());
	const resetStr = resets.length > 0 ? chalk.dim(` resets in ${formatDuration(Math.min(...resets))}`) : "";

	process.stdout.write(`    ${label}[${bar}] ${pctStr}${resetStr}\n`);
}

function printAccountDetail(info: AccountInfo, report: UsageReport | undefined): void {
	const oauth = info.credential.type === "oauth" ? (info.credential as OAuthCredential) : undefined;
	const expired = isExpired(info);

	process.stdout.write(`\n  ${chalk.bold(resolveLabel(info))}\n`);
	process.stdout.write(`  ${"Provider".padEnd(18)}${resolveProviderName(info.provider)}\n`);
	process.stdout.write(`  ${"Type".padEnd(18)}${oauth ? "OAuth" : "API Key"}\n`);

	if (expired) {
		process.stdout.write(`  ${"Status".padEnd(18)}${chalk.red("Expired")}\n`);
	} else if (info.blocked) {
		const resetStr = info.blockedUntil ? ` (resets in ${formatDuration(info.blockedUntil - Date.now())})` : "";
		process.stdout.write(`  ${"Status".padEnd(18)}${chalk.yellow(`Rate Limited${resetStr}`)}\n`);
	} else {
		process.stdout.write(`  ${"Status".padEnd(18)}${chalk.green("Active")}\n`);
	}

	if (oauth) {
		if (oauth.expires && oauth.expires > 0) {
			const remaining = oauth.expires - Date.now();
			const suffix = remaining > 0 ? `(${formatDuration(remaining)} remaining)` : chalk.red("(expired)");
			process.stdout.write(`  ${"Token expires".padEnd(18)}${new Date(oauth.expires).toLocaleString()} ${suffix}\n`);
		}
		if (oauth.email) process.stdout.write(`  ${"Email".padEnd(18)}${oauth.email}\n`);
		if (oauth.accountId) process.stdout.write(`  ${"Account ID".padEnd(18)}${oauth.accountId}\n`);
		if (oauth.projectId) process.stdout.write(`  ${"Project ID".padEnd(18)}${oauth.projectId}\n`);
		if (oauth.enterpriseUrl) process.stdout.write(`  ${"Enterprise URL".padEnd(18)}${oauth.enterpriseUrl}\n`);
	}

	if (report && report.limits.length > 0) {
		process.stdout.write(`\n  ${chalk.bold("Usage Limits")}\n`);
		for (let i = 0; i < report.limits.length; i++) {
			const limit = report.limits[i];
			const isLast = i === report.limits.length - 1;
			const connector = isLast ? "└─" : "├─";
			const continuation = isLast ? "   " : "│  ";
			const fraction = limit.amount.usedFraction ?? 0;
			const pct = Math.round(fraction * 100);
			const colorFn =
				limit.status === "exhausted" ? chalk.red : limit.status === "warning" ? chalk.yellow : chalk.green;

			const windowLabel = limit.window ? ` (${limit.window.label})` : "";
			process.stdout.write(`  ${connector} ${chalk.bold(`${limit.label}${windowLabel}`)}\n`);

			const bar = colorFn(renderBar(fraction, 24));
			const amounts =
				limit.amount.used !== undefined && limit.amount.limit !== undefined
					? `${limit.amount.used}/${limit.amount.limit} ${limit.amount.unit}`
					: `${pct}%`;
			const resetMs = limit.window?.resetsAt ? limit.window.resetsAt - Date.now() : undefined;
			const resetStr = resetMs && resetMs > 0 ? chalk.dim(` resets in ${formatDuration(resetMs)}`) : "";

			process.stdout.write(`  ${continuation}[${bar}] ${colorFn(`${amounts} (${pct}%)`)}${resetStr}\n`);
		}
	}
}

export default class Accounts extends Command {
	static description = "List accounts and show usage stats";

	static flags = {
		detail: Flags.boolean({ description: "Show detailed info per account" }),
		prune: Flags.boolean({ description: "Remove accounts that can't be identified (stale tokens)" }),
	};
	static args = {};

	async run(): Promise<void> {
		const { flags } = await this.parse(Accounts);
		const authStorage = await discoverAuthStorage();
		await authStorage.reload();

		const providers = authStorage.list();
		if (providers.length === 0) {
			process.stdout.write(chalk.dim("No accounts configured. Use `omp` then `/login` to add accounts.\n"));
			return;
		}

		process.stdout.write(chalk.bold("\nAccounts\n\n"));

		// Fetch usage
		let reports: UsageReport[] = [];
		try {
			reports = (await authStorage.fetchUsageReports()) ?? [];
			// Reload after fetch — backfill + dedup may have reduced credential count
			await authStorage.reload();
		} catch {
			process.stdout.write(chalk.dim("  (failed to fetch usage data)\n"));
		}

		let _totalCredentials = 0;
		for (const provider of providers) {
			const infos = authStorage.getAccountInfos(provider);
			if (infos.length === 0) continue;

			_totalCredentials += infos.length;
			const providerName = resolveProviderName(provider);
			const countStr = chalk.dim(`${infos.length} account${infos.length === 1 ? "" : "s"}`);
			process.stdout.write(`  ${chalk.bold(providerName)}  ${countStr}\n`);

			for (let i = 0; i < infos.length; i++) {
				const info = infos[i];
				const report = matchReport(info, reports);
				printAccountLine(info, i, report);
			}
			process.stdout.write("\n");
		}

		// Prune unidentifiable accounts
		if (flags.prune) {
			let pruned = 0;
			for (const provider of providers) {
				const infos = authStorage.getAccountInfos(provider);
				const toRemove: number[] = [];
				for (let i = infos.length - 1; i >= 0; i--) {
					const info = infos[i];
					if (info.credential.type !== "oauth") continue;
					const oauth = info.credential as OAuthCredential;
					if (!oauth.email && !oauth.accountId) {
						toRemove.push(i);
					}
				}
				if (toRemove.length > 0) {
					const allCreds = infos.map(info => info.credential);
					for (const idx of toRemove) {
						allCreds.splice(idx, 1);
						pruned++;
					}
					await authStorage.set(provider, allCreds);
				}
			}
			if (pruned > 0) {
				process.stdout.write(
					chalk.yellow(`  Pruned ${pruned} unidentifiable account${pruned === 1 ? "" : "s"}\n\n`),
				);
			} else {
				process.stdout.write(chalk.dim("  No stale accounts to prune\n\n"));
			}
		}

		// Show detailed view for each
		if (flags.detail) {
			process.stdout.write(chalk.bold("\nAccount Details\n"));
			for (const provider of providers) {
				const infos = authStorage.getAccountInfos(provider);
				for (const info of infos) {
					const report = matchReport(info, reports);
					printAccountDetail(info, report);
				}
			}
		}

		process.stdout.write("\n");
	}
}
