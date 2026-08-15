// /quota — OMP Quota Dashboard extension entry point.
//
// Registers `/quota`, an interactive, theme-aware TUI dashboard rendering
// every authenticated provider's quota data:
//
//   Provider
//     Account
//       Quota Pool (Antigravity Google/Anthropic/OpenAI backend counters)
//         Window
//
// Features:
//   - Theme-aware semantic colors (accent, success, warning, error, dim, muted)
//   - 12-cell health-colored remaining quota bars
//   - ATTENTION section for low/critical/exhausted quotas
//   - Keyboard navigation (↑/↓, Enter expand/collapse, a attention, h healthy, r refresh, q/Esc close)
//   - Clean organization names without redundant email prefixes
//   - Non-interactive snapshot mode: `/quota snapshot` (also headless fallback)
//
// Reuses OMP's existing AuthStorage/UsageReport infrastructure. Never modifies core.

import type { ExtensionAPI, ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import { QuotaDashboardComponent } from "./src/dashboard-component";
import {
	buildQuotaDashboardModel,
	type LocalActiveIdentity,
	type LocalUsageReport,
	type QuotaDashboardModel,
} from "./src/hierarchy";
import { renderQuotaSnapshot } from "./src/render-plain";

async function fetchModel(ctx: ExtensionCommandContext): Promise<QuotaDashboardModel | null> {
	const authStorage = ctx.modelRegistry.authStorage;
	const reports = (await authStorage.fetchUsageReports({
		baseUrlResolver: provider => ctx.modelRegistry.getProviderBaseUrl(provider),
	})) as LocalUsageReport[] | null;

	if (!reports || reports.length === 0) return null;

	const activeByProvider = new Map<string, LocalActiveIdentity>();
	const currentProvider = ctx.model?.provider;
	if (currentProvider) {
		const identity = authStorage.getOAuthAccountIdentity(currentProvider, ctx.sessionManager.getSessionId());
		if (identity) activeByProvider.set(currentProvider, identity);
	}

	return buildQuotaDashboardModel(reports, Date.now(), activeByProvider);
}

export default function quotaExtension(pi: ExtensionAPI): void {
	pi.setLabel("Quota");

	pi.registerCommand("quota", {
		description: "Interactive provider quota dashboard (/quota snapshot for text report)",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const isSnapshotMode = args.trim().toLowerCase() === "snapshot";
			const hasInteractiveUi = ctx.hasUI && typeof ctx.ui?.custom === "function";

			let initialModel: QuotaDashboardModel | null = null;
			try {
				initialModel = await fetchModel(ctx);
			} catch (error) {
				ctx.ui.notify(
					`Failed to fetch quota data: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
				return;
			}

			if (!initialModel) {
				ctx.ui.notify("No quota data available.", "warning");
				return;
			}

			if (isSnapshotMode || !hasInteractiveUi) {
				ctx.ui.notify(renderQuotaSnapshot(initialModel), "info");
				return;
			}

			// Interactive TUI Dashboard via ctx.ui.custom
			await ctx.ui.custom((tui, theme, _keybindings, done) => {
				return new QuotaDashboardComponent({
					model: initialModel!,
					theme,
					requestRender: () => tui.requestRender(),
					onRefresh: async () => {
						return await fetchModel(ctx);
					},
					onClose: () => {
						done(undefined);
					},
				});
			});
		},
	});
}
