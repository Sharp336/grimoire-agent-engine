/**
 * Ollama Cloud usage provider.
 *
 * Fetches quota usage via the `ollama-usage` CLI tool using the
 * `OLLAMA_BROWSER_COOKIE` environment variable.
 *
 * Prerequisites:
 * 1. `ollama-usage` CLI tool available on PATH
 * 2. `OLLAMA_BROWSER_COOKIE` environment variable set
 *
 * If either prerequisite is missing, returns a report with a note
 * explaining what's needed rather than failing silently.
 */

import type {
	UsageAmount,
	UsageFetchContext,
	UsageFetchParams,
	UsageLimit,
	UsageProvider,
	UsageReport,
	UsageStatus,
	UsageWindow,
} from "../usage";

const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

interface OllamaUsageJson {
	plan: string;
	session: {
		used_pct: number;
		resets_at: string;
	};
	weekly: {
		used_pct: number;
		resets_at: string;
	};
}

function parseIsoTime(value: string | undefined): number | undefined {
	if (!value) return undefined;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function buildAmount(usedPct: number | undefined): UsageAmount {
	if (usedPct === undefined || !Number.isFinite(usedPct)) {
		return { unit: "percent" };
	}
	const clamped = Math.min(Math.max(usedPct, 0), 100);
	const usedFraction = clamped / 100;
	return {
		used: clamped,
		limit: 100,
		remaining: Math.max(0, 100 - clamped),
		usedFraction,
		remainingFraction: Math.max(0, 1 - usedFraction),
		unit: "percent",
	};
}

function deriveStatus(amount: UsageAmount): UsageStatus | undefined {
	if (amount.usedFraction === undefined) return undefined;
	if (amount.usedFraction >= 1) return "exhausted";
	if (amount.usedFraction >= 0.9) return "warning";
	return "ok";
}

function buildLimit(args: {
	id: string;
	label: string;
	windowId: string;
	windowLabel: string;
	durationMs: number;
	usedPct: number | undefined;
	resetsAt: number | undefined;
	plan: string;
}): UsageLimit | null {
	const amount = buildAmount(args.usedPct);
	const window: UsageWindow = {
		id: args.windowId,
		label: args.windowLabel,
		durationMs: args.durationMs,
		...(args.resetsAt !== undefined ? { resetsAt: args.resetsAt } : {}),
	};
	return {
		id: args.id,
		label: args.label,
		scope: {
			provider: "ollama-cloud",
			windowId: args.windowId,
			tier: args.plan,
		},
		window,
		amount,
		status: deriveStatus(amount),
	};
}

function checkOllamaUsageAvailable(): boolean {
	try {
		const result = Bun.spawnSync(["ollama-usage", "--version"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		return result.exitCode === 0;
	} catch {
		return false;
	}
}

function getBrowserCookie(): string | undefined {
	return Bun.env.OLLAMA_BROWSER_COOKIE?.trim() || undefined;
}

async function fetchOllamaUsageOutput(cookie: string): Promise<OllamaUsageJson> {
	const proc = Bun.spawn(["ollama-usage", "--cookie", cookie, "--json"], {
		stdout: "pipe",
		stderr: "pipe",
	});

	const exitCode = await proc.exited;
	if (exitCode !== 0) {
		const stderr = await new Response(proc.stderr).text();
		throw new Error(`ollama-usage exited with code ${exitCode}: ${stderr.trim()}`);
	}

	const stdout = await new Response(proc.stdout).text();
	return JSON.parse(stdout) as OllamaUsageJson;
}

function buildPrereqNote(): string {
	const parts: string[] = [];
	if (!checkOllamaUsageAvailable()) {
		parts.push("install ollama-usage CLI (pip install git+https://github.com/florian-croiset/ollama-usage)");
	}
	if (!getBrowserCookie()) {
		parts.push("set OLLAMA_BROWSER_COOKIE env var (See https://github.com/florian-croiset/ollama-usage?tab=readme-ov-file#finding-your-cookie-manually for info.");
	}
	return parts.length > 0 ? `Requires: ${parts.join(" and ")}` : "";
}

function buildPrereqReport(): UsageReport {
	const note = buildPrereqNote();
	return {
		provider: "ollama-cloud",
		fetchedAt: Date.now(),
		limits: [],
		metadata: {
			note,
		},
	};
}

async function fetchOllamaCloudUsage(_params: UsageFetchParams, _ctx: UsageFetchContext): Promise<UsageReport | null> {
	const cookie = getBrowserCookie();
	const cliAvailable = checkOllamaUsageAvailable();

	if (!cliAvailable || !cookie) {
		return buildPrereqReport();
	}

	let output: OllamaUsageJson;
	try {
		output = await fetchOllamaUsageOutput(cookie);
	} catch (error) {
		// If the CLI fails, return a report with the error as a note
		return {
			provider: "ollama-cloud",
			fetchedAt: Date.now(),
			limits: [],
			metadata: {
				note: `Failed to fetch usage: ${error instanceof Error ? error.message : String(error)}`,
			},
		};
	}

	const plan = output.plan ?? "unknown";
	const sessionResetsAt = parseIsoTime(output.session?.resets_at);
	const weeklyResetsAt = parseIsoTime(output.weekly?.resets_at);

	const limits = [
		buildLimit({
			id: "ollama-cloud:session",
			label: "Session Usage",
			windowId: "session",
			windowLabel: "Session",
			durationMs: FIVE_HOURS_MS,
			usedPct: output.session?.used_pct,
			resetsAt: sessionResetsAt,
			plan,
		}),
		buildLimit({
			id: "ollama-cloud:weekly",
			label: "Weekly Usage",
			windowId: "weekly",
			windowLabel: "Weekly",
			durationMs: SEVEN_DAYS_MS,
			usedPct: output.weekly?.used_pct,
			resetsAt: weeklyResetsAt,
			plan,
		}),
	].filter((limit): limit is UsageLimit => limit !== null);

	return {
		provider: "ollama-cloud",
		fetchedAt: Date.now(),
		limits,
		metadata: {
			planType: plan,
		},
		raw: output,
	};
}

export const ollamaCloudUsageProvider: UsageProvider = {
	id: "ollama-cloud",
	supports: ({ provider }) => provider === "ollama-cloud",
	fetchUsage: fetchOllamaCloudUsage,
};
