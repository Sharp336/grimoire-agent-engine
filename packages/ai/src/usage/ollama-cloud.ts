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

const OLLAMA_USAGE_REPO = "https://github.com/1ts-Alec/ollama-usage";
const MAX_STDERR_LENGTH = 200;

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

function isValidUsageJson(value: unknown): value is OllamaUsageJson {
	if (typeof value !== "object" || value === null) return false;
	const obj = value as Record<string, unknown>;
	if (typeof obj.plan !== "string") return false;
	for (const key of ["session", "weekly"] as const) {
		const bucket = obj[key];
		if (typeof bucket !== "object" || bucket === null) return false;
		const b = bucket as Record<string, unknown>;
		if (typeof b.used_pct !== "number") return false;
		if (typeof b.resets_at !== "string") return false;
	}
	return true;
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

let ollamaUsageAvailable: boolean | undefined;

async function checkOllamaUsageAvailable(): Promise<boolean> {
	if (ollamaUsageAvailable !== undefined) return ollamaUsageAvailable;
	try {
		const proc = Bun.spawn(["ollama-usage", "--version"], {
			stdout: "ignore",
			stderr: "ignore",
		});
		const exitCode = await proc.exited;
		ollamaUsageAvailable = exitCode === 0;
	} catch {
		ollamaUsageAvailable = false;
	}
	return ollamaUsageAvailable;
}

function getBrowserCookie(): string | undefined {
	return Bun.env.OLLAMA_BROWSER_COOKIE?.trim() || undefined;
}

// The cookie is passed via OLLAMA_BROWSER_COOKIE env var — never as a CLI
// argument, which would be visible in the process list to all local users.
async function fetchOllamaUsageOutput(cookie: string): Promise<OllamaUsageJson> {
	const proc = Bun.spawn(["ollama-usage", "--json"], {
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, OLLAMA_BROWSER_COOKIE: cookie },
	});

	const exitCode = await proc.exited;
	if (exitCode !== 0) {
		const stderr = await new Response(proc.stderr).text();
		const sanitized = stderr
			.trim()
			.slice(0, MAX_STDERR_LENGTH)
			.replaceAll(/[\t\r]/g, " ");
		throw new Error(`ollama-usage exited with code ${exitCode}: ${sanitized}`);
	}

	const stdout = await new Response(proc.stdout).text();
	const parsed: unknown = JSON.parse(stdout);
	if (!isValidUsageJson(parsed)) {
		throw new Error("ollama-usage returned unexpected JSON shape");
	}
	return parsed;
}

async function buildPrereqNote(): Promise<string> {
	const parts: string[] = [];
	if (!(await checkOllamaUsageAvailable())) {
		parts.push(`install ollama-usage CLI (pip install git+${OLLAMA_USAGE_REPO})`);
	}
	if (!getBrowserCookie()) {
		parts.push(
			`set OLLAMA_BROWSER_COOKIE env var (see ${OLLAMA_USAGE_REPO}?tab=readme-ov-file#finding-your-cookie-manually for info)`,
		);
	}
	return parts.length > 0 ? `Requires: ${parts.join(" and ")}` : "";
}

async function buildPrereqReport(): Promise<UsageReport> {
	const note = await buildPrereqNote();
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
	const cliAvailable = await checkOllamaUsageAvailable();

	if (!cliAvailable || !cookie) {
		return buildPrereqReport();
	}

	let output: OllamaUsageJson;
	try {
		output = await fetchOllamaUsageOutput(cookie);
	} catch (error) {
		return {
			provider: "ollama-cloud",
			fetchedAt: Date.now(),
			limits: [],
			metadata: {
				note: `Failed to fetch usage: ${error instanceof Error ? error.message : String(error)}`,
			},
		};
	}

	const plan = output.plan;
	const sessionResetsAt = parseIsoTime(output.session.resets_at);
	const weeklyResetsAt = parseIsoTime(output.weekly.resets_at);

	const limits = [
		buildLimit({
			id: "ollama-cloud:session",
			label: "Session Usage",
			windowId: "session",
			windowLabel: "Session",
			durationMs: FIVE_HOURS_MS,
			usedPct: output.session.used_pct,
			resetsAt: sessionResetsAt,
			plan,
		}),
		buildLimit({
			id: "ollama-cloud:weekly",
			label: "Weekly Usage",
			windowId: "weekly",
			windowLabel: "Weekly",
			durationMs: SEVEN_DAYS_MS,
			usedPct: output.weekly.used_pct,
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
