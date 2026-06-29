import type { Settings } from "../../config/settings";
import type { ParsedSlashCommand, SlashCommandResult, SlashCommandRuntime } from "../types";
import { commandConsumed, parseSubcommand, usage } from "./parse";

export const TOKEN_SAVING_COMMAND_USAGE = "Usage: /tokensaving [on|off|status]";

export type TokenSavingSettingPath =
	| "task.eager"
	| "advisor.subagents"
	| "advisor.syncBacklog"
	| "advisor.immuneTurns"
	| "advisor.compactionEnabled"
	| "advisor.compactionThresholdPercent"
	| "advisor.compactionThresholdTokens"
	| "advisor.compactionModel"
	| "advisor.compactionStrategy"
	| "enabledModels"
	| "modelRoles";

export type TokenSavingSettingValue<P extends TokenSavingSettingPath> = P extends "task.eager"
	? "default" | "preferred" | "always"
	: P extends "advisor.subagents"
		? boolean
		: P extends "advisor.syncBacklog"
			? "off" | "1" | "3" | "5"
			: P extends "advisor.immuneTurns"
				? number
				: P extends "advisor.compactionEnabled"
					? boolean
					: P extends "advisor.compactionThresholdPercent"
						? number
						: P extends "advisor.compactionThresholdTokens"
							? number
							: P extends "advisor.compactionModel"
								? string
								: P extends "advisor.compactionStrategy"
									? "inherit" | "context-full" | "snapcompact"
									: P extends "enabledModels"
										? readonly string[]
										: P extends "modelRoles"
											? Record<string, string>
											: never;

export interface TokenSavingSettingsLike {
	get<P extends TokenSavingSettingPath>(path: P): TokenSavingSettingValue<P>;
	set<P extends TokenSavingSettingPath>(path: P, value: TokenSavingSettingValue<P>): void;
	getModelRole(role: string): string | undefined;
	setModelRole(role: string, modelId: string): void;
	getModelRoles(): Readonly<Record<string, string>>;
	getAgentDir?(): string;
}

export function toTokenSavingSettings(settings: Settings): TokenSavingSettingsLike {
	return {
		get: path => settings.get(path) as TokenSavingSettingValue<typeof path>,
		set: (path, value) => settings.set(path, value as never),
		getModelRole: role => settings.getModelRole(role),
		setModelRole: (role, modelId) => settings.setModelRole(role, modelId),
		getModelRoles: () => ({ ...settings.getModelRoles() }) as Readonly<Record<string, string>>,
		getAgentDir: () => settings.getAgentDir(),
	};
}

export interface TokenSavingChange {
	key: string;
	from: string | number | boolean | undefined;
	to: string | number | boolean;
}

export interface TokenSavingApplyResult {
	changes: TokenSavingChange[];
	candidate?: string;
	warnings: string[];
}

export interface TokenSavingEnableResult extends TokenSavingApplyResult {
	snapshotCreated: boolean;
	snapshotPath?: string;
	snapshotError?: string;
}

const CHEAP_MODEL_RE =
	/\b(deepseek|flash|smol|cheap|tiny|mini|qwen(?=\d|[\s:/-]|$)|gemma(?=\d|[\s:/-]|$)|local|ollama)/i;
const ROLE_CANDIDATE_ORDER = ["task", "smol", "tiny", "advisor"] as const;
const EXPENSIVE_ROLE_NAMES = ["default", "slow", "plan", "vision"] as const;

function display(value: unknown): string {
	if (value === undefined || value === "") return "unset";
	return String(value);
}

function isLikelyCheapModel(modelId: string | undefined): boolean {
	return !!modelId && CHEAP_MODEL_RE.test(modelId);
}

function protectedRoleModels(roles: Readonly<Record<string, string>>): Set<string> {
	const protectedModels = new Set<string>();
	for (const role of EXPENSIVE_ROLE_NAMES) {
		const model = roles[role];
		if (model) protectedModels.add(model);
	}
	return protectedModels;
}

function isProtectedExpensiveRoleModel(modelId: string | undefined, roles: Readonly<Record<string, string>>): boolean {
	return !!modelId && protectedRoleModels(roles).has(modelId);
}

export function selectTokenSavingModel(settings: TokenSavingSettingsLike): string | undefined {
	const roles = settings.getModelRoles();
	const protectedModels = protectedRoleModels(roles);
	const roleModels = ROLE_CANDIDATE_ORDER.map(role => roles[role]).filter((model): model is string => !!model);

	const cheapRoleModel = roleModels.find(model => isLikelyCheapModel(model) && !protectedModels.has(model));
	if (cheapRoleModel) return cheapRoleModel;

	const enabledModels = settings.get("enabledModels");
	const cheapEnabledModel = enabledModels.find(model => isLikelyCheapModel(model) && !protectedModels.has(model));
	if (cheapEnabledModel) return cheapEnabledModel;
	return undefined;
}

function setIfChanged<P extends TokenSavingSettingPath>(
	settings: TokenSavingSettingsLike,
	changes: TokenSavingChange[],
	key: P,
	value: TokenSavingSettingValue<P>,
): void {
	const current = settings.get(key);
	if (current === value) return;
	settings.set(key, value);
	changes.push({
		key,
		from: current as string | number | boolean | undefined,
		to: value as string | number | boolean,
	});
}

function setModelRoleIfChanged(
	settings: TokenSavingSettingsLike,
	changes: TokenSavingChange[],
	role: string,
	modelId: string,
): void {
	const current = settings.getModelRole(role);
	if (current === modelId) return;
	settings.setModelRole(role, modelId);
	changes.push({ key: `modelRoles.${role}`, from: current, to: modelId });
}

export function collectTokenSavingWarnings(settings: TokenSavingSettingsLike): string[] {
	const roles = settings.getModelRoles();
	const warnings: string[] = [];
	const defaultRole = settings.getModelRole("default");
	const taskRole = settings.getModelRole("task");
	const advisorRole = settings.getModelRole("advisor");

	if (!taskRole) warnings.push("modelRoles.task is unset; task subagents may inherit the expensive default model.");
	else if (taskRole === defaultRole)
		warnings.push("modelRoles.task equals modelRoles.default; task subagents are not shifted to a cheap model.");
	if (taskRole && taskRole !== defaultRole) {
		if (!isLikelyCheapModel(taskRole)) {
			warnings.push("modelRoles.task is not a cheap model; task subagents may still use an expensive model.");
		}
		if (isProtectedExpensiveRoleModel(taskRole, roles)) {
			warnings.push(
				"modelRoles.task points at an expensive orchestration role model; task subagents are additive model spend.",
			);
		}
	}
	if (settings.get("task.eager") !== "always")
		warnings.push("task.eager is not always; delegation is still optional.");
	if (settings.get("advisor.subagents"))
		warnings.push("advisor.subagents is true; advisor cost will multiply across task subagents.");
	if (settings.get("advisor.syncBacklog") !== "off")
		warnings.push("advisor.syncBacklog is not off; the expensive main can wait on advisor catch-up.");
	if (settings.get("advisor.immuneTurns") < 10)
		warnings.push("advisor.immuneTurns is below 10; repeated advisor interruptions can trigger extra main turns.");
	if (advisorRole && isProtectedExpensiveRoleModel(advisorRole, roles)) {
		warnings.push(
			"modelRoles.advisor points at an expensive orchestration role; advisor review is additive model spend.",
		);
	}
	if (advisorRole && !isLikelyCheapModel(advisorRole)) {
		warnings.push("modelRoles.advisor is not a cheap model; advisor review uses an expensive model.");
	}
	if (!settings.get("advisor.compactionEnabled"))
		warnings.push("advisor.compactionEnabled is false; advisor compaction is disabled.");
	if ((settings.get("advisor.compactionThresholdPercent") ?? 0) > 50)
		warnings.push("advisor.compactionThresholdPercent is above 50; compaction may not trigger effectively.");

	return warnings;
}

export async function formatTokenSavingStatus(settings: TokenSavingSettingsLike): Promise<string> {
	const warnings = collectTokenSavingWarnings(settings);
	const snapshotPath_ = snapshotPath(settings);
	const snapshotExists = snapshotPath_ ? await Bun.file(snapshotPath_).exists() : false;
	const active = snapshotExists;
	const lines = [
		`Token saving: ${active ? "on" : "off"}`,
		`Models: default=${display(settings.getModelRole("default"))}, task=${display(settings.getModelRole("task"))}, advisor=${display(settings.getModelRole("advisor"))}`,
		`Task routing: task.eager=${settings.get("task.eager")}`,
		`Advisor scope: subagents=${settings.get("advisor.subagents")}, syncBacklog=${settings.get("advisor.syncBacklog")}, immuneTurns=${settings.get("advisor.immuneTurns")}`,
	];
	if (warnings.length > 0) {
		lines.push("Warnings:");
		for (const warning of warnings) lines.push(`- ${warning}`);
	}
	lines.push(
		"Usage split: live main/task/advisor token breakdown is not available yet; offline stats can classify transcripts.",
	);
	return lines.join("\n");
}

export function applyTokenSaving(settings: TokenSavingSettingsLike): TokenSavingApplyResult {
	const changes: TokenSavingChange[] = [];
	const candidate = selectTokenSavingModel(settings);
	const defaultRole = settings.getModelRole("default");
	const taskRole = settings.getModelRole("task");
	const advisorRole = settings.getModelRole("advisor");
	const roles = settings.getModelRoles();

	setIfChanged(settings, changes, "task.eager", "always");
	setIfChanged(settings, changes, "advisor.subagents", false);
	setIfChanged(settings, changes, "advisor.syncBacklog", "off");
	setIfChanged(settings, changes, "advisor.immuneTurns", 10);
	setIfChanged(settings, changes, "advisor.compactionEnabled", true);
	setIfChanged(settings, changes, "advisor.compactionThresholdPercent", 25);
	setIfChanged(settings, changes, "advisor.compactionStrategy", "snapcompact");

	if (
		candidate &&
		(!taskRole ||
			taskRole === defaultRole ||
			!isLikelyCheapModel(taskRole) ||
			isProtectedExpensiveRoleModel(taskRole, roles))
	) {
		setModelRoleIfChanged(settings, changes, "task", candidate);
	}
	if (
		candidate &&
		(!advisorRole ||
			advisorRole === defaultRole ||
			!isLikelyCheapModel(advisorRole) ||
			isProtectedExpensiveRoleModel(advisorRole, roles))
	) {
		setModelRoleIfChanged(settings, changes, "advisor", candidate);
	}

	return { changes, candidate, warnings: collectTokenSavingWarnings(settings) };
}

const SNAPSHOT_FILE = "tokensaving-snapshot.json";

interface TokenSavingSnapshot {
	version: 1;
	settings: Array<{
		key: Exclude<TokenSavingSettingPath, "modelRoles">;
		value: string | number | boolean | readonly string[] | undefined;
	}>;
	modelRoles: Array<{ role: string; value?: string }>;
}

function snapshotPath(settings: TokenSavingSettingsLike): string | undefined {
	const agentDir = settings.getAgentDir?.();
	return agentDir ? `${agentDir}/${SNAPSHOT_FILE}` : undefined;
}

function buildSnapshot(changes: readonly TokenSavingChange[]): TokenSavingSnapshot {
	const snapshot: TokenSavingSnapshot = { version: 1, settings: [], modelRoles: [] };
	for (const change of changes) {
		if (change.key.startsWith("modelRoles.")) {
			snapshot.modelRoles.push({
				role: change.key.slice("modelRoles.".length),
				value: typeof change.from === "string" ? change.from : undefined,
			});
			continue;
		}
		snapshot.settings.push({
			key: change.key as Exclude<TokenSavingSettingPath, "modelRoles">,
			value: change.from,
		});
	}
	return snapshot;
}
async function readSnapshot(file: string): Promise<TokenSavingSnapshot | undefined> {
	if (!(await Bun.file(file).exists())) return undefined;
	const parsed = (await Bun.file(file).json()) as TokenSavingSnapshot;
	if (parsed.version !== 1 || !Array.isArray(parsed.settings) || !Array.isArray(parsed.modelRoles)) {
		throw new Error("Invalid token-saving snapshot format");
	}
	return parsed;
}
async function writeSnapshot(
	settings: TokenSavingSettingsLike,
	changes: readonly TokenSavingChange[],
): Promise<Pick<TokenSavingEnableResult, "snapshotCreated" | "snapshotPath" | "snapshotError">> {
	const file = snapshotPath(settings);
	if (!file || changes.length === 0) return { snapshotCreated: false, snapshotPath: file };
	try {
		let snapshot: TokenSavingSnapshot;
		if (await Bun.file(file).exists()) {
			const existing = await readSnapshot(file);
			if (existing) {
				// Merge: keep existing entries, add new ones not already in the snapshot
				snapshot = existing;
				for (const change of changes) {
					if (change.key.startsWith("modelRoles.")) {
						const role = change.key.slice("modelRoles.".length);
						if (!snapshot.modelRoles.some(r => r.role === role)) {
							snapshot.modelRoles.push({
								role,
								value: typeof change.from === "string" ? change.from : undefined,
							});
						}
					} else {
						const key = change.key as Exclude<TokenSavingSettingPath, "modelRoles">;
						if (!snapshot.settings.some(s => s.key === key)) {
							snapshot.settings.push({ key, value: change.from });
						}
					}
				}
				await Bun.write(file, `${JSON.stringify(snapshot, null, 2)}\n`);
				return { snapshotCreated: false, snapshotPath: file };
			}
		}
		// No existing snapshot — create fresh
		snapshot = buildSnapshot(changes);
		await Bun.write(file, `${JSON.stringify(snapshot, null, 2)}\n`);
		return { snapshotCreated: true, snapshotPath: file };
	} catch (err) {
		return {
			snapshotCreated: false,
			snapshotPath: file,
			snapshotError: err instanceof Error ? err.message : String(err),
		};
	}
}

export async function enableTokenSaving(settings: TokenSavingSettingsLike): Promise<TokenSavingEnableResult> {
	const result = applyTokenSaving(settings);
	setIfChanged(settings, result.changes, "advisor.compactionThresholdTokens", -1);
	return { ...result, ...(await writeSnapshot(settings, result.changes)) };
}
export async function disableTokenSaving(settings: TokenSavingSettingsLike): Promise<string> {
	const file = snapshotPath(settings);
	if (!file) {
		return "Token saving restore is unavailable: settings object does not expose an agent directory.";
	}
	let snapshot: TokenSavingSnapshot | undefined;
	try {
		snapshot = await readSnapshot(file);
	} catch (err) {
		return `Token saving restore failed: ${err instanceof Error ? err.message : String(err)}`;
	}
	if (!snapshot) {
		return "Token saving restore skipped: no token-saving snapshot was found.";
	}
	for (const item of snapshot.settings) {
		settings.set(item.key, item.value as never);
	}
	if (snapshot.modelRoles.length > 0) {
		const roles = { ...settings.getModelRoles() };
		for (const item of snapshot.modelRoles) {
			if (item.value === undefined) delete roles[item.role];
			else roles[item.role] = item.value;
		}
		settings.set("modelRoles", roles);
	}
	try {
		await Bun.file(file).delete();
	} catch (err) {
		return `Token saving restored, but snapshot cleanup failed: ${err instanceof Error ? err.message : String(err)}`;
	}
	return "Token saving settings restored from snapshot.";
}

export async function runTokenSavingCommand(args: string, settings: TokenSavingSettingsLike): Promise<string> {
	const { verb } = parseSubcommand(args);
	if (!verb || verb === "status") return formatTokenSavingStatus(settings);
	if (verb === "on") {
		const result = await enableTokenSaving(settings);
		const lines = ["Token saving enabled."];
		if (result.candidate) lines.push(`Cheap model candidate: ${result.candidate}`);
		if (result.changes.length === 0) lines.push("No setting changes were needed.");
		else {
			lines.push("Changed settings:");
			for (const change of result.changes)
				lines.push(`- ${change.key}: ${display(change.from)} -> ${display(change.to)}`);
		}
		if (result.snapshotCreated) lines.push(`Snapshot saved: ${result.snapshotPath}`);
		else if (result.snapshotPath && result.changes.length > 0)
			lines.push(`Snapshot already exists: ${result.snapshotPath}`);
		else if (!result.snapshotPath && result.changes.length > 0)
			lines.push("Snapshot not saved: settings object does not expose an agent directory.");
		if (result.snapshotError) lines.push(`Snapshot error: ${result.snapshotError}`);
		if (result.warnings.length > 0) {
			lines.push("Remaining warnings:");
			for (const warning of result.warnings) lines.push(`- ${warning}`);
		}
		return lines.join("\n");
	}
	if (verb === "off") return disableTokenSaving(settings);
	return TOKEN_SAVING_COMMAND_USAGE;
}

export async function handleTokenSavingCommand(
	command: ParsedSlashCommand,
	runtime: SlashCommandRuntime,
): Promise<SlashCommandResult> {
	const { verb } = parseSubcommand(command.args);
	if (verb && verb !== "on" && verb !== "off" && verb !== "status") return usage(TOKEN_SAVING_COMMAND_USAGE, runtime);
	const beforeAdvisor = runtime.settings.getModelRole("advisor");
	const output = await runTokenSavingCommand(command.args, toTokenSavingSettings(runtime.settings));
	await runtime.output(output);
	if (verb === "on" || verb === "off") {
		await runtime.settings.flush();
		if (beforeAdvisor !== runtime.settings.getModelRole("advisor")) {
			runtime.session.rebuildAdvisorRuntime();
		}
	}
	return commandConsumed();
}
