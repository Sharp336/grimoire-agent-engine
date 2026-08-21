/**
 * Stats CLI command handlers.
 *
 * Handles `omp stats` subcommand for viewing AI usage statistics.
 */

import { truncateToWidth } from "@oh-my-pi/pi-tui/utils";
import { formatDuration, formatNumber, formatPercent } from "@oh-my-pi/pi-utils";
import chalk from "@oh-my-pi/pi-utils/chalk";
import { Settings } from "../config/settings";
import { i18n } from "../i18n";
import { getExchangeRate, shouldConvertCurrency } from "../i18n/exchange-rate";
import { openPath } from "../utils/open";

/**
 * Single-line TTY progress bar. On a non-TTY stream we just stay quiet -
 * the final "Synced ..." summary still prints either way.
 */
function createSyncProgressReporter(): {
	onProgress: (event: { current: number; total: number; sessionFile: string }) => void;
	finish: () => void;
} {
	const stream = process.stderr;
	const isTty = stream.isTTY === true;
	let lastWidth = 0;
	let lastRender = 0;
	return {
		onProgress(event) {
			if (!isTty) return;
			const now = Date.now();
			// Throttle to ~30 fps and always force a render for the last file.
			if (event.current < event.total && now - lastRender < 33) return;
			lastRender = now;
			const label = chalk.dim(shortenSessionFile(event.sessionFile));
			const pct = ((event.current / event.total) * 100).toFixed(0).padStart(3, " ");
			const counter = chalk.cyan(`[${event.current}/${event.total}]`);
			const line = `${counter} ${pct}%  ${label}`;
			const columns = stream.columns ?? 120;
			const trimmed = truncateToWidth(line, columns - 1);
			stream.write(`\r${trimmed.padEnd(lastWidth)}`);
			lastWidth = trimmed.length;
		},
		finish() {
			if (!isTty || lastWidth === 0) return;
			stream.write(`\r${" ".repeat(lastWidth)}\r`);
			lastWidth = 0;
		},
	};
}

function shortenSessionFile(p: string): string {
	const marker = "/sessions/";
	const idx = p.indexOf(marker);
	return idx >= 0 ? p.slice(idx + marker.length) : p;
}

// =============================================================================
// Types
// =============================================================================

export interface StatsCommandArgs {
	port: number;
	host: string;
	json: boolean;
	summary: boolean;
}

function normalizePremiumRequests(n: number): number {
	return Math.round((n + Number.EPSILON) * 100) / 100;
}

// =============================================================================
// Command Handler
// =============================================================================

export async function runStatsCommand(cmd: StatsCommandArgs): Promise<void> {
	// Lazy import to avoid loading stats module when not needed
	const { closeDb, formatStatsDashboardUrl, getDashboardStats, getTotalMessageCount, startServer, syncAllSessions } =
		await import("@oh-my-pi/omp-stats");

	// Sync session files first
	const progress = createSyncProgressReporter();
	process.stderr.write("Syncing session files...\n");
	const { processed, files } = await syncAllSessions({ onProgress: progress.onProgress });
	progress.finish();
	const total = await getTotalMessageCount();
	console.log(`Synced ${processed} new entries from ${files} files (${total} total)\n`);

	if (cmd.json) {
		const stats = await getDashboardStats();
		console.log(JSON.stringify(stats, null, 2));
		return;
	}
	if (cmd.summary) {
		await Settings.init();
		await printStatsSummary();
		return;
	}

	// Start the dashboard server
	const { hostname, port } = await startServer(cmd.port, cmd.host);
	const url = formatStatsDashboardUrl(hostname, port);
	console.log(chalk.green(`Dashboard available at: ${url}`));

	// Open browser
	openPath(url);

	console.log("Press Ctrl+C to stop\n");

	// Keep process running
	process.on("SIGINT", () => {
		console.log("\nShutting down...");
		closeDb();
		process.exit(0);
	});

	// Keep the process alive
	await new Promise(() => {});
}

async function printStatsSummary(): Promise<void> {
	const { getDashboardStats } = await import("@oh-my-pi/omp-stats");
	const stats = await getDashboardStats();
	const { overall, byModel, byFolder } = stats;

	// 中文 locale 下显示 CNY 换算
	const convert = shouldConvertCurrency();
	let rate = 0;
	if (convert) {
		rate = await getExchangeRate();
	}
	function formatLocalCost(n: number): string {
		const usd = formatUSDCost(n);
		if (!convert || !rate) return usd;
		return `${usd} (≈¥${(n * rate).toFixed(2)})`;
	}

	console.log(chalk.bold(`\n${i18n.t("cli.stats.title", "=== AI Usage Statistics ===")}\n`));
	console.log(chalk.bold(i18n.t("cli.stats.overall", "Overall:")));
	console.log(
		`  ${i18n.t("cli.stats.requests", "Requests:")} ${formatNumber(overall.totalRequests)} ${i18n.t("cli.stats.errorsSuffix", "({count} errors)", { count: formatNumber(overall.failedRequests) })}`,
	);
	console.log(`  ${i18n.t("cli.stats.errorRate", "Error Rate:")} ${formatPercent(overall.errorRate)}`);
	console.log(
		`  ${i18n.t("cli.stats.totalTokens", "Total Tokens:")} ${formatNumber(overall.totalInputTokens + overall.totalOutputTokens)}`,
	);
	console.log(`  ${i18n.t("cli.stats.inputTokens", "Input Tokens:")} ${formatNumber(overall.totalInputTokens)}`);
	console.log(`  ${i18n.t("cli.stats.outputTokens", "Output Tokens:")} ${formatNumber(overall.totalOutputTokens)}`);
	console.log(`  ${i18n.t("cli.stats.cacheRate", "Cache Rate:")} ${formatPercent(overall.cacheRate)}`);
	console.log(`  ${i18n.t("cli.stats.cacheSavings", "Cache Savings:")} ${formatPercent(overall.cacheSavings)}`);
	console.log(`  ${i18n.t("cli.stats.totalCost", "Total Cost:")} ${formatLocalCost(overall.totalCost)}`);
	console.log(
		`  ${i18n.t("cli.stats.premiumRequests", "Premium Requests:")} ${formatNumber(normalizePremiumRequests(overall.totalPremiumRequests ?? 0))}`,
	);
	console.log(
		`  ${i18n.t("cli.stats.avgDuration", "Avg Duration:")} ${overall.avgDuration !== null ? formatDuration(overall.avgDuration) : "-"}`,
	);
	console.log(
		`  ${i18n.t("cli.stats.avgTtft", "Avg TTFT:")} ${overall.avgTtft !== null ? formatDuration(overall.avgTtft) : "-"}`,
	);
	if (overall.avgTokensPerSecond !== null) {
		console.log(
			`  ${i18n.t("cli.stats.avgTokensPerSecond", "Avg Tokens/s:")} ${overall.avgTokensPerSecond.toFixed(1)}`,
		);
	}

	if (byModel.length > 0) {
		console.log(chalk.bold(`\n${i18n.t("cli.stats.byModel", "By Model:")}`));
		for (const m of byModel.slice(0, 10)) {
			console.log(
				`  ${m.model}: ${i18n.t(
					"cli.stats.reqsCacheSuffix",
					"{count} reqs, {cost}, {pct} cache rate, {savings} cache savings",
					{
						count: formatNumber(m.totalRequests),
						cost: formatLocalCost(m.totalCost),
						pct: formatPercent(m.cacheRate),
						savings: formatPercent(m.cacheSavings),
					},
				)}`,
			);
		}
	}

	if (byFolder.length > 0) {
		console.log(chalk.bold(`\n${i18n.t("cli.stats.byFolder", "By Folder:")}`));
		for (const f of byFolder.slice(0, 10)) {
			console.log(
				`  ${f.folder}: ${i18n.t("cli.stats.reqsSuffix", "{count} reqs, {cost}", {
					count: formatNumber(f.totalRequests),
					cost: formatLocalCost(f.totalCost),
				})}`,
			);
		}
	}

	console.log("");
}
function formatUSDCost(n: number): string {
	if (n < 0.01) return `$${n.toFixed(4)}`;
	if (n < 1) return `$${n.toFixed(3)}`;
	return `$${n.toFixed(2)}`;
}
