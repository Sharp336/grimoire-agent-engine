/**
 * Report engine for `omp doctor`.
 *
 * Collects findings across environment, tools, storage, and plugins, renders
 * the human or JSON report, and owns the single stdout write — the command
 * wrapper stays thin. Mirrors the gc-cli.ts / stats-cli.ts split.
 */
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type AuthBrokerClientConfig, resolveAuthBrokerConfig } from "@oh-my-pi/pi-ai/auth-broker/discover";
import { isSqliteBusyError } from "@oh-my-pi/pi-ai/auth-storage";
import {
	$which,
	formatBytes,
	getAgentDbPath,
	getAgentDir,
	getCustomThemesDir,
	getProjectDir,
	isEnoent,
	MAIN_CONFIG_FILENAMES,
	parseFrontmatter,
	tryParseJson,
	VERSION,
} from "@oh-my-pi/pi-utils";
import { type } from "arktype";
import { JSONC, YAML } from "bun";
import { watchdogYamlSchema } from "../advisor/config";
import { collectConfigCandidates } from "../advisor/watchdog";
import { type Hook, hookCapability } from "../capability/hook";
import { type MCPServer, mcpCapability } from "../capability/mcp";
import type { LoadResult } from "../config/config-file";
import { KEYBINDINGS, KeybindingsManager, resolveKeybindingsConfigPaths } from "../config/keybindings";
import { ModelsConfigFile } from "../config/models-config";
import { classifySettingsYaml, type YamlLoadResult } from "../config/settings";
import { collectSystemInfo, formatSystemInfo } from "../debug/system-info";
import { loadCapability } from "../discovery";
import { type ParsedAgentFields, parseAgentFields } from "../discovery/helpers";
import { listOmpExtensionRoots } from "../discovery/omp-extension-roots";
import { readExtensionManifest } from "../extensibility/extensions/loader";
import { PluginManager } from "../extensibility/plugins/manager";
import type { DoctorCheck } from "../extensibility/plugins/types";
import { convertToLegacyConfig, validateServerConfig } from "../mcp/config";
import type { MCPServerConfig } from "../mcp/types";
import { theme, themeJsonSchema } from "../modes/theme/theme";
import { loadBundledAgents } from "../task/agents";
import { readChromiumEnvOverride, resolveSystemChromium } from "../tools/browser/launch";
import { BUILTIN_TOOL_NAMES, HIDDEN_TOOL_NAMES } from "../tools/builtin-names";
import { replaceTabs, shortenPath, TRUNCATE_LENGTHS, truncateToWidth } from "../tools/render-utils";
import {
	type DbProbe,
	type DbRepair,
	probeDatabase,
	probeSqliteRecoverCapability,
	recoverInterruptedSwap,
	repairDatabase,
	resolveDoctorDatabases,
	vacuumEligible,
} from "./doctor-sqlite";
import { withGcLock } from "./gc-cli";

export type DoctorStatus = "ok" | "warning" | "error";

export type DoctorCategory =
	| "environment"
	| "config"
	| "tools"
	| "storage"
	| "mcp"
	| "browser"
	| "auth"
	| "setup"
	| "plugins";

export interface DoctorFinding {
	/** Stable dotted id, e.g. "storage.history.db" or "tools.git". */
	id: string;
	category: DoctorCategory;
	status: DoctorStatus;
	summary: string;
	details: string[];
	remedy?: string;
	/** Present only on `--fix` runs where this finding was repaired. */
	fixed?: boolean;
}

export interface DoctorCommandFlags {
	json?: boolean;
	fix?: boolean;
	agentDir?: string;
}

export interface DoctorCommandArgs {
	flags: DoctorCommandFlags;
}

export interface DoctorReport {
	schemaVersion: 1;
	generatedAt: string;
	ompVersion: string;
	fix: boolean;
	overallStatus: DoctorStatus;
	findings: DoctorFinding[];
}

const CATEGORY_ORDER: readonly DoctorCategory[] = [
	"environment",
	"config",
	"tools",
	"storage",
	"mcp",
	"browser",
	"auth",
	"setup",
	"plugins",
];

const TOOL_CHECKS: ReadonlyArray<{ name: string; missingStatus: DoctorStatus; remedy: string }> = [
	// git is the one hard requirement: all VCS integration routes through src/utils/git.ts.
	{ name: "git", missingStatus: "error", remedy: "Install git; omp's VCS integration requires it" },
	{ name: "jj", missingStatus: "warning", remedy: "Install jj if you use Jujutsu repositories" },
	{ name: "gh", missingStatus: "warning", remedy: "Install gh to enable the github tool" },
];

async function collectEnvironmentFinding(): Promise<DoctorFinding> {
	const info = await collectSystemInfo();
	return {
		id: "environment.system",
		category: "environment",
		status: "ok",
		summary: `${info.os} ${info.arch}`,
		details: formatSystemInfo(info)
			.split("\n")
			.filter(line => line.length > 0),
	};
}

function collectToolFindings(): DoctorFinding[] {
	const findings: DoctorFinding[] = TOOL_CHECKS.map(tool => {
		const resolved = $which(tool.name);
		if (resolved !== null) {
			return { id: `tools.${tool.name}`, category: "tools", status: "ok", summary: resolved, details: [] };
		}
		return {
			id: `tools.${tool.name}`,
			category: "tools",
			status: tool.missingStatus,
			summary: `${tool.name} not found on PATH`,
			details: [],
			remedy: tool.remedy,
		};
	});
	// On Linux, fuser backs cross-process holder detection (doctor-sqlite hasHolders);
	// without it, busy-database checks degrade to null (proceed-and-let-locks-decide).
	if (process.platform === "linux") {
		const fuser = $which("fuser");
		if (fuser !== null) {
			findings.push({ id: "tools.fuser", category: "tools", status: "ok", summary: fuser, details: [] });
		} else {
			findings.push({
				id: "tools.fuser",
				category: "tools",
				status: "warning",
				summary: "fuser not found on PATH",
				details: [],
				remedy:
					"Install psmisc (provides fuser) so doctor can detect foreign database holders; busy-database checks are degraded without it",
			});
		}
	}
	return findings;
}

/**
 * Probe how the browser tool would resolve a Chromium executable — without
 * downloading or launching anything. Mirrors `ensureChromiumExecutable`'s
 * precedence (system detection first, then the env override) but stats the
 * override path, which the real launcher does not (it trusts the value and
 * lets puppeteer fail at launch). The doctor catches a stale override before
 * the user hits a confusing launch error.
 */
async function collectBrowserFindings(): Promise<DoctorFinding[]> {
	const sysChrome = resolveSystemChromium();
	if (sysChrome) {
		return [{ id: "browser.chromium", category: "browser", status: "ok", summary: sysChrome, details: [] }];
	}
	const envPath = readChromiumEnvOverride();
	if (envPath) {
		try {
			const st = await fs.promises.stat(envPath);
			if (st.isFile()) {
				return [
					{
						id: "browser.chromium",
						category: "browser",
						status: "ok",
						summary: envPath,
						details: ["resolved via PUPPETEER_EXECUTABLE_PATH"],
					},
				];
			}
			return [
				{
					id: "browser.chromium",
					category: "browser",
					status: "error",
					summary: "PUPPETEER_EXECUTABLE_PATH is not a regular file",
					details: [envPath],
					remedy:
						"Set PUPPETEER_EXECUTABLE_PATH to an existing Chrome/Chromium binary, or unset it to fall back to system detection",
				},
			];
		} catch (error) {
			if (isEnoent(error)) {
				return [
					{
						id: "browser.chromium",
						category: "browser",
						status: "error",
						summary: "PUPPETEER_EXECUTABLE_PATH points at a missing file",
						details: [envPath],
						remedy:
							"Set PUPPETEER_EXECUTABLE_PATH to an existing Chrome/Chromium binary, or unset it to fall back to system detection",
					},
				];
			}
			return [
				{
					id: "browser.chromium",
					category: "browser",
					status: "error",
					summary: `cannot stat PUPPETEER_EXECUTABLE_PATH: ${(error as Error).message}`,
					details: [envPath],
					remedy:
						"Fix the path or permissions of PUPPETEER_EXECUTABLE_PATH, or unset it to fall back to system detection",
				},
			];
		}
	}
	return [
		{
			id: "browser.chromium",
			category: "browser",
			status: "warning",
			summary:
				"no system Chrome/Chromium found and PUPPETEER_EXECUTABLE_PATH is unset; Chromium may be downloaded on first browser use",
			details: [],
			remedy: "Install Chrome/Chromium or set PUPPETEER_EXECUTABLE_PATH to avoid the first-use download",
		},
	];
}
/**
 * Render only the origin (scheme://host:port) of a broker URL so no
 * userinfo, query, or fragment, any of which may carry credentials,
 * ever reaches a finding. Unparseable values are replaced with a
 * redaction placeholder rather than echoed raw.
 */
function sanitizeBrokerUrl(raw: string): string {
	try {
		const url = new URL(raw);
		return url.origin;
	} catch {
		return "<unparseable broker URL>";
	}
}
/**
 * Probe auth/setup: credential presence per configured provider, OAuth token
 * expiry, and broker mode. Bounded to local file checks — no network, no
 * broker reachability probe, no token refresh, no shell execution — and never
 * any secret material in the output (presence/absence and expiry only).
 *
 * Broker detection reuses the real `resolveAuthBrokerConfig` (the shared
 * resolver) but injects a doctor-specific config-value resolver that handles
 * only literal and env-var references. A `!command`-backed broker URL or token
 * is reported as a finding (command-backed, not resolved) rather than executed,
 * so a health check never spawns a shell. The local credential read is a
 * read-only SQL probe of the `auth_credentials` table that
 * `SqliteAuthCredentialStore` owns: doctor never opens the auth DB read-write,
 * never runs `AuthStorage.reload`, and never triggers OAuth refresh, so a
 * health check cannot mutate credentials or block on a refresh.
 * `JSON_EXTRACT(data, '$.expires')` pulls the expiry without loading access or
 * refresh tokens into JS. Broker URLs are rendered as origin-only (no
 * userinfo, query, or fragment) so embedded credentials in any URL component
 * never leak. When --agent-dir is set, `allowTokenFile: false` is passed to
 * `resolveAuthBrokerConfig` so the global broker token file is never read; a
 * broker finding is emitted only when the token comes from env or the scoped
 * config.yml.
 */
async function collectAuthFindings(flags: DoctorCommandFlags): Promise<DoctorFinding[]> {
	const agentDir = flags.agentDir ?? getAgentDir();

	// Broker config resolution reads env, <agentDir>/config.yml, and the
	// broker token file only — no HTTP. A configured broker means credentials
	// live remotely; report it and skip the local store (no reachability
	// probe). The doctor-specific resolver handles only literal/env
	// references; a `!command` value is recorded (never executed) and surfaced
	// as a finding.
	//
	// When --agent-dir is set (scoped), the global broker token file
	// (`~/.omp/auth-broker.token`) is OUTSIDE the scope and must not be read.
	// `allowTokenFile: false` makes resolveAuthBrokerConfig skip the file
	// fallback entirely, so a scoped run can only see tokens from env or the
	// scoped config.yml — never the user's real global token.
	const scoped = flags.agentDir !== undefined;
	let commandBackedField: string | null = null;
	const doctorConfigValueResolver = async (config: string): Promise<string | undefined> => {
		if (config.startsWith("!")) {
			commandBackedField = config;
			return undefined;
		}
		const envValue = process.env[config];
		return envValue || config;
	};
	let brokerConfig: AuthBrokerClientConfig | null;
	try {
		brokerConfig = await resolveAuthBrokerConfig({
			agentDir,
			configValueResolver: doctorConfigValueResolver,
			allowTokenFile: !scoped,
		});
	} catch {
		// The only throw from resolveAuthBrokerConfig is "URL set but no
		// token". Do NOT forward the raw error text — it embeds the URL.
		// Report a sanitized finding instead. When scoped, the token file
		// is out of scope, so the remedy points to scoped sources only.
		return [
			{
				id: "auth.broker",
				category: "auth",
				status: "error",
				summary: "auth broker URL configured but no bearer token is available",
				details: [],
				remedy: scoped
					? "Set OMP_AUTH_BROKER_TOKEN or the `auth.broker.token` config entry under the scoped agent dir"
					: "Set OMP_AUTH_BROKER_TOKEN, the `auth.broker.token` config entry, or place a token at the broker token file",
			},
		];
	}
	if (commandBackedField !== null) {
		return [
			{
				id: "auth.broker",
				category: "auth",
				status: "warning",
				summary: "auth broker config is command-backed; doctor cannot resolve it without executing a shell command",
				details: [],
				remedy: "Run `omp doctor` in a context where the broker command resolves, or use a literal URL/token",
			},
		];
	}
	if (brokerConfig) {
		return [
			{
				id: "auth.broker",
				category: "auth",
				status: "ok",
				summary: "credentials served by remote auth broker",
				details: [sanitizeBrokerUrl(brokerConfig.url)],
			},
		];
	}

	// Local SQLite store. Stat first so a fresh install (no agent.db) is a
	// single ok finding, not an open error. Open read-only; never create,
	// never migrate.
	const dbPath = getAgentDbPath(agentDir);
	try {
		await fs.promises.stat(dbPath);
	} catch (error) {
		if (isEnoent(error)) {
			return [{ id: "auth.storage", category: "auth", status: "ok", summary: "no credentials stored", details: [] }];
		}
		return [
			{
				id: "auth.storage",
				category: "auth",
				status: "error",
				summary: `cannot stat auth database: ${error instanceof Error ? error.message : String(error)}`,
				details: [],
			},
		];
	}

	let db: Database | undefined;
	try {
		db = new Database(dbPath, { readonly: true, create: false });
		db.run("PRAGMA busy_timeout = 5000");
		const tableRow = db
			.query("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'auth_credentials'")
			.get() as { present?: number } | undefined;
		if (tableRow?.present !== 1) {
			return [{ id: "auth.storage", category: "auth", status: "ok", summary: "no credentials stored", details: [] }];
		}
		// Read only provider / type / disabled / expiry — never the secret
		// payload columns. JSON_EXTRACT pulls `expires` without loading the
		// access/refresh tokens into JS.
		type AuthProbeRow = {
			provider: string;
			credential_type: string;
			disabled_cause: string | null;
			expires: number | null;
		};
		const rows = db
			.query(
				"SELECT provider, credential_type, disabled_cause, JSON_EXTRACT(data, '$.expires') AS expires FROM auth_credentials ORDER BY provider ASC, id ASC",
			)
			.all() as AuthProbeRow[];
		if (rows.length === 0) {
			return [{ id: "auth.storage", category: "auth", status: "ok", summary: "no credentials stored", details: [] }];
		}
		const now = Date.now();
		const byProvider = new Map<string, AuthProbeRow[]>();
		for (const row of rows) {
			const list = byProvider.get(row.provider) ?? [];
			list.push(row);
			byProvider.set(row.provider, list);
		}
		const findings: DoctorFinding[] = [];
		for (const [provider, providerRows] of byProvider) {
			const active = providerRows.filter(row => row.disabled_cause === null);
			if (active.length === 0) {
				// Only disabled (soft-deleted) tombstones remain — the user once
				// configured this provider; report absence, not silence.
				findings.push({
					id: `auth.${provider}`,
					category: "auth",
					status: "warning",
					summary: `no credentials for ${provider}`,
					details: [],
					remedy: "Run `omp login`",
				});
				continue;
			}
			const hasValid = active.some(
				row =>
					row.credential_type === "api_key" ||
					(row.credential_type === "oauth" && row.expires !== null && row.expires > now),
			);
			if (hasValid) {
				findings.push({
					id: `auth.${provider}`,
					category: "auth",
					status: "ok",
					summary: `credentials present for ${provider}`,
					details: [],
				});
				continue;
			}
			const hasExpiredOauth = active.some(
				row => row.credential_type === "oauth" && (row.expires === null || row.expires <= now),
			);
			if (hasExpiredOauth) {
				findings.push({
					id: `auth.${provider}`,
					category: "auth",
					status: "warning",
					summary: `token expired for ${provider}`,
					details: [],
					remedy: "Run `omp login`",
				});
				continue;
			}
			// Active rows of an unrecognized type — treat as present rather than
			// falsely reporting absence.
			findings.push({
				id: `auth.${provider}`,
				category: "auth",
				status: "ok",
				summary: `credentials present for ${provider}`,
				details: [],
			});
		}
		return findings;
	} catch (error) {
		if (isSqliteBusyError(error)) {
			return [
				{
					id: "auth.storage",
					category: "auth",
					status: "warning",
					summary: "auth database busy",
					details: [],
					remedy: "Close running omp sessions and re-run `omp doctor`",
				},
			];
		}
		return [
			{
				id: "auth.storage",
				category: "auth",
				status: "error",
				summary: `cannot read auth database: ${error instanceof Error ? error.message : String(error)}`,
				details: [],
			},
		];
	} finally {
		db?.close();
	}
}
async function collectSqliteRecoverFinding(): Promise<DoctorFinding> {
	// The engine memoizes this probe; the cost is paid once per process.
	const capability = await probeSqliteRecoverCapability();
	if (capability.available) {
		return {
			id: "tools.sqlite3-recover",
			category: "tools",
			status: "ok",
			summary: capability.detail,
			details: [],
		};
	}
	return {
		id: "tools.sqlite3-recover",
		category: "tools",
		status: "warning",
		summary: capability.detail,
		details: [],
		remedy: "Install a newer sqlite3; salvage repairs unavailable",
	};
}

function storageFinding(probe: DbProbe, repair: DbRepair | null): DoctorFinding {
	const details = [
		`size ${formatBytes(probe.dbBytes)} · wal ${formatBytes(probe.walBytes)} · journal ${probe.journalMode ?? "unknown"}`,
	];
	if (repair?.quarantinePath) details.push(`originals preserved at ${repair.quarantinePath}`);
	const base = {
		id: `storage.${probe.label}`,
		category: "storage" as const,
		details,
	};
	// (1) A locked database is an expected condition, not a failure.
	if (probe.busy || repair?.busy === true) {
		return {
			...base,
			status: "warning",
			summary: `${probe.label}: database busy`,
			remedy: "Close running omp sessions and re-run `omp doctor --fix`",
		};
	}
	// (2) A repair was attempted and failed; the file is left untouched.
	if (repair?.error !== null && repair?.error !== undefined) {
		return {
			...base,
			status: "error",
			summary: `${probe.label}: repair failed`,
			details: [...base.details, repair.error],
		};
	}
	// (3) FK violations are not resolved by maintenance actions (checkpoint/optimize/vacuum);
	// a db with unresolved violations stays warning even when --fix ran maintenance.
	// No fixed flag: the FK issue itself was not repaired, though actions are noted.
	if (probe.foreignKeyViolations > 0) {
		const actions = repair !== null && repair.actions.length > 0 ? `${repair.actions.join(", ")}; ` : "";
		return {
			...base,
			status: "warning",
			summary: `${probe.label}: ${actions}${probe.foreignKeyViolations} foreign-key violations`,
		};
	}
	// (4) Successful repair actions override the stale pre-repair probe: a corrupt
	// db that was quarantined, salvaged, or rescued is now ok.
	if (repair !== null && repair.actions.length > 0) {
		let summary = `${probe.label}: ${repair.actions.join(", ")}`;
		if (repair.bytesAfter < repair.bytesBefore) {
			summary += ` (${formatBytes(repair.bytesBefore)} -> ${formatBytes(repair.bytesAfter)})`;
		}
		return { ...base, status: "ok", summary, fixed: true };
	}
	// (5) Pre-repair probe failures — only reached when no repair actions ran
	// (read-only mode, or repair did nothing). A stat-failure probe (present +
	// openError) surfaces as error here.
	if (probe.openError !== null) {
		return {
			...base,
			status: "error",
			summary: `${probe.label}: cannot open`,
			details: [...base.details, probe.openError],
		};
	}
	if (probe.quickCheck !== "ok" && probe.quickCheck !== null) {
		return {
			...base,
			status: "error",
			summary: `${probe.label}: corrupt`,
			details: [...base.details, probe.quickCheck],
		};
	}
	// (6) Free-page warning uses the engine's vacuumEligible so warn and repair agree;
	// a small free-heavy db does not warn forever and --fix does not falsely claim fixed.
	if (vacuumEligible(probe)) {
		const pct = Math.round(((probe.freelistCount ?? 0) / (probe.pageCount ?? 1)) * 100);
		return {
			...base,
			status: "warning",
			summary: `${probe.label}: ${pct}% free pages`,
			remedy: "Run `omp doctor --fix` to reclaim space",
		};
	}
	if (probe.walBytes > 0) {
		return {
			...base,
			status: "warning",
			summary: `${probe.label}: WAL ${formatBytes(probe.walBytes)} uncheckpointed`,
			remedy: "Run `omp doctor --fix`",
		};
	}
	return { ...base, status: "ok", summary: `${probe.label}: healthy` };
}

async function collectConfigFindings(flags: DoctorCommandFlags): Promise<DoctorFinding[]> {
	// All config paths resolve under the scoped agent dir, matching the storage
	// section's --agent-dir gating: a run restricted to a temp dir must never
	// diagnose (or scan for quarantines under) the real ~/.omp/agent.
	const agentDir = flags.agentDir ?? getAgentDir();
	const findings: DoctorFinding[] = [];
	findings.push(await diagnoseSettingsConfig(agentDir));
	// diagnose(path) parses/classifies at an explicit path without running the
	// JSON→YAML migration, quarantining, or caching — read-only.
	// Startup order (ConfigFile.#resolveReadPath + #jsonMigrationPath):
	// models.yml → models.yaml → models.json. diagnose(explicitPath) skips the
	// built-in .yaml fallback, so walk the same chain here without migrate/write.
	const modelsCandidates = ["models.yml", "models.yaml", "models.json"] as const;
	let modelsResult: LoadResult<unknown> = { status: "not-found" };
	let modelsFilename: string = modelsCandidates[0];
	for (const filename of modelsCandidates) {
		const result = ModelsConfigFile.diagnose(path.join(agentDir, filename));
		if (result.status === "not-found") continue;
		modelsResult = result;
		modelsFilename = filename;
		break;
	}
	findings.push(loadResultConfigFinding("models", modelsFilename, modelsResult));
	findings.push(...(await collectQuarantinedConfigs(agentDir)));
	return findings;
}

async function diagnoseSettingsConfig(agentDir: string): Promise<DoctorFinding> {
	// The loader tries MAIN_CONFIG_FILENAMES in order and uses the first present
	// file; diagnose that one. Absent-with-defaults is ok, not a problem finding.
	// classifySettingsYaml already distinguishes missing (ENOENT) from unreadable
	// (EACCES etc.) — only a true "missing" result advances to the next candidate;
	// any other access/read failure becomes an error finding instead of a false
	// "absent".
	for (const filename of MAIN_CONFIG_FILENAMES) {
		const candidate = path.join(agentDir, filename);
		const result = await classifySettingsYaml(candidate);
		if (result.kind === "missing") continue;
		return yamlConfigFinding("settings", filename, result);
	}
	return {
		id: "config.settings",
		category: "config",
		status: "ok",
		summary: "settings: absent (using defaults)",
		details: [],
	};
}

function yamlConfigFinding(name: string, filename: string, result: YamlLoadResult): DoctorFinding {
	const base = { id: `config.${name}`, category: "config" as const };
	switch (result.kind) {
		case "missing":
			return { ...base, status: "ok", summary: `${name}: absent (using defaults)`, details: [] };
		case "loaded":
			return { ...base, status: "ok", summary: `${name}: valid`, details: [] };
		case "invalid":
			return {
				...base,
				status: "error",
				summary: `${name}: failed to load`,
				details: [String(result.error ?? "invalid YAML")],
				remedy: `Fix ${filename} or remove it to use defaults`,
			};
		case "unreadable":
			return {
				...base,
				status: "error",
				summary: `${name}: unreadable`,
				details: [String(result.error)],
			};
	}
}

function loadResultConfigFinding(name: string, filename: string, result: LoadResult<unknown>): DoctorFinding {
	const base = { id: `config.${name}`, category: "config" as const };
	if (result.status === "not-found") {
		return { ...base, status: "ok", summary: `${name}: absent (using defaults)`, details: [] };
	}
	if (result.status === "error") {
		return {
			...base,
			status: "error",
			summary: `${name}: failed to load`,
			details: [result.error.message],
			remedy: `Fix ${filename} or remove it to use defaults`,
		};
	}
	return { ...base, status: "ok", summary: `${name}: valid`, details: [] };
}

async function collectQuarantinedConfigs(agentDir: string): Promise<DoctorFinding[]> {
	// Quarantine naming: `${filePath}.broken-${stamp}`. Only files whose base
	// name matches a known omp config filename are omp configs — an unrelated
	// `foo.broken-*` is not ours to report. Aggregate every matched quarantine
	// into a single `config.quarantined` finding (one id, each file listed in
	// details) so repeated backups of the same config do not duplicate ids.
	const knownConfigBasenames: Record<string, true> = {
		"config.yml": true,
		"config.yaml": true,
		"settings.yml": true,
		"settings.yaml": true,
		"models.yml": true,
		"models.yaml": true,
		"models.json": true,
	};
	let entries: string[];
	try {
		entries = await fs.promises.readdir(agentDir);
	} catch (error) {
		if (isEnoent(error)) return [];
		return [
			{
				id: "config.quarantined",
				category: "config",
				status: "error",
				summary: "quarantine scan: cannot read agent directory",
				details: [error instanceof Error ? error.message : String(error)],
			},
		];
	}
	const quarantined: string[] = [];
	for (const entry of entries) {
		const match = /^(.+)\.broken-.+$/.exec(entry);
		if (!match) continue;
		const original = match[1] as string;
		if (!(original in knownConfigBasenames)) continue;
		quarantined.push(entry);
	}
	if (quarantined.length === 0) return [];
	quarantined.sort();
	return [
		{
			id: "config.quarantined",
			category: "config",
			status: "error",
			summary: `${quarantined.length} quarantined config backup${quarantined.length === 1 ? "" : "s"} after failed loads`,
			details: quarantined,
			remedy: "Review each backup and restore or delete it",
		},
	];
}

async function collectStorageFindings(flags: DoctorCommandFlags): Promise<DoctorFinding[]> {
	const databases = resolveDoctorDatabases(flags.agentDir, flags.agentDir !== undefined);
	const collect = async (): Promise<DoctorFinding[]> => {
		const findings: DoctorFinding[] = [];
		// Sequential probes: parallel opens of sibling databases multiply lock pressure for no real gain.
		for (const db of databases) {
			const swap = await recoverInterruptedSwap(db, flags.fix === true);
			if (swap.found && !swap.restored) {
				findings.push({
					id: `storage.${db.label}`,
					category: "storage",
					status: flags.fix === true ? "error" : "warning",
					summary:
						flags.fix === true
							? `${db.label}: interrupted swap rollback failed`
							: `${db.label}: interrupted swap detected`,
					details: swap.error === null ? [] : [swap.error],
					remedy: "Run `omp doctor --fix` to restore from the archived original",
				});
				continue;
			}
			const probe = await probeDatabase(db);
			if (!probe.present) continue;
			const repair = flags.fix === true ? await repairDatabase(probe) : null;
			const finding = storageFinding(probe, repair);
			if (swap.restored) {
				// The renderer suppresses details on ok findings, so surface the
				// rollback in the summary — never conceal a restoration.
				finding.summary = `restored from archive; ${finding.summary}`;
				finding.details.push("restored from archive after an interrupted swap");
			}
			findings.push(finding);
		}
		return findings;
	};
	// Share gc's lock so `omp gc --apply` and `omp doctor --fix` cannot vacuum the same files concurrently.
	if (flags.fix === true) return withGcLock(flags.agentDir ?? getAgentDir(), collect);
	return collect();
}

async function loadRawMcpEntries(
	items: Array<MCPServer & { _source: { path: string } }>,
): Promise<{ entries: Map<string, unknown>; sourceErrors: string[] }> {
	// Read each unique source file once and extract the raw mcpServers entry
	// for each server name. The native provider normalizes enabled/timeout
	// before constructing MCPServer, so the raw entry is needed to validate
	// the original shape (e.g. enabled:{} → undefined loses the malformation).
	// A vanished/unreadable/unparseable source produces a load error that is
	// surfaced as an MCP finding — it must not degrade silently to the
	// normalized item.
	const rawByPath = new Map<string, Record<string, unknown>>();
	const sourceErrors: string[] = [];
	const rawEntries = new Map<string, unknown>();
	for (const item of items) {
		const filePath = item._source.path;
		if (!rawByPath.has(filePath)) {
			try {
				const content = await fs.promises.readFile(filePath, "utf8");
				const parsed = tryParseJson<{ mcpServers?: Record<string, unknown> }>(content);
				rawByPath.set(filePath, parsed?.mcpServers ?? {});
			} catch (error) {
				rawByPath.set(filePath, {});
				sourceErrors.push(
					`Failed to read raw MCP config from ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
		const servers = rawByPath.get(filePath) ?? {};
		if (item.name in servers) {
			rawEntries.set(item.name, servers[item.name]);
		}
	}
	return { entries: rawEntries, sourceErrors };
}

async function collectMcpFindings(flags: DoctorCommandFlags): Promise<DoctorFinding[]> {
	// Use the real capability loader (the same path the app uses at runtime)
	// so project-level .mcp.json, .omp/mcp.json, and plugin MCP configs are
	// diagnosed, not just the user-level mcp.json.
	//
	// --agent-dir scopes USER config only: userAgentDir is passed through the
	// loader context (not via setAgentDir mutation) so the native provider reads
	// user-level mcp.json from the scoped dir. Project discovery stays rooted at
	// getProjectDir() — the real project dir — so project .mcp.json is searched
	// in the right place. When scoped, providers are limited to omp-owned ones
	// (native + mcp-json) so external tool configs (~/.claude.json, ~/.codex/…)
	// stay out of the scoped run.
	const scoped = flags.agentDir !== undefined;
	const result = await loadCapability<MCPServer>(mcpCapability.id, {
		cwd: getProjectDir(),
		userAgentDir: flags.agentDir,
		providers: scoped ? ["native", "mcp-json"] : undefined,
		// includeInvalid keeps items the capability validator would drop (missing
		// command/url) so diagnoseMcpServer can report them through the real
		// validateServerConfig instead of them vanishing silently.
		includeInvalid: true,
	});
	// Build a map of raw config entries by reading each source file once.
	// The native provider normalizes enabled/timeout before the MCPServer
	// object is constructed (invalid → undefined, string → coerced), so
	// shape validation on the normalized MCPServer misses malformed values.
	// Reading the raw entry preserves the original shape for validation.
	const { entries: rawEntries, sourceErrors } = await loadRawMcpEntries(result.items);
	const findings: DoctorFinding[] = result.items.map(server =>
		diagnoseMcpServer(server.name, server, rawEntries.get(server.name)),
	);
	// A vanished/unreadable/unparseable source file must surface as an error
	// finding — it must not degrade silently to the normalized item.
	if (sourceErrors.length > 0) {
		findings.push({
			id: "mcp.config-source",
			category: "mcp",
			status: "error",
			summary: "MCP config: source file errors",
			details: sourceErrors,
			remedy: "Fix or remove the unreadable MCP config file",
		});
	}
	// Provider throws (e.g. a null entry in mcpServers) surface as warnings,
	// not items — report them so malformed configs are not silently ignored.
	if (result.warnings.length > 0) {
		findings.push({
			id: "mcp.config",
			category: "mcp",
			status: "error",
			summary: "MCP config: provider errors",
			details: result.warnings,
			remedy: "Fix the malformed MCP server entry in mcp.json",
		});
	}
	if (findings.length === 0) {
		return [{ id: "mcp.none", category: "mcp", status: "ok", summary: "no MCP servers configured", details: [] }];
	}
	return findings;
}

function validateMcpFieldShapes(name: string, server: MCPServer, raw: unknown): string[] {
	const errors: string[] = [];
	// Validate against the RAW config entry (before the provider normalizes
	// enabled/timeout) so malformed values the provider would silently coerce
	// are caught. Fall back to the normalized MCPServer if the raw entry is
	// unavailable (e.g. from a provider that doesn't use mcpServers JSON).
	const rawEntry = (raw !== null && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
	// enabled: must be boolean if present (null is malformed, not absent)
	if ("enabled" in rawEntry && rawEntry.enabled !== undefined) {
		if (typeof rawEntry.enabled !== "boolean") {
			errors.push(
				`Server "${name}": "enabled" must be a boolean, got ${rawEntry.enabled === null ? "null" : typeof rawEntry.enabled}`,
			);
		}
	}
	// timeout: must be non-negative finite number if present (null is malformed, not absent)
	if ("timeout" in rawEntry && rawEntry.timeout !== undefined) {
		if (typeof rawEntry.timeout !== "number" || !Number.isFinite(rawEntry.timeout) || rawEntry.timeout < 0) {
			errors.push(
				`Server "${name}": "timeout" must be a non-negative number, got ${rawEntry.timeout === null ? "null" : JSON.stringify(rawEntry.timeout)}`,
			);
		}
	}
	if (server.command !== undefined && typeof server.command !== "string") {
		errors.push(`Server "${name}": "command" must be a string, got ${typeof server.command}`);
	}
	if (server.args !== undefined && !Array.isArray(server.args)) {
		errors.push(`Server "${name}": "args" must be an array, got ${typeof server.args}`);
	} else if (Array.isArray(server.args) && server.args.some(a => typeof a !== "string")) {
		errors.push(`Server "${name}": "args" must be an array of strings`);
	}
	// env: must be an object with string values
	if (server.env !== undefined) {
		if (typeof server.env !== "object" || Array.isArray(server.env) || server.env === null) {
			errors.push(`Server "${name}": "env" must be an object, got ${typeof server.env}`);
		} else {
			for (const [key, value] of Object.entries(server.env)) {
				if (typeof value !== "string") {
					errors.push(`Server "${name}": "env.${key}" must be a string, got ${typeof value}`);
				}
			}
		}
	}
	// headers: must be an object with string values
	if (server.headers !== undefined) {
		if (typeof server.headers !== "object" || Array.isArray(server.headers) || server.headers === null) {
			errors.push(`Server "${name}": "headers" must be an object, got ${typeof server.headers}`);
		} else {
			for (const [key, value] of Object.entries(server.headers)) {
				if (typeof value !== "string") {
					errors.push(`Server "${name}": "headers.${key}" must be a string, got ${typeof value}`);
				}
			}
		}
	}
	if (server.url !== undefined && typeof server.url !== "string") {
		errors.push(`Server "${name}": "url" must be a string, got ${typeof server.url}`);
	}
	return errors;
}

function diagnoseMcpServer(name: string, server: MCPServer, raw?: unknown): DoctorFinding {
	const base = { id: `mcp.${name}`, category: "mcp" as const };
	// Shape validation runs BEFORE the disabled shortcut so a disabled server
	// with a malformed spec (e.g. enabled:false, command:7) still reports the
	// shape error — the user should know the config is broken even if the
	// server is currently off.
	const shapeErrors = validateMcpFieldShapes(name, server, raw);
	// A disabled server is ok regardless of transport-endpoint validity — it
	// never runs. But shape errors still surface (see above).
	if (server.enabled === false && shapeErrors.length === 0) {
		return { ...base, status: "ok", summary: `${name}: disabled`, details: [] };
	}
	if (server.enabled === false && shapeErrors.length > 0) {
		return { ...base, status: "error", summary: `${name}: invalid spec`, details: shapeErrors };
	}
	// Convert canonical MCPServer to legacy MCPServerConfig for the real
	// validator.  Malformed entries (null, wrong shape) are caught here so the
	// report still emits an error finding instead of crashing.
	let config: MCPServerConfig;
	try {
		config = convertToLegacyConfig(server);
	} catch (error) {
		return {
			...base,
			status: "error",
			summary: `${name}: malformed server config`,
			details: [error instanceof Error ? error.message : String(error)],
		};
	}
	// Reuse the real validator: never re-implement its rules.
	const errors = [...shapeErrors, ...validateServerConfig(name, config)];
	if (errors.length > 0) {
		return { ...base, status: "error", summary: `${name}: invalid spec`, details: errors };
	}
	const serverType = config.type ?? "stdio";
	if (serverType === "stdio") {
		// "command" in config narrows the union to MCPStdioServerConfig; the
		// validator already guaranteed command is present and non-empty.
		let command = "";
		if ("command" in config && typeof config.command === "string") command = config.command;
		// Bun.which mirrors the PATH resolution the spawn path uses; no live spawn.
		const resolved = Bun.which(command);
		if (resolved === null) {
			return {
				...base,
				status: "error",
				summary: `${name}: command not found`,
				details: [`command "${command}" not found on PATH`],
				remedy: `Install "${command}" or fix the command in mcp.json`,
			};
		}
		return { ...base, status: "ok", summary: `${name}: ${resolved}`, details: [] };
	}
	// http/sse: validate URL syntax only — no live connects, no OAuth probes.
	// "url" in config narrows to the http/sse members; the validator guaranteed url.
	let url = "";
	if ("url" in config && typeof config.url === "string") url = config.url;
	try {
		new URL(url);
	} catch (error) {
		return {
			...base,
			status: "error",
			summary: `${name}: invalid url`,
			details: [error instanceof Error ? error.message : String(error)],
		};
	}
	return { ...base, status: "ok", summary: `${name}: ${url}`, details: [] };
}
// ── setup section ──────────────────────────────────────────────────────────
// Read-only sanity probes over user/project config surfaces (agents,
// keybindings, watchdog, skills, themes, extensions/hooks). Each probe parses
// and validates through the real loaders' read-only seams — no factory
// execution, no hook script execution, no writes, no manager instantiation
// that migrates or persists.

/** Known tool name set for agent `tools` reference validation. */
const KNOWN_TOOL_NAMES = new Set<string>([...BUILTIN_TOOL_NAMES, ...HIDDEN_TOOL_NAMES]);

/** Scan a directory for `.md` files, returning `{ filePath, content }` sorted by name. */
async function scanMarkdownDir(dir: string): Promise<Array<{ filePath: string; content: string }>> {
	let entries: fs.Dirent[];
	try {
		entries = await fs.promises.readdir(dir, { withFileTypes: true });
	} catch (error) {
		if (isEnoent(error)) return [];
		throw error;
	}
	const files = entries
		.filter(entry => (entry.isFile() || entry.isSymbolicLink()) && entry.name.endsWith(".md"))
		.sort((a, b) => a.name.localeCompare(b.name));
	const results: Array<{ filePath: string; content: string }> = [];
	for (const file of files) {
		const filePath = path.join(dir, file.name);
		try {
			const content = await fs.promises.readFile(filePath, "utf-8");
			results.push({ filePath, content });
		} catch (error) {
			if (isEnoent(error)) continue;
			throw error;
		}
	}
	return results;
}

/** Build the set of known agent names (discovered + bundled) for spawns validation. */
function buildKnownAgentNames(discovered: ParsedAgentFields[]): Set<string> {
	const names = new Set<string>();
	for (const fields of discovered) names.add(fields.name);
	for (const bundled of loadBundledAgents()) names.add(bundled.name);
	return names;
}

/** Discover skill names from the three skill roots for autoloadSkills validation. */
async function discoverSkillNames(agentDir: string, projectDir: string, errors: string[]): Promise<Set<string>> {
	const dirs = [
		path.join(agentDir, "skills"),
		path.join(agentDir, "managed-skills"),
		path.join(projectDir, ".omp", "skills"),
	];
	const names = new Set<string>();
	for (const dir of dirs) {
		let entries: fs.Dirent[];
		try {
			entries = await fs.promises.readdir(dir, { withFileTypes: true });
		} catch (error) {
			if (isEnoent(error)) continue;
			errors.push(`skills: ${error instanceof Error ? error.message : String(error)}`);
			continue;
		}
		for (const entry of entries) {
			if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
			if (entry.name.startsWith(".")) continue;
			const skillPath = path.join(dir, entry.name, "SKILL.md");
			try {
				const content = await fs.promises.readFile(skillPath, "utf-8");
				const { frontmatter } = parseFrontmatter(content, { source: skillPath, level: "off" });
				const rawName = frontmatter.name;
				if (typeof rawName === "string" && rawName.trim()) names.add(rawName.trim());
				else names.add(entry.name);
			} catch (error) {
				if (isEnoent(error)) continue;
				// Skip unreadable skill files — the skills collector reports them.
			}
		}
	}
	return names;
}

/** Resolve agent scan dirs: user/project roots plus extension-package agents/ dirs.
 * When unscoped (agentDir === undefined), uses `listOmpExtensionRoots` to resolve
 * the same extension roots the runtime discovers (CLI, settings, installed plugins).
 * When scoped, scans only explicit dirs under the scoped agentDir/projectDir. */
async function resolveAgentScanDirs(
	agentDir: string,
	projectDir: string,
	scoped: boolean,
	errors: string[],
): Promise<string[]> {
	const baseDirs = [path.join(agentDir, "agents"), path.join(projectDir, ".omp", "agents")];
	if (!scoped) {
		// Use the same side-effect-free extension-root resolution as the runtime.
		// listOmpExtensionRoots is read-only (stats dirs, reads settings.json, lists
		// installed plugins) — no factory execution, no hook script execution.
		try {
			const roots = await listOmpExtensionRoots({ cwd: projectDir, home: os.homedir(), repoRoot: null });
			for (const root of roots) baseDirs.push(path.join(root.path, "agents"));
		} catch (error) {
			errors.push(`extension roots: ${error instanceof Error ? error.message : String(error)}`);
		}
	} else {
		// Scoped: scan only explicit extension dirs under the scoped dirs.
		const extRoots = [path.join(agentDir, "extensions"), path.join(projectDir, ".omp", "extensions")];
		for (const extRoot of extRoots) {
			let entries: fs.Dirent[];
			try {
				entries = await fs.promises.readdir(extRoot, { withFileTypes: true });
			} catch (error) {
				if (isEnoent(error)) continue;
				errors.push(`${path.basename(extRoot)}: ${error instanceof Error ? error.message : String(error)}`);
				continue;
			}
			for (const entry of entries) {
				if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
				if (entry.name.startsWith(".")) continue;
				baseDirs.push(path.join(extRoot, entry.name, "agents"));
			}
		}
	}
	return baseDirs;
}

/** File extensions the runtime loadTools scans for custom tool files. */
const TOOL_FILE_EXTS = [".json", ".md", ".ts", ".js", ".sh", ".bash", ".py"];

/** Check if a file exists (ENOENT → false, other errors → false). */
async function fileExists(filePath: string): Promise<boolean> {
	try {
		await fs.promises.stat(filePath);
		return true;
	} catch {
		return false;
	}
}

/** Derive the runtime tool name from a tool file, reading metadata when present.
 * Mirrors loadTools in builtin.ts: JSON files use the `name` field (or basename),
 * MD files use frontmatter `name` (or basename), executable files use basename. */
async function deriveToolName(filePath: string, fileName: string): Promise<string | null> {
	const ext = path.extname(fileName);
	const baseName = fileName.replace(/\.(json|md|ts|js|sh|bash|py)$/, "");
	try {
		if (ext === ".json") {
			const content = await fs.promises.readFile(filePath, "utf-8");
			const data = tryParseJson<{ name?: string }>(content);
			return data?.name || baseName;
		}
		if (ext === ".md") {
			const content = await fs.promises.readFile(filePath, "utf-8");
			const { frontmatter } = parseFrontmatter(content, { source: filePath });
			return (frontmatter.name as string) || baseName;
		}
	} catch {
		// Unreadable file — fall back to basename.
	}
	return baseName;
}

async function collectAgentSetupFinding(agentDir: string, projectDir: string, scoped: boolean): Promise<DoctorFinding> {
	const errors: string[] = [];
	const warnings: string[] = [];
	const parsed: ParsedAgentFields[] = [];
	const dirs = await resolveAgentScanDirs(agentDir, projectDir, scoped, errors);

	for (const dir of dirs) {
		let files: Array<{ filePath: string; content: string }>;
		try {
			files = await scanMarkdownDir(dir);
		} catch (error) {
			errors.push(
				`${path.basename(path.dirname(dir))}/agents: ${error instanceof Error ? error.message : String(error)}`,
			);
			continue;
		}
		for (const { filePath, content } of files) {
			const baseName = path.basename(filePath);
			try {
				const { frontmatter } = parseFrontmatter(content, { source: filePath, level: "fatal" });
				const fields = parseAgentFields(frontmatter);
				if (!fields) {
					errors.push(`${baseName}: missing name or description`);
					continue;
				}
				parsed.push(fields);
			} catch (error) {
				errors.push(`${baseName}: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
	}

	// Validate references only when agents were successfully parsed.
	if (parsed.length > 0) {
		const knownAgentNames = buildKnownAgentNames(parsed);
		const knownSkillNames = await discoverSkillNames(agentDir, projectDir, errors);
		// Build the known tool name set from the same static tool-discovery sources
		// the runtime uses: built-in names + custom tools from <configDir>/tools/.
		// Scans the same directories and extensions as loadTools in builtin.ts:
		// .json/.md/.ts/.js/.sh/.bash/.py files + subdirs with index.ts/index.js.
		const knownTools = new Set<string>(KNOWN_TOOL_NAMES);
		const toolDirs = [path.join(agentDir, "tools"), path.join(projectDir, ".omp", "tools")];
		for (const toolDir of toolDirs) {
			let toolEntries: fs.Dirent[];
			try {
				toolEntries = await fs.promises.readdir(toolDir, { withFileTypes: true });
			} catch (error) {
				if (isEnoent(error)) continue;
				errors.push(`tools: ${error instanceof Error ? error.message : String(error)}`);
				continue;
			}
			for (const toolEntry of toolEntries) {
				if (toolEntry.name.startsWith(".")) continue;
				if (toolEntry.isFile() || toolEntry.isSymbolicLink()) {
					const ext = path.extname(toolEntry.name);
					if (!TOOL_FILE_EXTS.includes(ext)) continue;
					const toolPath = path.join(toolDir, toolEntry.name);
					const derivedName = await deriveToolName(toolPath, toolEntry.name);
					if (derivedName) knownTools.add(derivedName);
				} else if (toolEntry.isDirectory()) {
					// Subdirectory tools: only register when the runtime-expected
					// index file exists (mirrors loadTools in builtin.ts).
					const indexPath = path.join(toolDir, toolEntry.name, "index.ts");
					const indexJsPath = path.join(toolDir, toolEntry.name, "index.js");
					if ((await fileExists(indexPath)) || (await fileExists(indexJsPath))) {
						knownTools.add(toolEntry.name);
					}
				}
			}
		}
		for (const fields of parsed) {
			for (const tool of fields.tools ?? []) {
				if (!knownTools.has(tool) && !tool.startsWith("mcp__")) {
					warnings.push(`${fields.name}: unknown tool "${tool}"`);
				}
			}
			if (fields.spawns !== undefined && fields.spawns !== "*") {
				for (const target of fields.spawns) {
					if (!knownAgentNames.has(target)) {
						warnings.push(`${fields.name}: spawns references unknown agent "${target}"`);
					}
				}
			}
			for (const skill of fields.autoloadSkills ?? []) {
				if (!knownSkillNames.has(skill)) {
					warnings.push(`${fields.name}: autoloadSkills references unknown skill "${skill}"`);
				}
			}
		}
	}

	if (errors.length > 0) {
		return {
			id: "setup.agents",
			category: "setup",
			status: "error",
			summary: `agents: ${errors.length} error${errors.length === 1 ? "" : "s"}`,
			details: errors,
		};
	}
	if (warnings.length > 0) {
		return {
			id: "setup.agents",
			category: "setup",
			status: "warning",
			summary: `agents: ${warnings.length} warning${warnings.length === 1 ? "" : "s"}`,
			details: warnings,
		};
	}
	return {
		id: "setup.agents",
		category: "setup",
		status: "ok",
		summary: `agents: ${parsed.length} valid`,
		details: [],
	};
}
async function collectKeybindingsSetupFinding(agentDir: string): Promise<DoctorFinding> {
	const { readPath } = resolveKeybindingsConfigPaths(agentDir);
	let content: string;
	try {
		content = await fs.promises.readFile(readPath, "utf-8");
	} catch (error) {
		if (isEnoent(error)) {
			return {
				id: "setup.keybindings",
				category: "setup",
				status: "ok",
				summary: "keybindings: defaults in use",
				details: [],
			};
		}
		return {
			id: "setup.keybindings",
			category: "setup",
			status: "error",
			summary: "keybindings: cannot read config",
			details: [error instanceof Error ? error.message : String(error)],
		};
	}
	// Parse YAML/JSONC per extension — same parsers loadRawConfig uses.
	let rawConfig: unknown;
	try {
		if (readPath.endsWith(".json")) {
			rawConfig = JSONC.parse(content);
		} else {
			rawConfig = YAML.parse(content);
		}
	} catch (error) {
		return {
			id: "setup.keybindings",
			category: "setup",
			status: "error",
			summary: "keybindings: syntax error",
			details: [error instanceof Error ? error.message : String(error)],
		};
	}
	if (!rawConfig || typeof rawConfig !== "object" || Array.isArray(rawConfig)) {
		return {
			id: "setup.keybindings",
			category: "setup",
			status: "error",
			summary: "keybindings: expected a mapping",
			details: [],
		};
	}
	const config = rawConfig as Record<string, unknown>;
	const warnings: string[] = [];
	for (const key of Object.keys(config)) {
		if (!(key in KEYBINDINGS)) {
			warnings.push(`unknown action "${key}"`);
		}
	}
	// Detect chord conflicts via the TUI's in-memory manager (no file persistence, no global set).
	try {
		const manager = KeybindingsManager.inMemory(config as Parameters<typeof KeybindingsManager.inMemory>[0]);
		for (const conflict of manager.getConflicts()) {
			warnings.push(`chord conflict: "${conflict.key}" bound to ${conflict.keybindings.join(", ")}`);
		}
	} catch (error) {
		return {
			id: "setup.keybindings",
			category: "setup",
			status: "error",
			summary: "keybindings: validation failed",
			details: [error instanceof Error ? error.message : String(error)],
		};
	}
	if (warnings.length > 0) {
		return {
			id: "setup.keybindings",
			category: "setup",
			status: "warning",
			summary: `keybindings: ${warnings.length} issue${warnings.length === 1 ? "" : "s"}`,
			details: warnings,
		};
	}
	return { id: "setup.keybindings", category: "setup", status: "ok", summary: "keybindings: valid", details: [] };
}

async function collectWatchdogSetupFinding(agentDir: string, projectDir: string): Promise<DoctorFinding> {
	let candidates: Array<{ path: string; content: string }>;
	try {
		candidates = await collectConfigCandidates(projectDir, agentDir, ["WATCHDOG.yml", "WATCHDOG.yaml"]);
	} catch (error) {
		return {
			id: "setup.watchdog",
			category: "setup",
			status: "error",
			summary: "watchdog: discovery failed",
			details: [error instanceof Error ? error.message : String(error)],
		};
	}
	if (candidates.length === 0) {
		return {
			id: "setup.watchdog",
			category: "setup",
			status: "ok",
			summary: "watchdog: no watchdog config",
			details: [],
		};
	}
	const errors: string[] = [];
	for (const candidate of candidates) {
		let parsed: unknown;
		try {
			parsed = YAML.parse(candidate.content);
		} catch (error) {
			errors.push(
				`${path.basename(candidate.path)}: YAML syntax error — ${error instanceof Error ? error.message : String(error)}`,
			);
			continue;
		}
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			errors.push(`${path.basename(candidate.path)}: expected a YAML mapping`);
			continue;
		}
		const result = watchdogYamlSchema(parsed);
		if (result instanceof type.errors) {
			errors.push(`${path.basename(candidate.path)}: schema error — ${result.summary}`);
		}
	}
	if (errors.length > 0) {
		return {
			id: "setup.watchdog",
			category: "setup",
			status: "error",
			summary: `watchdog: ${errors.length} error${errors.length === 1 ? "" : "s"}`,
			details: errors,
		};
	}
	return {
		id: "setup.watchdog",
		category: "setup",
		status: "ok",
		summary: `watchdog: ${candidates.length} config${candidates.length === 1 ? "" : "s"} valid`,
		details: [],
	};
}

async function collectSkillsSetupFinding(agentDir: string, projectDir: string): Promise<DoctorFinding> {
	const dirs = [
		path.join(agentDir, "skills"),
		path.join(agentDir, "managed-skills"),
		path.join(projectDir, ".omp", "skills"),
	];
	const errors: string[] = [];
	let count = 0;
	for (const dir of dirs) {
		let entries: fs.Dirent[];
		try {
			entries = await fs.promises.readdir(dir, { withFileTypes: true });
		} catch (error) {
			if (isEnoent(error)) continue;
			errors.push(`${path.basename(dir)}: ${error instanceof Error ? error.message : String(error)}`);
			continue;
		}
		for (const entry of entries) {
			if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
			if (entry.name.startsWith(".")) continue;
			const skillPath = path.join(dir, entry.name, "SKILL.md");
			try {
				const content = await fs.promises.readFile(skillPath, "utf-8");
				const { frontmatter } = parseFrontmatter(content, { source: skillPath, level: "fatal" });
				const name = typeof frontmatter.name === "string" ? frontmatter.name.trim() : undefined;
				const description =
					typeof frontmatter.description === "string" ? frontmatter.description.trim() : undefined;
				if (!name || !description) {
					errors.push(`${entry.name}/SKILL.md: missing name or description`);
					continue;
				}
				count++;
			} catch (error) {
				if (isEnoent(error)) continue;
				errors.push(`${entry.name}/SKILL.md: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
	}
	if (errors.length > 0) {
		return {
			id: "setup.skills",
			category: "setup",
			status: "error",
			summary: `skills: ${errors.length} error${errors.length === 1 ? "" : "s"}`,
			details: errors,
		};
	}
	return { id: "setup.skills", category: "setup", status: "ok", summary: `skills: ${count} valid`, details: [] };
}

async function collectThemesSetupFinding(agentDir: string): Promise<DoctorFinding> {
	const themesDir = getCustomThemesDir(agentDir);
	let entries: fs.Dirent[];
	try {
		entries = await fs.promises.readdir(themesDir, { withFileTypes: true });
	} catch (error) {
		if (isEnoent(error)) {
			return {
				id: "setup.themes",
				category: "setup",
				status: "ok",
				summary: "themes: no custom themes",
				details: [],
			};
		}
		return {
			id: "setup.themes",
			category: "setup",
			status: "error",
			summary: "themes: cannot read themes directory",
			details: [error instanceof Error ? error.message : String(error)],
		};
	}
	const errors: string[] = [];
	let count = 0;
	for (const entry of entries) {
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;
		if (!entry.name.endsWith(".json")) continue;
		const themePath = path.join(themesDir, entry.name);
		try {
			const json: unknown = await Bun.file(themePath).json();
			const result = themeJsonSchema(json);
			if (result instanceof type.errors) {
				errors.push(`${entry.name}: ${result.summary}`);
				continue;
			}
			count++;
		} catch (error) {
			if (isEnoent(error)) continue;
			errors.push(`${entry.name}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	if (errors.length > 0) {
		return {
			id: "setup.themes",
			category: "setup",
			status: "error",
			summary: `themes: ${errors.length} error${errors.length === 1 ? "" : "s"}`,
			details: errors,
		};
	}
	return { id: "setup.themes", category: "setup", status: "ok", summary: `themes: ${count} valid`, details: [] };
}

/** Validate a single extension package: manifest + hook files. */
async function validateExtensionPackage(pkgRoot: string, errors: string[]): Promise<boolean> {
	const pkgName = path.basename(pkgRoot);
	const packageJsonPath = path.join(pkgRoot, "package.json");
	// Statically validate the manifest — read the JSON ourselves so a
	// broken parse surfaces as an error (readExtensionManifest swallows
	// parse errors and returns null). No factory execution, no import.
	let pkgExists = true;
	try {
		await fs.promises.stat(packageJsonPath);
	} catch (error) {
		if (isEnoent(error)) {
			pkgExists = false;
		} else {
			errors.push(`${pkgName}: ${error instanceof Error ? error.message : String(error)}`);
			return false;
		}
	}
	if (pkgExists) {
		try {
			await Bun.file(packageJsonPath).json();
		} catch (error) {
			if (isEnoent(error)) {
				pkgExists = false;
			} else {
				errors.push(`${pkgName}: broken manifest — ${error instanceof Error ? error.message : String(error)}`);
				return false;
			}
		}
	}
	if (pkgExists) {
		const manifest = await readExtensionManifest(packageJsonPath);
		if (manifest?.extensions?.length) {
			for (const extPath of manifest.extensions) {
				const resolved = path.resolve(pkgRoot, extPath);
				try {
					await fs.promises.stat(resolved);
				} catch (error) {
					if (isEnoent(error)) {
						errors.push(`${pkgName}: manifest references missing file "${extPath}"`);
					} else {
						errors.push(`${pkgName}: ${error instanceof Error ? error.message : String(error)}`);
					}
				}
			}
		}
	}
	// Validate hook files in this extension's hooks/pre|post dirs.
	for (const hookType of ["pre", "post"] as const) {
		const hookDir = path.join(pkgRoot, "hooks", hookType);
		let hookEntries: fs.Dirent[];
		try {
			hookEntries = await fs.promises.readdir(hookDir, { withFileTypes: true });
		} catch (error) {
			if (isEnoent(error)) continue;
			errors.push(`${pkgName}/hooks/${hookType}: ${error instanceof Error ? error.message : String(error)}`);
			continue;
		}
		for (const hookEntry of hookEntries) {
			if (!hookEntry.isFile() && !hookEntry.isSymbolicLink()) continue;
			if (hookEntry.name.startsWith(".")) continue;
			const hookPath = path.join(hookDir, hookEntry.name);
			const baseName = hookEntry.name.includes(".")
				? hookEntry.name.slice(0, hookEntry.name.lastIndexOf("."))
				: hookEntry.name;
			const tool = baseName === "*" ? "*" : baseName;
			const hook: Hook = {
				name: hookEntry.name,
				path: hookPath,
				type: hookType,
				tool,
				level: "user",
				_source: { provider: "doctor", path: hookPath, level: "user" } as never,
			};
			const validationError = hookCapability.validate?.(hook);
			if (validationError !== undefined) {
				errors.push(`${pkgName}/hooks/${hookType}/${hookEntry.name}: ${validationError}`);
			}
		}
	}
	return true;
}

/** Scan a hooks/pre|post dir pair under a base dir for hook validation. */
async function scanTopLevelHooks(base: string, errors: string[]): Promise<void> {
	for (const hookType of ["pre", "post"] as const) {
		const hookDir = path.join(base, "hooks", hookType);
		let hookEntries: fs.Dirent[];
		try {
			hookEntries = await fs.promises.readdir(hookDir, { withFileTypes: true });
		} catch (error) {
			if (isEnoent(error)) continue;
			errors.push(`hooks/${hookType}: ${error instanceof Error ? error.message : String(error)}`);
			continue;
		}
		for (const hookEntry of hookEntries) {
			if (!hookEntry.isFile() && !hookEntry.isSymbolicLink()) continue;
			if (hookEntry.name.startsWith(".")) continue;
			const hookPath = path.join(hookDir, hookEntry.name);
			const baseName = hookEntry.name.includes(".")
				? hookEntry.name.slice(0, hookEntry.name.lastIndexOf("."))
				: hookEntry.name;
			const tool = baseName === "*" ? "*" : baseName;
			const hook: Hook = {
				name: hookEntry.name,
				path: hookPath,
				type: hookType,
				tool,
				level: "user",
				_source: { provider: "doctor", path: hookPath, level: "user" } as never,
			};
			const validationError = hookCapability.validate?.(hook);
			if (validationError !== undefined) {
				errors.push(`hooks/${hookType}/${hookEntry.name}: ${validationError}`);
			}
		}
	}
}

async function collectExtensionsSetupFinding(
	agentDir: string,
	projectDir: string,
	scoped: boolean,
): Promise<DoctorFinding> {
	const errors: string[] = [];
	let count = 0;

	// Build the list of extension package roots to validate.
	let pkgRoots: string[] = [];
	if (!scoped) {
		// Use the same side-effect-free extension-root resolution as the runtime.
		// listOmpExtensionRoots returns individual extension root paths directly.
		try {
			const roots = await listOmpExtensionRoots({ cwd: projectDir, home: os.homedir(), repoRoot: null });
			pkgRoots = roots.map(root => root.path);
		} catch (error) {
			errors.push(`extension roots: ${error instanceof Error ? error.message : String(error)}`);
		}
	} else {
		// Scoped: scan explicit extensions dirs under the scoped dirs.
		const extDirs = [path.join(agentDir, "extensions"), path.join(projectDir, ".omp", "extensions")];
		for (const extDir of extDirs) {
			let entries: fs.Dirent[];
			try {
				entries = await fs.promises.readdir(extDir, { withFileTypes: true });
			} catch (error) {
				if (isEnoent(error)) continue;
				errors.push(`${path.basename(extDir)}: ${error instanceof Error ? error.message : String(error)}`);
				continue;
			}
			for (const entry of entries) {
				if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
				if (entry.name.startsWith(".")) continue;
				pkgRoots.push(path.join(extDir, entry.name));
			}
		}
	}

	for (const pkgRoot of pkgRoots) {
		const validated = await validateExtensionPackage(pkgRoot, errors);
		if (validated) count++;
	}

	// Also scan top-level hooks/pre|post dirs (not inside an extension package).
	for (const base of [agentDir, path.join(projectDir, ".omp")]) {
		await scanTopLevelHooks(base, errors);
	}

	if (errors.length > 0) {
		return {
			id: "setup.extensions",
			category: "setup",
			status: "error",
			summary: `extensions: ${errors.length} error${errors.length === 1 ? "" : "s"}`,
			details: errors,
		};
	}
	return {
		id: "setup.extensions",
		category: "setup",
		status: "ok",
		summary: `extensions: ${count} valid`,
		details: [],
	};
}

async function collectSetupFindings(flags: DoctorCommandFlags): Promise<DoctorFinding[]> {
	const agentDir = flags.agentDir ?? getAgentDir();
	const projectDir = getProjectDir();
	return [
		await collectAgentSetupFinding(agentDir, projectDir, flags.agentDir !== undefined),
		await collectKeybindingsSetupFinding(agentDir),
		await collectWatchdogSetupFinding(agentDir, projectDir),
		await collectSkillsSetupFinding(agentDir, projectDir),
		await collectThemesSetupFinding(agentDir),
		await collectExtensionsSetupFinding(agentDir, projectDir, flags.agentDir !== undefined),
	];
}

async function collectPluginFindings(flags: DoctorCommandFlags): Promise<DoctorFinding[]> {
	// Plugin state is root-scoped; a run restricted to --agent-dir must not
	// repair (and thereby mutate) state outside its scope.
	const fix = flags.fix === true && flags.agentDir === undefined;
	let checks: DoctorCheck[];
	try {
		checks = await new PluginManager().doctor({ fix });
	} catch (error) {
		// A malformed plugins/package.json makes PluginManager.doctor() rethrow;
		// catch so the rest of the report still renders.
		return [
			{
				id: "plugins.doctor",
				category: "plugins",
				status: "error",
				summary: `plugin doctor failed: ${error instanceof Error ? error.message : String(error)}`,
				details: [],
			},
		];
	}
	return checks.map(check => {
		// PluginManager.doctor({fix:true}) returns the ORIGINAL error/warning status
		// with fixed:true; the plugin CLI excludes fixed checks from error totals.
		// Mirror that semantics: a fixed check normalizes to ok, preserving the
		// original problem text so the user sees what was repaired.
		if (check.fixed === true) {
			return {
				id: `plugins.${check.name}`,
				category: "plugins" as const,
				status: "ok",
				summary: `fixed: ${check.message}`,
				details: [],
				fixed: true,
			};
		}
		return {
			id: `plugins.${check.name}`,
			category: "plugins" as const,
			status: check.status,
			summary: check.message,
			details: [],
		};
	});
}

export async function collectDoctorReport(flags: DoctorCommandFlags): Promise<DoctorReport> {
	const findings: DoctorFinding[] = [
		await collectEnvironmentFinding(),
		...(await collectConfigFindings(flags)),
		...collectToolFindings(),
		await collectSqliteRecoverFinding(),
		...(await collectStorageFindings(flags)),
		...(await collectMcpFindings(flags)),
		...(await collectBrowserFindings()),
		...(await collectAuthFindings(flags)),
		...(await collectSetupFindings(flags)),
		...(await collectPluginFindings(flags)),
	];
	const overallStatus: DoctorStatus = findings.some(f => f.status === "error")
		? "error"
		: findings.some(f => f.status === "warning")
			? "warning"
			: "ok";
	return {
		schemaVersion: 1,
		generatedAt: new Date().toISOString(),
		ompVersion: VERSION,
		fix: flags.fix === true,
		overallStatus,
		findings,
	};
}

export function renderDoctorReport(report: DoctorReport): string {
	// Raw check output (SQLite errors, plugin messages) is untrusted terminal
	// input: tabs break alignment, long lines overflow, home paths leak.
	const sanitize = (text: string): string => truncateToWidth(replaceTabs(shortenPath(text)), TRUNCATE_LENGTHS.CONTENT);
	const lines: string[] = [`omp doctor v${report.ompVersion}${report.fix ? " (--fix)" : ""}`];
	for (const category of CATEGORY_ORDER) {
		const group = report.findings.filter(finding => finding.category === category);
		if (group.length === 0) continue;
		lines.push("", category.charAt(0).toUpperCase() + category.slice(1));
		for (const finding of group) {
			const glyph =
				finding.status === "ok"
					? theme.status.enabled
					: finding.status === "warning"
						? theme.status.warning
						: theme.status.error;
			const tail = finding.id.startsWith(`${category}.`) ? finding.id.slice(category.length + 1) : finding.id;
			lines.push(`  ${glyph} ${sanitize(tail).padEnd(14)}  ${sanitize(finding.summary)}`);
			if (finding.status === "ok") continue;
			for (const detail of finding.details) lines.push(`      ${sanitize(detail)}`);
			if (finding.remedy !== undefined) lines.push(`      → ${sanitize(finding.remedy)}`);
		}
	}
	const ok = report.findings.filter(finding => finding.status === "ok").length;
	const warnings = report.findings.filter(finding => finding.status === "warning").length;
	const errors = report.findings.filter(finding => finding.status === "error").length;
	lines.push("", `${ok} ok · ${warnings} warnings · ${errors} errors`);
	return `${lines.join("\n")}\n`;
}

export async function runDoctorCommand(args: DoctorCommandArgs): Promise<DoctorReport> {
	const report = await collectDoctorReport(args.flags);
	const output = args.flags.json === true ? `${JSON.stringify(report, null, 2)}\n` : renderDoctorReport(report);
	process.stdout.write(output);
	return report;
}
