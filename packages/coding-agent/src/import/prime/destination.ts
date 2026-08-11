import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { type Dirent, constants as fsConstants, type Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getAgentDbPath, MAIN_CONFIG_FILENAMES, withFileLock } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";
import { ModelRegistry } from "../../config/model-registry";
import { ModelsConfigFile } from "../../config/models-config";
import { type SettingPath, Settings, type SettingsCreateOnlyMutation, type SettingValue } from "../../config/settings";
import { loadSkillsFromDir } from "../../extensibility/skills";
import { AuthStorage } from "../../session/auth-storage";
import { revalidatePrimeSource } from "./source";
import type {
	PrimeConfigParserResult,
	PrimeCredentialClassification,
	PrimeImportDomain,
	PrimeImportItemResult,
	PrimeImportLoss,
	PrimeImportPlan,
	PrimeImportReport,
	PrimeJsonValue,
	PrimeNormalizedModel,
	PrimeNormalizedModelOperation,
	PrimeNormalizedModelOverride,
	PrimeRollbackManifestEntry,
	PrimeSkillCandidate,
	PrimeSkillParserResult,
	PrimeSourceSnapshot,
} from "./types";

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const isRecord = (value: unknown): value is Record<string, unknown> =>
	value !== null && typeof value === "object" && !Array.isArray(value);
const missing = (error: unknown): boolean => isRecord(error) && error.code === "ENOENT";
class DestinationValidationError extends Error {}
class ModelValidationError extends DestinationValidationError {}
class SkillExistingWinsError extends Error {}

function expectedDestinationError(error: unknown): boolean {
	return (
		error instanceof DestinationValidationError ||
		error instanceof SkillExistingWinsError ||
		(isRecord(error) &&
			typeof error.code === "string" &&
			[
				"EACCES",
				"EEXIST",
				"EFBIG",
				"EISDIR",
				"EINVAL",
				"ELOOP",
				"EMFILE",
				"ENFILE",
				"ENODEV",
				"ENOENT",
				"ENOTDIR",
				"ENOTEMPTY",
				"ENOSPC",
				"EPERM",
				"EROFS",
				"EXDEV",
			].includes(error.code))
	);
}
const sha256 = (value: Uint8Array): string => createHash("sha256").update(value).digest("hex");
const clone = <T>(value: T): T => {
	if (Array.isArray(value)) return value.map(entry => clone(entry)) as T;
	if (isRecord(value))
		return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, clone(entry)])) as T;
	return value;
};
const planBindings = new WeakMap<object, string>();
function stableValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(stableValue);
	if (isRecord(value))
		return Object.fromEntries(
			Object.keys(value)
				.sort(compare)
				.map(key => [key, stableValue(value[key])]),
		);
	return value;
}
function bindingDigest(input: PrimeDestinationInput): string {
	const secretIds = new Set<string>();
	for (const operation of input.config.credentials)
		if (operation.secretOperationId) secretIds.add(operation.secretOperationId);
	for (const operation of input.config.models) {
		if (operation.providerApiKey?.secretOperationId) secretIds.add(operation.providerApiKey.secretOperationId);
		for (const value of Object.values(operation.providerConfig?.headers ?? {}))
			if (value.secretOperationId) secretIds.add(value.secretOperationId);
		for (const value of Object.values(operation.model.headers ?? {}))
			if (value.secretOperationId) secretIds.add(value.secretOperationId);
	}
	const secrets = [...secretIds].sort(compare).map(id => [id, input.config.secretTable.get(id)]);
	return sha256(
		Buffer.from(
			JSON.stringify(
				stableValue({
					snapshot: input.snapshot,
					config: input.config.operations,
					settings: input.config.effectiveSettings,
					skills: input.skills.candidates,
					sourceDomains: input.sourceDomains,
					allowModelLosses: input.allowModelLosses,
					secrets,
				}),
			),
		),
	);
}

export type PrimeSupportedSettingPath =
	| "defaultThinkingLevel"
	| "steeringMode"
	| "followUpMode"
	| "hideThinkingBlock"
	| "shellPath"
	| "enabledModels"
	| "treeFilterMode"
	| "compaction.enabled"
	| "compaction.reserveTokens"
	| "compaction.keepRecentTokens"
	| "retry.enabled"
	| "retry.maxRetries"
	| "retry.baseDelayMs"
	| "retry.maxDelayMs"
	| "skills.enableSkillCommands"
	| "modelRoles";

type PrimeNonRoleSettingPath = Exclude<PrimeSupportedSettingPath, "modelRoles">;
export type PrimeSettingMutation =
	| {
			[P in PrimeNonRoleSettingPath]: {
				readonly kind: "setting";
				readonly path: P;
				readonly value: SettingValue<P>;
				readonly sourceRefs: readonly string[];
				readonly itemId: string;
			};
	  }[PrimeNonRoleSettingPath]
	| {
			readonly kind: "setting";
			readonly path: "modelRoles";
			readonly value: Readonly<Record<string, string>>;
			readonly sourceRefs: readonly string[];
			readonly itemId: string;
			readonly roleValues: Readonly<Record<string, string>>;
	  };

export interface PrimeDestinationPaths {
	readonly agentDir: string;
	readonly cwd: string;
	readonly settingsCandidates: readonly string[];
	readonly modelsPath: string;
	readonly agentDbPath: string;
	readonly skillsRoot: string;
}
export type PrimeDestinationPrecondition =
	| { readonly kind: "setting"; readonly path: PrimeSupportedSettingPath; readonly configured: false }
	| {
			readonly kind: "models";
			readonly destinationRef: string;
			readonly sha256?: string;
			readonly identity?: Readonly<{ dev: number; ino: number }>;
	  }
	| { readonly kind: "skill"; readonly destinationRef: string; readonly absent: true };
export interface PrimeDestinationInput {
	readonly snapshot: PrimeSourceSnapshot;
	readonly config: PrimeConfigParserResult;
	readonly skills: PrimeSkillParserResult;
	readonly allowModelLosses?: boolean;
	readonly sourceDomains?: readonly PrimeImportDomain[];
}
export interface PrimeDestinationPlan extends PrimeImportPlan {
	readonly destination: PrimeDestinationPaths;
	/** Budgets captured from the source snapshot for every destination re-read. */
	readonly maxFileBytes: number;
	readonly maxTotalBytes: number;
	readonly maxEntries: number;
	readonly settingMutations: readonly PrimeSettingMutation[];
	readonly preconditions: readonly PrimeDestinationPrecondition[];
	readonly items: readonly PrimeImportItemResult[];
	readonly losses: readonly PrimeImportLoss[];
}
export interface PrimeDestinationApplyResult {
	readonly report: PrimeImportReport;
	readonly rollbackEntries: readonly PrimeRollbackManifestEntry[];
}
interface ExistingModels {
	readonly path: string;
	readonly sha256?: string;
	readonly identity?: Readonly<{ dev: number; ino: number }>;
	readonly value: Record<string, unknown>;
}

function isExists(error: unknown): boolean {
	return isRecord(error) && error.code === "EEXIST";
}
function loss(code: PrimeImportLoss["code"], sourceRef: string, destination?: string): PrimeImportLoss {
	return { code, domain: "config", sourceRef, ...(destination ? { path: destination } : {}) };
}
function sortLosses(values: readonly PrimeImportLoss[]): PrimeImportLoss[] {
	return [...values].sort((a, b) =>
		compare(
			`${a.sourceRef}\u0000${a.path ?? ""}\u0000${a.code}`,
			`${b.sourceRef}\u0000${b.path ?? ""}\u0000${b.code}`,
		),
	);
}
function sortItems(values: readonly PrimeImportItemResult[]): PrimeImportItemResult[] {
	return [...values].sort((a, b) =>
		compare(
			`${a.kind}\u0000${a.itemId}\u0000${a.sourceRefs.join("\u0000")}`,
			`${b.kind}\u0000${b.itemId}\u0000${b.sourceRefs.join("\u0000")}`,
		),
	);
}
function result(
	itemId: string,
	kind: PrimeImportItemResult["kind"],
	refs: readonly string[],
	outcome: PrimeImportItemResult["outcome"],
	codes?: readonly PrimeImportLoss["code"][],
): PrimeImportItemResult {
	return {
		itemId,
		kind,
		sourceRefs: [...refs].sort(compare),
		outcome,
		...(codes?.length ? { lossCodes: [...codes].sort(compare) } : {}),
	};
}
function refsFor(config: PrimeConfigParserResult, key: string): string[] {
	return [
		...new Set(
			config.settings
				.filter(operation => Object.hasOwn(operation.values, key))
				.flatMap(operation => operation.sourceRefs),
		),
	].sort(compare);
}
function settingValue(
	pathValue: PrimeSupportedSettingPath,
	value: PrimeJsonValue,
	refs: readonly string[],
): PrimeSettingMutation | undefined {
	const base = { kind: "setting" as const, path: pathValue, sourceRefs: refs, itemId: `setting:${pathValue}` };
	switch (pathValue) {
		case "defaultThinkingLevel":
			return typeof value === "string"
				? ({ ...base, value: value as SettingValue<"defaultThinkingLevel"> } as PrimeSettingMutation)
				: undefined;
		case "steeringMode":
		case "followUpMode":
		case "treeFilterMode":
		case "shellPath":
			return typeof value === "string"
				? ({ ...base, value: value as SettingValue<typeof pathValue> } as PrimeSettingMutation)
				: undefined;
		case "hideThinkingBlock":
		case "compaction.enabled":
		case "retry.enabled":
		case "skills.enableSkillCommands":
			return typeof value === "boolean"
				? ({ ...base, value: value as SettingValue<typeof pathValue> } as PrimeSettingMutation)
				: undefined;
		case "enabledModels":
			return Array.isArray(value) && value.every(entry => typeof entry === "string")
				? ({ ...base, value: value as SettingValue<"enabledModels"> } as PrimeSettingMutation)
				: undefined;
		case "compaction.reserveTokens":
		case "compaction.keepRecentTokens":
		case "retry.maxRetries":
		case "retry.baseDelayMs":
		case "retry.maxDelayMs":
			return typeof value === "number" && Number.isFinite(value)
				? ({ ...base, value: value as SettingValue<typeof pathValue> } as PrimeSettingMutation)
				: undefined;
		case "modelRoles":
			return undefined;
	}
}
function planSettings(
	config: PrimeConfigParserResult,
	settings: Settings,
): {
	mutations: PrimeSettingMutation[];
	items: PrimeImportItemResult[];
	preconditions: PrimeDestinationPrecondition[];
} {
	const paths: readonly PrimeSupportedSettingPath[] = [
		"compaction.enabled",
		"compaction.keepRecentTokens",
		"compaction.reserveTokens",
		"defaultThinkingLevel",
		"enabledModels",
		"followUpMode",
		"hideThinkingBlock",
		"retry.baseDelayMs",
		"retry.enabled",
		"retry.maxDelayMs",
		"retry.maxRetries",
		"shellPath",
		"skills.enableSkillCommands",
		"steeringMode",
		"treeFilterMode",
	];
	const mutations: PrimeSettingMutation[] = [],
		items: PrimeImportItemResult[] = [],
		preconditions: PrimeDestinationPrecondition[] = [];
	for (const key of paths) {
		const value = config.effectiveSettings[key];
		if (value === undefined) continue;
		const refs = refsFor(config, key),
			id = `setting:${key}`;
		if (settings.isConfigured(key as SettingPath)) items.push(result(id, "settings", refs, "skipped"));
		else {
			const mutation = settingValue(key, value, refs);
			if (mutation) {
				mutations.push(mutation);
				preconditions.push({ kind: "setting", path: key, configured: false });
				items.push(result(id, "settings", refs, "planned"));
			} else items.push(result(id, "settings", refs, "lost", ["destination-invalid"]));
		}
	}
	const roles = config.effectiveSettings.modelRoles;
	if (isRecord(roles)) {
		const current = settings.get("modelRoles"),
			currentRoles = isRecord(current) ? current : {},
			pending: Record<string, string> = {};
		for (const role of Object.keys(roles).sort(compare)) {
			const value = roles[role],
				id = `setting:modelRoles:${role}`,
				refs = refsFor(config, "modelRoles");
			if (typeof value !== "string") continue;
			if (typeof currentRoles[role] === "string") items.push(result(id, "settings", refs, "skipped"));
			else {
				pending[role] = value;
				items.push(result(id, "settings", refs, "planned"));
				preconditions.push({ kind: "setting", path: "modelRoles", configured: false });
			}
		}
		if (Object.keys(pending).length)
			mutations.push({
				kind: "setting",
				path: "modelRoles",
				value: pending,
				roleValues: pending,
				sourceRefs: refsFor(config, "modelRoles"),
				itemId: "setting:modelRoles",
			});
	}
	return { mutations, items, preconditions };
}

function presenceShape(value: unknown): unknown {
	if (!isRecord(value)) return true;
	return Object.fromEntries(
		Object.keys(value)
			.sort(compare)
			.map(key => [key, presenceShape(value[key])]),
	);
}
function modelShape(model: PrimeNormalizedModel | PrimeNormalizedModelOverride): Record<string, unknown> {
	const shape: Record<string, unknown> = {};
	const modelRecord: Record<string, unknown> = Object.fromEntries(Object.entries(model));
	for (const key of [
		"name",
		"api",
		"baseUrl",
		"reasoning",
		"thinking",
		"input",
		"supportsTools",
		"cost",
		"contextWindow",
		"maxTokens",
		"premiumMultiplier",
		"omitMaxOutputTokens",
		"compat",
		"headers",
	] as const) {
		if (modelRecord[key] === undefined) continue;
		if (key === "headers" && model.headers)
			shape.headers = Object.fromEntries(Object.keys(model.headers).map(header => [header, true]));
		else if (key === "thinking" && model.thinking)
			shape.thinking = {
				mode: true,
				efforts: true,
				...(model.thinking.effortMap ? { effortMap: presenceShape(model.thinking.effortMap) } : {}),
			};
		else if (key === "compat" && model.compat) shape.compat = presenceShape(model.compat);
		else if (key === "cost" && model.cost)
			shape.cost = Object.fromEntries(Object.keys(model.cost).map(field => [field, true]));
		else shape[key] = true;
	}
	return shape;
}
function absent(target: Record<string, unknown>, candidate: Record<string, unknown>): boolean {
	for (const [key, value] of Object.entries(candidate)) {
		if (!Object.hasOwn(target, key)) return true;
		if (isRecord(value) && isRecord(target[key]) && absent(target[key], value)) return true;
	}
	return false;
}
function providerShape(operation: PrimeNormalizedModelOperation): Record<string, unknown> {
	const shape = Object.create(null) as Record<string, unknown>;
	for (const [key, value] of Object.entries(operation.providerConfig ?? {}))
		shape[key] =
			key === "headers" && isRecord(value)
				? Object.fromEntries(Object.keys(value).map(header => [header, true]))
				: key === "compat" && isRecord(value)
					? presenceShape(value)
					: true;
	return shape;
}
function currentModel(
	provider: Record<string, unknown>,
	operation: PrimeNormalizedModelOperation,
): Record<string, unknown> | undefined {
	if (operation.modelKind === "override") {
		const overrides = provider.modelOverrides;
		if (!isRecord(overrides) || !Object.hasOwn(overrides, operation.model.id)) return undefined;
		const value = overrides[operation.model.id];
		return isRecord(value) ? value : undefined;
	}
	if (!Array.isArray(provider.models)) return undefined;
	const value = provider.models.find(entry => isRecord(entry) && entry.id === operation.model.id);
	return isRecord(value) ? value : undefined;
}
function modelChanges(root: Record<string, unknown>, operation: PrimeNormalizedModelOperation): boolean {
	const providers = root.providers;
	if (!isRecord(providers)) return true;
	const providerValue = providers[operation.provider];
	if (!isRecord(providerValue)) return true;
	if (absent(providerValue, providerShape(operation))) return true;
	const model = currentModel(providerValue, operation);
	return model === undefined || absent(model, modelShape(operation.model));
}
function modelId(operation: PrimeNormalizedModelOperation): string {
	return `model:${operation.provider}:${operation.modelKind}:${operation.model.id}`;
}
interface CoalescedModelOperations {
	readonly operation: PrimeNormalizedModelOperation;
	readonly operations: readonly PrimeNormalizedModelOperation[];
	readonly valid: boolean;
}

function coalesceModelOperations(
	operations: readonly PrimeNormalizedModelOperation[],
): readonly CoalescedModelOperations[] {
	const groups = new Map<
		string,
		{ operation: PrimeNormalizedModelOperation; operations: PrimeNormalizedModelOperation[]; valid: boolean }
	>();
	for (const operation of operations) {
		const key = modelId(operation);
		const existing = groups.get(key);
		if (!existing) {
			groups.set(key, {
				operation: { ...operation, sourceRefs: [...new Set(operation.sourceRefs)].sort(compare) },
				operations: [operation],
				valid: validModelOperation(operation),
			});
			continue;
		}
		existing.operations.push(operation);
		existing.valid &&= validModelOperation(operation);
		existing.operation = {
			...existing.operation,
			sourceRefs: [...new Set([...existing.operation.sourceRefs, ...operation.sourceRefs])].sort(compare),
		};
	}
	return [...groups.values()];
}

function hydrateModel(
	model: PrimeNormalizedModel | PrimeNormalizedModelOverride,
	config: PrimeConfigParserResult,
): Record<string, unknown> {
	const value: Record<string, unknown> = { id: model.id };
	const modelRecord: Record<string, unknown> = Object.fromEntries(Object.entries(model));
	for (const key of [
		"name",
		"api",
		"baseUrl",
		"reasoning",
		"input",
		"supportsTools",
		"cost",
		"contextWindow",
		"maxTokens",
		"premiumMultiplier",
		"omitMaxOutputTokens",
		"compat",
	] as const)
		if (modelRecord[key] !== undefined) value[key] = clone(modelRecord[key]);
	if (model.thinking)
		value.thinking = {
			mode: model.thinking.mode,
			efforts: [...model.thinking.efforts],
			...(model.thinking.effortMap ? { effortMap: { ...model.thinking.effortMap } } : {}),
		};
	if (model.headers) {
		const headers = Object.create(null) as Record<string, string>;
		for (const [name, header] of Object.entries(model.headers).sort(([a], [b]) => compare(a, b))) {
			if (header.classification !== "literal_api_key")
				throw new DestinationValidationError("invalid literal header");
			const operationId = header.secretOperationId;
			if (typeof operationId !== "string") throw new DestinationValidationError("invalid literal header");
			const secret = config.secretTable.get(operationId);
			if (!secret) throw new DestinationValidationError("invalid literal header");
			Object.defineProperty(headers, name, { value: secret, enumerable: true, writable: true, configurable: true });
		}
		value.headers = headers;
	}
	return value;
}
function merge(target: Record<string, unknown>, candidate: Record<string, unknown>): boolean {
	let changed = false;
	for (const [key, value] of Object.entries(candidate)) {
		if (key === "__proto__" || key === "prototype" || key === "constructor") continue;
		if (!Object.hasOwn(target, key)) {
			Object.defineProperty(target, key, {
				value: clone(value),
				enumerable: true,
				writable: true,
				configurable: true,
			});
			changed = true;
		} else if (isRecord(value) && isRecord(target[key])) changed = merge(target[key], value) || changed;
	}
	return changed;
}
function mergeModel(
	root: Record<string, unknown>,
	operation: PrimeNormalizedModelOperation,
	config: PrimeConfigParserResult,
): void {
	const providers = isRecord(root.providers) ? root.providers : (Object.create(null) as Record<string, unknown>);
	const existingProvider = Object.hasOwn(providers, operation.provider) ? providers[operation.provider] : undefined;
	const provider: Record<string, unknown> = isRecord(existingProvider)
		? existingProvider
		: (Object.create(null) as Record<string, unknown>);
	Object.defineProperty(root, "providers", {
		value: providers,
		enumerable: true,
		writable: true,
		configurable: true,
	});
	Object.defineProperty(providers, operation.provider, {
		value: provider,
		enumerable: true,
		writable: true,
		configurable: true,
	});
	const providerValue: Record<string, unknown> = Object.create(null);
	for (const [key, raw] of Object.entries(operation.providerConfig ?? {})) {
		if (key === "headers" && isRecord(raw)) {
			const headers = Object.create(null) as Record<string, string>;
			for (const [name, value] of Object.entries(raw)) {
				if (!isRecord(value) || value.classification !== "literal_api_key")
					throw new DestinationValidationError("invalid literal header");
				const operationId = value.secretOperationId;
				if (typeof operationId !== "string") throw new DestinationValidationError("invalid literal header");
				const secret = config.secretTable.get(operationId);
				if (!secret) throw new DestinationValidationError("invalid literal header");
				Object.defineProperty(headers, name, {
					value: secret,
					enumerable: true,
					writable: true,
					configurable: true,
				});
			}
			Object.defineProperty(providerValue, key, {
				value: headers,
				enumerable: true,
				writable: true,
				configurable: true,
			});
		} else
			Object.defineProperty(providerValue, key, {
				value: clone(raw),
				enumerable: true,
				writable: true,
				configurable: true,
			});
	}
	merge(provider, providerValue);
	const model = hydrateModel(operation.model, config);
	if (operation.modelKind === "definition") {
		const rawModels = provider.models;
		const models: Record<string, unknown>[] = Array.isArray(rawModels)
			? rawModels.filter((entry: unknown): entry is Record<string, unknown> => isRecord(entry))
			: [];
		const current = models.find(entry => entry.id === operation.model.id);
		if (current) merge(current, model);
		else models.push(model);
		provider.models = models;
	} else {
		const overrides: Record<string, unknown> = isRecord(provider.modelOverrides)
			? provider.modelOverrides
			: (Object.create(null) as Record<string, unknown>);
		const existingOverride = Object.hasOwn(overrides, operation.model.id) ? overrides[operation.model.id] : undefined;
		if (isRecord(existingOverride)) merge(existingOverride, model);
		else
			Object.defineProperty(overrides, operation.model.id, {
				value: model,
				enumerable: true,
				writable: true,
				configurable: true,
			});
		provider.modelOverrides = overrides;
	}
}

function modelCandidatePaths(destination: PrimeDestinationPaths): readonly string[] {
	return [
		destination.modelsPath,
		`${destination.modelsPath.slice(0, -4)}.yaml`,
		`${destination.modelsPath.slice(0, -4)}.jsonc`,
		`${destination.modelsPath.slice(0, -4)}.json`,
	];
}
const DEFAULT_DESTINATION_FILE_BYTES = 16 * 1024 * 1024;
const MAX_SKILL_TREE_ENTRIES = 100_000;
const MAX_SKILL_TREE_DEPTH = 64;
const MAX_SKILL_TREE_BYTES = 64 * 1024 * 1024;
interface DescriptorSnapshot {
	readonly bytes: Buffer;
	readonly identity: Readonly<{ dev: number; ino: number }>;
}
async function descriptorSnapshot(
	target: string,
	maxBytes = DEFAULT_DESTINATION_FILE_BYTES,
): Promise<DescriptorSnapshot> {
	const handle = await fs.open(target, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
	try {
		const stat = await handle.stat();
		if (!stat.isFile()) throw new DestinationValidationError("destination is not a regular file");
		if (stat.size > maxBytes) throw new DestinationValidationError("destination file byte budget exhausted");
		const bytes = await handle.readFile();
		if (bytes.byteLength > maxBytes) throw new DestinationValidationError("destination file byte budget exhausted");
		return { bytes, identity: { dev: stat.dev, ino: stat.ino } };
	} finally {
		await handle.close();
	}
}
async function descriptorBytes(target: string, maxBytes = DEFAULT_DESTINATION_FILE_BYTES): Promise<Buffer> {
	return (await descriptorSnapshot(target, maxBytes)).bytes;
}
async function readModels(
	destination: PrimeDestinationPaths,
	maxBytes = DEFAULT_DESTINATION_FILE_BYTES,
): Promise<ExistingModels> {
	for (const candidate of modelCandidatePaths(destination))
		try {
			const snapshot = await descriptorSnapshot(candidate, maxBytes);
			const loaded = ModelsConfigFile.relocate(candidate).parse(snapshot.bytes.toString("utf8"));
			if (loaded.status !== "ok" || !isRecord(loaded.value))
				throw new DestinationValidationError("models destination is invalid");
			return {
				path: candidate,
				sha256: sha256(snapshot.bytes),
				identity: snapshot.identity,
				value: loaded.value,
			};
		} catch (error) {
			if (!missing(error)) throw error;
		}
	return { path: destination.modelsPath, value: {} };
}
async function canonicalCreatePath(value: string): Promise<string> {
	const suffix: string[] = [];
	let current = path.resolve(value);
	for (;;) {
		try {
			await fs.lstat(current);
		} catch (error) {
			if (!missing(error)) throw error;
			const parent = path.dirname(current);
			if (parent === current) throw new DestinationValidationError("invalid destination");
			suffix.push(path.basename(current));
			current = parent;
			continue;
		}
		let canonical: string;
		try {
			canonical = await fs.realpath(current);
		} catch {
			throw new DestinationValidationError("invalid destination");
		}
		return path.join(canonical, ...suffix.reverse());
	}
}
async function hasSymlinkAncestor(value: string): Promise<boolean> {
	let current = path.resolve(value);
	const root = path.parse(current).root;
	for (;;) {
		const parent = path.dirname(current);
		if (parent === root || current === root) return false;
		try {
			if ((await fs.lstat(current)).isSymbolicLink()) return true;
		} catch (error) {
			if (!missing(error)) throw error;
		}
		current = parent;
	}
}

async function validateSettingsCandidates(destination: PrimeDestinationPaths): Promise<void> {
	for (const candidate of destination.settingsCandidates)
		try {
			if ((await fs.lstat(candidate)).isSymbolicLink())
				throw new DestinationValidationError("invalid settings destination");
		} catch (error) {
			if (!missing(error)) throw error;
		}
}

async function paths(agentDirValue: string, cwdValue: string): Promise<PrimeDestinationPaths> {
	const requestedAgentDir = path.resolve(agentDirValue);
	if (await hasSymlinkAncestor(requestedAgentDir)) throw new DestinationValidationError("invalid destination");
	return destinationPaths(requestedAgentDir, await canonicalCreatePath(cwdValue));
}
const HASH_RE = /^[0-9a-f]{64}$/;
function destinationPaths(agentDir: string, cwd: string): PrimeDestinationPaths {
	return {
		agentDir,
		cwd,
		settingsCandidates: MAIN_CONFIG_FILENAMES.map(file => path.join(agentDir, file)),
		modelsPath: path.join(agentDir, "models.yml"),
		agentDbPath: getAgentDbPath(agentDir),
		skillsRoot: path.join(agentDir, "skills"),
	};
}

function inside(root: string, target: string): boolean {
	const relative = path.relative(root, target);
	return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function noSymlinkPath(root: string, target: string, finalKind: "file" | "directory"): Promise<boolean> {
	if (!inside(root, target)) return false;
	const relative = path.relative(root, target);
	let current = root;
	try {
		const rootStat = await fs.lstat(current);
		if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) return false;
		for (const segment of relative ? relative.split(path.sep) : []) {
			current = path.join(current, segment);
			const stat = await fs.lstat(current);
			if (stat.isSymbolicLink()) return false;
			if (current === target) {
				if (finalKind === "file" && !stat.isFile()) return false;
				if (finalKind === "directory" && !stat.isDirectory()) return false;
			} else if (!stat.isDirectory()) return false;
		}
		return relative.length > 0;
	} catch (error) {
		if (missing(error)) return false;
		throw error;
	}
}

function ownedByCurrentUser(stat: Stats): boolean {
	return typeof process.getuid !== "function" || stat.uid === process.getuid();
}
function ownedByTrustedUser(stat: Stats): boolean {
	return ownedByCurrentUser(stat) || stat.uid === 0;
}

function privateCredentialFile(stat: Stats): boolean {
	return (
		stat.isFile() &&
		!stat.isSymbolicLink() &&
		stat.nlink === 1 &&
		ownedByCurrentUser(stat) &&
		(stat.mode & 0o077) === 0
	);
}

function privateCredentialDirectory(stat: Stats): boolean {
	return stat.isDirectory() && !stat.isSymbolicLink() && ownedByCurrentUser(stat) && (stat.mode & 0o022) === 0;
}

interface CredentialProbe {
	readonly valid: boolean;
	readonly present: boolean;
}

interface CredentialIdentity {
	readonly dev: number;
	readonly ino: number;
	readonly mode: number;
	readonly nlink: number;
}

interface CredentialStoreIdentity {
	readonly primary?: CredentialIdentity;
	readonly companions: Readonly<Record<string, CredentialIdentity>>;
}

interface OpenedCredentialStorage {
	readonly auth: AuthStorage;
	readonly before: CredentialStoreIdentity;
}

function credentialIdentity(stat: Stats): CredentialIdentity {
	return { dev: stat.dev, ino: stat.ino, mode: stat.mode, nlink: stat.nlink };
}

function sameCredentialIdentity(left: CredentialIdentity, right: CredentialIdentity): boolean {
	return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode && left.nlink === right.nlink;
}

function credentialCompanionPaths(dbPath: string): readonly string[] {
	return [`${dbPath}-wal`, `${dbPath}-shm`, `${dbPath}-journal`];
}

async function credentialFileIdentity(dbPath: string): Promise<CredentialIdentity | undefined> {
	try {
		const stat = await fs.lstat(dbPath);
		if (!privateCredentialFile(stat)) throw new DestinationValidationError("unsafe credential database");
		return credentialIdentity(stat);
	} catch (error) {
		if (missing(error)) return undefined;
		throw error;
	}
}

async function credentialStoreIdentity(dbPath: string): Promise<CredentialStoreIdentity> {
	const primary = await credentialFileIdentity(dbPath);
	const companions: Record<string, CredentialIdentity> = {};
	for (const companion of credentialCompanionPaths(dbPath)) {
		try {
			const stat = await fs.lstat(companion);
			if (!privateCredentialFile(stat)) throw new DestinationValidationError("unsafe credential companion");
			companions[companion] = credentialIdentity(stat);
		} catch (error) {
			if (!missing(error)) throw error;
		}
	}
	return { primary, companions };
}

function sameCredentialStoreIdentity(left: CredentialStoreIdentity, right: CredentialStoreIdentity): boolean {
	if (Boolean(left.primary) !== Boolean(right.primary)) return false;
	if (left.primary && right.primary && !sameCredentialIdentity(left.primary, right.primary)) return false;
	return Object.entries(left.companions).every(([candidate, identity]) => {
		const current = right.companions[candidate];
		return current === undefined || sameCredentialIdentity(identity, current);
	});
}

async function probeCredentialStore(dbPath: string): Promise<CredentialProbe> {
	try {
		const directory = await fs.lstat(path.dirname(dbPath));
		if (!privateCredentialDirectory(directory)) return { valid: false, present: false };
		const identity = await credentialStoreIdentity(dbPath);
		const companionPresent = Object.keys(identity.companions).length > 0;
		if (!identity.primary) return { valid: !companionPresent, present: false };
		return { valid: true, present: true };
	} catch (error) {
		if (error instanceof DestinationValidationError) return { valid: false, present: false };
		if (!missing(error)) throw error;
		return { valid: true, present: false };
	}
}
async function openCredentialReadOnly(dbPath: string): Promise<Database> {
	const identity = await credentialStoreIdentity(dbPath);
	if (Object.keys(identity.companions).length > 0) return new Database(await fs.realpath(dbPath), { readonly: true });
	const bytes = await descriptorBytes(dbPath);
	const sqliteHeader = Buffer.from("SQLite format 3\0");
	if (bytes.length > 19 && bytes.subarray(0, sqliteHeader.length).equals(sqliteHeader)) {
		bytes[18] = 1;
		bytes[19] = 1;
	}
	return Database.deserialize(bytes, { readonly: true });
}

async function validateExistingCredentialDatabase(dbPath: string): Promise<void> {
	let db: Database | undefined;
	try {
		db = await openCredentialReadOnly(dbPath);
		const version = db.query("SELECT version FROM auth_schema_version WHERE id = 1").get() as {
			version?: number;
		} | null;
		if (version?.version !== 7) throw new DestinationValidationError("credential schema requires migration");
		const columns = db.query("PRAGMA table_info(auth_credentials)").all() as Array<{ name?: unknown }>;
		const names = new Set(columns.flatMap(row => (typeof row.name === "string" ? [row.name] : [])));
		for (const name of ["id", "provider", "credential_type", "data", "identity_key", "disabled_cause"])
			if (!names.has(name)) throw new DestinationValidationError("credential schema is incomplete");
	} catch (error) {
		if (error instanceof DestinationValidationError) throw error;
		throw new DestinationValidationError("invalid credential database");
	} finally {
		db?.close();
	}
}

async function openCredentialStorageCreateOnly(
	dbPath: string,
	allowIsolatedCreate = false,
): Promise<OpenedCredentialStorage> {
	const beforeProbe = await probeCredentialStore(dbPath);
	if (!beforeProbe.valid) throw new DestinationValidationError("invalid credential destination");
	const before = await credentialStoreIdentity(dbPath);
	if (before.primary) {
		await validateExistingCredentialDatabase(dbPath);
		let auth: AuthStorage;
		try {
			auth = await AuthStorage.createExisting(dbPath, {}, before.primary);
		} catch {
			throw new DestinationValidationError("credential destination changed during open");
		}
		const after = await credentialStoreIdentity(dbPath);
		if (!sameCredentialStoreIdentity(before, after)) {
			auth.close();
			throw new DestinationValidationError("credential destination changed during open");
		}
		return { auth, before };
	}
	if (!allowIsolatedCreate) throw new DestinationValidationError("credential destination absent");
	const auth = await AuthStorage.create(dbPath);
	const after = await credentialStoreIdentity(dbPath);
	if (!after.primary) {
		auth.close();
		throw new DestinationValidationError("staged credential destination missing");
	}
	return { auth, before: after };
}
async function checkpointCredentialStage(dbPath: string): Promise<void> {
	const db = new Database(dbPath);
	try {
		db.run("PRAGMA wal_checkpoint(TRUNCATE)");
		db.query("PRAGMA journal_mode=DELETE").get();
	} finally {
		db.close();
	}
	for (const companion of credentialCompanionPaths(dbPath))
		try {
			const stat = await fs.lstat(companion);
			if (!privateCredentialFile(stat)) throw new DestinationValidationError("unsafe credential companion");
			await fs.unlink(companion);
		} catch (error) {
			if (!missing(error)) throw error;
		}
}

async function hasStoredCredential(dbPath: string, provider?: string): Promise<CredentialProbe> {
	let db: Database | undefined;
	try {
		const store = await probeCredentialStore(dbPath);
		if (!store.valid || !store.present) return store;
		db = await openCredentialReadOnly(dbPath);
		const row = provider
			? db
					.query("SELECT 1 FROM auth_credentials WHERE provider = ? AND disabled_cause IS NULL LIMIT 1")
					.get(provider)
			: db.query("SELECT 1 FROM auth_credentials LIMIT 1").get();
		return { valid: true, present: row !== null && row !== undefined };
	} catch {
		return { valid: false, present: false };
	} finally {
		db?.close();
	}
}

const CONTROL_IDENTIFIER_RE = /[\p{Cc}\p{Cf}]/u;
function validCredentialProvider(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		!/\s/u.test(value) &&
		!CONTROL_IDENTIFIER_RE.test(value) &&
		value !== "__proto__" &&
		value !== "prototype" &&
		value !== "constructor"
	);
}
interface CredentialDigestRow {
	readonly id: number;
	readonly credential_type: string;
	readonly data: string;
	readonly identity_key: string | null;
}
async function credentialProviderDigest(dbPath: string, provider: string): Promise<string | undefined> {
	const store = await probeCredentialStore(dbPath);
	if (!store.valid || !store.present) return undefined;
	let db: Database | undefined;
	try {
		db = await openCredentialReadOnly(dbPath);
		const rows = db
			.query(
				"SELECT id, credential_type, data, identity_key FROM auth_credentials WHERE provider = ? AND disabled_cause IS NULL ORDER BY id ASC",
			)
			.all(provider) as CredentialDigestRow[];
		if (rows.length === 0) return undefined;
		const canonical = rows.map(row => [row.id, row.credential_type, row.data, row.identity_key] as const);
		return sha256(Buffer.from(JSON.stringify(canonical)));
	} finally {
		db?.close();
	}
}
function validModelProvider(value: unknown): value is string {
	return validCredentialProvider(value) && !value.includes(":definition:") && !value.includes(":override:");
}
function validModelOverrideId(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value !== "__proto__" &&
		value !== "prototype" &&
		value !== "constructor"
	);
}
function validProviderConfig(value: unknown): boolean {
	if (value === undefined) return true;
	if (!isRecord(value)) return false;
	const allowed = ["api", "auth", "authHeader", "baseUrl", "compat", "headers"];
	for (const key of Object.keys(value)) if (!allowed.includes(key)) return false;
	for (const key of ["headers", "compat"]) {
		if (Object.hasOwn(value, key) && value[key] !== undefined && !isRecord(value[key])) return false;
	}
	return true;
}
function validModelOperation(operation: PrimeNormalizedModelOperation): boolean {
	return (
		validModelProvider(operation.provider) &&
		typeof operation.model.id === "string" &&
		operation.model.id.length > 0 &&
		(operation.modelKind !== "override" || validModelOverrideId(operation.model.id)) &&
		validProviderConfig(operation.providerConfig)
	);
}
function parseModelItemId(
	itemId: string,
): { provider: string; modelKind: "definition" | "override"; modelId: string } | undefined {
	if (!itemId.startsWith("model:")) return undefined;
	const rest = itemId.slice("model:".length);
	for (const modelKind of ["definition", "override"] as const) {
		const marker = `:${modelKind}:`,
			index = rest.indexOf(marker);
		if (index > 0 && index + marker.length < rest.length) {
			const provider = rest.slice(0, index),
				modelId = rest.slice(index + marker.length);
			if (validModelProvider(provider) && (modelKind === "definition" || validModelOverrideId(modelId)))
				return { provider, modelKind, modelId };
		}
	}
	return undefined;
}

function validRollbackOwnership(entry: PrimeRollbackManifestEntry): boolean {
	if (
		typeof entry.itemId !== "string" ||
		typeof entry.destinationRef !== "string" ||
		typeof entry.currentSha256 !== "string" ||
		typeof entry.created !== "boolean" ||
		typeof entry.priorExists !== "boolean" ||
		(entry.canonicalDestinationRef !== undefined && typeof entry.canonicalDestinationRef !== "string") ||
		(entry.logicalDestinationRef !== undefined && typeof entry.logicalDestinationRef !== "string") ||
		(entry.priorSha256 !== undefined && typeof entry.priorSha256 !== "string") ||
		(entry.preconditionSha256 !== undefined && typeof entry.preconditionSha256 !== "string")
	)
		return false;
	if (entry.destinationRef !== entry.itemId) return false;
	if (entry.logicalDestinationRef !== undefined && entry.logicalDestinationRef !== entry.itemId) return false;
	if (typeof entry.canonicalDestinationRef !== "string") return false;
	if (path.resolve(entry.canonicalDestinationRef) !== entry.canonicalDestinationRef) return false;
	if (entry.created === entry.priorExists) return false;
	if (!HASH_RE.test(entry.currentSha256)) return false;
	if (entry.priorExists) {
		return (
			typeof entry.priorSha256 === "string" &&
			HASH_RE.test(entry.priorSha256) &&
			entry.preconditionSha256 === entry.priorSha256
		);
	}
	return entry.priorSha256 === undefined && entry.preconditionSha256 === undefined;
}

export async function validatePrimeDestinationRollbackEntry(
	entry: PrimeRollbackManifestEntry,
	destination: PrimeDestinationPaths,
): Promise<boolean> {
	if (!validRollbackOwnership(entry) || entry.canonicalDestinationRef === undefined) return false;
	try {
		if (entry.kind === "settings") {
			if (entry.nodeType !== "regular-file") return false;
			const identifier = entry.itemId.slice("setting:".length);
			if (!entry.itemId.startsWith("setting:") || identifier.length === 0) return false;
			const role = identifier.startsWith("modelRoles:") ? identifier.slice("modelRoles:".length) : undefined;
			const settingPath = role === undefined ? identifier : "modelRoles";
			const supportedSettingPaths = new Set<string>([
				"defaultThinkingLevel",
				"steeringMode",
				"followUpMode",
				"hideThinkingBlock",
				"shellPath",
				"enabledModels",
				"treeFilterMode",
				"compaction.enabled",
				"compaction.reserveTokens",
				"compaction.keepRecentTokens",
				"retry.enabled",
				"retry.maxRetries",
				"retry.baseDelayMs",
				"retry.maxDelayMs",
				"skills.enableSkillCommands",
				"modelRoles",
			]);
			if (
				!supportedSettingPaths.has(settingPath) ||
				(settingPath === "modelRoles" && role === undefined) ||
				(role !== undefined && role.length === 0)
			)
				return false;
			const configuredPath = settingPath as PrimeSupportedSettingPath,
				canonical = entry.canonicalDestinationRef;
			if (!destination.settingsCandidates.includes(canonical)) return false;
			if (!(await noSymlinkPath(destination.agentDir, canonical, "file"))) return false;
			const settings = await Settings.loadReadOnly({ agentDir: destination.agentDir, cwd: destination.cwd });
			if (role === undefined) {
				if (!settings.isConfigured(configuredPath)) return false;
			} else {
				const roles = settings.get("modelRoles");
				if (!isRecord(roles) || typeof roles[role] !== "string") return false;
			}
			return (await descriptorDigest(canonical)) === entry.currentSha256;
		}
		if (entry.kind === "models") {
			if (entry.nodeType !== "regular-file" || entry.canonicalDestinationRef !== destination.modelsPath)
				return false;
			const parsed = parseModelItemId(entry.itemId);
			if (!parsed || !(await noSymlinkPath(destination.agentDir, destination.modelsPath, "file"))) return false;
			const current = await readModels(destination);
			if (current.path !== destination.modelsPath) return false;
			const providers = current.value.providers;
			if (!isRecord(providers)) return false;
			const provider = providers[parsed.provider];
			if (!isRecord(provider)) return false;
			let model: unknown;
			if (parsed.modelKind === "definition") {
				model = Array.isArray(provider.models)
					? provider.models.find((value: unknown) => isRecord(value) && value.id === parsed.modelId)
					: undefined;
			} else {
				model = isRecord(provider.modelOverrides) ? provider.modelOverrides[parsed.modelId] : undefined;
			}
			if (!isRecord(model) || model.id !== parsed.modelId) return false;
			return (await descriptorDigest(destination.modelsPath)) === entry.currentSha256;
		}
		if (entry.kind === "credentials") {
			if (entry.nodeType !== "regular-file" || entry.canonicalDestinationRef !== destination.agentDbPath)
				return false;
			const provider = entry.itemId.startsWith("credential:") ? entry.itemId.slice("credential:".length) : "";
			if (
				!validCredentialProvider(provider) ||
				!(await noSymlinkPath(destination.agentDir, destination.agentDbPath, "file"))
			)
				return false;
			return (await credentialProviderDigest(destination.agentDbPath, provider)) === entry.currentSha256;
		}
		if (entry.kind === "skills") {
			if (entry.nodeType !== "directory-tree" || !entry.itemId.startsWith("skill:")) return false;
			const name = entry.itemId.slice("skill:".length);
			if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\\") || name.includes("\0"))
				return false;
			const canonical = path.join(destination.skillsRoot, name);
			if (entry.canonicalDestinationRef !== canonical) return false;
			if (!(await noSymlinkPath(destination.agentDir, destination.skillsRoot, "directory"))) return false;
			if (!(await noSymlinkPath(destination.skillsRoot, canonical, "directory"))) return false;
			return (await skillTreeDigest(canonical)) === entry.currentSha256;
		}
		return false;
	} catch {
		return false;
	}
}
function credentialCode(classification: PrimeCredentialClassification): PrimeImportLoss["code"] | undefined {
	return classification === "literal_api_key"
		? undefined
		: classification === "command_ref"
			? "credentials-command-ref"
			: classification === "env_or_literal_ref"
				? "credentials-env-ref"
				: classification === "oauth_relogin"
					? "credentials-oauth-relogin"
					: classification === "ambient_dependency"
						? "credentials-ambient-dependency"
						: "credentials-unknown";
}
function invalidProviderLosses(input: PrimeDestinationInput): PrimeImportLoss[] {
	const losses: PrimeImportLoss[] = [];
	for (const operation of input.config.models)
		if (!validModelProvider(operation.provider))
			losses.push(loss("models-invalid-value", operation.sourceRefs[0] ?? "models"));
	for (const operation of input.config.credentials)
		if (!validCredentialProvider(operation.provider))
			losses.push(loss("credentials-unknown", operation.sourceRefs[0] ?? "credentials"));
	return losses;
}
function invalidAgentItems(input: PrimeDestinationInput): PrimeImportItemResult[] {
	const items: PrimeImportItemResult[] = [];
	const paths: readonly PrimeSupportedSettingPath[] = [
		"compaction.enabled",
		"compaction.keepRecentTokens",
		"compaction.reserveTokens",
		"defaultThinkingLevel",
		"enabledModels",
		"followUpMode",
		"hideThinkingBlock",
		"retry.baseDelayMs",
		"retry.enabled",
		"retry.maxDelayMs",
		"retry.maxRetries",
		"shellPath",
		"skills.enableSkillCommands",
		"steeringMode",
		"treeFilterMode",
	];
	for (const key of paths) {
		if (input.config.effectiveSettings[key] !== undefined)
			items.push(result(`setting:${key}`, "settings", refsFor(input.config, key), "lost", ["destination-invalid"]));
	}
	const roles = input.config.effectiveSettings.modelRoles;
	if (isRecord(roles))
		for (const role of Object.keys(roles).sort(compare))
			if (typeof roles[role] === "string")
				items.push(
					result(`setting:modelRoles:${role}`, "settings", refsFor(input.config, "modelRoles"), "lost", [
						"destination-invalid",
					]),
				);
	for (const group of coalesceModelOperations(input.config.models)) {
		const code = group.valid ? "destination-invalid" : "models-invalid-value";
		items.push(result(modelId(group.operation), "models", group.operation.sourceRefs, "lost", [code]));
	}
	for (const candidate of [...input.skills.candidates].sort((a, b) => compare(a.name, b.name)))
		items.push(
			result(`skill:${candidate.name}`, "skills", [candidate.directorySourceRef], "lost", ["destination-invalid"]),
		);
	for (const operation of [...input.config.credentials].sort((a, b) => compare(a.provider, b.provider))) {
		const code = credentialCode(operation.classification),
			invalidProvider = !validCredentialProvider(operation.provider);
		items.push(
			result(
				`credential:${operation.provider}`,
				"credentials",
				operation.sourceRefs,
				invalidProvider || operation.classification === "literal_api_key" ? "lost" : "skipped",
				invalidProvider
					? ["credentials-unknown"]
					: operation.classification === "literal_api_key"
						? ["destination-invalid"]
						: code
							? [code]
							: undefined,
			),
		);
	}
	return items;
}
function invalidSettingsItems(input: PrimeDestinationInput): PrimeImportItemResult[] {
	const items: PrimeImportItemResult[] = [];
	const paths: readonly PrimeSupportedSettingPath[] = [
		"compaction.enabled",
		"compaction.keepRecentTokens",
		"compaction.reserveTokens",
		"defaultThinkingLevel",
		"enabledModels",
		"followUpMode",
		"hideThinkingBlock",
		"retry.baseDelayMs",
		"retry.enabled",
		"retry.maxDelayMs",
		"retry.maxRetries",
		"shellPath",
		"skills.enableSkillCommands",
		"steeringMode",
		"treeFilterMode",
	];
	for (const key of paths)
		if (input.config.effectiveSettings[key] !== undefined)
			items.push(result(`setting:${key}`, "settings", refsFor(input.config, key), "lost", ["destination-invalid"]));
	const roles = input.config.effectiveSettings.modelRoles;
	if (isRecord(roles))
		for (const role of Object.keys(roles).sort(compare))
			if (typeof roles[role] === "string")
				items.push(
					result(`setting:modelRoles:${role}`, "settings", refsFor(input.config, "modelRoles"), "lost", [
						"destination-invalid",
					]),
				);
	return items;
}
function skillPayloadFitsSnapshot(candidate: PrimeSkillCandidate, snapshot: PrimeSourceSnapshot): boolean {
	if (candidate.files.length > snapshot.maxEntries) return false;
	let totalBytes = 0;
	for (const entry of candidate.files) {
		const payloadBytes =
			entry.kind === "file" ? entry.size : entry.kind === "symlink" ? Buffer.byteLength(entry.target) : 0;
		if (payloadBytes > snapshot.maxFileBytes) return false;
		totalBytes += Buffer.byteLength(entry.relativePath) + payloadBytes;
		if (totalBytes > snapshot.maxTotalBytes) return false;
	}
	return true;
}

export async function planPrimeDestination(
	input: PrimeDestinationInput,
	options: { readonly agentDir: string; readonly cwd: string },
): Promise<PrimeDestinationPlan> {
	let destination = destinationPaths(path.resolve(options.agentDir), path.resolve(options.cwd));
	try {
		destination = await paths(options.agentDir, options.cwd);
		await validateAgentDir(destination.agentDir);
	} catch (error) {
		if (!expectedDestinationError(error)) throw error;
		const plan: PrimeDestinationPlan = {
			schemaVersion: 1,
			snapshotId: input.snapshot.snapshotId,
			operations: [...input.config.operations],
			destination,
			maxFileBytes: input.snapshot.maxFileBytes,
			maxTotalBytes: input.snapshot.maxTotalBytes,
			maxEntries: input.snapshot.maxEntries,
			settingMutations: [],
			preconditions: [],
			items: sortItems(invalidAgentItems(input)),
			losses: sortLosses([
				...input.config.losses,
				...input.skills.losses,
				...invalidProviderLosses(input),
				loss("destination-invalid", "destination", destination.agentDir),
			]),
		};
		planBindings.set(plan, bindingDigest(input));
		return plan;
	}
	const authProbe = await hasStoredCredential(destination.agentDbPath);
	const authInvalid = !authProbe.valid;
	let settingPlan: {
		mutations: PrimeSettingMutation[];
		items: PrimeImportItemResult[];
		preconditions: PrimeDestinationPrecondition[];
	};
	const losses = [...input.config.losses, ...input.skills.losses, ...invalidProviderLosses(input)];
	try {
		await validateSettingsCandidates(destination);
		const settings = await Settings.loadCreateOnly({
			agentDir: destination.agentDir,
			cwd: destination.cwd,
			readLimits: {
				maxFileBytes: input.snapshot.maxFileBytes,
				maxTotalBytes: input.snapshot.maxTotalBytes,
				maxDepth: 64,
				maxEntries: input.snapshot.maxEntries,
			},
		});
		settingPlan = planSettings(input.config, settings);
	} catch {
		settingPlan = { mutations: [], items: invalidSettingsItems(input), preconditions: [] };
		losses.push(loss("destination-invalid", "destination", destination.settingsCandidates[0]));
	}
	const items = [...settingPlan.items];
	const preconditions = [...settingPlan.preconditions];
	let models: ExistingModels = { path: destination.modelsPath, value: {} };
	let modelsInvalid = false;
	try {
		models = await readModels(destination, input.snapshot.maxFileBytes);
	} catch (error) {
		if (!expectedDestinationError(error)) throw error;
		modelsInvalid = true;
		losses.push(loss("destination-invalid", "global/models.json", destination.modelsPath));
	}
	let skillsRootInvalid = false;
	try {
		await validateDirectory(destination.skillsRoot);
	} catch (error) {
		if (!expectedDestinationError(error)) throw error;
		skillsRootInvalid = true;
	}
	for (const group of coalesceModelOperations(input.config.models)) {
		const operation = group.operation;
		if (!group.valid) {
			items.push(result(modelId(operation), "models", operation.sourceRefs, "lost", ["models-invalid-value"]));
			continue;
		}
		if (modelsInvalid) {
			items.push(result(modelId(operation), "models", operation.sourceRefs, "lost", ["destination-invalid"]));
			continue;
		}
		const changed = group.operations.some(value => modelChanges(models.value, value));
		items.push(result(modelId(operation), "models", operation.sourceRefs, changed ? "planned" : "skipped"));
		if (changed) {
			const candidates = modelCandidatePaths(destination),
				selected = candidates.indexOf(models.path);
			for (let index = 0; index <= selected; index++) {
				const candidate = candidates[index];
				preconditions.push(
					index === selected && models.sha256
						? {
								kind: "models",
								destinationRef: candidate,
								sha256: models.sha256,
								...(models.identity ? { identity: models.identity } : {}),
							}
						: { kind: "models", destinationRef: candidate },
				);
			}
		}
	}
	for (const candidate of [...input.skills.candidates].sort((a, b) => compare(a.name, b.name))) {
		const destinationRef = path.join(destination.skillsRoot, candidate.name);
		if (skillsRootInvalid || !skillPayloadFitsSnapshot(candidate, input.snapshot)) {
			losses.push(loss("destination-invalid", candidate.directorySourceRef, destination.skillsRoot));
			items.push(
				result(`skill:${candidate.name}`, "skills", [candidate.directorySourceRef], "lost", [
					"destination-invalid",
				]),
			);
			continue;
		}
		try {
			await fs.lstat(destinationRef);
			items.push(result(`skill:${candidate.name}`, "skills", [candidate.directorySourceRef], "skipped"));
		} catch (error) {
			if (!missing(error)) {
				if (!expectedDestinationError(error)) throw error;
				losses.push(loss("destination-invalid", candidate.directorySourceRef, destinationRef));
				items.push(
					result(`skill:${candidate.name}`, "skills", [candidate.directorySourceRef], "lost", [
						"destination-invalid",
					]),
				);
			} else {
				items.push(result(`skill:${candidate.name}`, "skills", [candidate.directorySourceRef], "planned"));
				preconditions.push({ kind: "skill", destinationRef, absent: true });
			}
		}
	}
	for (const operation of [...input.config.credentials].sort((a, b) => compare(a.provider, b.provider))) {
		const code = credentialCode(operation.classification),
			authLoss = operation.classification === "literal_api_key" && authInvalid,
			invalidProvider = !validCredentialProvider(operation.provider);
		if (authLoss)
			losses.push(loss("destination-invalid", operation.sourceRefs[0] ?? "credentials", destination.agentDbPath));
		items.push(
			result(
				`credential:${operation.provider}`,
				"credentials",
				operation.sourceRefs,
				invalidProvider || authLoss
					? "lost"
					: operation.classification === "literal_api_key"
						? "planned"
						: "skipped",
				invalidProvider ? ["credentials-unknown"] : authLoss ? ["destination-invalid"] : code ? [code] : undefined,
			),
		);
	}
	const plan: PrimeDestinationPlan = {
		schemaVersion: 1,
		snapshotId: input.snapshot.snapshotId,
		operations: [...input.config.operations],
		destination,
		maxFileBytes: input.snapshot.maxFileBytes,
		maxTotalBytes: input.snapshot.maxTotalBytes,
		maxEntries: input.snapshot.maxEntries,
		settingMutations: settingPlan.mutations,
		preconditions,
		items: sortItems(items),
		losses: sortLosses(losses),
	};
	planBindings.set(plan, bindingDigest(input));
	return plan;
}

function safeInternalSymlink(root: string, link: string, target: string): boolean {
	if (target.length === 0 || path.posix.isAbsolute(target) || path.win32.isAbsolute(target) || target.includes("\0"))
		return false;
	return inside(root, path.resolve(path.dirname(link), target));
}

async function materializeSkill(candidate: PrimeSkillCandidate, root: string): Promise<void> {
	const base = path.join(root, candidate.name);
	await fs.mkdir(base, { recursive: true, mode: 0o700 });
	for (const entry of [...candidate.files].sort(
		(left, right) =>
			(left.relativePath === "SKILL.md" ? 1 : 0) - (right.relativePath === "SKILL.md" ? 1 : 0) ||
			compare(left.relativePath, right.relativePath),
	)) {
		const target = path.join(base, entry.relativePath),
			relative = path.relative(base, target);
		if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`))
			throw new DestinationValidationError("skill path escape");
		if (entry.kind === "directory") {
			await fs.mkdir(target, { recursive: true, mode: entry.mode & 0o777 });
			await fs.chmod(target, entry.mode & 0o777);
		} else if (entry.kind === "file") {
			const bytes = Buffer.from(entry.contentBase64, "base64");
			if (bytes.byteLength !== entry.size || sha256(bytes) !== entry.sha256)
				throw new DestinationValidationError("skill payload mismatch");
			await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
			await fs.writeFile(target, bytes, { flag: "wx", mode: entry.mode & 0o777 });
			await fs.chmod(target, entry.mode & 0o777);
		} else {
			if (!safeInternalSymlink(base, target, entry.target))
				throw new DestinationValidationError("skill symlink escape");
			await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
			await fs.symlink(entry.target, target);
		}
	}
}
interface NodeIdentity {
	readonly dev: number;
	readonly ino: number;
}
interface OwnedSkillMaterial {
	readonly root: string;
	readonly leaves: string[];
	readonly leafNodes: Map<string, NodeIdentity>;
	readonly directories: string[];
}

async function validateSkillParent(root: string, target: string): Promise<void> {
	if (!inside(root, target)) throw new DestinationValidationError("skill destination escape");
	let current = root;
	const relative = path.relative(root, path.dirname(target));
	for (const segment of relative ? relative.split(path.sep) : []) {
		current = path.join(current, segment);
		try {
			const stat = await fs.lstat(current);
			if (stat.isSymbolicLink() || !stat.isDirectory())
				throw new DestinationValidationError("skill destination path changed");
		} catch (error) {
			if (missing(error)) return;
			throw error;
		}
	}
}

async function copySkillTree(source: string, destination: string, owned: OwnedSkillMaterial): Promise<void> {
	const entries = await fs.readdir(source, { withFileTypes: true });
	entries.sort(
		(left, right) =>
			(left.name === "SKILL.md" ? 1 : 0) - (right.name === "SKILL.md" ? 1 : 0) || compare(left.name, right.name),
	);
	for (const entry of entries) {
		const sourcePath = path.join(source, entry.name);
		const destinationPath = path.join(destination, entry.name);
		const sourceStat = await fs.lstat(sourcePath);
		if (entry.isDirectory()) {
			if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink())
				throw new DestinationValidationError("skill source path changed");
			await validateSkillParent(owned.root, destinationPath);
			try {
				await fs.mkdir(destinationPath, { recursive: false, mode: 0o700 });
			} catch (error) {
				if (isExists(error)) throw new SkillExistingWinsError();
				throw error;
			}
			owned.directories.push(destinationPath);
			await validateSkillParent(owned.root, destinationPath);
			await copySkillTree(sourcePath, destinationPath, owned);
		} else if (entry.isSymbolicLink()) {
			if (!sourceStat.isSymbolicLink()) throw new DestinationValidationError("skill source path changed");
			await validateSkillParent(owned.root, destinationPath);
			try {
				await fs.symlink(await fs.readlink(sourcePath), destinationPath);
			} catch (error) {
				if (isExists(error)) throw new SkillExistingWinsError();
				throw error;
			}
			owned.leaves.push(destinationPath);
			await validateSkillParent(owned.root, destinationPath);
		} else {
			if (!sourceStat.isFile() || sourceStat.isSymbolicLink())
				throw new DestinationValidationError("skill source path changed");
			const mode = sourceStat.mode & 0o777,
				bytes = await descriptorBytes(sourcePath);
			let handle: fs.FileHandle | undefined;
			try {
				await validateSkillParent(owned.root, destinationPath);
				handle = await fs.open(
					destinationPath,
					fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
					mode,
				);
				owned.leaves.push(destinationPath);
				const destinationStat = await handle.stat();
				if (!destinationStat.isFile() || destinationStat.isSymbolicLink())
					throw new DestinationValidationError("skill destination leaf changed");
				owned.leafNodes.set(destinationPath, { dev: destinationStat.dev, ino: destinationStat.ino });
				await validateSkillParent(owned.root, destinationPath);
				await handle.writeFile(bytes);
				await handle.chmod(mode);
			} catch (error) {
				if (isExists(error)) throw new SkillExistingWinsError();
				throw error;
			} finally {
				await handle?.close();
			}
		}
	}
}

async function cleanupOwnedSkillMaterial(owned: OwnedSkillMaterial): Promise<boolean> {
	let clean = true;
	for (const target of [...owned.leaves].reverse())
		try {
			const identity = owned.leafNodes.get(target);
			if (identity) {
				const handle = await fs.open(
					target,
					fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
				);
				try {
					const stat = await handle.stat();
					if (!stat.isFile() || stat.dev !== identity.dev || stat.ino !== identity.ino) {
						clean = false;
						continue;
					}
				} finally {
					await handle.close();
				}
			} else if (!(await noSymlinkPath(owned.root, target, "file"))) {
				clean = false;
				continue;
			}
			await fs.unlink(target);
		} catch (error) {
			if (!missing(error)) clean = false;
		}
	for (const target of [...owned.directories].reverse())
		try {
			if (!(await noSymlinkPath(owned.root, target, "directory"))) {
				clean = false;
				continue;
			}
			await fs.rmdir(target);
		} catch (error) {
			if (isRecord(error) && error.code === "ENOTEMPTY") continue;
			if (!missing(error)) clean = false;
		}
	return clean;
}
async function validateSkills(root: string, candidates: readonly PrimeSkillCandidate[]): Promise<void> {
	const loaded = await loadSkillsFromDir({ dir: root, source: "prime" });
	const expected = candidates.map(candidate => candidate.name).sort(compare),
		actual = loaded.skills.map(skill => skill.name).sort(compare);
	if (
		loaded.warnings.length ||
		expected.length !== actual.length ||
		expected.some((name, index) => name !== actual[index])
	)
		throw new DestinationValidationError("invalid staged skills");
}
async function validateModels(modelPath: string, config: PrimeConfigParserResult): Promise<void> {
	const auth = await AuthStorage.create(":memory:");
	try {
		for (const operation of config.credentials.filter(
			value => value.classification === "literal_api_key" && validCredentialProvider(value.provider),
		)) {
			const secret = operation.secretOperationId ? config.secretTable.get(operation.secretOperationId) : undefined;
			if (!secret) throw new DestinationValidationError("invalid literal credential");
			auth.insertCredentialsIfProviderAbsent(operation.provider, [{ type: "api_key", key: secret }]);
		}
		const loaded = ModelsConfigFile.relocate(modelPath).tryLoad();
		if (loaded.status !== "ok") throw new ModelValidationError("invalid staged models");
		const registry = new ModelRegistry(auth, modelPath);
		if (registry.getError()) throw new ModelValidationError("invalid staged registry");
	} finally {
		auth.close();
	}
}

async function validateCreationParent(target: string): Promise<void> {
	let current = path.dirname(target);
	let child: Stats | undefined;
	for (;;) {
		let stat: Stats;
		try {
			stat = await fs.lstat(current);
		} catch (error) {
			if (!missing(error)) throw error;
			const parent = path.dirname(current);
			if (parent === current) throw new DestinationValidationError("invalid destination");
			current = parent;
			continue;
		}
		const writable = (stat.mode & 0o022) !== 0,
			nearest = child === undefined,
			stickyProtected =
				!writable || ((stat.mode & 0o1000) !== 0 && child !== undefined && ownedByTrustedUser(child));
		if (
			stat.isSymbolicLink() ||
			!stat.isDirectory() ||
			(nearest ? !ownedByCurrentUser(stat) || writable : !ownedByTrustedUser(stat) || !stickyProtected)
		)
			throw new DestinationValidationError("invalid destination");
		child = stat;
		const parent = path.dirname(current);
		if (parent === current) return;
		current = parent;
	}
}
async function validateAgentDir(agentDir: string): Promise<void> {
	if (await hasSymlinkAncestor(agentDir)) throw new DestinationValidationError("invalid destination");
	await validateCreationParent(await canonicalCreatePath(agentDir));
	await validateDirectory(agentDir);
}
async function validateDirectory(target: string): Promise<void> {
	try {
		const stat = await fs.lstat(target);
		if (stat.isSymbolicLink() || !stat.isDirectory() || !ownedByCurrentUser(stat) || (stat.mode & 0o022) !== 0)
			throw new DestinationValidationError("invalid destination");
	} catch (error) {
		if (!missing(error)) throw error;
	}
}
async function ensureDirectory(target: string): Promise<void> {
	try {
		const stat = await fs.lstat(target);
		if (stat.isSymbolicLink() || !stat.isDirectory() || !ownedByCurrentUser(stat) || (stat.mode & 0o022) !== 0)
			throw new DestinationValidationError("invalid destination");
		return;
	} catch (error) {
		if (!missing(error)) throw error;
	}
	try {
		await fs.mkdir(target, { recursive: true, mode: 0o700 });
	} catch (error) {
		if (!isExists(error)) throw error;
	}
	const stat = await fs.lstat(target);
	if (stat.isSymbolicLink() || !stat.isDirectory() || !ownedByCurrentUser(stat) || (stat.mode & 0o022) !== 0)
		throw new DestinationValidationError("invalid destination");
}
async function nearestExistingDirectoryDevice(target: string): Promise<number> {
	let current = target;
	for (;;) {
		try {
			const stat = await fs.lstat(current);
			if (stat.isSymbolicLink() || !stat.isDirectory()) throw new DestinationValidationError("invalid destination");
			return stat.dev;
		} catch (error) {
			if (!missing(error)) throw error;
			const parent = path.dirname(current);
			if (parent === current) throw new DestinationValidationError("invalid destination");
			current = parent;
		}
	}
}
type PreconditionResult = "ok" | "drift" | "invalid";
async function preconditionsHold(plan: PrimeDestinationPlan, includeModels = true): Promise<PreconditionResult> {
	try {
		await validateAgentDir(plan.destination.agentDir);
	} catch {
		return "drift";
	}
	let settings: Settings;
	try {
		settings = await Settings.loadCreateOnly({
			agentDir: plan.destination.agentDir,
			cwd: plan.destination.cwd,
			readLimits: {
				maxFileBytes: plan.maxFileBytes,
				maxTotalBytes: plan.maxTotalBytes,
				maxDepth: 64,
				maxEntries: plan.maxEntries,
			},
		});
	} catch {
		return "invalid";
	}
	for (const precondition of plan.preconditions) {
		if (precondition.kind === "models" && !includeModels) continue;
		if (precondition.kind === "setting") {
			if (precondition.path !== "modelRoles" && settings.isConfigured(precondition.path)) return "drift";
		} else if (precondition.kind === "models") {
			try {
				const stat = await fs.lstat(precondition.destinationRef);
				if (
					!precondition.sha256 ||
					!stat.isFile() ||
					(precondition.identity !== undefined &&
						(stat.dev !== precondition.identity.dev || stat.ino !== precondition.identity.ino)) ||
					(await descriptorDigest(precondition.destinationRef, plan.maxFileBytes)) !== precondition.sha256
				)
					return "drift";
			} catch (error) {
				if (missing(error) && !precondition.sha256) continue;
				return "invalid";
			}
		} else if (precondition.kind === "skill") {
			try {
				await fs.lstat(precondition.destinationRef);
				return "drift";
			} catch (error) {
				if (!missing(error)) return "invalid";
			}
		}
	}
	return "ok";
}
async function cleanupStage(stage: string): Promise<void> {
	await fs.rm(stage, { recursive: true, force: true });
}
function markLost(items: readonly PrimeImportItemResult[], code: PrimeImportLoss["code"]): PrimeImportItemResult[] {
	return items.map(value =>
		value.outcome === "planned"
			? { ...value, outcome: "lost", lossCodes: [...new Set([...(value.lossCodes ?? []), code])].sort(compare) }
			: value,
	);
}
function mark(
	items: readonly PrimeImportItemResult[],
	ids: readonly string[],

	outcome: PrimeImportItemResult["outcome"],
): PrimeImportItemResult[] {
	const selected = new Set(ids);
	return items.map(value => (selected.has(value.itemId) ? { ...value, outcome } : value));
}
function planned(plan: PrimeDestinationPlan, kind: PrimeImportItemResult["kind"]): PrimeImportItemResult[] {
	return plan.items.filter(item => item.kind === kind && item.outcome === "planned");
}
function markLostIds(
	items: readonly PrimeImportItemResult[],
	ids: readonly string[],
	code: PrimeImportLoss["code"],
): PrimeImportItemResult[] {
	const selected = new Set(ids);
	return items.map(value =>
		selected.has(value.itemId)
			? { ...value, outcome: "lost", lossCodes: [...new Set([...(value.lossCodes ?? []), code])].sort(compare) }
			: value,
	);
}
function validateCredentials(config: PrimeConfigParserResult): void {
	for (const operation of config.credentials) {
		if (operation.classification !== "literal_api_key" || !validCredentialProvider(operation.provider)) continue;
		const operationId = operation.secretOperationId;
		const secret = operationId ? config.secretTable.get(operationId) : undefined;
		if (!secret) throw new DestinationValidationError("invalid literal credential");
	}
}
async function publishCreateOnly(stage: string, destination: string): Promise<boolean> {
	try {
		await fs.link(stage, destination);
		await fs.unlink(stage);
		return true;
	} catch (error) {
		if (isExists(error)) return false;
		throw error;
	}
}
async function publishModelsNonClobber(
	stage: string,
	destination: string,
	expected: ExistingModels,
	maxBytes: number,
): Promise<{ readonly digest: string } | undefined> {
	const staged = await descriptorSnapshot(stage, maxBytes),
		stagedDigest = sha256(staged.bytes);
	if (expected.path !== destination || !expected.sha256 || !expected.identity) {
		try {
			await fs.link(stage, destination);
		} catch (error) {
			if (isExists(error)) return undefined;
			throw error;
		}
		const published = await fs.lstat(destination);
		if (!published.isFile() || published.isSymbolicLink())
			throw new DestinationValidationError("published models mismatch");
		return { digest: stagedDigest };
	}
	const current = await descriptorSnapshot(destination, maxBytes);
	if (
		current.identity.dev !== expected.identity.dev ||
		current.identity.ino !== expected.identity.ino ||
		sha256(current.bytes) !== expected.sha256
	)
		return undefined;
	await fs.rename(stage, destination);
	const published = await fs.lstat(destination);
	if (
		!published.isFile() ||
		published.isSymbolicLink() ||
		published.dev !== staged.identity.dev ||
		published.ino !== staged.identity.ino
	)
		throw new DestinationValidationError("published models mismatch");
	return { digest: stagedDigest };
}
function assertPlanInput(
	plan: PrimeDestinationPlan,
	input: PrimeDestinationInput,
	plannedCredentialIds: ReadonlySet<string>,
): void {
	if (input.snapshot.snapshotId !== plan.snapshotId) throw new Error("plan input mismatch");
	const modelIds = new Set(input.config.models.map(operation => modelId(operation)));
	for (const item of planned(plan, "models")) if (!modelIds.has(item.itemId)) throw new Error("plan input mismatch");
	const skillIds = new Set(input.skills.candidates.map(candidate => `skill:${candidate.name}`));
	for (const item of planned(plan, "skills")) if (!skillIds.has(item.itemId)) throw new Error("plan input mismatch");
	const credentialIds = new Set(
		input.config.credentials
			.filter(
				operation => operation.classification === "literal_api_key" && validCredentialProvider(operation.provider),
			)
			.map(operation => `credential:${operation.provider}`),
	);
	for (const itemId of plannedCredentialIds) if (!credentialIds.has(itemId)) throw new Error("plan input mismatch");
}
function settingMutationsForApply(mutations: readonly PrimeSettingMutation[]): SettingsCreateOnlyMutation[] {
	return mutations.flatMap(mutation =>
		mutation.path === "modelRoles"
			? Object.entries(mutation.roleValues)
					.sort(([left], [right]) => compare(left, right))
					.map(([role, value]) => ({ path: "modelRoles" as const, role, value }))
			: [{ path: mutation.path, value: mutation.value } as SettingsCreateOnlyMutation],
	);
}
function settingItemId(identifier: string): string {
	return `setting:${identifier}`;
}

interface PriorDestinationState {
	readonly priorExists: boolean;
	readonly priorSha256?: string;
}
async function descriptorDigest(target: string, maxBytes = DEFAULT_DESTINATION_FILE_BYTES): Promise<string> {
	return sha256(await descriptorBytes(target, maxBytes));
}
async function capturePriorState(
	target: string,
	maxBytes = DEFAULT_DESTINATION_FILE_BYTES,
): Promise<PriorDestinationState> {
	try {
		const stat = await fs.lstat(target);
		if (!stat.isFile()) return { priorExists: true };
		return { priorExists: true, priorSha256: await descriptorDigest(target, maxBytes) };
	} catch (error) {
		if (missing(error)) return { priorExists: false };
		throw error;
	}
}
async function skillTreeDigest(target: string): Promise<string> {
	const records: string[] = [];
	let entryCount = 0;
	let totalBytes = 0;
	const visit = async (current: string, relative: string, depth: number): Promise<void> => {
		if (depth > MAX_SKILL_TREE_DEPTH) throw new DestinationValidationError("skill tree depth budget exhausted");
		const directory = await fs.opendir(current),
			entries: Dirent[] = [];
		try {
			for await (const entry of directory) {
				if (entries.length >= MAX_SKILL_TREE_ENTRIES)
					throw new DestinationValidationError("skill tree entry budget exhausted");
				entries.push(entry);
			}
		} finally {
			await directory.close();
		}
		entryCount += entries.length;
		if (entryCount > MAX_SKILL_TREE_ENTRIES)
			throw new DestinationValidationError("skill tree entry budget exhausted");
		for (const entry of entries) {
			const child = path.join(current, entry.name),
				childRelative = path.join(relative, entry.name),
				digestRelative = childRelative.split(path.sep).join("/"),
				stat = await fs.lstat(child);
			if (stat.isSymbolicLink()) {
				const linkTarget = await fs.readlink(child);
				if (!safeInternalSymlink(target, child, linkTarget))
					throw new DestinationValidationError("skill tree contains an unsafe symlink");
				records.push(`l\0${digestRelative}\0${JSON.stringify(linkTarget)}`);
			} else if (stat.isDirectory()) await visit(child, childRelative, depth + 1);
			else if (stat.isFile()) {
				totalBytes += stat.size;
				if (totalBytes > MAX_SKILL_TREE_BYTES)
					throw new DestinationValidationError("skill tree byte budget exhausted");
				records.push(`f\0${digestRelative}\0${await descriptorDigest(child)}`);
			} else throw new DestinationValidationError("skill tree contains a special node");
		}
	};
	await visit(target, "", 0);
	return sha256(Buffer.from(records.join("\n")));
}
function rollbackEntry(
	itemId: string,
	kind: PrimeImportItemResult["kind"],
	canonicalDestinationRef: string,
	currentSha256: string,
	prior: PriorDestinationState | undefined,
	nodeType: PrimeRollbackManifestEntry["nodeType"],
): PrimeRollbackManifestEntry {
	const priorExists = prior?.priorExists ?? false;
	const priorSha256 = prior?.priorSha256;
	return {
		itemId,
		kind,
		destinationRef: itemId,
		canonicalDestinationRef: path.resolve(canonicalDestinationRef),
		created: !priorExists,
		priorExists,
		priorSha256,
		preconditionSha256: priorSha256,
		currentSha256,
		nodeType,
	};
}

export async function applyPrimeDestination(
	plan: PrimeDestinationPlan,
	input: PrimeDestinationInput,
): Promise<PrimeDestinationApplyResult> {
	let items = [...plan.items],
		losses = [...plan.losses],
		committed = false,
		partialApply = false,
		publicationUncertain = false,
		credentialDestinationInvalid = false,
		stage: string | undefined;
	const rollbackEntries: PrimeRollbackManifestEntry[] = [];
	const priorStates = new Map<string, PriorDestinationState>();
	const priorFor = async (target: string): Promise<PriorDestinationState> => {
		const existing = priorStates.get(target);
		if (existing) return existing;
		const captured = await capturePriorState(target, plan.maxFileBytes);
		priorStates.set(target, captured);
		return captured;
	};
	const finalize = async (report: PrimeImportReport): Promise<PrimeImportReport> => {
		if (!stage) return report;
		const cleanupTarget = stage;
		try {
			await cleanupStage(cleanupTarget);
		} catch {
			const pending = report.items.filter(item => item.outcome === "planned").map(item => item.itemId);
			report = {
				...report,
				items: markLostIds(report.items, pending, "destination-cleanup-failed"),
				losses: sortLosses([
					...report.losses,
					loss("destination-cleanup-failed", "destination", plan.destination.agentDir),
				]),
				partialApply: report.partialApply || committed,
			};
		} finally {
			stage = undefined;
		}
		return report;
	};
	const finish = async (report: PrimeImportReport): Promise<PrimeDestinationApplyResult> => ({
		report: await finalize(report),
		rollbackEntries: [...rollbackEntries].sort((left, right) =>
			compare(
				`${left.kind}\u0000${left.itemId}\u0000${left.canonicalDestinationRef ?? ""}`,
				`${right.kind}\u0000${right.itemId}\u0000${right.canonicalDestinationRef ?? ""}`,
			),
		),
	});
	const plannedCredentialIds = new Set(
		plan.items
			.filter(value => value.kind === "credentials" && value.outcome === "planned")
			.map(value => value.itemId),
	);
	if (planBindings.get(plan) !== bindingDigest(input)) throw new Error("plan input mismatch");
	validateCredentials(input.config);
	assertPlanInput(plan, input, plannedCredentialIds);
	if (!plan.items.some(item => item.outcome === "planned"))
		return finish({
			schemaVersion: 1,
			snapshotId: plan.snapshotId,
			items: sortItems(items),
			losses: sortLosses(losses),
			partialApply: false,
		});
	try {
		stage = await fs.mkdtemp(path.join(path.dirname(plan.destination.agentDir), ".prime-import-"));
		const stageStat = await fs.lstat(stage),
			stageIdentity = { dev: stageStat.dev, ino: stageStat.ino };
		if (
			!stageStat.isDirectory() ||
			stageStat.isSymbolicLink() ||
			!ownedByCurrentUser(stageStat) ||
			(stageStat.mode & 0o022) !== 0
		)
			throw new DestinationValidationError("invalid private stage");
		const verifyStage = async (): Promise<void> => {
			const currentStage = await fs.lstat(stage as string);
			if (
				!currentStage.isDirectory() ||
				currentStage.isSymbolicLink() ||
				!ownedByCurrentUser(currentStage) ||
				(currentStage.mode & 0o022) !== 0 ||
				currentStage.dev !== stageIdentity.dev ||
				currentStage.ino !== stageIdentity.ino
			)
				throw new DestinationValidationError("staged destination changed");
		};
		const modelItems = planned(plan, "models"),
			skillItems = planned(plan, "skills"),
			modelPath = path.join(stage, "models.yml"),
			skillRoot = path.join(stage, "skills");
		if (
			modelItems.length &&
			(await fs.lstat(stage)).dev !== (await nearestExistingDirectoryDevice(plan.destination.agentDir))
		) {
			losses.push(loss("destination-invalid", "destination", plan.destination.modelsPath));
			return finish({
				schemaVersion: 1,
				snapshotId: plan.snapshotId,
				items: sortItems(markLost(items, "destination-invalid")),
				losses: sortLosses(losses),
				partialApply: false,
			});
		}
		await verifyStage();
		const skills = input.skills.candidates.filter(candidate =>
			skillItems.some(value => value.itemId === `skill:${candidate.name}`),
		);
		if (skills.length) {
			await fs.mkdir(skillRoot, { recursive: true, mode: 0o700 });
			for (const candidate of skills.sort((a, b) => compare(a.name, b.name))) {
				if (!skillPayloadFitsSnapshot(candidate, input.snapshot))
					throw new DestinationValidationError("staged skill payload budget exhausted");
				await materializeSkill(candidate, skillRoot);
			}
			await validateSkills(skillRoot, skills);
		}
		await verifyStage();
		const sourceDrift = await revalidatePrimeSource(
				input.snapshot,
				input.sourceDomains ? { domains: input.sourceDomains } : {},
			),
			preconditionResult = await preconditionsHold(plan, false),
			destinationCode: PrimeImportLoss["code"] =
				preconditionResult === "invalid" ? "destination-invalid" : "destination-drift";
		if (!sourceDrift.ok || preconditionResult !== "ok") {
			losses.push(...sourceDrift.losses, loss(destinationCode, "destination", plan.destination.agentDir));
			return finish({
				schemaVersion: 1,
				snapshotId: plan.snapshotId,
				items: sortItems(markLost(items, sourceDrift.ok ? destinationCode : "destination-drift")),
				losses: sortLosses(losses),
				partialApply: false,
			});
		}
		const lockPath = path.join(
			path.dirname(plan.destination.agentDir),
			`${path.basename(plan.destination.agentDir)}.prime-import`,
		);
		return await withFileLock(lockPath, async () => {
			await verifyStage();
			const again = await revalidatePrimeSource(
					input.snapshot,
					input.sourceDomains ? { domains: input.sourceDomains } : {},
				),
				preconditionResult = await preconditionsHold(plan, false),
				destinationCode: PrimeImportLoss["code"] =
					preconditionResult === "invalid" ? "destination-invalid" : "destination-drift";
			if (!again.ok || preconditionResult !== "ok") {
				losses.push(...again.losses, loss(destinationCode, "destination", plan.destination.agentDir));
				return finish({
					schemaVersion: 1,
					snapshotId: plan.snapshotId,
					items: sortItems(markLost(items, again.ok ? destinationCode : "destination-drift")),
					losses: sortLosses(losses),
					partialApply: false,
				});
			}
			if (modelItems.length) {
				await ensureDirectory(plan.destination.agentDir);
				await withFileLock(plan.destination.modelsPath, async () => {
					await verifyStage();
					if ((await preconditionsHold(plan)) !== "ok") {
						losses.push(loss("destination-drift", "destination", plan.destination.modelsPath));
						items = markLostIds(
							items,
							modelItems.map(value => value.itemId),
							"destination-drift",
						);
						return;
					}
					let current: ExistingModels;
					try {
						current = await readModels(plan.destination, plan.maxFileBytes);
					} catch (error) {
						if (!expectedDestinationError(error)) throw error;
						losses.push(loss("destination-invalid", "destination", plan.destination.modelsPath));
						items = markLostIds(
							items,
							modelItems.map(value => value.itemId),
							"destination-invalid",
						);
						return;
					}
					const active = coalesceModelOperations(input.config.models).filter(group =>
							modelItems.some(value => value.itemId === modelId(group.operation)),
						),
						changed = active.filter(group =>
							group.operations.some(operation => modelChanges(current.value, operation)),
						);
					for (const group of active)
						if (!changed.includes(group)) items = mark(items, [modelId(group.operation)], "skipped");
					if (changed.length === 0) return;
					let merged: Record<string, unknown> = clone(current.value);
					let importable = changed;
					if (input.allowModelLosses) {
						importable = [];
						const rejectedSourceRefs = new Set<string>();
						for (const group of changed) {
							const candidate: Record<string, unknown> = clone(merged);
							for (const operation of group.operations) mergeModel(candidate, operation, input.config);
							const candidateBytes = Buffer.from(YAML.stringify(candidate, null, 2));
							try {
								if (candidateBytes.byteLength > plan.maxFileBytes)
									throw new ModelValidationError("staged models byte budget exhausted");
								await fs.writeFile(modelPath, candidateBytes, { flag: "wx", mode: 0o600 });
								await validateModels(modelPath, input.config);
							} catch (error) {
								if (!(error instanceof ModelValidationError)) throw error;
								for (const operation of group.operations)
									for (const sourceRef of operation.sourceRefs) rejectedSourceRefs.add(sourceRef);
								items = markLostIds(items, [modelId(group.operation)], "models-invalid-value");
								continue;
							} finally {
								await fs.rm(modelPath, { force: true });
							}
							merged = candidate;
							importable.push(group);
						}
						for (const sourceRef of rejectedSourceRefs)
							losses.push({ code: "models-invalid-value", domain: "models", sourceRef });
						if (importable.length === 0) return;
					} else {
						for (const group of changed)
							for (const operation of group.operations) mergeModel(merged, operation, input.config);
					}
					const stagedModelBytes = Buffer.from(YAML.stringify(merged, null, 2));
					if (stagedModelBytes.byteLength > plan.maxFileBytes)
						throw new ModelValidationError("staged models byte budget exhausted");
					await fs.writeFile(modelPath, stagedModelBytes, { flag: "wx", mode: 0o600 });
					await validateModels(modelPath, input.config);
					const modelPrior = await priorFor(plan.destination.modelsPath);
					publicationUncertain = true;
					const modelPublished = await publishModelsNonClobber(
						modelPath,
						plan.destination.modelsPath,
						current,
						plan.maxFileBytes,
					);
					publicationUncertain = false;
					if (!modelPublished) {
						losses.push(loss("destination-drift", "destination", plan.destination.modelsPath));
						items = markLostIds(
							items,
							importable.map(group => modelId(group.operation)),
							"destination-drift",
						);
						return;
					}
					items = mark(
						items,
						importable.map(group => modelId(group.operation)),
						"imported",
					);
					committed = true;
					for (const group of importable)
						rollbackEntries.push(
							rollbackEntry(
								modelId(group.operation),
								"models",
								plan.destination.modelsPath,
								modelPublished.digest,
								modelPrior,
								"regular-file",
							),
						);
				}).catch(async error => {
					if (
						!input.allowModelLosses ||
						!(error instanceof ModelValidationError) ||
						committed ||
						publicationUncertain
					)
						throw error;
					await fs.rm(modelPath, { force: true });
					for (const sourceRef of new Set(modelItems.flatMap(item => item.sourceRefs)))
						losses.push({ code: "models-invalid-value", domain: "models", sourceRef });
					items = markLostIds(
						items,
						modelItems.map(item => item.itemId),
						"models-invalid-value",
					);
				});
			}
			let skillsAvailable = true;
			for (const skill of skillItems.sort((a, b) => compare(a.itemId, b.itemId))) {
				if (!skillsAvailable) continue;
				await verifyStage();
				try {
					await ensureDirectory(plan.destination.skillsRoot);
				} catch (error) {
					if (!(error instanceof DestinationValidationError)) throw error;
					const pending = skillItems.filter(value => value.outcome === "planned").map(value => value.itemId);
					items = markLostIds(items, pending, "destination-invalid");
					for (const itemId of pending) {
						const sourceRef = items.find(item => item.itemId === itemId)?.sourceRefs[0] ?? "skills";
						losses.push(loss("destination-invalid", sourceRef, plan.destination.skillsRoot));
					}
					partialApply ||= committed;
					skillsAvailable = false;
					continue;
				}
				const name = skill.itemId.slice(6),
					destination = path.join(plan.destination.skillsRoot, name),
					staged = path.join(skillRoot, name),
					skillPrior = await priorFor(destination);
				const skillDigest = await skillTreeDigest(staged);
				try {
					await validateSkillParent(plan.destination.skillsRoot, destination);
					await fs.mkdir(destination, { recursive: false, mode: 0o700 });
					await validateSkillParent(plan.destination.skillsRoot, destination);
				} catch (error) {
					if (!isExists(error)) throw error;
					await fs.rm(staged, { recursive: true, force: true });
					items = mark(items, [skill.itemId], "skipped");
					continue;
				}
				const owned: OwnedSkillMaterial = {
					root: plan.destination.skillsRoot,
					leaves: [],
					leafNodes: new Map(),
					directories: [destination],
				};
				publicationUncertain = true;
				try {
					await copySkillTree(staged, destination, owned);
				} catch (error) {
					if (error instanceof SkillExistingWinsError) {
						const clean = await cleanupOwnedSkillMaterial(owned);
						if (!clean) {
							losses.push(loss("destination-cleanup-failed", skill.sourceRefs[0] ?? skill.itemId, destination));
							items = markLostIds(items, [skill.itemId], "destination-cleanup-failed");
							partialApply = true;
						} else items = mark(items, [skill.itemId], "skipped");
						publicationUncertain = false;
						continue;
					}
					const clean = await cleanupOwnedSkillMaterial(owned);
					if (!clean) {
						losses.push(loss("destination-cleanup-failed", skill.sourceRefs[0] ?? skill.itemId, destination));
						partialApply = true;
					}
					throw error;
				}
				const published = await fs.lstat(destination);
				if (!published.isDirectory() || published.isSymbolicLink()) {
					const clean = await cleanupOwnedSkillMaterial(owned);
					publicationUncertain = !clean;
					if (!clean) {
						losses.push(loss("destination-cleanup-failed", skill.sourceRefs[0] ?? skill.itemId, destination));
						partialApply = true;
					}
					throw new DestinationValidationError("published skill changed");
				}
				publicationUncertain = false;
				items = mark(items, [skill.itemId], "imported");
				committed = true;
				rollbackEntries.push(
					rollbackEntry(skill.itemId, "skills", destination, skillDigest, skillPrior, "directory-tree"),
				);
			}
			const literal = input.config.credentials.filter(
				value =>
					value.classification === "literal_api_key" && plannedCredentialIds.has(`credential:${value.provider}`),
			);
			if (literal.length) {
				credentialDestinationInvalid = true;
				const providers = [...new Set(literal.map(value => value.provider))].sort(compare);
				await ensureDirectory(plan.destination.agentDir);
				if (!stage) throw new DestinationValidationError("credential stage is unavailable");
				const authPrior = await priorFor(plan.destination.agentDbPath),
					destinationBefore = await credentialStoreIdentity(plan.destination.agentDbPath),
					destinationPresent = Boolean(destinationBefore.primary),
					credentialStagePath = destinationPresent ? plan.destination.agentDbPath : path.join(stage, "agent.db"),
					batches = providers.map(provider => ({
						provider,
						credentials: literal
							.filter(value => value.provider === provider)
							.map(operation => {
								const secret = operation.secretOperationId
									? input.config.secretTable.get(operation.secretOperationId)
									: undefined;
								if (!secret) throw new DestinationValidationError("invalid literal credential");
								return { type: "api_key" as const, key: secret };
							}),
					}));
				const opened = await openCredentialStorageCreateOnly(credentialStagePath, !destinationPresent);
				let batchResult: { inserted: string[]; skipped: string[] };
				try {
					const duringOpen = await credentialStoreIdentity(credentialStagePath);
					if (!sameCredentialStoreIdentity(opened.before, duringOpen))
						throw new DestinationValidationError("credential destination changed before insert");
					batchResult = opened.auth.insertCredentialsIfProvidersAbsent(batches);
				} finally {
					opened.auth.close();
				}
				if (!destinationPresent) await checkpointCredentialStage(credentialStagePath);
				const stagedAfter = await credentialStoreIdentity(credentialStagePath);
				if (!sameCredentialStoreIdentity(opened.before, stagedAfter) && destinationPresent)
					throw new DestinationValidationError("credential destination changed during insert");
				if (!destinationPresent) {
					if (Object.keys(stagedAfter.companions).length > 0)
						throw new DestinationValidationError("staged credential companions remain");
					if (!(await publishCreateOnly(credentialStagePath, plan.destination.agentDbPath)))
						throw new DestinationValidationError("credential destination appeared during publication");
				}
				const destinationAfter = await credentialStoreIdentity(plan.destination.agentDbPath),
					destinationProbeAfter = await probeCredentialStore(plan.destination.agentDbPath);
				if (!destinationProbeAfter.valid || !destinationAfter.primary)
					throw new DestinationValidationError("credential destination invalid after publication");
				if (destinationPresent && !sameCredentialStoreIdentity(destinationBefore, destinationAfter))
					throw new DestinationValidationError("credential destination changed during publication");
				const importedCredentialProviders = batchResult.inserted,
					skippedCredentialProviders = batchResult.skipped;
				items = mark(
					items,
					importedCredentialProviders.map(provider => `credential:${provider}`),
					"imported",
				);
				items = mark(
					items,
					skippedCredentialProviders.map(provider => `credential:${provider}`),
					"skipped",
				);
				if (importedCredentialProviders.length) {
					committed = true;
					for (const provider of importedCredentialProviders) {
						const authDigest = await credentialProviderDigest(plan.destination.agentDbPath, provider);
						if (!authDigest) throw new DestinationValidationError("imported credential missing");
						rollbackEntries.push(
							rollbackEntry(
								`credential:${provider}`,
								"credentials",
								plan.destination.agentDbPath,
								authDigest,
								authPrior,
								"regular-file",
							),
						);
					}
				}
				credentialDestinationInvalid = false;
			}
			if (plan.settingMutations.length) {
				for (const candidate of plan.destination.settingsCandidates) await priorFor(candidate);
				await ensureDirectory(plan.destination.agentDir);
				const settingResult = await Settings.applyCreateOnlyIsolated(
					{
						agentDir: plan.destination.agentDir,
						cwd: plan.destination.cwd,
						readLimits: {
							maxFileBytes: plan.maxFileBytes,
							maxTotalBytes: plan.maxTotalBytes,
							maxDepth: 64,
							maxEntries: plan.maxEntries,
						},
					},
					settingMutationsForApply(plan.settingMutations),
				);
				const importedSettingIds = settingResult.applied.map(settingItemId);
				const skippedSettingIds = settingResult.skipped.map(settingItemId);
				items = mark(items, importedSettingIds, "imported");
				items = mark(items, skippedSettingIds, "skipped");
				if (importedSettingIds.length > 0) committed = true;
				if (importedSettingIds.length) {
					let settingsPath = plan.destination.settingsCandidates[0];
					for (const candidate of plan.destination.settingsCandidates)
						try {
							const stat = await fs.lstat(candidate);
							if (stat.isFile()) {
								settingsPath = candidate;
								break;
							}
						} catch (error) {
							if (!missing(error)) throw error;
						}
					if (settingsPath) {
						const settingsDigest = await descriptorDigest(settingsPath),
							settingsPrior = priorStates.get(settingsPath);
						for (const itemId of importedSettingIds)
							rollbackEntries.push(
								rollbackEntry(itemId, "settings", settingsPath, settingsDigest, settingsPrior, "regular-file"),
							);
					}
				}
			}
			return finish({
				schemaVersion: 1,
				snapshotId: plan.snapshotId,
				items: sortItems(items),
				losses: sortLosses(losses),
				partialApply,
			});
		});
	} catch {
		if (credentialDestinationInvalid) {
			losses.push(loss("destination-invalid", "destination", plan.destination.agentDbPath));
			items = markLost(items, "destination-invalid");
		}
		losses.push(loss("destination-apply-failed", "destination", plan.destination.agentDir));
		return finish({
			schemaVersion: 1,
			snapshotId: plan.snapshotId,
			items: sortItems(markLost(items, "destination-apply-failed")),
			losses: sortLosses(losses),
			partialApply: partialApply || committed || publicationUncertain,
		});
	}
}
