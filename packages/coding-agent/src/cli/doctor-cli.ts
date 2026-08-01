/**
 * Report engine for `omp doctor`.
 *
 * Collects findings across environment, tools, storage, and plugins, renders
 * the human or JSON report, and owns the single stdout write — the command
 * wrapper stays thin. Mirrors the gc-cli.ts / stats-cli.ts split.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { $which, formatBytes, getAgentDir, MAIN_CONFIG_FILENAMES, VERSION } from "@oh-my-pi/pi-utils";
import type { LoadResult } from "../config/config-file";
import { ModelsConfigFile } from "../config/models-config";
import { classifySettingsYaml, type YamlLoadResult } from "../config/settings";
import { collectSystemInfo, formatSystemInfo } from "../debug/system-info";
import { PluginManager } from "../extensibility/plugins/manager";
import { theme } from "../modes/theme/theme";
import { replaceTabs, shortenPath, TRUNCATE_LENGTHS, truncateToWidth } from "../tools/render-utils";
import {
	type DbProbe,
	type DbRepair,
	FREE_PAGE_VACUUM_RATIO,
	probeDatabase,
	recoverInterruptedSwap,
	repairDatabase,
	resolveDoctorDatabases,
} from "./doctor-sqlite";
import { withGcLock } from "./gc-cli";

export type DoctorStatus = "ok" | "warning" | "error";

export type DoctorCategory = "environment" | "config" | "tools" | "storage" | "plugins";

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

const CATEGORY_ORDER: readonly DoctorCategory[] = ["environment", "config", "tools", "storage", "plugins"];

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
	return TOOL_CHECKS.map(tool => {
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
	if (probe.busy || repair?.busy === true) {
		return {
			...base,
			status: "warning",
			summary: `${probe.label}: database busy`,
			remedy: "Close running omp sessions and re-run `omp doctor --fix`",
		};
	}
	if (repair?.error !== null && repair?.error !== undefined) {
		return {
			...base,
			status: "error",
			summary: `${probe.label}: repair failed`,
			details: [...base.details, repair.error],
		};
	}
	if (repair !== null && repair.actions.length > 0) {
		let summary = `${probe.label}: ${repair.actions.join(", ")}`;
		if (repair.bytesAfter < repair.bytesBefore) {
			summary += ` (${formatBytes(repair.bytesBefore)} -> ${formatBytes(repair.bytesAfter)})`;
		}
		return { ...base, status: "ok", summary, fixed: true };
	}
	if (probe.openError !== null) {
		return {
			...base,
			status: "error",
			summary: `${probe.label}: cannot open`,
			details: [...base.details, probe.openError],
		};
	}
	if (probe.quickCheck !== "ok") {
		return {
			...base,
			status: "error",
			summary: `${probe.label}: corrupt`,
			details: [...base.details, probe.quickCheck ?? "quick_check unavailable"],
		};
	}
	if (probe.foreignKeyViolations > 0) {
		return {
			...base,
			status: "warning",
			summary: `${probe.label}: ${probe.foreignKeyViolations} foreign-key violations`,
		};
	}
	if (
		probe.pageCount !== null &&
		probe.pageCount > 0 &&
		probe.freelistCount !== null &&
		probe.freelistCount / probe.pageCount >= FREE_PAGE_VACUUM_RATIO
	) {
		const pct = Math.round((probe.freelistCount / probe.pageCount) * 100);
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
	const modelsYml = path.join(agentDir, "models.yml");
	let modelsResult = ModelsConfigFile.diagnose(modelsYml);
	let modelsFilename = "models.yml";
	if (modelsResult.status === "not-found") {
		// Legacy models.json: startup feeds it through #ensureMigrated(), but that
		// writes to disk — the read-only diagnostic must classify the JSON source
		// directly so a broken legacy models.json surfaces as an error instead of
		// a false "absent". diagnose() on the .json path reads/parses it as JSONC
		// without any migration or write.
		const jsonResult = ModelsConfigFile.diagnose(path.join(agentDir, "models.json"));
		if (jsonResult.status !== "not-found") {
			modelsResult = jsonResult;
			modelsFilename = "models.json";
		}
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
	} catch {
		return [];
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
			if (swap.restored) finding.details.push("restored from archive after an interrupted swap");
			findings.push(finding);
		}
		return findings;
	};
	// Share gc's lock so `omp gc --apply` and `omp doctor --fix` cannot vacuum the same files concurrently.
	if (flags.fix === true) return withGcLock(flags.agentDir ?? getAgentDir(), collect);
	return collect();
}

async function collectPluginFindings(flags: DoctorCommandFlags): Promise<DoctorFinding[]> {
	// Plugin state is root-scoped; a run restricted to --agent-dir must not
	// repair (and thereby mutate) state outside its scope.
	const fix = flags.fix === true && flags.agentDir === undefined;
	const checks = await new PluginManager().doctor({ fix });
	return checks.map(check => ({
		id: `plugins.${check.name}`,
		category: "plugins" as const,
		status: check.status,
		summary: check.message,
		details: [],
		fixed: check.fixed,
	}));
}

export async function collectDoctorReport(flags: DoctorCommandFlags): Promise<DoctorReport> {
	const findings: DoctorFinding[] = [
		await collectEnvironmentFinding(),
		...(await collectConfigFindings(flags)),
		...collectToolFindings(),
		...(await collectStorageFindings(flags)),
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
			lines.push(`  ${glyph} ${tail.padEnd(14)}  ${sanitize(finding.summary)}`);
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
