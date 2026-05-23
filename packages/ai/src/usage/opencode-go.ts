import * as os from "node:os";
import * as path from "node:path";
import type { UsageFetchContext, UsageFetchParams, UsageLimit, UsageProvider, UsageReport } from "../usage";

const DASHBOARD_URL_PREFIX = "https://opencode.ai/workspace/";
const DASHBOARD_URL_SUFFIX = "/go";
const USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142 Safari/537.36";

const SCRAPED_NUMBER_PATTERN = String.raw`(-?\d+(?:\.\d+)?)`;

const WINDOW_PATTERNS = {
	rolling: {
		id: "5h",
		label: "5 Hour",
		field: "rollingUsage",
		pctFirst: new RegExp(
			String.raw`rollingUsage:\$R\[\d+\]=\{[^}]*usagePercent:${SCRAPED_NUMBER_PATTERN}[^}]*resetInSec:${SCRAPED_NUMBER_PATTERN}[^}]*\}`,
		),
		resetFirst: new RegExp(
			String.raw`rollingUsage:\$R\[\d+\]=\{[^}]*resetInSec:${SCRAPED_NUMBER_PATTERN}[^}]*usagePercent:${SCRAPED_NUMBER_PATTERN}[^}]*\}`,
		),
	},
	weekly: {
		id: "weekly",
		label: "Weekly",
		field: "weeklyUsage",
		pctFirst: new RegExp(
			String.raw`weeklyUsage:\$R\[\d+\]=\{[^}]*usagePercent:${SCRAPED_NUMBER_PATTERN}[^}]*resetInSec:${SCRAPED_NUMBER_PATTERN}[^}]*\}`,
		),
		resetFirst: new RegExp(
			String.raw`weeklyUsage:\$R\[\d+\]=\{[^}]*resetInSec:${SCRAPED_NUMBER_PATTERN}[^}]*usagePercent:${SCRAPED_NUMBER_PATTERN}[^}]*\}`,
		),
	},
	monthly: {
		id: "monthly",
		label: "Monthly",
		field: "monthlyUsage",
		pctFirst: new RegExp(
			String.raw`monthlyUsage:\$R\[\d+\]=\{[^}]*usagePercent:${SCRAPED_NUMBER_PATTERN}[^}]*resetInSec:${SCRAPED_NUMBER_PATTERN}[^}]*\}`,
		),
		resetFirst: new RegExp(
			String.raw`monthlyUsage:\$R\[\d+\]=\{[^}]*resetInSec:${SCRAPED_NUMBER_PATTERN}[^}]*usagePercent:${SCRAPED_NUMBER_PATTERN}[^}]*\}`,
		),
	},
} as const;

type WindowKey = keyof typeof WINDOW_PATTERNS;

interface OpenCodeGoConfig {
	workspaceId: string;
	authCookie: string;
}

interface ScrapedWindowUsage {
	usagePercent: number;
	resetInSec: number;
}

function parseWindowUsage(html: string, pctFirst: RegExp, resetFirst: RegExp): ScrapedWindowUsage | undefined {
	const pctMatch = pctFirst.exec(html);
	if (pctMatch) {
		const usagePercent = Number(pctMatch[1]);
		const resetInSec = Number(pctMatch[2]);
		if (Number.isFinite(usagePercent) && Number.isFinite(resetInSec)) return { usagePercent, resetInSec };
	}

	const resetMatch = resetFirst.exec(html);
	if (resetMatch) {
		const resetInSec = Number(resetMatch[1]);
		const usagePercent = Number(resetMatch[2]);
		if (Number.isFinite(usagePercent) && Number.isFinite(resetInSec)) return { usagePercent, resetInSec };
	}

	return undefined;
}

function readConfigFromEnv(): OpenCodeGoConfig | undefined {
	const workspaceId = process.env.OPENCODE_GO_WORKSPACE_ID?.trim();
	const authCookie = process.env.OPENCODE_GO_AUTH_COOKIE?.trim();
	if (workspaceId && authCookie) return { workspaceId, authCookie };
	return undefined;
}

function getConfigCandidatePaths(): string[] {
	const configHome = process.env.XDG_CONFIG_HOME?.trim() || path.join(os.homedir(), ".config");
	return [path.join(configHome, "opencode", "opencode-quota", "opencode-go.json")];
}

async function readConfigFromFile(): Promise<OpenCodeGoConfig | undefined> {
	for (const configPath of getConfigCandidatePaths()) {
		try {
			const parsed = (await Bun.file(configPath).json()) as Record<string, unknown>;
			const workspaceId = typeof parsed.workspaceId === "string" ? parsed.workspaceId.trim() : "";
			const authCookie = typeof parsed.authCookie === "string" ? parsed.authCookie.trim() : "";
			if (workspaceId && authCookie) return { workspaceId, authCookie };
		} catch {
			// Missing/invalid config just means this optional provider is unavailable.
		}
	}
	return undefined;
}

async function resolveConfig(params: UsageFetchParams): Promise<OpenCodeGoConfig | undefined> {
	const envConfig = readConfigFromEnv();
	if (envConfig) return envConfig;

	const metadata = params.credential.metadata;
	const workspaceId = typeof metadata?.workspaceId === "string" ? metadata.workspaceId.trim() : "";
	const metadataCookie = typeof metadata?.authCookie === "string" ? metadata.authCookie.trim() : "";
	const authCookie = metadataCookie || params.credential.apiKey?.trim() || "";
	if (workspaceId && authCookie) return { workspaceId, authCookie };

	return readConfigFromFile();
}

function buildLimit(key: WindowKey, usage: ScrapedWindowUsage, nowMs: number): UsageLimit {
	const spec = WINDOW_PATTERNS[key];
	const used = Math.max(0, usage.usagePercent);
	const remaining = Math.max(0, 100 - used);
	const usedFraction = used / 100;
	const remainingFraction = remaining / 100;
	return {
		id: `opencode-go-${spec.id}`,
		label: "OpenCode Go",
		scope: { provider: "opencode-go", windowId: spec.id },
		window: { id: spec.id, label: spec.label, resetsAt: nowMs + Math.max(0, usage.resetInSec) * 1000 },
		amount: { used, limit: 100, remaining, usedFraction, remainingFraction, unit: "percent" },
		status: remainingFraction <= 0 ? "exhausted" : remainingFraction <= 0.2 ? "warning" : "ok",
	};
}

export async function fetchOpenCodeGoUsage(
	params: UsageFetchParams,
	ctx: UsageFetchContext,
): Promise<UsageReport | null> {
	if (params.provider !== "opencode-go") return null;
	const config = await resolveConfig(params);
	if (!config) return null;

	const response = await ctx.fetch(
		`${DASHBOARD_URL_PREFIX}${encodeURIComponent(config.workspaceId)}${DASHBOARD_URL_SUFFIX}`,
		{
			method: "GET",
			headers: {
				"User-Agent": USER_AGENT,
				Accept: "text/html",
				Cookie: `auth=${config.authCookie}`,
			},
			signal: params.signal,
		},
	);
	if (!response.ok) {
		ctx.logger?.debug("OpenCode Go dashboard returned non-OK status", { status: response.status });
		return null;
	}

	const html = await response.text();
	const nowMs = Date.now();
	const limits = (Object.keys(WINDOW_PATTERNS) as WindowKey[])
		.map(key => {
			const spec = WINDOW_PATTERNS[key];
			const parsed = parseWindowUsage(html, spec.pctFirst, spec.resetFirst);
			return parsed ? buildLimit(key, parsed, nowMs) : undefined;
		})
		.filter((limit): limit is UsageLimit => limit !== undefined);
	if (limits.length === 0) return null;

	return {
		provider: "opencode-go",
		fetchedAt: nowMs,
		limits,
		metadata: { workspaceId: config.workspaceId },
	};
}

export const opencodeGoUsageProvider: UsageProvider = {
	id: "opencode-go",
	fetchUsage: fetchOpenCodeGoUsage,
	supports: params => params.provider === "opencode-go",
};

export const _test = { parseWindowUsage };
