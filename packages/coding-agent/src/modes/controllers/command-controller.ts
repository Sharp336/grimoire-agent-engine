import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { CompactionCancelledError, type CompactionOutcome } from "@oh-my-pi/pi-agent-core/compaction";
import {
	getEnvApiKey,
	getProviderDetails,
	type ProviderDetails,
	resolveUsedFraction,
	type UsageLimit,
	type UsageReport,
} from "@oh-my-pi/pi-ai";
import { Loader, Markdown, padding, Spacer, Text, visibleWidth } from "@oh-my-pi/pi-tui";
import { formatDuration, logger, Snowflake, sanitizeText } from "@oh-my-pi/pi-utils";
import { shouldEnableAppendOnlyContext } from "../../config/append-only-context-mode";
import { type BashResult, isPersistentShellCdCommand } from "../../exec/bash-executor";
import { type LoadedCustomShare, loadCustomShare } from "../../export/custom-share";
import { parseExportArgs } from "../../export/html/args";
import { shareSession } from "../../export/share";
import type { CompactOptions } from "../../extensibility/extensions/types";
import {
	diffMentalModelContent,
	type HindsightApi,
	type HindsightSessionState,
	loadHindsightConfig,
	reloadMentalModelsForSession,
	resolveSeedsForScope,
	seedAlreadyExists,
	summarizeMentalModel,
} from "../../hindsight";
import { memoryStatsUnavailableMessage, resolveMemoryBackend } from "../../memory-backend";
import { BashExecutionComponent } from "../../modes/components/bash-execution";
import { BorderedLoader } from "../../modes/components/bordered-loader";
import { DynamicBorder } from "../../modes/components/dynamic-border";
import { EvalExecutionComponent } from "../../modes/components/eval-execution";
import { MoveOverlay, type MoveOverlayResult } from "../../modes/components/move-overlay";
import { TranscriptBlock } from "../../modes/components/transcript-container";
import { getMarkdownTheme, getSymbolTheme, theme } from "../../modes/theme/theme";
import type { InteractiveModeContext } from "../../modes/types";
import { computeContextBreakdown, renderContextUsage } from "../../modes/utils/context-usage";
import { buildHotkeysMarkdown } from "../../modes/utils/hotkeys-markdown";
import { buildToolsMarkdown } from "../../modes/utils/tools-markdown";
import type { AsyncJobSnapshotItem } from "../../session/agent-session";
import type { AuthStorage, OAuthAccountIdentity } from "../../session/auth-storage";
import type { CompactMode } from "../../session/compact-modes";
import type { NewSessionOptions } from "../../session/session-entries";
import { formatShakeSummary, type ShakeMode, type ShakeResult } from "../../session/shake-types";
import { formatActiveAccountLabel, limitMatchesActiveAccount } from "../../slash-commands/helpers/active-oauth-account";
import { outputMeta } from "../../tools/output-meta";
import { resolveToCwd, stripOuterDoubleQuotes } from "../../tools/path-utils";
import { replaceTabs, truncateToWidth } from "../../tools/render-utils";
import {
	getChangelogPath,
	parseChangelog,
	RECENT_CHANGELOG_ENTRY_LIMIT,
	renderChangelogEntries,
} from "../../utils/changelog";
import { copyToClipboard } from "../../utils/clipboard";
import { openPath } from "../../utils/open";
import { setSessionTerminalTitle } from "../../utils/title-generator";

function showMarkdownPanel(ctx: InteractiveModeContext, title: string, markdown: string): void {
	const block = new TranscriptBlock();
	block.addChild(new DynamicBorder());
	block.addChild(new Text(theme.bold(theme.fg("accent", title)), 1, 0));
	block.addChild(new Spacer(1));
	block.addChild(new Markdown(markdown.trim(), 1, 1, getMarkdownTheme()));
	block.addChild(new DynamicBorder());
	ctx.presentCommandOutput(block);
}

export class CommandController {
	constructor(private readonly ctx: InteractiveModeContext) {}

	openInBrowser(urlOrPath: string): void {
		openPath(urlOrPath);
	}

	async handleExportCommand(text: string): Promise<void> {
		try {
			const { outputPath, useUserThemes } = parseExportArgs(text.slice("/export".length));
			if (outputPath === "--copy" || outputPath === "clipboard" || outputPath === "copy") {
				this.ctx.showWarning("Use /dump to copy the session to clipboard.");
				return;
			}

			const filePath = await this.ctx.session.exportToHtml(outputPath, useUserThemes);
			this.ctx.showStatus(`Session exported to: ${filePath}`);
			this.openInBrowser(filePath);
		} catch (error: unknown) {
			this.ctx.showError(`Failed to export session: ${error instanceof Error ? error.message : "Unknown error"}`);
		}
	}

	async handleDumpCommand(): Promise<void> {
		try {
			const formatted = this.ctx.session.formatSessionAsText();
			if (!formatted) {
				this.ctx.showError("No messages to dump yet.");
				return;
			}
			// Build the LLM request JSON sidecar first so its path (and a
			// raw-context warning) can be appended to the copied transcript.
			let sidecarPath: string | undefined;
			let sidecarError: string | undefined;
			try {
				sidecarPath = await this.ctx.session.dumpLlmRequestToTmpDir();
			} catch (error: unknown) {
				sidecarError = error instanceof Error ? error.message : "Unknown error";
			}
			const doc = sidecarPath
				? `${formatted}\n\n---\nLLM request JSON: ${sidecarPath}\nThis file persists on disk and may contain raw context/secrets — treat accordingly.`
				: formatted;
			await copyToClipboard(doc);
			const statusParts = ["Session copied to clipboard"];
			if (sidecarPath) statusParts.push(`LLM request JSON: ${sidecarPath}`);
			if (sidecarError) statusParts.push(`LLM request JSON unavailable: ${sidecarError}`);
			this.ctx.showStatus(statusParts.join("\n"));
		} catch (error: unknown) {
			this.ctx.showError(`Failed to copy session: ${error instanceof Error ? error.message : "Unknown error"}`);
		}
	}

	handleAdvisorDumpCommand(isRaw = false) {
		try {
			const advisorHistory = this.ctx.session.formatAdvisorHistoryAsText({ compact: !isRaw });
			if (advisorHistory === null) {
				this.ctx.showError("Advisor is not active for this session.");
				return;
			}
			if (!advisorHistory) {
				this.ctx.showError("Advisor has no history yet.");
				return;
			}
			copyToClipboard(advisorHistory);
			this.ctx.showStatus("Advisor history copied to clipboard");
		} catch (error: unknown) {
			this.ctx.showError(
				`Failed to copy advisor history: ${error instanceof Error ? error.message : "Unknown error"}`,
			);
		}
	}

	async handleDebugTranscriptCommand(): Promise<void> {
		try {
			const width = Math.max(1, this.ctx.ui.terminal.columns);
			const renderedLines = this.ctx.chatContainer.render(width).map(line => replaceTabs(Bun.stripANSI(line)));
			const rendered = renderedLines.join("\n").trimEnd();
			if (!rendered) {
				this.ctx.showError("No messages to dump yet.");
				return;
			}
			const tmpPath = path.join(os.tmpdir(), `${Snowflake.next()}-tmp.txt`);
			await Bun.write(tmpPath, `${rendered}\n`);
			this.ctx.showStatus(`Debug transcript written to:\n${tmpPath}`);
		} catch (error: unknown) {
			this.ctx.showError(
				`Failed to write debug transcript: ${error instanceof Error ? error.message : "Unknown error"}`,
			);
		}
	}

	async handleShareCommand(): Promise<void> {
		let customShare: LoadedCustomShare | null;
		try {
			customShare = await loadCustomShare();
		} catch (err) {
			this.ctx.showError(err instanceof Error ? err.message : String(err));
			return;
		}

		const loader = new BorderedLoader(this.ctx.ui, theme, "Sharing session...");
		this.ctx.editorContainer.clear();
		this.ctx.editorContainer.addChild(loader);
		this.ctx.ui.setFocus(loader);
		this.ctx.ui.requestRender();

		const restoreEditor = () => {
			loader.dispose();
			this.ctx.editorContainer.clear();
			this.ctx.editorContainer.addChild(this.ctx.editor);
			this.ctx.ui.setFocus(this.ctx.editor);
		};
		loader.onAbort = () => {
			restoreEditor();
			this.ctx.showStatus("Share cancelled");
		};

		// Custom share scripts keep their legacy contract: they receive a path
		// to a standalone HTML export. No fallback to the default flow on error.
		if (customShare) {
			const tmpFile = path.join(os.tmpdir(), `${Snowflake.next()}.html`);
			try {
				await this.ctx.session.exportToHtml(tmpFile);
				const result = await customShare.fn(tmpFile);
				if (loader.signal.aborted) return;
				restoreEditor();

				if (typeof result === "string") {
					this.ctx.showStatus(`Share URL: ${result}`);
					this.openInBrowser(result);
				} else if (result) {
					const parts: string[] = [];
					if (result.url) parts.push(`Share URL: ${result.url}`);
					if (result.message) parts.push(result.message);
					if (parts.length > 0) this.ctx.showStatus(parts.join("\n"));
					if (result.url) this.openInBrowser(result.url);
				} else {
					this.ctx.showStatus("Session shared");
				}
			} catch (err) {
				if (!loader.signal.aborted) {
					restoreEditor();
					this.ctx.showError(`Custom share failed: ${err instanceof Error ? err.message : String(err)}`);
				}
			} finally {
				await fs.rm(tmpFile, { force: true }).catch(() => {});
			}
			return;
		}

		// Default: encrypted snapshot to a secret gist (preferred) or the share
		// server; the key rides in the link fragment and never leaves the client.
		try {
			const result = await shareSession(this.ctx.session.sessionManager, {
				serverUrl: this.ctx.settings.get("share.serverUrl"),
				store: this.ctx.settings.get("share.store"),
				state: this.ctx.session.state,
				obfuscator: this.ctx.settings.get("share.redactSecrets") ? this.ctx.session.obfuscator : undefined,
			});
			if (loader.signal.aborted) return;
			restoreEditor();

			const lines = [`Share URL: ${result.url}`];
			if (result.gistUrl) lines.push(`Gist: ${result.gistUrl}`);
			if (result.truncated) lines.push("Note: large content was trimmed to fit the share size limit.");
			this.ctx.showStatus(lines.join("\n"));
			this.openInBrowser(result.url);
		} catch (error: unknown) {
			if (!loader.signal.aborted) {
				restoreEditor();
				this.ctx.showError(`Failed to share session: ${error instanceof Error ? error.message : "Unknown error"}`);
			}
		}
	}

	async handleSessionCommand(): Promise<void> {
		const stats = this.ctx.session.getSessionStats();
		const premiumRequests =
			"premiumRequests" in stats && typeof stats.premiumRequests === "number"
				? stats.premiumRequests
				: this.ctx.session.sessionManager.getUsageStatistics().premiumRequests;
		const normalizedPremiumRequests = Math.round((premiumRequests + Number.EPSILON) * 100) / 100;

		let info = `${theme.bold("Session Info")}\n\n`;
		info += `${theme.fg("dim", "File:")} ${stats.sessionFile ?? "In-memory"}\n`;
		info += `${theme.fg("dim", "ID:")} ${stats.sessionId}\n\n`;
		info += `\n${theme.bold("Provider")}\n`;
		const model = this.ctx.session.model;
		if (!model) {
			info += `${theme.fg("dim", "No model selected")}\n`;
		} else {
			const authMode = resolveProviderAuthMode(this.ctx.session.modelRegistry.authStorage, model.provider);
			const openaiWebsocketSetting = this.ctx.settings.get("providers.openaiWebsockets") ?? "auto";
			const preferOpenAICodexWebsockets =
				openaiWebsocketSetting === "on" ? true : openaiWebsocketSetting === "off" ? false : undefined;
			const credentialSource = this.ctx.session.modelRegistry.authStorage.describeCredentialSource(
				model.provider,
				stats.sessionId,
			);
			const providerDetails = getProviderDetails({
				model,
				sessionId: stats.sessionId,
				authMode,
				credentialSource,
				preferWebsockets: preferOpenAICodexWebsockets,
				providerSessionState: this.ctx.session.providerSessionState,
			});
			info += renderProviderSection(providerDetails, theme);
		}
		info += `\n`;
		info += `${theme.bold("Messages")}\n`;
		info += `${theme.fg("dim", "User:")} ${stats.userMessages}\n`;
		info += `${theme.fg("dim", "Assistant:")} ${stats.assistantMessages}\n`;
		info += `${theme.fg("dim", "Tool Calls:")} ${stats.toolCalls}\n`;
		info += `${theme.fg("dim", "Tool Results:")} ${stats.toolResults}\n`;
		info += `${theme.fg("dim", "Total:")} ${stats.totalMessages}\n\n`;
		// Append-only context
		{
			const setting = this.ctx.settings.get("provider.appendOnlyContext") ?? "auto";
			const model = this.ctx.session.model;
			const mode = shouldEnableAppendOnlyContext(setting, model);
			const activeLabel = mode ? theme.fg("success", "active") : theme.fg("dim", "inactive");
			const settingLabel = setting === "auto" ? `${setting} (${model?.provider ?? "?"})` : setting;
			info += `${theme.fg("dim", "Append-Only:")} ${activeLabel} (setting: ${settingLabel})\n`;
		}
		info += `${theme.bold("Tokens")}\n`;
		info += `${theme.fg("dim", "Input:")} ${stats.tokens.input.toLocaleString()}\n`;
		info += `${theme.fg("dim", "Output:")} ${stats.tokens.output.toLocaleString()}\n`;
		if (stats.tokens.cacheRead > 0) {
			info += `${theme.fg("dim", "Cache Read:")} ${stats.tokens.cacheRead.toLocaleString()}\n`;
		}
		if (stats.tokens.cacheWrite > 0) {
			info += `${theme.fg("dim", "Cache Write:")} ${stats.tokens.cacheWrite.toLocaleString()}\n`;
		}
		info += `${theme.fg("dim", "Total:")} ${stats.tokens.total.toLocaleString()}\n`;

		if (stats.cost > 0 || normalizedPremiumRequests > 0) {
			info += `\n${theme.bold("Cost")}\n`;
			if (stats.cost > 0) {
				info += `${theme.fg("dim", "Total:")} ${stats.cost.toFixed(4)}\n`;
			}
			if (normalizedPremiumRequests > 0) {
				info += `${theme.fg("dim", "Premium Requests:")} ${normalizedPremiumRequests.toLocaleString()}\n`;
			}
		}

		if (this.ctx.lspServers && this.ctx.lspServers.length > 0) {
			info += `\n${theme.bold("LSP Servers")}\n`;
			for (const server of this.ctx.lspServers) {
				const statusColor =
					server.status === "ready"
						? "success"
						: server.status === "available"
							? "dim"
							: server.status === "connecting"
								? "warning"
								: "error";
				const statusText =
					server.status === "error" && server.error ? `${server.status}: ${server.error}` : server.status;
				info += `${theme.fg("dim", `${server.name}:`)} ${theme.fg(statusColor, statusText)} ${theme.fg("dim", `(${server.fileTypes.join(", ")})`)}\n`;
			}
		}

		if (this.ctx.mcpManager) {
			const mcpServers = this.ctx.mcpManager.getConnectedServers();
			info += `\n${theme.bold("MCP Servers")}\n`;
			if (mcpServers.length === 0) {
				info += `${theme.fg("dim", "None connected")}\n`;
			} else {
				for (const name of mcpServers) {
					const conn = this.ctx.mcpManager.getConnection(name);
					const toolCount = conn?.tools?.length ?? 0;
					info += `${theme.fg("dim", `${name}:`)} ${theme.fg("success", "connected")} ${theme.fg("dim", `(${toolCount} tools)`)}\n`;
				}
			}
		}

		this.ctx.presentCommandOutput([new Spacer(1), new Text(info, 1, 0)]);
	}

	static readonly #advisorStatusGlyph: Record<string, string> = {
		running: "●",
		paused: "○",
		no_model: "○",
		quota_exhausted: "✕",
		error: "✕",
	};

	static readonly #advisorStatusLabel: Record<string, string> = {
		running: "running",
		paused: "off",
		no_model: "no model",
		quota_exhausted: "quota exhausted",
		error: "error",
	};

	async handleAdvisorStatusCommand(): Promise<void> {
		const stats = this.ctx.session.getAdvisorStats();
		if (!stats.configured) {
			this.ctx.presentCommandOutput([new Spacer(1), new Text("Advisor is disabled.", 1, 0)]);
			return;
		}
		// Fetch live quota data (cached 5 min by the auth-gateway) so we can show
		// real usage windows/reset timers per advisor provider. Non-fatal when absent.
		const usageProvider = this.ctx.session as { fetchUsageReports?: () => Promise<UsageReport[] | null> };
		let usageReports: UsageReport[] | null = null;
		if (usageProvider.fetchUsageReports) {
			try {
				usageReports = await usageProvider.fetchUsageReports();
			} catch {
				// Network/auth failure is non-fatal — just skip the quota line.
			}
		}
		// Resolve the active OAuth identity for each advisor's provider so quota
		// filtering matches the credential actually in use (not sibling accounts).
		const resolveActiveAdvisorAccount = (provider: string, sessionId?: string): OAuthAccountIdentity | undefined =>
			this.ctx.session.modelRegistry.authStorage.getOAuthAccountIdentity(
				provider,
				sessionId ?? this.ctx.session.sessionId,
			);
		const nowMs = Date.now();
		// Roster view: show every configured advisor with its status, even when
		// none are live (all paused/no-model). The old code returned a generic
		// message that hid the per-advisor state the user needs to act on.
		if (stats.advisors.length > 1 || (stats.configured && !stats.active)) {
			let info = `${theme.bold("Advisor Status")} (${stats.advisors.length} advisors)\n`;
			for (const a of stats.advisors) {
				const glyph = CommandController.#advisorStatusGlyph[a.status] ?? "?";
				const label = CommandController.#advisorStatusLabel[a.status] ?? a.status;
				const color =
					a.status === "running"
						? "success"
						: a.status === "quota_exhausted" || a.status === "error"
							? "error"
							: "dim";
				info += `\n${theme.fg(color, glyph)} ${theme.bold(a.name)} ${theme.fg("dim", `[${label}]`)}\n`;
				if (a.model) {
					info += `${theme.fg("dim", "Model:")} ${a.model.provider}/${a.model.id}\n`;
				}
				if (a.model && usageReports) {
					const quota = formatCompactQuota(
						a.model.provider,
						usageReports,
						nowMs,
						resolveActiveAdvisorAccount(a.model.provider, a.sessionId),
					);
					if (quota) info += `${theme.fg("dim", quota)}\n`;
				}
				if (a.status === "running" || a.status === "quota_exhausted") {
					const ctx =
						a.contextWindow > 0
							? `${a.contextTokens.toLocaleString()} / ${a.contextWindow.toLocaleString()} (${Math.round((a.contextTokens / a.contextWindow) * 100)}%)`
							: `${a.contextTokens.toLocaleString()}`;
					info += `${theme.fg("dim", "Context:")} ${ctx}\n`;
					info += `${theme.fg("dim", "Messages:")} ${a.messages.total.toLocaleString()}\n`;
					info += `${theme.fg("dim", "Spend:")} ${a.tokens.input.toLocaleString()} in / ${a.tokens.output.toLocaleString()} out`;
					if (a.cost > 0) info += `, $${a.cost.toFixed(4)}`;
					info += "\n";
				}
			}
			if (stats.active) {
				info += `\n${theme.bold("Totals")}\n`;
				info += `${theme.fg("dim", "Tokens:")} ${stats.tokens.total.toLocaleString()}\n`;
				if (stats.cost > 0) info += `${theme.fg("dim", "Cost:")} $${stats.cost.toFixed(4)}\n`;
			}
			this.ctx.presentCommandOutput([new Spacer(1), new Text(info, 1, 0)]);
			return;
		}
		// Single active advisor — detailed view.
		const model = stats.model;
		let info = `${theme.bold("Advisor Status")}\n\n`;
		if (stats.advisors.length === 1) {
			const a = stats.advisors[0];
			const glyph = CommandController.#advisorStatusGlyph[a.status] ?? "?";
			const label = CommandController.#advisorStatusLabel[a.status] ?? a.status;
			info += `${theme.fg(a.status === "running" ? "success" : "error", glyph)} ${a.name} ${theme.fg("dim", `[${label}]`)}\n\n`;
		}
		if (model) {
			info += `${theme.bold("Provider")}\n`;
			info += `${theme.fg("dim", "Model:")} ${model.provider}/${model.id}\n`;
		}
		if (model && usageReports) {
			const quota = formatCompactQuota(
				model.provider,
				usageReports,
				nowMs,
				resolveActiveAdvisorAccount(model.provider, stats.advisors[0]?.sessionId),
			);
			if (quota) {
				info += `\n${theme.bold("Quota")}\n`;
				info += `${theme.fg("dim", quota)}\n`;
			}
		}
		info += `\n${theme.bold("Messages")}\n`;
		info += `${theme.fg("dim", "User:")} ${stats.messages.user.toLocaleString()}\n`;
		info += `${theme.fg("dim", "Assistant:")} ${stats.messages.assistant.toLocaleString()}\n`;
		info += `${theme.fg("dim", "Total:")} ${stats.messages.total.toLocaleString()}\n`;
		info += `\n${theme.bold("Context")}\n`;
		if (stats.contextWindow > 0) {
			const percent = Math.round((stats.contextTokens / stats.contextWindow) * 100);
			info += `${theme.fg("dim", "Tokens:")} ${stats.contextTokens.toLocaleString()} / ${stats.contextWindow.toLocaleString()} (${percent}%)\n`;
		} else {
			info += `${theme.fg("dim", "Tokens:")} ${stats.contextTokens.toLocaleString()}\n`;
		}
		info += `\n${theme.bold("Spend")}\n`;
		info += `${theme.fg("dim", "Input:")} ${stats.tokens.input.toLocaleString()}\n`;
		info += `${theme.fg("dim", "Output:")} ${stats.tokens.output.toLocaleString()}\n`;
		if (stats.tokens.cacheRead > 0) {
			info += `${theme.fg("dim", "Cache Read:")} ${stats.tokens.cacheRead.toLocaleString()}\n`;
		}
		if (stats.cost > 0) info += `${theme.fg("dim", "Cost:")} $${stats.cost.toFixed(4)}\n`;
		this.ctx.presentCommandOutput([new Spacer(1), new Text(info, 1, 0)]);
	}

	async handleJobsCommand(): Promise<void> {
		const snapshot = this.ctx.session.getAsyncJobSnapshot({ recentLimit: 5 });
		if (!snapshot) {
			this.ctx.showWarning("Async background jobs are unavailable in this session.");
			return;
		}

		const now = Date.now();
		const lineWidth = Math.max(24, (this.ctx.ui.terminal.columns ?? 100) - 24);
		let info = `${theme.bold("Background Jobs")}\n\n`;
		info += `${theme.fg("dim", "Running:")} ${snapshot.running.length}\n`;

		if (snapshot.running.length === 0 && snapshot.recent.length === 0) {
			info += `\n${theme.fg("dim", "No async jobs yet.")}\n`;
			this.ctx.presentCommandOutput([new Spacer(1), new Text(info, 1, 0)]);
			return;
		}

		if (snapshot.running.length > 0) {
			info += `\n${theme.bold("Running Jobs")}\n`;
			for (const job of snapshot.running) {
				info += `${renderJobLine(job, now)}\n`;
				info += `  ${theme.fg("dim", truncateJobLabel(job.label, lineWidth))}\n`;
			}
		}

		if (snapshot.recent.length > 0) {
			info += `\n${theme.bold("Recent Jobs")}\n`;
			for (const job of snapshot.recent) {
				info += `${renderJobLine(job, now)}\n`;
				info += `  ${theme.fg("dim", truncateJobLabel(job.label, lineWidth))}\n`;
			}
		}

		this.ctx.presentCommandOutput([new Spacer(1), new Text(info.trimEnd(), 1, 0)]);
	}

	async handleUsageCommand(reports?: UsageReport[] | null): Promise<void> {
		let usageReports = reports ?? null;
		if (!usageReports) {
			const provider = this.ctx.session as { fetchUsageReports?: () => Promise<UsageReport[] | null> };
			if (!provider.fetchUsageReports) {
				this.ctx.showWarning("Usage reporting is not configured for this session.");
				return;
			}
			try {
				usageReports = await provider.fetchUsageReports();
			} catch (error) {
				this.ctx.showError(`Failed to fetch usage data: ${error instanceof Error ? error.message : String(error)}`);
				return;
			}
		}

		if (!usageReports || usageReports.length === 0) {
			this.ctx.showWarning("No usage data available.");
			return;
		}

		const availableWidth = Math.max(40, (this.ctx.ui.terminal.columns ?? 100) - 2);
		const currentProvider = this.ctx.session.model?.provider;
		const activeAccount = currentProvider
			? this.ctx.session.modelRegistry.authStorage.getOAuthAccountIdentity(
					currentProvider,
					this.ctx.session.sessionId,
				)
			: undefined;
		const usageModelSelectors = this.ctx.session.getUsageReportingModelSelectors(usageReports);
		const output = renderUsageReports(
			usageReports,
			theme,
			Date.now(),
			availableWidth,
			provider => (provider === currentProvider ? activeAccount : undefined),
			usageModelSelectors,
		);
		this.ctx.presentCommandOutput([new Spacer(1), new Text(output, 1, 0)]);
	}

	/** `/usage models`: the full model roster the default `/usage` view summarizes. */
	async handleUsageModelsCommand(): Promise<void> {
		const provider = this.ctx.session as { fetchUsageReports?: () => Promise<UsageReport[] | null> };
		if (!provider.fetchUsageReports) {
			this.ctx.showWarning("Usage reporting is not configured for this session.");
			return;
		}
		let usageReports: UsageReport[] | null = null;
		try {
			usageReports = await provider.fetchUsageReports();
		} catch (error) {
			this.ctx.showError(`Failed to fetch usage data: ${error instanceof Error ? error.message : String(error)}`);
			return;
		}
		const availableWidth = Math.max(40, (this.ctx.ui.terminal.columns ?? 100) - 2);
		const selectors = this.ctx.session.getUsageReportingModelSelectors(usageReports ?? []);
		this.ctx.presentCommandOutput([
			new Spacer(1),
			new Text(renderUsageModelRoster(theme, selectors, availableWidth), 1, 0),
		]);
	}

	async handleChangelogCommand(showFull = false): Promise<void> {
		const changelogPath = getChangelogPath();
		const allEntries = await parseChangelog(changelogPath);
		const entriesToShow = showFull ? allEntries : allEntries.slice(0, RECENT_CHANGELOG_ENTRY_LIMIT);
		const changelogMarkdown =
			entriesToShow.length > 0 ? renderChangelogEntries(entriesToShow).markdown : "No changelog entries found.";
		const title = showFull ? "Full Changelog" : "Recent Changes";
		const hint = showFull
			? ""
			: `\n\n${theme.fg("dim", "Use")} ${theme.bold("/changelog full")} ${theme.fg("dim", "to view the complete changelog.")}`;

		const block = new TranscriptBlock();
		block.addChild(new DynamicBorder());
		block.addChild(new Text(theme.bold(theme.fg("accent", title)), 1, 0));
		block.addChild(new Spacer(1));
		block.addChild(new Markdown(changelogMarkdown + hint, 1, 1, getMarkdownTheme()));
		block.addChild(new DynamicBorder());
		this.ctx.presentCommandOutput(block);
	}

	handleHotkeysCommand(): void {
		const hotkeys = buildHotkeysMarkdown({ keybindings: this.ctx.keybindings });
		showMarkdownPanel(this.ctx, "Keyboard Shortcuts", hotkeys);
	}

	handleToolsCommand(): void {
		const tools = buildToolsMarkdown({
			tools: this.ctx.session.agent.state.tools,
			xdevTools: this.ctx.session.getXdevToolEntries(),
		});
		showMarkdownPanel(this.ctx, "Available Tools", tools);
	}

	handleContextCommand(): void {
		const breakdown = computeContextBreakdown(this.ctx.session, { snapcompactSavings: true });
		if (breakdown.contextWindow <= 0) {
			this.ctx.showWarning("Context usage is unavailable: no model is selected for this session.");
			return;
		}
		const output = renderContextUsage(breakdown, theme);
		const block = new TranscriptBlock();
		block.addChild(new DynamicBorder());
		block.addChild(new Text(theme.bold(theme.fg("accent", "Context Usage")), 1, 0));
		block.addChild(new Spacer(1));
		block.addChild(new Text(output, 1, 0));
		block.addChild(new DynamicBorder());
		this.ctx.presentCommandOutput(block);
	}

	async handleMemoryCommand(text: string): Promise<void> {
		const argumentText = text.slice(7).trim();
		const action = argumentText.split(/\s+/, 1)[0]?.toLowerCase() || "view";
		const agentDir = this.ctx.settings.getAgentDir();
		const backend = await resolveMemoryBackend(this.ctx.settings);

		if (action === "view") {
			const payload = await backend.buildDeveloperInstructions(agentDir, this.ctx.settings, this.ctx.session);
			if (!payload) {
				this.ctx.showWarning("Memory payload is empty (memory backend off, disabled, or no memory available).");
				return;
			}
			const block = new TranscriptBlock();
			block.addChild(new DynamicBorder());
			block.addChild(new Text(theme.bold(theme.fg("accent", "Memory Injection Payload")), 1, 0));
			block.addChild(new Spacer(1));
			block.addChild(new Markdown(payload, 1, 1, getMarkdownTheme()));
			block.addChild(new DynamicBorder());
			this.ctx.presentCommandOutput(block);
			return;
		}

		if (action === "reset" || action === "clear") {
			try {
				await backend.clear(agentDir, this.ctx.sessionManager.getCwd(), this.ctx.session);
				await this.ctx.session.refreshBaseSystemPrompt();
				this.ctx.showStatus("Memory data cleared and system prompt refreshed.");
			} catch (error) {
				this.ctx.showError(`Memory clear failed: ${error instanceof Error ? error.message : String(error)}`);
			}
			return;
		}

		if (action === "enqueue" || action === "rebuild") {
			try {
				await backend.enqueue(agentDir, this.ctx.sessionManager.getCwd(), this.ctx.session);
				this.ctx.showStatus("Memory consolidation enqueued.");
			} catch (error) {
				this.ctx.showError(`Memory enqueue failed: ${error instanceof Error ? error.message : String(error)}`);
			}
			return;
		}

		if (action === "stats" || action === "diagnose") {
			const hook = action === "stats" ? backend.stats : backend.diagnose;
			try {
				const payload = await hook?.(agentDir, this.ctx.sessionManager.getCwd(), this.ctx.session);
				if (!payload) {
					this.ctx.showWarning(memoryStatsUnavailableMessage(backend.id, action));
					return;
				}
				showMarkdownPanel(this.ctx, `Memory ${action === "stats" ? "Stats" : "Diagnostics"}`, payload);
			} catch (error) {
				this.ctx.showError(`Memory ${action} failed: ${error instanceof Error ? error.message : String(error)}`);
			}
			return;
		}

		if (action === "mm") {
			await this.#handleMentalModelsSubcommand(argumentText);
			return;
		}

		this.ctx.showError("Usage: /memory <view|stats|diagnose|clear|reset|enqueue|rebuild|mm ...>");
	}

	async #handleMentalModelsSubcommand(argumentText: string): Promise<void> {
		// Parse: "mm <verb> [arg]"
		const parts = argumentText.split(/\s+/).slice(1);
		const verb = parts[0]?.toLowerCase() ?? "list";
		const arg = parts[1];

		const state = this.ctx.session.getHindsightSessionState();
		const primary = state && !state.aliasOf ? state : undefined;
		if (!primary) {
			this.ctx.showError("Hindsight backend is not active for this session.");
			return;
		}
		if (!primary.config.mentalModelsEnabled) {
			this.ctx.showError("Mental models are disabled (hindsight.mentalModelsEnabled = false).");
			return;
		}

		switch (verb) {
			case "list":
				await this.#mmList(primary);
				return;
			case "show":
				if (!arg) return this.ctx.showError("Usage: /memory mm show <id>");
				await this.#mmShow(primary, arg);
				return;
			case "refresh":
				await this.#mmRefresh(primary, arg);
				return;
			case "history":
				if (!arg) return this.ctx.showError("Usage: /memory mm history <id>");
				await this.#mmHistory(primary, arg);
				return;
			case "seed":
				await this.#mmSeed(primary);
				return;
			case "reload":
				await this.#mmReload(primary);
				return;
			case "delete":
			case "remove":
				if (!arg) return this.ctx.showError("Usage: /memory mm delete <id>");
				await this.#mmDelete(primary, arg);
				return;
			default:
				this.ctx.showError("Usage: /memory mm <list|show|refresh|history|seed|reload|delete>");
		}
	}

	async #mmList(state: HindsightSessionState): Promise<void> {
		const client: HindsightApi = state.client;
		try {
			const response = await client.listMentalModels(state.bankId, { detail: "metadata" });
			const items = response.items ?? [];
			if (items.length === 0) {
				this.ctx.showStatus(`No mental models on bank ${state.bankId}.`);
				return;
			}
			const lines = items
				.slice()
				.sort((a, b) => a.id.localeCompare(b.id))
				.map(summarizeMentalModel);
			showMarkdownPanel(this.ctx, `Mental Models — ${state.bankId}`, lines.join("\n"));
		} catch (error) {
			this.ctx.showError(`mm list failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	async #mmShow(state: HindsightSessionState, id: string): Promise<void> {
		try {
			const model = await state.client.getMentalModel(state.bankId, id, { detail: "content" });
			if (!model) {
				this.ctx.showError(`Mental model not found: ${id}`);
				return;
			}
			const tags = model.tags && model.tags.length > 0 ? `\n_tags: ${model.tags.join(", ")}_` : "";
			const refreshed = model.last_refreshed_at ? `\n_last refreshed: ${model.last_refreshed_at}_` : "";
			const sourceQuery = model.source_query ? `\n\n**Source query:** ${model.source_query}` : "";
			const content = (model.content ?? "_(empty — background reflect may still be running)_").trim();
			showMarkdownPanel(
				this.ctx,
				model.name,
				`**id:** \`${model.id}\`${tags}${refreshed}${sourceQuery}\n\n${content}`,
			);
		} catch (error) {
			this.ctx.showError(`mm show failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	async #mmRefresh(state: HindsightSessionState, id: string | undefined): Promise<void> {
		try {
			if (id) {
				// Single-model refresh is explicit operator intent: bypass the
				// auto-refresh filter so curated/manual models can still be
				// refreshed on demand.
				await state.client.refreshMentalModel(state.bankId, id);
				this.ctx.showStatus(`Refresh queued for mental model ${id}.`);
			} else {
				// Bulk refresh: only touch models that opted into automatic
				// refresh via `trigger.refresh_after_consolidation`. Curated
				// models are reviewed before publishing and must not be
				// silently regenerated by a bank-wide refresh sweep. Reading
				// `detail: "content"` here is required because the trigger
				// field is excluded from `detail: "metadata"`.
				const list = await state.client.listMentalModels(state.bankId, { detail: "content" });
				const items = list.items ?? [];
				if (items.length === 0) {
					this.ctx.showStatus(`No mental models on bank ${state.bankId}.`);
					return;
				}
				const targets = items.filter(m => m.trigger?.refresh_after_consolidation === true);
				const skipped = items.length - targets.length;
				if (targets.length === 0) {
					this.ctx.showStatus(
						`No mental models opted into auto-refresh; ${skipped} curated model(s) left untouched. Pass an explicit id to refresh one of them.`,
					);
					return;
				}
				let queued = 0;
				for (const item of targets) {
					try {
						await state.client.refreshMentalModel(state.bankId, item.id);
						queued++;
					} catch (error) {
						this.ctx.showWarning(
							`Refresh failed for ${item.id}: ${error instanceof Error ? error.message : String(error)}`,
						);
					}
				}
				const skippedSuffix = skipped > 0 ? `; skipped ${skipped} curated model(s)` : "";
				this.ctx.showStatus(
					`Refresh queued for ${queued}/${targets.length} auto-refresh model(s)${skippedSuffix}.`,
				);
			}
			// Reload the cache after a brief grace so the new content (if the refresh
			// completes synchronously on the server) flows into the system prompt.
			await Bun.sleep(500);
			await reloadMentalModelsForSession(state.session);
		} catch (error) {
			this.ctx.showError(`mm refresh failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	async #mmHistory(state: HindsightSessionState, id: string): Promise<void> {
		try {
			const [model, history] = await Promise.all([
				state.client.getMentalModel(state.bankId, id, { detail: "content" }),
				state.client.getMentalModelHistory(state.bankId, id),
			]);
			if (!model) {
				this.ctx.showError(`Mental model not found: ${id}`);
				return;
			}
			if (history.length === 0) {
				this.ctx.showStatus(`No history recorded for ${id}.`);
				return;
			}
			// History is most-recent first. Each entry stores the content BEFORE that
			// change. To diff "what changed at entry N", compare entry N's
			// previous_content (= state before that change) with entry N-1's
			// previous_content (= state after that change, which was state before
			// the next change). For the most recent change, compare against the
			// model's CURRENT content.
			const sections: string[] = [];
			for (let i = 0; i < history.length; i++) {
				const before = history[i].previous_content ?? "";
				const after = i === 0 ? (model.content ?? "") : (history[i - 1].previous_content ?? "");
				const diff = diffMentalModelContent(before, after);
				sections.push(`### ${history[i].changed_at}\n\n\`\`\`diff\n${diff}\n\`\`\``);
			}
			showMarkdownPanel(this.ctx, `History — ${model.name}`, sections.join("\n\n"));
		} catch (error) {
			this.ctx.showError(`mm history failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	async #mmSeed(state: HindsightSessionState): Promise<void> {
		try {
			const config = loadHindsightConfig(this.ctx.settings);
			const seeds = resolveSeedsForScope(
				{
					bankId: state.bankId,
					retainTags: state.retainTags,
					recallTags: state.recallTags,
					recallTagsMatch: state.recallTagsMatch,
				},
				config.scoping,
			);
			if (seeds.length === 0) {
				this.ctx.showStatus(`No built-in seeds apply to scoping=${config.scoping}.`);
				return;
			}
			const list = await state.client.listMentalModels(state.bankId, { detail: "metadata" });
			const existing = list.items ?? [];
			let created = 0;
			let skipped = 0;
			for (const seed of seeds) {
				if (seedAlreadyExists(seed, existing)) {
					skipped++;
					continue;
				}
				try {
					await state.client.createMentalModel(state.bankId, seed.name, seed.sourceQuery, {
						id: seed.id,
						tags: seed.tags.length > 0 ? seed.tags : undefined,
						maxTokens: seed.maxTokens,
						trigger: seed.trigger,
					});
					created++;
				} catch (error) {
					this.ctx.showWarning(
						`Seed failed for ${seed.id}: ${error instanceof Error ? error.message : String(error)}`,
					);
				}
			}
			this.ctx.showStatus(`Seeded ${created} new mental model(s); ${skipped} already present.`);
		} catch (error) {
			this.ctx.showError(`mm seed failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	async #mmReload(state: HindsightSessionState): Promise<void> {
		const ok = await reloadMentalModelsForSession(state.session);
		if (ok) {
			this.ctx.showStatus("Mental-model cache reloaded.");
		} else {
			this.ctx.showError("Reload failed (Hindsight backend not active or mental models disabled).");
		}
	}

	async #mmDelete(state: HindsightSessionState, id: string): Promise<void> {
		try {
			const removed = await state.client.deleteMentalModel(state.bankId, id);
			if (!removed) {
				this.ctx.showError(`Mental model not found: ${id}`);
				return;
			}
			// Drop the cached snippet so the closing tag does not silently keep
			// stale content in the system prompt until the next agent_end TTL.
			await reloadMentalModelsForSession(state.session);
			this.ctx.showStatus(`Deleted mental model ${id} from bank ${state.bankId}.`);
		} catch (error) {
			this.ctx.showError(`mm delete failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	async #runNewSessionFlow(options?: NewSessionOptions, label: string = "New session started"): Promise<void> {
		this.ctx.clearTransientSessionUi();

		if (this.ctx.session.isCompacting) {
			this.ctx.session.abortCompaction();
			while (this.ctx.session.isCompacting) {
				await Bun.sleep(10);
			}
		}
		if (!(await this.ctx.session.newSession(options))) return;
		this.ctx.resetObserverRegistry();
		setSessionTerminalTitle(this.ctx.sessionManager.getSessionName(), this.ctx.sessionManager.getCwd());

		this.ctx.statusLine.invalidate();
		this.ctx.statusLine.resetActiveTime();
		this.ctx.updateEditorBorderColor();
		this.ctx.clearTransientSessionUi();
		this.ctx.resetTranscript();

		this.ctx.present([new Spacer(1), new Text(`${theme.fg("accent", `${theme.status.success} ${label}`)}`, 1, 1)]);
		await this.ctx.reloadTodos();
		this.ctx.ui.requestRender(true, { clearScrollback: true });
	}

	async handleClearCommand(): Promise<void> {
		await this.#runNewSessionFlow();
	}

	async handleFreshCommand(): Promise<void> {
		const result = this.ctx.session.freshSession();
		if (!result) {
			this.ctx.showWarning("Wait for the current response to finish or abort it before refreshing provider state.");
			return;
		}
		const stateLabel = result.closedProviderSessions === 1 ? "provider state" : "provider states";
		this.ctx.statusLine.invalidate();
		this.ctx.ui.requestRender();
		this.ctx.showStatus(`Fresh provider session started (${result.closedProviderSessions} ${stateLabel} pruned).`);
	}

	async handleResetContextCommand(): Promise<void> {
		if (this.ctx.session.isCompacting) {
			this.ctx.session.abortCompaction();
			while (this.ctx.session.isCompacting) {
				await Bun.sleep(10);
			}
		}
		const result = await this.ctx.session.resetSessionContext();
		if (!result) {
			this.ctx.showWarning("Wait for the current response to finish or abort it before resetting the context.");
			return;
		}
		// Drop the rendered transcript so the UI matches the now-empty model
		// context (mirrors #runNewSessionFlow's teardown, minus the new session —
		// the session id, title, and transcript file all survive).
		this.ctx.clearTransientSessionUi();
		this.ctx.resetTranscript();
		this.ctx.statusLine.invalidate();
		this.ctx.updateEditorBorderColor();
		const noun = result.droppedCount === 1 ? "message" : "messages";
		this.ctx.present([
			new Spacer(1),
			new Text(
				`${theme.fg("accent", `${theme.status.success} Context reset — ${result.droppedCount} ${noun} dropped; session continues.`)}`,
				1,
				1,
			),
		]);
		this.ctx.ui.requestRender(true, { clearScrollback: true });
	}

	async handleDropCommand(): Promise<void> {
		if (!this.ctx.sessionManager.getSessionFile()) {
			this.ctx.showError("Nothing to drop (in-memory session)");
			return;
		}
		await this.#runNewSessionFlow({ drop: true }, "Session dropped");
	}

	async handleForkCommand(): Promise<void> {
		if (this.ctx.session.isStreaming) {
			this.ctx.showWarning("Wait for the current response to finish or abort it before forking.");
			return;
		}
		if (this.ctx.loadingAnimation) {
			this.ctx.loadingAnimation.stop();
			this.ctx.loadingAnimation = undefined;
		}
		this.ctx.statusContainer.disposeChildren();

		const success = await this.ctx.session.fork();
		if (!success) {
			this.ctx.showError("Fork failed (session not persisted or cancelled)");
			return;
		}

		this.ctx.statusLine.invalidate();
		this.ctx.ui.requestRender();

		const sessionFile = this.ctx.session.sessionFile;
		const shortPath = sessionFile ? sessionFile.split("/").pop() : "new session";
		this.ctx.present([
			new Spacer(1),
			new Text(`${theme.fg("accent", `${theme.status.success} Session forked to ${shortPath}`)}`, 1, 1),
		]);
	}

	/**
	 * `/move` — relocate the current session to a different directory.
	 *
	 * With no `targetPath` (TUI only), opens an autocomplete overlay so the user
	 * can pick or type a directory. With a `targetPath`, resolves it directly.
	 * If the target directory does not exist, the user is asked whether to create
	 * it. The active session file and artifacts are moved into the target
	 * directory's session bucket so `/resume` from that directory can find it.
	 */
	async handleMoveCommand(targetPath?: string): Promise<void> {
		if (this.ctx.session.isStreaming) {
			this.ctx.showWarning("Wait for the current response to finish or abort it before moving.");
			return;
		}

		let input: string | undefined = targetPath?.trim() || undefined;

		// No argument in TUI mode: open the path autocomplete overlay.
		if (!input) {
			const result = await this.ctx.showHookCustom<MoveOverlayResult | undefined>(
				(_tui, _theme, _keybindings, done) => new MoveOverlay(this.ctx.sessionManager.getCwd(), done),
				{ overlay: true },
			);
			if (!result) return; // cancelled
			input = result.directory;
		}

		const unquoted = stripOuterDoubleQuotes(input);
		if (!unquoted) {
			this.ctx.showError("Usage: /move <path>");
			return;
		}

		const cwd = this.ctx.sessionManager.getCwd();
		const resolvedPath = resolveToCwd(unquoted, cwd);

		// If the directory doesn't exist, offer to create it.
		let isDirectory: boolean;
		try {
			isDirectory = (await fs.stat(resolvedPath)).isDirectory();
		} catch {
			isDirectory = false;
		}

		if (!isDirectory) {
			const parentDir = path.dirname(resolvedPath);
			let parentExists = false;
			try {
				parentExists = (await fs.stat(parentDir)).isDirectory();
			} catch {
				parentExists = false;
			}
			if (!parentExists) {
				this.ctx.showError(`Cannot create "${path.basename(resolvedPath)}": parent directory does not exist`);
				return;
			}
			const confirmed = await this.ctx.showHookConfirm(
				"Create directory?",
				`"${path.basename(resolvedPath)}" does not exist. Create it?`,
			);
			if (!confirmed) return;
			try {
				await fs.mkdir(resolvedPath, { recursive: true });
			} catch (err) {
				this.ctx.showError(`Failed to create directory: ${err instanceof Error ? err.message : String(err)}`);
				return;
			}
		}
		try {
			await this.ctx.settings.flush();
		} catch (err) {
			this.ctx.showError(`Failed to save pending settings: ${err instanceof Error ? err.message : String(err)}`);
			return;
		}

		try {
			await this.ctx.session.moveSession(resolvedPath);
		} catch (err) {
			this.ctx.showError(`Move failed: ${err instanceof Error ? err.message : String(err)}`);
			return;
		}
		await this.ctx.applyCwdChange(resolvedPath);

		this.ctx.updateEditorBorderColor();
		await this.ctx.reloadTodos();
		this.ctx.ui.requestRender();

		this.ctx.present([
			new Spacer(1),
			new Text(`${theme.fg("accent", `${theme.status.success} Moved to ${resolvedPath}`)}`, 1, 1),
		]);
	}

	async handleRenameCommand(title: string): Promise<void> {
		try {
			const stored = await this.ctx.sessionManager.setSessionName(title, "user");
			if (!stored) {
				this.ctx.showError("Session name cannot be empty.");
				return;
			}
			const name = this.ctx.sessionManager.getSessionName()!;
			this.ctx.showStatus(`Session renamed to "${name}".`);
		} catch (err) {
			this.ctx.showError(`Rename failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	async handleBashCommand(command: string, excludeFromContext = false): Promise<void> {
		const isDeferred = this.ctx.session.isStreaming;
		const shouldPersistCwd = isPersistentShellCdCommand(command);
		if (isDeferred && shouldPersistCwd) {
			this.ctx.showWarning("Wait for the current response to finish or abort it before changing directories.");
			return;
		}

		this.ctx.bashComponent = new BashExecutionComponent(command, this.ctx.ui, excludeFromContext);

		if (isDeferred) {
			this.ctx.pendingMessagesContainer.addChild(this.ctx.bashComponent);
			this.ctx.pendingBashComponents.push(this.ctx.bashComponent);
		} else {
			this.ctx.present(this.ctx.bashComponent);
		}
		this.ctx.ui.requestRender();

		try {
			const result = await this.ctx.session.executeBash(
				command,
				chunk => {
					if (this.ctx.bashComponent) {
						this.ctx.bashComponent.appendOutput(chunk);
					}
				},
				{ excludeFromContext, useUserShell: true },
			);
			if (this.ctx.bashComponent) {
				const meta = outputMeta().truncationFromSummary(result, { direction: "tail" }).get();
				this.ctx.bashComponent.setComplete(result.exitCode, result.cancelled, {
					output: result.output,
					truncation: meta?.truncation,
				});
			}
			try {
				if (shouldPersistCwd) await this.#applyBashResultCwd(result);
			} catch (error) {
				this.ctx.showError(
					`Bash command completed, but OMP failed to update its working directory: ${
						error instanceof Error ? error.message : "Unknown error"
					}`,
				);
			}
		} catch (error) {
			if (this.ctx.bashComponent) {
				this.ctx.bashComponent.setComplete(undefined, false);
			}
			this.ctx.showError(`Bash command failed: ${error instanceof Error ? error.message : "Unknown error"}`);
		}

		this.ctx.bashComponent = undefined;
		this.ctx.ui.requestRender();
	}

	async #moveInteractiveCwd(resolvedPath: string): Promise<void> {
		await this.ctx.sessionManager.moveTo(resolvedPath);
		await this.ctx.applyCwdChange(resolvedPath);
		this.ctx.updateEditorBorderColor();
		await this.ctx.reloadTodos();
	}

	async #applyBashResultCwd(result: BashResult): Promise<void> {
		if (result.cancelled || result.exitCode !== 0 || !result.workingDir) return;
		if (!path.isAbsolute(result.workingDir)) return;

		const resolvedPath = path.resolve(result.workingDir);
		if (resolvedPath === path.resolve(this.ctx.sessionManager.getCwd())) return;

		let isDirectory = false;
		try {
			isDirectory = (await fs.stat(resolvedPath)).isDirectory();
		} catch {
			isDirectory = false;
		}
		if (!isDirectory) return;

		await this.#moveInteractiveCwd(resolvedPath);
	}

	async handlePythonCommand(code: string, excludeFromContext = false): Promise<void> {
		const isDeferred = this.ctx.session.isStreaming;
		this.ctx.pythonComponent = new EvalExecutionComponent(code, this.ctx.ui, excludeFromContext);

		if (isDeferred) {
			this.ctx.pendingMessagesContainer.addChild(this.ctx.pythonComponent);
			this.ctx.pendingPythonComponents.push(this.ctx.pythonComponent);
		} else {
			this.ctx.present(this.ctx.pythonComponent);
		}
		this.ctx.ui.requestRender();

		try {
			const result = await this.ctx.session.executePython(
				code,
				chunk => {
					if (this.ctx.pythonComponent) {
						this.ctx.pythonComponent.appendOutput(chunk);
					}
				},
				{ excludeFromContext },
			);

			if (this.ctx.pythonComponent) {
				const meta = outputMeta().truncationFromSummary(result, { direction: "tail" }).get();
				this.ctx.pythonComponent.setComplete(result.exitCode, result.cancelled, {
					output: result.output,
					truncation: meta?.truncation,
				});
			}
		} catch (error) {
			if (this.ctx.pythonComponent) {
				this.ctx.pythonComponent.setComplete(undefined, false);
			}
			this.ctx.showError(`Python execution failed: ${error instanceof Error ? error.message : "Unknown error"}`);
		}

		this.ctx.pythonComponent = undefined;
		this.ctx.ui.requestRender();
	}

	async handleCompactCommand(
		customInstructions?: string,
		mode?: CompactMode,
		beforeFlush?: (outcome: CompactionOutcome) => void | Promise<void>,
		internalGuidance?: string,
	): Promise<CompactionOutcome> {
		const entries = this.ctx.sessionManager.getEntries();
		const messageCount = entries.filter(e => e.type === "message").length;

		if (messageCount < 2) {
			this.ctx.showWarning("Nothing to compact (no messages yet)");
			return "ok";
		}

		// `internalGuidance` is a private summarizer directive (plan-mode
		// "Approve and compact context") that MUST stay off the public
		// `customInstructions` channel of the `session_before_compact` extension
		// hook — extensions treat that field as user focus and would otherwise
		// bias the summary toward the plan boilerplate (issue #4359). Ride it
		// through as a CompactOptions field instead.
		if (internalGuidance) {
			return this.executeCompaction({ internalGuidance, ...(mode ? { mode } : {}) }, false, beforeFlush, mode);
		}
		return this.executeCompaction(customInstructions, false, beforeFlush, mode);
	}

	/**
	 * TUI handler for `/shake`. `elide` drops heavy structural content and
	 * `images` strips image blocks. Rebuilds the chat and reports counts.
	 */
	async handleShakeCommand(mode: ShakeMode): Promise<void> {
		let result: ShakeResult;
		try {
			result = await this.ctx.session.shake(mode);
		} catch (error) {
			this.ctx.showError(`Shake failed: ${error instanceof Error ? error.message : String(error)}`);
			return;
		}

		const dropped = result.toolResultsDropped + result.blocksDropped + (result.imagesDropped ?? 0);
		if (dropped === 0) {
			this.ctx.showStatus("Nothing to shake.");
			return;
		}
		this.ctx.rebuildChatFromMessages();
		this.ctx.statusLine.invalidate();
		this.ctx.ui.requestRender();
		this.ctx.showStatus(formatShakeSummary(result));
	}

	async executeCompaction(
		customInstructionsOrOptions?: string | CompactOptions,
		isAuto = false,
		beforeFlush?: (outcome: CompactionOutcome) => void | Promise<void>,
		mode?: CompactMode,
	): Promise<CompactionOutcome> {
		if (this.ctx.loadingAnimation) {
			this.ctx.loadingAnimation.stop();
			this.ctx.loadingAnimation = undefined;
		}
		this.ctx.statusContainer.disposeChildren();

		const label = isAuto ? "Auto-compacting context... (esc to cancel)" : "Compacting context... (esc to cancel)";
		const compactingLoader = new Loader(
			this.ctx.ui,
			spinner => theme.fg("accent", spinner),
			text => theme.fg("muted", text),
			label,
			getSymbolTheme().spinnerFrames,
		);
		this.ctx.statusContainer.addChild(compactingLoader);
		this.ctx.ui.requestRender();

		let outcome: CompactionOutcome = "ok";
		try {
			const instructions = typeof customInstructionsOrOptions === "string" ? customInstructionsOrOptions : undefined;
			const baseOptions =
				customInstructionsOrOptions && typeof customInstructionsOrOptions === "object"
					? customInstructionsOrOptions
					: undefined;
			// The slash path passes `mode` positionally; the extension path carries
			// it inside the options object. Either source wins over no mode.
			const effectiveMode = mode ?? baseOptions?.mode;
			const options =
				baseOptions || effectiveMode
					? { ...baseOptions, ...(effectiveMode ? { mode: effectiveMode } : {}) }
					: undefined;
			await this.ctx.session.compact(instructions, options);

			compactingLoader.stop();
			this.ctx.statusContainer.disposeChildren();
			this.ctx.rebuildChatFromMessages({ reuseSettledComponents: true });

			this.ctx.statusLine.invalidate();
			// Same as the auto-compaction rebuild: a collapsed transcript is an
			// intentional replacement, so drop the stale pre-compaction scrollback
			// instead of repainting the shrunken frame below it. With collapse
			// disabled the full history stays inline and scrollback is kept.
			if (this.ctx.settings.get("display.collapseCompacted")) {
				this.ctx.ui.requestRender(true, { clearScrollback: true });
			} else {
				this.ctx.ui.requestRender();
			}
		} catch (error) {
			if (error instanceof CompactionCancelledError) {
				outcome = "cancelled";
				this.ctx.showError("Compaction cancelled");
			} else {
				outcome = "failed";
				const message = error instanceof Error ? error.message : String(error);
				this.ctx.showError(`Compaction failed: ${message}`);
			}
		} finally {
			compactingLoader.stop();
			this.ctx.statusContainer.disposeChildren();
		}
		// Run the caller's pre-flush hook (e.g. the plan-approval model transition)
		// before queued user input is dispatched, so any turn queued during
		// compaction executes on the post-compaction model rather than the model
		// compaction itself ran on.
		if (beforeFlush) await beforeFlush(outcome);
		await this.ctx.flushCompactionQueue({ willRetry: false });
		return outcome;
	}

	async handleHandoffCommand(customInstructions?: string): Promise<void> {
		if (this.ctx.session.isStreaming) {
			this.ctx.showWarning("Wait for the current response to finish or abort it before handing off.");
			return;
		}

		const entries = this.ctx.sessionManager.getEntries();
		const messageCount = entries.filter(e => e.type === "message").length;

		if (messageCount < 2) {
			this.ctx.showWarning("Nothing to hand off (no messages yet)");
			return;
		}

		if (this.ctx.loadingAnimation) {
			this.ctx.loadingAnimation.stop();
			this.ctx.loadingAnimation = undefined;
		}
		this.ctx.statusContainer.disposeChildren();

		const handoffLoader = new Loader(
			this.ctx.ui,
			spinner => theme.fg("accent", spinner),
			text => theme.fg("muted", text),
			"Generating handoff… (esc to cancel)",
			getSymbolTheme().spinnerFrames,
		);
		this.ctx.statusContainer.addChild(handoffLoader);
		this.ctx.ui.requestRender();

		try {
			// Handoff generation runs as a oneshot request; the new session is shown after it completes.
			const result = await this.ctx.session.handoff(customInstructions);

			if (!result) {
				this.ctx.showError("Handoff cancelled");
				return;
			}

			// Rebuild chat from the new session (which now contains the handoff document).
			this.ctx.clearTransientSessionUi();
			this.ctx.renderInitialMessages();
			this.ctx.statusLine.invalidate();
			this.ctx.updateEditorBorderColor();
			await this.ctx.reloadTodos();

			this.ctx.present([
				new Spacer(1),
				new Text(`${theme.fg("accent", `${theme.status.success} New session started with handoff context`)}`, 1, 1),
			]);
			if (result.savedPath) {
				this.ctx.showStatus(`Handoff document saved to: ${result.savedPath}`);
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			// `session.handoff()` normalizes genuine cancellations to this exact message; a
			// provider error (even one named AbortError) is re-thrown verbatim so it surfaces
			// as a real failure instead of a false "cancelled".
			if (message === "Handoff cancelled") {
				this.ctx.showError("Handoff cancelled");
			} else {
				// Persist the real failure so it is debuggable after the transient
				// TUI error clears (#7993).
				logger.error("Handoff failed", { error: message });
				this.ctx.showError(`Handoff failed: ${message}`);
			}
		} finally {
			handoffLoader.stop();
			this.ctx.statusContainer.disposeChildren();
		}
		this.ctx.ui.requestRender(true, { clearScrollback: true });
	}
}

const BAR_WIDTH_MAX = 24;
const BAR_WIDTH_MIN = 6;

function renderJobLine(job: AsyncJobSnapshotItem, now: number): string {
	const duration = formatDuration(Math.max(0, now - job.startTime));
	const status = formatJobStatus(job.status);
	return `${theme.fg("dim", job.id)} ${theme.fg("dim", `[${job.type}]`)} ${status} ${theme.fg("dim", `(${duration})`)}`;
}

function formatJobStatus(status: AsyncJobSnapshotItem["status"]): string {
	if (status === "running") return theme.fg("warning", "running");
	if (status === "completed") return theme.fg("success", "completed");
	if (status === "cancelled") return theme.fg("dim", "cancelled");
	return theme.fg("error", "failed");
}

function truncateJobLabel(label: string, maxWidth: number): string {
	if (visibleWidth(label) <= maxWidth) return label;
	if (maxWidth <= 1) return "…";

	let out = "";
	for (const char of label) {
		const next = `${out}${char}`;
		if (visibleWidth(`${next}…`) > maxWidth) break;
		out = next;
	}

	return `${out}…`;
}

function formatNumber(value: number, maxFractionDigits = 1): string {
	return new Intl.NumberFormat("en-US", { maximumFractionDigits: maxFractionDigits }).format(value);
}

function resolveProviderAuthMode(authStorage: AuthStorage, provider: string): string {
	if (authStorage.hasOAuth(provider)) {
		return "oauth";
	}
	if (authStorage.has(provider)) {
		return "api key";
	}
	if (getEnvApiKey(provider)) {
		return "env api key";
	}
	if (authStorage.hasAuth(provider)) {
		return "runtime/fallback";
	}
	return "unknown";
}

export function renderProviderSection(details: ProviderDetails, uiTheme: Pick<typeof theme, "fg">): string {
	const lines: string[] = [];
	lines.push(`${uiTheme.fg("dim", "Name:")} ${details.provider}`);
	for (const field of details.fields) {
		lines.push(`${uiTheme.fg("dim", `${field.label}:`)} ${field.value}`);
	}
	return `${lines.join("\n")}\n`;
}

function formatLimitTitle(limit: UsageLimit): string {
	const tier = limit.scope.tier;
	if (tier && !limit.label.toLowerCase().includes(tier.toLowerCase())) {
		return `${limit.label} (${tier})`;
	}
	return limit.label;
}

/** Window label to append to a limit title, or "" when it would just repeat it. */
function formatWindowSuffix(label: string, windowLabel: string): string {
	const normalizedLabel = label.toLowerCase();
	const normalizedWindow = windowLabel.toLowerCase();
	if (normalizedWindow === "quota window") return "";
	if (normalizedLabel.includes(normalizedWindow)) return "";
	return windowLabel;
}

/** ` (org)` suffix when the report is org-attributed — two subscriptions can share one email. */
function orgSuffix(report: UsageReport): string {
	const orgName = report.metadata?.orgName;
	const orgId = report.metadata?.orgId;
	const org = typeof orgName === "string" && orgName ? orgName : typeof orgId === "string" ? orgId : undefined;
	return org ? ` (${org})` : "";
}

function formatAccountLabel(limit: UsageLimit, report: UsageReport, index: number): string {
	const email = report.metadata?.email;
	if (typeof email === "string" && email) return `${email}${orgSuffix(report)}`;
	const accountId =
		typeof report.metadata?.accountId === "string" && report.metadata.accountId
			? report.metadata.accountId
			: limit.scope.accountId || undefined;
	if (accountId) return `${accountId}${orgSuffix(report)}`;
	const projectId =
		typeof report.metadata?.projectId === "string" && report.metadata.projectId
			? report.metadata.projectId
			: limit.scope.projectId || undefined;
	if (projectId) return projectId;
	return `account ${index + 1}`;
}

function formatUnlimitedReportLabel(report: UsageReport, index: number): string {
	const email = report.metadata?.email;
	if (typeof email === "string" && email) return `${email}${orgSuffix(report)}`;
	const accountId = report.metadata?.accountId;
	if (typeof accountId === "string" && accountId) return `${accountId}${orgSuffix(report)}`;
	const projectId = report.metadata?.projectId;
	if (typeof projectId === "string" && projectId) return projectId;
	return `account ${index + 1}`;
}

/**
 * Account label for a report's legend cell. Reports with limits resolve through
 * {@link formatAccountLabel} so scoped account/project ids still win over empty
 * metadata strings; limit-less reports fall back to metadata alone.
 */
function formatReportLabel(report: UsageReport, index: number): string {
	const limit = report.limits[0];
	return limit ? formatAccountLabel(limit, report, index) : formatUnlimitedReportLabel(report, index);
}

/**
 * Legend labels for one provider's account columns. With two or more columns,
 * an organization suffix or an email domain that every account shares costs
 * width without telling the credentials apart, so it is dropped. A single
 * column keeps its full label: the org is then the only field distinguishing
 * two subscriptions on one email ([#5691](https://github.com/can1357/oh-my-pi/issues/5691)).
 */
function formatLegendLabels(reports: UsageReport[]): string[] {
	const labels = reports.map((report, index) => formatReportLabel(report, index));
	if (labels.length < 2) return labels;
	const orgs = new Set(reports.map(report => orgSuffix(report)));
	const sharedOrg = orgs.size === 1 ? [...orgs][0] : undefined;
	const withoutOrg = sharedOrg
		? labels.map(label => (label.endsWith(sharedOrg) ? label.slice(0, -sharedOrg.length) : label))
		: labels;
	const domains = new Set(withoutOrg.map(label => label.slice(label.indexOf("@"))));
	if (domains.size === 1 && withoutOrg.every(label => label.includes("@"))) {
		return withoutOrg.map(label => label.slice(0, label.indexOf("@")));
	}
	return withoutOrg;
}

function padColumn(text: string, width: number): string {
	const visible = visibleWidth(text);
	if (visible >= width) return text;
	return `${text}${padding(width - visible)}`;
}

type AggregateDisplayStatus = NonNullable<UsageLimit["status"]> | "neutral";

function isUsedOnlyAbsoluteAmount(limit: UsageLimit): boolean {
	const amount = limit.amount;
	return (
		amount.unit !== "percent" &&
		amount.unit !== "unknown" &&
		amount.used !== undefined &&
		Number.isFinite(amount.used) &&
		amount.limit === undefined &&
		amount.remaining === undefined &&
		resolveUsedFraction(limit) === undefined
	);
}

function resolveAggregateStatus(limits: UsageLimit[]): AggregateDisplayStatus {
	const hasOk = limits.some(limit => limit.status === "ok");
	const hasWarning = limits.some(limit => limit.status === "warning");
	const hasExhausted = limits.some(limit => limit.status === "exhausted");
	if (!hasOk && !hasWarning && !hasExhausted) {
		return limits.length > 0 && limits.every(isUsedOnlyAbsoluteAmount) ? "neutral" : "unknown";
	}
	if (hasOk) {
		return hasWarning || hasExhausted ? "warning" : "ok";
	}
	if (hasWarning) return "warning";
	return "exhausted";
}

function resolveResetRange(limits: UsageLimit[], nowMs: number): string | null {
	const windows = limits
		.map(limit => limit.window)
		.filter(
			(window): window is NonNullable<UsageLimit["window"]> =>
				window?.resetsAt !== undefined && Number.isFinite(window.resetsAt) && window.resetsAt > nowMs,
		);
	if (windows.length === 0) return null;
	// Use the shared verb when every contributing window agrees (e.g. all "tick");
	// mixed or absent labels fall back to the generic "resets".
	const labels = new Set(windows.map(window => window.resetLabel ?? "resets"));
	const verb = labels.size === 1 ? [...labels][0]! : "resets";
	const offsets = windows.map(window => window.resetsAt! - nowMs);
	const minReset = Math.min(...offsets);
	const maxReset = Math.max(...offsets);
	if (maxReset - minReset > 60_000) {
		return `${verb} in ${formatDuration(minReset)}–${formatDuration(maxReset)}`;
	}
	return `${verb} in ${formatDuration(minReset)}`;
}
/**
 * Compact one-line quota summary for a single advisor's provider.
 * Returns `null` when the provider has no usage data.
 * When `activeAccount` is provided, only limits matching that credential
 * are shown (mirrors `renderUsageReports`'s account-stickiness filtering).
 * Example output: `Quota: 7d window · 67% used · resets in 3.2d`
 */
export function formatCompactQuota(
	provider: string,
	reports: UsageReport[],
	nowMs: number,
	activeAccount?: OAuthAccountIdentity,
): string | null {
	const providerReports = reports.filter(r => r.provider === provider);
	if (providerReports.length === 0) return null;
	// Group limits by window id so we show BOTH the 5-hour and 7-day windows
	// (or any other distinct windows the provider exposes). Within each window,
	// pick the highest used fraction across accounts — that's the most pressing.
	const byWindow = new Map<string, { limit: UsageLimit; fraction: number }>();
	for (const report of providerReports) {
		for (const limit of report.limits) {
			// Skip limits that belong to a different credential than the one
			// the advisor is actually using, so we don't alarm the user with
			// an exhausted account that isn't theirs.
			if (activeAccount && !limitMatchesActiveAccount(report, limit, activeAccount)) continue;
			const fraction = resolveUsedFraction(limit);
			if (fraction === undefined) continue;
			const key = limit.window?.id ?? limit.scope.windowId ?? "—";
			const existing = byWindow.get(key);
			if (!existing || fraction > existing.fraction) byWindow.set(key, { limit, fraction });
		}
	}
	if (byWindow.size === 0) return null;
	// Sort windows by urgency (highest fraction first) so the most pressing
	// quota is always the first thing the user sees.
	const entries = [...byWindow.values()].sort((a, b) => b.fraction - a.fraction);
	const lines: string[] = [];
	for (const { limit, fraction } of entries) {
		const pct = Math.round(fraction * 100);
		const windowLabel = limit.window?.label ?? limit.scope.windowId ?? "—";
		// Include the limit label (account/tier) when it carries identity beyond
		// the window name, so the user can tell which credential's quota is shown.
		const identity = limit.label.trim();
		const header = identity && identity !== windowLabel ? `${windowLabel} (${identity})` : windowLabel;
		const parts = [`${header}: ${pct}% used`];
		const reset = resolveResetRange([limit], nowMs);
		if (reset) parts.push(reset);
		lines.push(parts.join(" · "));
	}
	return `Quota: ${lines.join(" │ ")}`;
}

function resolveStatusIcon(status: AggregateDisplayStatus, uiTheme: typeof theme): string {
	if (status === "neutral") return uiTheme.fg("dim", uiTheme.status.info);
	if (status === "exhausted") return uiTheme.fg("error", uiTheme.status.error);
	if (status === "warning") return uiTheme.fg("warning", uiTheme.status.warning);
	if (status === "ok") return uiTheme.fg("success", uiTheme.status.success);
	return uiTheme.fg("dim", uiTheme.status.pending);
}

function resolveStatusColor(status: UsageLimit["status"]): "success" | "warning" | "error" | "dim" {
	if (status === "exhausted") return "error";
	if (status === "warning") return "warning";
	if (status === "ok") return "success";
	return "dim";
}

/** Eighth-block ramp so a bar carries sub-cell precision at small widths. */
const BAR_PARTIALS = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"] as const;

/** Filled portion is the USED fraction; the remainder is a dim track. */
function renderUsageBar(
	fraction: number,
	status: UsageLimit["status"],
	uiTheme: typeof theme,
	barWidth: number,
): string {
	if (barWidth <= 0) return "";
	const exact = Math.min(Math.max(fraction, 0), 1) * barWidth;
	let fullCells = Math.floor(exact);
	let eighths = Math.round((exact - fullCells) * 8);
	if (eighths === 8) {
		fullCells += 1;
		eighths = 0;
	}
	const partial = fullCells < barWidth ? BAR_PARTIALS[eighths] : "";
	const leading = "█".repeat(fullCells) + partial;
	const track = "─".repeat(Math.max(0, barWidth - fullCells - (partial ? 1 : 0)));
	return `${uiTheme.fg(resolveStatusColor(status), leading)}${uiTheme.fg("dim", track)}`;
}

/** Remaining quota as a short cell string: `100%`, `<1%`, `0%`. */
function formatFreePercent(fraction: number): string {
	const free = Math.max(0, 1 - fraction) * 100;
	if (free === 0) return "0%";
	if (free >= 99.95) return "100%";
	if (free < 1) return "<1%";
	return `${Math.round(free)}%`;
}

/** Absolute used-only amount (no cap to draw a bar against), e.g. `$12.44 used`. */
function formatUsedOnlyAmount(limit: UsageLimit): string {
	const used = limit.amount.used ?? 0;
	const text = limit.amount.unit === "usd" ? `$${used.toFixed(2)}` : `${formatNumber(used, 2)} ${limit.amount.unit}`;
	return `${text} used`;
}

/** One quota window across every account column of a provider. */
interface UsageRow {
	title: string;
	cells: (UsageLimit | undefined)[];
	reset: string;
	notes: string[];
}

/** One provider section: metered accounts as columns, one row per quota window. */
interface UsageBlock {
	provider: string;
	accounts: UsageReport[];
	rows: UsageRow[];
	notes: string[];
	credits: string[];
	unmetered: string[];
	status: AggregateDisplayStatus;
	modelCount: number;
}

/** Column geometry shared by every provider block so bars stay comparable. */
interface UsageLayout {
	labelWidth: number;
	barWidth: number;
	resetWidth: number;
	cellWidth: number;
}

const LABEL_WIDTH_MAX = 26;
const LABEL_WIDTH_MIN = 8;
const PERCENT_WIDTH = 4;
const USAGE_INDENT = 2;

function buildUsageBlock(
	provider: string,
	providerReports: UsageReport[],
	nowMs: number,
	modelCount: number,
): UsageBlock {
	// An account with no reported limits owns no bar column: a blank column only
	// shrinks its siblings' bars and shifts the legend away from the data.
	const metered = providerReports.filter(report => report.limits.length > 0);
	// Order account columns ONCE per provider (worst-first), then apply that same
	// order to every window row. Sorting each row by its own used fraction
	// (issue #6067) desynchronized the columns, so a positional label denoted a
	// different credential per row.
	const accounts = metered
		.map((report, position) => ({
			report,
			position,
			worst: report.limits.reduce((max, limit) => Math.max(max, resolveUsedFraction(limit) ?? -1), -1),
		}))
		.sort((a, b) => (b.worst !== a.worst ? b.worst - a.worst : a.position - b.position))
		.map(entry => entry.report);
	const columnOf = new Map(accounts.map((report, index) => [report, index]));

	// Cells are keyed by the owning report, not by array position, so a provider
	// where one account is missing a window still lines its bars up with the legend.
	const grouped = new Map<string, UsageRow>();
	for (const report of metered) {
		for (const limit of report.limits) {
			const windowId = limit.window?.id ?? limit.scope.windowId ?? "default";
			const title = formatLimitTitle(limit);
			const windowLabel = limit.window?.label ?? windowId;
			const suffix = formatWindowSuffix(title, windowLabel);
			const row = grouped.get(`${title}|${windowId}`) ?? {
				title: suffix ? `${title} · ${suffix}` : title,
				cells: new Array<UsageLimit | undefined>(accounts.length).fill(undefined),
				reset: "",
				notes: [],
			};
			row.cells[columnOf.get(report) ?? 0] = limit;
			grouped.set(`${title}|${windowId}`, row);
		}
	}
	const rows = [...grouped.values()];
	for (const row of rows) {
		const cells = row.cells.filter((limit): limit is UsageLimit => limit !== undefined);
		// Accounts on the same window rarely reset at the same instant, and the
		// old per-account label suffix showed each one. Collapsing to a single
		// countdown must not drop that: `resolveResetRange` keeps the shared verb
		// when every account agrees and widens to `earliest–latest` when they do
		// not, so a mixed-reset row still reports when quota comes back.
		row.reset = resolveResetRange(cells, nowMs) ?? "";
		// Accounts sharing a window group usually repeat the same per-limit note
		// (e.g. "Overage requests: 5"); dedupe so it renders once for the row.
		row.notes = [...new Set(cells.flatMap(limit => limit.notes ?? []))];
	}

	const credits: string[] = [];
	for (const report of providerReports) {
		const count = report.resetCredits?.availableCount ?? 0;
		if (count <= 0) continue;
		const expiries = (report.resetCredits?.credits ?? [])
			.map(credit => (credit.expiresAt ? Date.parse(credit.expiresAt) : Number.NaN))
			.filter(expiry => Number.isFinite(expiry));
		const upcoming = expiries.filter(expiry => expiry > nowMs);
		const expired = expiries.length - upcoming.length;
		const detail = [
			upcoming.length > 0 ? `first expires in ${formatDuration(Math.min(...upcoming) - nowMs)}` : "",
			expired > 0 ? `${expired} expired` : "",
		].filter(Boolean);
		credits.push(
			`${formatReportLabel(report, 0)}: ${count} saved reset${count === 1 ? "" : "s"}${detail.length > 0 ? ` (${detail.join(", ")})` : ""} — /usage reset`,
		);
	}

	return {
		provider,
		accounts,
		rows,
		notes: [...new Set(providerReports.flatMap(report => report.notes ?? []))],
		credits,
		unmetered: providerReports
			.filter(report => report.limits.length === 0)
			.map((report, index) => {
				const tier = report.metadata?.planType;
				const suffix = typeof tier === "string" && tier ? ` (${tier})` : "";
				return `${formatReportLabel(report, index)}${suffix} — no limits reported`;
			}),
		status: resolveAggregateStatus(providerReports.flatMap(report => report.limits)),
		modelCount,
	};
}

/**
 * Solve one column geometry for the whole report so every bar is the same
 * length and directly comparable. When the widest provider cannot fit, the
 * label column gives ground first, then the reset column, then the bar itself.
 */
function resolveUsageLayout(blocks: UsageBlock[], availableWidth: number): UsageLayout {
	const columns = blocks.reduce((max, block) => Math.max(max, block.accounts.length), 1);
	const longestTitle = blocks.reduce(
		(max, block) => Math.max(max, ...block.rows.map(row => visibleWidth(row.title))),
		0,
	);
	const longestReset = blocks.reduce(
		(max, block) => Math.max(max, ...block.rows.map(row => visibleWidth(row.reset))),
		0,
	);
	let labelWidth = Math.max(LABEL_WIDTH_MIN, Math.min(LABEL_WIDTH_MAX, longestTitle));
	let resetWidth = longestReset;
	let barWidth = 0;
	for (;;) {
		const fixed = USAGE_INDENT + labelWidth + 2 + (resetWidth > 0 ? resetWidth + 2 : 0) + (columns - 1) * 2;
		barWidth = Math.floor((availableWidth - fixed) / columns) - 1 - PERCENT_WIDTH;
		if (barWidth >= BAR_WIDTH_MIN) break;
		if (labelWidth > LABEL_WIDTH_MIN) {
			labelWidth = Math.max(LABEL_WIDTH_MIN, labelWidth - Math.max(1, BAR_WIDTH_MIN - barWidth));
			continue;
		}
		if (resetWidth > 0) {
			resetWidth = 0;
			continue;
		}
		break;
	}
	// A one- or two-cell bar is decoration, not information: below the legible
	// minimum the cell keeps only the percentage ([#5770](https://github.com/can1357/oh-my-pi/issues/5770)).
	barWidth = barWidth < BAR_WIDTH_MIN ? 0 : Math.min(BAR_WIDTH_MAX, barWidth);
	return { labelWidth, barWidth, resetWidth, cellWidth: barWidth + (barWidth > 0 ? 1 : 0) + PERCENT_WIDTH };
}

export function renderUsageReports(
	reports: UsageReport[],
	uiTheme: typeof theme,
	nowMs: number,
	availableWidth: number,
	resolveActiveAccount?: (provider: string) => OAuthAccountIdentity | undefined,
	usageModelSelectors: readonly string[] = [],
): string {
	const grouped = new Map<string, UsageReport[]>();
	for (const report of reports) {
		const list = grouped.get(report.provider) ?? [];
		list.push(report);
		grouped.set(report.provider, list);
	}
	// Most-pressured provider first: the quota about to run out is the one the
	// user opened `/usage` to find.
	const blocks = Array.from(grouped.entries())
		.map(([provider, providerReports]) =>
			buildUsageBlock(
				provider,
				providerReports,
				nowMs,
				usageModelSelectors.filter(selector => selector.startsWith(`${provider}/`)).length,
			),
		)
		.sort((a, b) => {
			const pressure = (block: UsageBlock): number =>
				block.accounts
					.flatMap(report => report.limits)
					.reduce((max, limit) => Math.max(max, resolveUsedFraction(limit) ?? -1), -1);
			const delta = pressure(b) - pressure(a);
			return delta !== 0 ? delta : a.provider.localeCompare(b.provider);
		});

	const layout = resolveUsageLayout(blocks, availableWidth);
	const latestFetchedAt = Math.max(...reports.map(report => report.fetchedAt ?? 0));
	const accountCount = reports.length;
	const summary = [
		`${blocks.length} provider${blocks.length === 1 ? "" : "s"}`,
		`${accountCount} account${accountCount === 1 ? "" : "s"}`,
		latestFetchedAt ? `updated ${formatDuration(nowMs - latestFetchedAt)} ago` : "",
	].filter(Boolean);
	const lines: string[] = [
		`${uiTheme.bold(uiTheme.fg("accent", "Usage"))} ${uiTheme.fg("dim", `· ${summary.join(" · ")}`)}`,
		uiTheme.fg("dim", `${padding(USAGE_INDENT)}bar shows quota used · percentage shows quota free`),
	];

	for (const block of blocks) {
		const activeAccount = resolveActiveAccount?.(block.provider);
		const isActive = (report: UsageReport): boolean =>
			report.limits.some(limit => limitMatchesActiveAccount(report, limit, activeAccount));
		const labels = formatLegendLabels(block.accounts);
		const heading = `${resolveStatusIcon(block.status, uiTheme)} ${uiTheme.bold(uiTheme.fg("accent", block.provider))}`;
		const modelSuffix =
			block.modelCount > 0 ? ` · ${block.modelCount} model${block.modelCount === 1 ? "" : "s"}` : "";

		lines.push("");
		if (block.accounts.length === 0) {
			// Every account under this provider is limit-less; the rows below are
			// empty, so the heading carries the provider on its own.
			lines.push(`${heading}${modelSuffix ? `  ${uiTheme.fg("dim", modelSuffix.replace(/^ · /, ""))}` : ""}`);
		} else if (block.accounts.length === 1) {
			// One account: fold its label into the heading instead of spending a
			// legend row on a single column. A positional `account 1` placeholder
			// carries no identity, so only a real label is worth the space.
			const report = block.accounts[0]!;
			const label = labels[0] ?? "";
			const named = label !== "account 1";
			const marker = isActive(report) ? `${uiTheme.fg("accent", uiTheme.status.enabled)} ` : "";
			const detail = [named ? label : "", modelSuffix.replace(/^ · /, "")].filter(Boolean).join(" · ");
			lines.push(detail ? `${heading}  ${marker}${uiTheme.fg("dim", detail)}` : heading);
		} else {
			const accountText = `${block.accounts.length} accounts`;
			lines.push(`${heading}  ${uiTheme.fg("dim", `${accountText}${modelSuffix}`)}`);
			// The legend renders once per provider, not once per window row, and
			// sits on the same column offsets the bars use.
			const legend = block.accounts.map((report, index) => {
				const active = isActive(report);
				const text = `${active ? uiTheme.status.enabled : " "} ${truncateJobLabel(labels[index] ?? "", layout.cellWidth - 2)}`;
				return (
					uiTheme.fg(active ? "accent" : "dim", text) + padding(Math.max(0, layout.cellWidth - visibleWidth(text)))
				);
			});
			lines.push(`${padding(USAGE_INDENT + layout.labelWidth + 2)}${legend.join("  ")}`.trimEnd());
		}

		// The active credential is normally flagged with a marker on its own
		// column. When the session's identity matches no reported account — an
		// org-qualified identity against org-less report metadata, for instance —
		// name it explicitly rather than leaving the session unattributed.
		if (activeAccount && !block.accounts.some(isActive)) {
			const sessionLabel = formatActiveAccountLabel(activeAccount);
			if (sessionLabel) {
				lines.push(`${padding(USAGE_INDENT)}${uiTheme.fg("dim", `in use by this session: ${sessionLabel}`)}`);
			}
		}

		for (const row of block.rows) {
			const cells = row.cells.map(limit => {
				if (!limit) return padding(layout.cellWidth);
				if (isUsedOnlyAbsoluteAmount(limit)) {
					return padColumn(
						uiTheme.fg("dim", truncateJobLabel(formatUsedOnlyAmount(limit), layout.cellWidth)),
						layout.cellWidth,
					);
				}
				const fraction = resolveUsedFraction(limit);
				const bar = renderUsageBar(
					fraction ?? 0,
					fraction === undefined ? undefined : limit.status,
					uiTheme,
					layout.barWidth,
				);
				const percent = fraction === undefined ? "—" : formatFreePercent(fraction);
				const color = fraction === undefined ? "dim" : resolveStatusColor(limit.status);
				const value = uiTheme.fg(color === "success" ? "muted" : color, percent);
				const cell = `${bar}${layout.barWidth > 0 ? " " : ""}${padding(PERCENT_WIDTH - percent.length)}${value}`;
				return cell;
			});
			const label = padColumn(truncateJobLabel(row.title, layout.labelWidth), layout.labelWidth);
			const reset = row.reset && layout.resetWidth > 0 ? `  ${uiTheme.fg("dim", row.reset)}` : "";
			lines.push(truncateToWidth(`${padding(USAGE_INDENT)}${label}  ${cells.join("  ")}${reset}`, availableWidth));
			// Per-window notes (e.g. "Overage requests: 5") hang under their row.
			if (row.notes.length > 0) {
				const notes = row.notes.map(note => note.replace(/[\r\n]+/g, " ")).join(" • ");
				lines.push(
					`${padding(USAGE_INDENT * 2)}${uiTheme.fg("dim", replaceTabs(truncateToWidth(sanitizeText(notes), availableWidth - USAGE_INDENT * 2)))}`.trimEnd(),
				);
			}
		}

		// Provider-wide disclaimers (e.g. "OMP-observed spend only") render once
		// below the rows instead of duplicating onto every limit.
		if (block.notes.length > 0) {
			const notes = block.notes.map(note => note.replace(/[\r\n]+/g, " ")).join(" • ");
			lines.push(
				`${padding(USAGE_INDENT)}${uiTheme.fg("dim", replaceTabs(truncateToWidth(sanitizeText(notes), availableWidth - USAGE_INDENT)))}`.trimEnd(),
			);
		}
		for (const credit of block.credits) {
			lines.push(
				`${padding(USAGE_INDENT)}${uiTheme.fg("dim", truncateToWidth(credit, availableWidth - USAGE_INDENT))}`,
			);
		}
		// Accounts with no rate limits (e.g. business/enterprise plans).
		for (const account of block.unmetered) {
			lines.push(
				`${padding(USAGE_INDENT)}${uiTheme.fg("dim", truncateToWidth(account, availableWidth - USAGE_INDENT))}`,
			);
		}
	}

	// Single guard for every line kind — headings, legends, notes and rows all
	// stay inside the terminal even when the solver has already hit its floors.
	return lines.map(line => truncateToWidth(line, availableWidth)).join("\n");
}

/**
 * `/usage models` body: every model selector whose provider reports live usage,
 * grouped by provider. The default `/usage` view only carries the per-provider
 * count so the quota bars are not buried under a model roster.
 */
export function renderUsageModelRoster(
	uiTheme: typeof theme,
	usageModelSelectors: readonly string[],
	availableWidth: number,
): string {
	if (usageModelSelectors.length === 0) {
		return uiTheme.fg("dim", "No models are mapped to a live usage report.");
	}
	const byProvider = new Map<string, string[]>();
	for (const selector of usageModelSelectors) {
		const slash = selector.indexOf("/");
		const provider = slash > 0 ? selector.slice(0, slash) : selector;
		const model = slash > 0 ? selector.slice(slash + 1) : selector;
		const models = byProvider.get(provider) ?? [];
		models.push(model);
		byProvider.set(provider, models);
	}
	const total = usageModelSelectors.length;
	const lines = [
		`${uiTheme.bold(uiTheme.fg("accent", "Models with usage data"))} ${uiTheme.fg("dim", `· ${total} model${total === 1 ? "" : "s"}`)}`,
	];
	for (const [provider, models] of [...byProvider.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
		lines.push("");
		lines.push(`${uiTheme.fg("accent", provider)} ${uiTheme.fg("dim", `(${models.length})`)}`);
		for (const model of models) {
			lines.push(
				`${padding(USAGE_INDENT)}${replaceTabs(truncateToWidth(sanitizeText(model), availableWidth - USAGE_INDENT))}`,
			);
		}
	}
	return lines.join("\n");
}
