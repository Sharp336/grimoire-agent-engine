import * as path from "node:path";
import type { OAuthCredential, UsageReport } from "@oh-my-pi/pi-ai";
import { extractCursorAccessTokenUserId } from "@oh-my-pi/pi-ai/oauth/cursor";
import { ptree } from "@oh-my-pi/pi-utils";
import { getAgentDbPath } from "@oh-my-pi/pi-utils/dirs";
import { AuthStorage, SqliteAuthCredentialStore } from "../session/auth-storage";
import { exactCredentialStore, isClaimedOAuthCredential } from "./execution-resolver";
import type { RocksEngineMutations } from "./rocks-store";

type Account = { provider_id: string; external_id: string | null; pools: Array<{ pool_id: string }>;
	quota_windows: Array<{ window_id: string; window_seconds: number }> };
type Credential = { method: "api_key"; value: string } | { method: "oauth"; store: "local_omp";
	agentDir: string; accountId: string; credentialId: number } | null;
type Observation = { metric: string; dimension: "pool" | "quota_window"; dimension_id: string;
	value: number | string; unit: string | null; observed_at: string; resets_at: string | null;
	window_start: string | null; window_end: string | null };
type Probe = { principalId: string; accountRef: string; kind: "builtin" | "module";
	builtinId?: string; builtinVersion?: number; bindingRevision?: number; account: Account; credential: Credential };
type LocalOAuth = { store: SqliteAuthCredentialStore; credential: OAuthCredential };
const metrics: Record<string, true> = {
	quota_remaining: true, exhausted: true, hard_denial: true, cash_balance_usd: true,
	aggregate_spend_usd: true, package_remaining: true, package_resets_at: true,
	package_expires_at: true, request_count: true, inventory_model_count: true,
};
const observationFields: Record<string, true> = {
	metric: true, dimension: true, dimension_id: true, value: true, unit: true,
	resets_at: true, window_start: true, window_end: true,
};
const failure = (status: string) => ({ status, observations: [] as Observation[] });
const codexLimitId = /^openai-codex:(?:primary|secondary|[a-z0-9-]+:(?:primary|secondary))$/;
/** Exact builtin readers: each reads only its claimed local OMP OAuth row of one provider. */
const BUILTIN_PROVIDERS: Record<string, string> = {
	openai_codex_usage: "openai-codex",
	anthropic_claude_usage: "anthropic",
	cursor_usage: "cursor",
};

function validObservation(item: unknown, account: Account, observedAt: string): Observation | null {
	if (!item || typeof item !== "object" || Array.isArray(item)) return null;
	const row = item as Record<string, unknown>;
	if (Object.keys(row).some(key => !observationFields[key]) ||
		!["metric", "dimension", "dimension_id", "value", "unit", "resets_at", "window_start", "window_end"].every(key => key in row) ||
		typeof row.metric !== "string" || !metrics[row.metric] ||
		(row.dimension !== "pool" && row.dimension !== "quota_window") || typeof row.dimension_id !== "string" ||
		!(row.dimension === "pool" ? account.pools.some(pool => pool.pool_id === row.dimension_id)
			: account.quota_windows.some(window => window.window_id === row.dimension_id)) ||
		!(row.metric === "package_resets_at" || row.metric === "package_expires_at"
			? typeof row.value === "string" && Number.isFinite(Date.parse(row.value))
			: typeof row.value === "number" && Number.isFinite(row.value)) ||
		(["hard_denial", "exhausted"].includes(row.metric) && row.value !== 0 && row.value !== 1) ||
		!(row.unit === null || ["fraction", "usd", "requests", "tokens"].includes(row.unit as string)) ||
		!["resets_at", "window_start", "window_end"].every(key => row[key] === null || typeof row[key] === "string" && Number.isFinite(Date.parse(row[key])))) return null;
	return { metric: row.metric, dimension: row.dimension, dimension_id: row.dimension_id,
		value: row.value as number | string, unit: row.unit as string | null, observed_at: observedAt,
		resets_at: row.resets_at as string | null, window_start: row.window_start as string | null,
		window_end: row.window_end as string | null };
}

async function localOAuth(provider: string, credential: Extract<Credential, { method: "oauth" }>) {
	if (!path.isAbsolute(credential.agentDir) || !Number.isSafeInteger(credential.credentialId) || credential.credentialId < 1)
		return null;
	const store = await SqliteAuthCredentialStore.open(getAgentDbPath(credential.agentDir));
	try {
		const selected = store.listAuthCredentials(provider).find(item => item.id === credential.credentialId &&
			item.credential.type === "oauth" && isClaimedOAuthCredential(provider, item.credential, credential.accountId));
		if (!selected) { store.close(); return null; }
		return { store, credential: selected.credential as OAuthCredential };
	} catch (error) {
		store.close();
		throw error;
	}
}

/** The report answers for the claimed account only when the provider's own identity matches the claim. */
function sameAccount(provider: string, report: UsageReport, credential: OAuthCredential, accountId: string): boolean {
	if (provider === "cursor") return extractCursorAccessTokenUserId(credential.access) === accountId;
	return report.metadata?.accountId === accountId;
}

/** A quota window is the limit with its exact id and the same window duration; no fraction is guessed. */
function matchingWindow(provider: string, report: UsageReport, window: Account["quota_windows"][number]) {
	return report.limits.find(item => item.id === window.window_id &&
		(provider === "openai-codex" ? codexLimitId.test(item.id) : item.id.startsWith(`${provider}:`)) &&
		item.window?.durationMs === window.window_seconds * 1000);
}

/** A pool is the limit with its exact id (Claude extra usage, Cursor spend and request rails). */
function matchingPool(provider: string, report: UsageReport, pool: Account["pools"][number]) {
	return report.limits.find(item => item.id === pool.pool_id && item.id.startsWith(`${provider}:`));
}

async function builtin(builtinId: string, account: Account, credential: Credential, signal?: AbortSignal) {
	const provider = BUILTIN_PROVIDERS[builtinId];
	if (!provider || !credential || credential.method !== "oauth" || account.provider_id !== provider)
		return failure("builtin_unsupported");
	const local = await localOAuth(provider, credential).catch(() => null);
	if (!local) return failure("credential_unavailable_on_device");
	let storage: AuthStorage;
	try {
		storage = new AuthStorage(exactCredentialStore(local.store, provider, credential.credentialId));
	} catch {
		local.store.close();
		return failure("unavailable");
	}
	try {
		await storage.reload();
		const report = await storage.fetchCredentialUsageReport(provider, credential.credentialId, { signal });
		if (!report || report.provider !== provider || !Number.isFinite(report.fetchedAt)) return failure("unavailable");
		if (!sameAccount(provider, report, local.credential, credential.accountId))
			return failure("account_identity_mismatch");
		const meterStates = report.metadata?.meterStates as Record<string, { allowed?: boolean; limitReached?: boolean }> | undefined;
		const observedAt = new Date(report.fetchedAt).toISOString();
		const observations: Observation[] = [];
		for (const window of account.quota_windows) {
			const limit = matchingWindow(provider, report, window);
			if (!limit) continue;
			let exhausted = limit.status === "exhausted";
			if (provider === "openai-codex") {
				const prefix: string = limit.id.slice("openai-codex:".length).replace(/:(?:primary|secondary)$/, "");
				const meter = prefix === "primary" || prefix === "secondary" ? "chat" : prefix;
				exhausted ||= meterStates?.[meter]?.allowed === false && meterStates[meter]?.limitReached === true;
			}
			const resets_at = limit.window?.resetsAt === undefined ? null : new Date(limit.window.resetsAt).toISOString();
			const base = { dimension: "quota_window" as const, dimension_id: window.window_id,
				observed_at: observedAt, resets_at, window_start: null, window_end: null };
			if (typeof limit.amount.remainingFraction === "number" && Number.isFinite(limit.amount.remainingFraction))
				observations.push({ ...base, metric: "quota_remaining", value: limit.amount.remainingFraction, unit: "fraction" });
			if (exhausted) observations.push({ ...base, metric: "exhausted", value: 1, unit: null });
		}
		// Pools carry what the provider actually reports: USD spent or requests used, never a
		// fraction standing in for them. Percent-only rails have no pool metric and are omitted.
		for (const pool of account.pools) {
			const limit = matchingPool(provider, report, pool);
			if (!limit || !Number.isFinite(limit.amount.used)) continue;
			const resets_at = limit.window?.resetsAt === undefined ? null : new Date(limit.window.resetsAt).toISOString();
			const base = { dimension: "pool" as const, dimension_id: pool.pool_id,
				observed_at: observedAt, resets_at, window_start: null, window_end: null };
			if (limit.amount.unit === "usd")
				observations.push({ ...base, metric: "aggregate_spend_usd", value: limit.amount.used!, unit: "usd" });
			else if (limit.amount.unit === "requests")
				observations.push({ ...base, metric: "request_count", value: limit.amount.used!, unit: "requests" });
			else continue;
			if (limit.status === "exhausted") observations.push({ ...base, metric: "exhausted", value: 1, unit: null });
		}
		return { status: "ready", observations };
	} catch {
		return failure("unavailable");
	} finally {
		storage.close();
	}
}

async function moduleProbe(modulePath: string, accountRef: string, account: Account, credential: Credential, signal?: AbortSignal) {
	if (process.platform === "win32" && path.extname(modulePath).toLowerCase() !== ".exe") return failure("module_not_executable");
	let moduleCredential: { method: "api_key"; value: string } | { method: "oauth"; access_token: string } | null = null;
	let opened: LocalOAuth | null = null;
	if (credential?.method === "api_key") moduleCredential = credential;
	if (credential?.method === "oauth") {
		opened = await localOAuth(account.provider_id, credential).catch(() => null);
		if (!opened) return failure("credential_unavailable_on_device");
		moduleCredential = { method: "oauth", access_token: opened.credential.access };
	}
	try {
		const input = JSON.stringify({ schema: "grimoire.usage_probe.input.v1",
			account: { account_ref: accountRef, provider_id: account.provider_id, external_id: account.external_id },
			pools: account.pools, quota_windows: account.quota_windows, credential: moduleCredential });
		using proc = ptree.spawn([modulePath], { cwd: path.dirname(modulePath), stdin: Buffer.from(input),
			env: { PATH: process.env.PATH ?? "", SYSTEMROOT: process.env.SYSTEMROOT ?? "",
				TEMP: process.env.TEMP ?? "", TMP: process.env.TMP ?? "" },
			signal: ptree.combineSignals(signal, 10_000) });
		const chunks: Uint8Array[] = [];
		let bytes = 0;
		for await (const chunk of proc.stdout) {
			bytes += chunk.byteLength;
			if (bytes > 65_536) {
				proc.kill();
				await proc.exited.catch(() => {});
				return failure("invalid_output");
			}
			chunks.push(chunk);
		}
		if ((await proc.exited) !== 0) return failure("module_failed");
		let value: unknown;
		try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))); }
		catch { return failure("invalid_output"); }
		if (!value || typeof value !== "object" || Array.isArray(value)) return failure("invalid_output");
		const row = value as Record<string, unknown>;
		if (Object.keys(row).some(key => !["schema", "observed_at", "observations"].includes(key)) ||
			Object.keys(row).length !== 3 || row.schema !== "grimoire.usage_probe.output.v1" ||
			typeof row.observed_at !== "string" || !Number.isFinite(Date.parse(row.observed_at)) ||
			!Array.isArray(row.observations) || row.observations.length > 256) return failure("invalid_output");
		const observations = row.observations.map(item => validObservation(item, account, row.observed_at as string));
		return observations.every(item => item !== null)
			? { status: "ready", observations: observations as Observation[] } : failure("invalid_output");
	} catch {
		return failure(signal?.aborted ? "cancelled" : "module_failed");
	} finally {
		opened?.store.close();
	}
}

export async function runUsageProbe(store: RocksEngineMutations, deviceId: string, raw: Record<string, unknown>, signal?: AbortSignal) {
	if (signal?.aborted) return failure("cancelled");
	const input = raw as Partial<Probe>;
	if (!input.principalId || !input.accountRef || !input.account ||
		!Array.isArray(input.account.pools) || !Array.isArray(input.account.quota_windows)) return failure("invalid_request");
	if (input.kind === "builtin") {
		if (!input.builtinId || !BUILTIN_PROVIDERS[input.builtinId] || input.builtinVersion !== 1)
			return failure("builtin_unsupported");
		return builtin(input.builtinId, input.account, input.credential ?? null, signal);
	}
	if (input.kind !== "module" || !Number.isSafeInteger(input.bindingRevision)) return failure("invalid_request");
	const binding = await store.getUsageProbeBinding(input.principalId, deviceId, input.accountRef);
	if (!binding.modulePath || binding.revision !== input.bindingRevision) return failure("probe_unconfigured");
	return moduleProbe(binding.modulePath, input.accountRef, input.account, input.credential ?? null, signal);
}
