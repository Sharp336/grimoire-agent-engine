// Theme-aware TUI dashboard renderer for /quota.
// Implements full semantic coloring, attention section, collapsible hierarchy, and responsive layout.

import {
	formatDuration,
	formatPercent,
	type MinimalTheme,
	padEndVisible,
	renderRemainingBarStyled,
	visibleWidth,
} from "./format";
import type {
	AttentionItem,
	QuotaAccountGroup,
	QuotaDashboardModel,
	QuotaProviderGroup,
	QuotaWindowRow,
} from "./hierarchy";

export interface DashboardViewState {
	selectedIndex: number;
	collapsedAccounts: Set<string>;
	collapsedPools: Set<string>;
	attentionOnly: boolean;
	hideHealthy: boolean;
	isRefreshing?: boolean;
	refreshError?: string;
}

export type SelectableKind = "account" | "pool";

export interface SelectableTarget {
	index: number;
	kind: SelectableKind;
	id: string; // account.id or pool.id
}

const DEFAULT_WIDTH = 80;
const MIN_LABEL_WIDTH = 12;
const MAX_LABEL_WIDTH = 22;

export function collectSelectables(model: QuotaDashboardModel, viewState: DashboardViewState): SelectableTarget[] {
	const items: SelectableTarget[] = [];
	let currentIndex = 0;

	for (const provider of model.providers) {
		for (const account of provider.accounts) {
			if (viewState.attentionOnly && !account.healthSummary.hasIssues) {
				continue;
			}
			items.push({
				index: currentIndex++,
				kind: "account",
				id: account.id,
			});

			const isAccountCollapsed = viewState.collapsedAccounts.has(account.id);
			if (!isAccountCollapsed && !account.noLimits) {
				for (const pool of account.pools) {
					if (viewState.hideHealthy) {
						const hasVisibleRows = pool.rows.some(r => r.health.status !== "healthy");
						if (!hasVisibleRows) continue;
					}
					if (pool.label !== undefined) {
						items.push({
							index: currentIndex++,
							kind: "pool",
							id: `${account.id}#${pool.id}`,
						});
					}
				}
			}
		}
	}

	return items;
}

function renderHeader(
	model: QuotaDashboardModel,
	viewState: DashboardViewState,
	theme: MinimalTheme,
	width: number,
): string[] {
	const lines: string[] = [];

	const title = theme.bold(theme.fg("accent", "QUOTA"));
	const now = Date.now();
	const ageMs = Math.max(0, now - model.refreshedAt);
	const timeStr = ageMs < 5000 ? "refreshed now" : `refreshed ${formatDuration(ageMs)} ago`;
	const timeFormatted = theme.fg("dim", timeStr);

	const titleLen = visibleWidth("QUOTA");
	const timeLen = visibleWidth(timeStr);
	const spaceBetween = Math.max(2, width - titleLen - timeLen);
	lines.push(`${title}${" ".repeat(spaceBetween)}${timeFormatted}`);

	// Summary counts line
	const { healthyCount, lowCount, criticalCount, exhaustedCount, allHealthy } = model.summary;
	if (allHealthy) {
		lines.push(theme.fg("success", "✓ All reported quotas healthy"));
	} else {
		const parts: string[] = [];
		if (healthyCount > 0) {
			parts.push(theme.fg("success", `✓ ${healthyCount} healthy`));
		}
		if (lowCount > 0) {
			parts.push(theme.fg("warning", `⚠ ${lowCount} low`));
		}
		if (criticalCount > 0) {
			parts.push(theme.fg("error", `! ${criticalCount} critical`));
		}
		if (exhaustedCount > 0) {
			parts.push(theme.fg("error", `✕ ${exhaustedCount} exhausted`));
		}
		lines.push(parts.join("   "));
	}

	if (viewState.isRefreshing) {
		lines.push(theme.fg("accent", "↻ Refreshing quota data…"));
	} else if (viewState.refreshError) {
		lines.push(theme.fg("error", `Refresh failed: ${viewState.refreshError}`));
	}

	if (viewState.attentionOnly) {
		lines.push(theme.fg("warning", theme.bold("[ATTENTION ONLY MODE — press 'a' to show all]")));
	} else if (viewState.hideHealthy) {
		lines.push(theme.fg("muted", "[HIDING HEALTHY — press 'h' to show]"));
	}

	return lines;
}

function renderAttentionSection(items: AttentionItem[], theme: MinimalTheme, width: number): string[] {
	if (items.length === 0) return [];

	const lines: string[] = [""];
	lines.push(theme.bold(theme.fg("error", "ATTENTION")));
	lines.push(theme.fg("dim", "─".repeat(Math.min(width, 50))));
	lines.push("");

	for (const item of items) {
		const symbolStr = theme.fg(item.health.color, item.health.symbol);
		const itemPath = `${item.providerLabel} · ${item.accountLabel}${item.poolLabel ? ` · ${item.poolLabel}` : ""} · ${item.windowLabel}`;
		lines.push(`${symbolStr} ${theme.fg("text", itemPath)}`);

		const pctStr = item.remainingFraction !== undefined ? formatPercent(item.remainingFraction) : "0%";
		const pctStyled = theme.fg(item.health.color, padEndVisible(pctStr, 6));
		const resetStr = item.resetCountdown ? theme.fg("dim", `↻ ${item.resetCountdown}`) : "";

		lines.push(`  ${pctStyled}                                        ${resetStr}`.trimEnd());
		lines.push("");
	}

	return lines;
}

function renderWindowRow(
	row: QuotaWindowRow,
	theme: MinimalTheme,
	indent: string,
	labelColWidth: number,
	isNarrow: boolean,
): string {
	const label = padEndVisible(row.label, labelColWidth);

	if (row.health.status === "neutral") {
		return `${indent}${label}  ${theme.fg("dim", row.usedText ?? "")}`;
	}

	if (row.health.status === "unknown") {
		const bar = renderRemainingBarStyled(undefined, row.health, theme);
		return `${indent}${label}  ${bar}   ?   ${theme.fg("muted", "unknown")}`;
	}

	const bar = renderRemainingBarStyled(row.remainingFraction, row.health, theme);
	const pctStr = row.remainingFraction !== undefined ? formatPercent(row.remainingFraction).padStart(4) : "  0%";
	const symbol = theme.fg(row.health.color, row.health.symbol);
	const resetStr = row.resetCountdown ? `   ${theme.fg("dim", `↻ ${row.resetCountdown}`)}` : "";

	if (isNarrow) {
		// Narrow layout: label on top, bar below
		return `${indent}${row.label}\n${indent}  ${bar}  ${pctStr}  ${symbol}${resetStr}`;
	}

	return `${indent}${label}  ${bar}  ${pctStr}   ${symbol}${resetStr}`;
}

function renderAccountBlock(
	account: QuotaAccountGroup,
	_provider: QuotaProviderGroup,
	viewState: DashboardViewState,
	selectables: SelectableTarget[],
	theme: MinimalTheme,
	width: number,
): string[] {
	const lines: string[] = [];

	const isCollapsed = viewState.collapsedAccounts.has(account.id);
	const target = selectables.find(s => s.kind === "account" && s.id === account.id);
	const isSelected = target !== undefined && target.index === viewState.selectedIndex;

	const cursor = isSelected ? theme.fg("accent", "❯ ") : "  ";
	const disclosure = isCollapsed ? theme.fg("dim", "▸ ") : theme.fg("dim", "▾ ");

	let accountLabel = account.label;
	if (account.isActive) {
		accountLabel = `${theme.fg("accent", "● ")}${theme.bold(account.label)}`;
	} else {
		accountLabel = theme.bold(account.label);
	}

	let rightTag = "";
	if (account.isActive) {
		rightTag = theme.fg("accent", theme.bold("ACTIVE"));
	} else if (account.planBadge) {
		rightTag = theme.fg("muted", account.planBadge);
	}

	if (isCollapsed) {
		const { exhaustedCount, criticalCount, lowCount, summaryText } = account.healthSummary;
		let summaryStyled = theme.fg("success", "all healthy");
		if (exhaustedCount > 0 || criticalCount > 0) {
			summaryStyled = theme.fg("error", summaryText);
		} else if (lowCount > 0) {
			summaryStyled = theme.fg("warning", summaryText);
		} else if (account.noLimits) {
			summaryStyled = theme.fg("dim", "no limits");
		}
		rightTag = rightTag ? `${rightTag}   ${summaryStyled}` : summaryStyled;
	}

	const leftPart = `${cursor}${disclosure}${accountLabel}`;
	const leftW = visibleWidth(leftPart);
	const rightW = visibleWidth(rightTag);
	const gap = Math.max(2, width - leftW - rightW);

	lines.push(`${leftPart}${" ".repeat(gap)}${rightTag}`.trimEnd());

	if (account.cleanOrgName) {
		lines.push(`    ${theme.fg("muted", account.cleanOrgName)}`);
	}

	if (isCollapsed) {
		return lines;
	}

	if (account.noLimits) {
		lines.push(`    ${theme.fg("dim", "no limits reported")}`);
		return lines;
	}

	const isNarrow = width < 60;
	const labelColWidth = isNarrow
		? MIN_LABEL_WIDTH
		: Math.min(MAX_LABEL_WIDTH, Math.max(MIN_LABEL_WIDTH, Math.floor(width * 0.25)));

	for (const pool of account.pools) {
		const visibleRows = viewState.hideHealthy ? pool.rows.filter(r => r.health.status !== "healthy") : pool.rows;
		if (visibleRows.length === 0) continue;

		const poolKey = `${account.id}#${pool.id}`;
		const isPoolCollapsed = viewState.collapsedPools.has(poolKey);
		const poolTarget = selectables.find(s => s.kind === "pool" && s.id === poolKey);
		const isPoolSelected = poolTarget !== undefined && poolTarget.index === viewState.selectedIndex;

		if (pool.label !== undefined) {
			const poolCursor = isPoolSelected ? theme.fg("accent", "❯ ") : "  ";
			const poolDisclosure = isPoolCollapsed ? theme.fg("dim", "▸ ") : theme.fg("dim", "▾ ");
			lines.push(`  ${poolCursor}${poolDisclosure}${theme.fg("text", theme.bold(pool.label))}`);
		}

		if (isPoolCollapsed && pool.label !== undefined) {
			continue;
		}

		const rowIndent = pool.label !== undefined ? "      " : "    ";
		for (const row of visibleRows) {
			lines.push(renderWindowRow(row, theme, rowIndent, labelColWidth, isNarrow));
		}
	}

	if (account.savedResets) {
		const { count, detailLines } = account.savedResets;
		lines.push(
			`    ${theme.fg("accent", "✦")} ${theme.fg("dim", `${count} saved rate-limit reset${count === 1 ? "" : "s"} available`)}`,
		);
		for (const detail of detailLines) {
			lines.push(`        ${theme.fg("dim", detail)}`);
		}
	}

	return lines;
}

function renderProviderSection(
	provider: QuotaProviderGroup,
	viewState: DashboardViewState,
	selectables: SelectableTarget[],
	theme: MinimalTheme,
	width: number,
): string[] {
	const lines: string[] = [];

	let visibleAccounts = provider.accounts;
	if (viewState.attentionOnly) {
		visibleAccounts = provider.accounts.filter(a => a.healthSummary.hasIssues);
		if (visibleAccounts.length === 0) return [];
	}

	const titleLeft = theme.bold(theme.fg("accent", provider.label.toUpperCase()));
	const acctCountStr = `${provider.accounts.length} ${provider.accounts.length === 1 ? "account" : "accounts"}`;
	const acctCountStyled = theme.fg("muted", acctCountStr);

	const leftW = visibleWidth(provider.label.toUpperCase());
	const rightW = visibleWidth(acctCountStr);
	const gap = Math.max(2, width - leftW - rightW);

	lines.push(`${titleLeft}${" ".repeat(gap)}${acctCountStyled}`);
	lines.push(theme.fg("borderMuted", "─".repeat(Math.min(width, 52))));

	for (let i = 0; i < visibleAccounts.length; i++) {
		if (i > 0) lines.push("");
		lines.push(...renderAccountBlock(visibleAccounts[i]!, provider, viewState, selectables, theme, width));
	}

	return lines;
}

function renderFooter(theme: MinimalTheme): string {
	return theme.fg("dim", "↑↓ navigate   enter expand   a attention   h healthy   r refresh   q close");
}

export function renderDashboard(
	model: QuotaDashboardModel,
	viewState: DashboardViewState,
	theme: MinimalTheme,
	width = DEFAULT_WIDTH,
): string[] {
	const safeWidth = Math.max(40, width);
	const selectables = collectSelectables(model, viewState);

	const lines: string[] = [];

	// Header
	lines.push(...renderHeader(model, viewState, theme, safeWidth));

	// Attention Section (only if not empty)
	if (!viewState.attentionOnly) {
		lines.push(...renderAttentionSection(model.attentionItems, theme, safeWidth));
	}

	// Provider Sections
	for (const provider of model.providers) {
		const providerLines = renderProviderSection(provider, viewState, selectables, theme, safeWidth);
		if (providerLines.length > 0) {
			lines.push("");
			lines.push(...providerLines);
		}
	}

	// Footer
	lines.push("");
	lines.push(renderFooter(theme));

	return lines;
}
