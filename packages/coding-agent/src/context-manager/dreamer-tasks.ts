import * as fs from "node:fs/promises";
import * as path from "node:path";
import { escapeXmlText, isEnoent, prompt, truncate } from "@oh-my-pi/pi-utils";
import type { Settings } from "../config/settings";
import dreamerSystemPrompt from "../prompts/context-manager/dreamer-system.md" with { type: "text" };
import dreamerTurnTemplate from "../prompts/context-manager/dreamer-turn.md" with { type: "text" };
import type { SessionManager } from "../session/session-manager";
import type { ContextAgentRunner } from "./agent-runner";
import { CONTEXT_DREAM_TASKS, type ContextDreamTaskDefinition, type ContextDreamTaskName } from "./dreamer-registry";
import type { ContextMemoryAdapter, ContextMemoryMaintenanceRecord, ContextMemoryScope } from "./memory";
import type { ContextStore } from "./storage";
import type { ContextSessionFactRecord } from "./types";

const MAX_MEMORY_INPUT = 50;
const MAX_BACKING_FILES = 16;
const STALE_VERIFICATION_MS = 30 * 24 * 60 * 60 * 1000;
const PROJECT_MEMORY_TYPES = new Set([
	"PROJECT_RULES",
	"ARCHITECTURE",
	"CONSTRAINTS",
	"CONFIG_VALUES",
	"NAMING",
	"FACT",
]);
const USER_MEMORY_TYPES = new Set(["preference", "instruction", "personality", "relationship"]);
const CORRECTION_SIGNAL =
	/\b(?:actually|no[,;:]?|i (?:already|said|prefer|want|need)|remember that|as i explained|to be clear)\b|(?:不是|我已经|我说过|请记住|我更喜欢|以后|纠正|准确地说)/i;

interface ManagedMemoryMetadata {
	readonly backingFiles?: readonly string[];
	readonly fileHashes?: Readonly<Record<string, string>>;
	readonly fileIndependent?: boolean;
	readonly verifiedAt?: number;
	readonly kind?: string;
	readonly sourceTask?: string;
}

interface ContextDreamTaskWorkResult {
	readonly changed: number;
	readonly summary: string;
}

export interface ContextDreamTaskExecutorOptions {
	readonly store: ContextStore;
	readonly settings: Settings;
	readonly runner: ContextAgentRunner;
	readonly sessionManager: SessionManager;
	readonly getMemoryAdapter: () => ContextMemoryAdapter | undefined;
	readonly getProjectId: () => string | undefined;
	readonly getSessionId: () => string | undefined;
	readonly getCwd: () => string;
}

export interface ContextDreamTaskRunOptions {
	readonly forced: boolean;
	readonly settings?: Settings;
	readonly signal?: AbortSignal;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseRoot(text: string): Record<string, unknown> {
	const trimmed = text.trim();
	if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
		throw new Error("Dreamer output must be one bare JSON object");
	}
	const value: unknown = JSON.parse(trimmed);
	if (!isRecord(value)) throw new Error("Dreamer output must be a JSON object");
	return value;
}

function records(value: unknown): Record<string, unknown>[] {
	return Array.isArray(value) ? value.filter(isRecord) : [];
}

function strings(value: unknown): string[] {
	return Array.isArray(value)
		? value
				.filter((item): item is string => typeof item === "string")
				.map(item => item.trim())
				.filter(Boolean)
		: [];
}

function finiteInteger(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
}

function metadataRecord(record: ContextMemoryMaintenanceRecord): Readonly<Record<string, unknown>> {
	return isRecord(record.metadata) ? record.metadata : {};
}

function managedMetadata(record: ContextMemoryMaintenanceRecord): ManagedMemoryMetadata {
	const managed = metadataRecord(record).managedContext;
	if (!isRecord(managed)) return {};
	return {
		...(Array.isArray(managed.backingFiles)
			? { backingFiles: managed.backingFiles.filter((item): item is string => typeof item === "string") }
			: {}),
		...(isRecord(managed.fileHashes)
			? {
					fileHashes: Object.fromEntries(
						Object.entries(managed.fileHashes).filter(
							(entry): entry is [string, string] => typeof entry[1] === "string",
						),
					),
				}
			: {}),
		...(typeof managed.fileIndependent === "boolean" ? { fileIndependent: managed.fileIndependent } : {}),
		...(typeof managed.verifiedAt === "number" ? { verifiedAt: managed.verifiedAt } : {}),
		...(typeof managed.kind === "string" ? { kind: managed.kind } : {}),
		...(typeof managed.sourceTask === "string" ? { sourceTask: managed.sourceTask } : {}),
	};
}

function patchedMetadata(
	record: ContextMemoryMaintenanceRecord,
	patch: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
	const metadata = metadataRecord(record);
	return {
		...metadata,
		managedContext: {
			...(isRecord(metadata.managedContext) ? metadata.managedContext : {}),
			...patch,
		},
	};
}

function normalizedContent(value: string): string {
	return value
		.normalize("NFKC")
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, " ")
		.trim();
}

function memoryInput(record: ContextMemoryMaintenanceRecord): Readonly<Record<string, unknown>> {
	return {
		id: record.id,
		content: truncate(record.content, 4_000),
		memoryType: record.memoryType ?? "unknown",
		importance: record.importance,
		metadata: record.metadata,
	};
}

function userMessageText(message: { readonly role: string }): string {
	if (message.role !== "user" || !("content" in message)) return "";
	const content = (message as { readonly content?: unknown }).content;
	if (typeof content === "string") return content.trim();
	if (!Array.isArray(content)) return "";
	return content
		.filter(isRecord)
		.filter(part => part.type === "text" && typeof part.text === "string")
		.map(part => String(part.text))
		.join("\n")
		.trim();
}

async function fileFingerprint(filePath: string): Promise<string | undefined> {
	try {
		const stat = await fs.stat(filePath);
		if (!stat.isFile()) return undefined;
		const hasher = new Bun.CryptoHasher("sha256");
		for await (const chunk of Bun.file(filePath).stream()) hasher.update(chunk);
		return hasher.digest("hex");
	} catch (error) {
		if (isEnoent(error)) return undefined;
		throw error;
	}
}

async function normalizeBackingFiles(cwd: string, values: readonly string[]): Promise<string[]> {
	const root = await fs.realpath(cwd);
	const normalized: string[] = [];
	for (const value of [...new Set(values)].slice(0, MAX_BACKING_FILES)) {
		if (!value || path.isAbsolute(value)) continue;
		const candidate = path.resolve(root, value);
		const relative = path.relative(root, candidate);
		if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) continue;
		try {
			const real = await fs.realpath(candidate);
			const realRelative = path.relative(root, real);
			if (!realRelative || realRelative.startsWith("..") || path.isAbsolute(realRelative)) continue;
			if (!(await fs.stat(real)).isFile()) continue;
			normalized.push(realRelative.split(path.sep).join("/"));
		} catch (error) {
			if (!isEnoent(error)) throw error;
		}
	}
	return normalized;
}

async function backingFileHashes(cwd: string, files: readonly string[]): Promise<Record<string, string>> {
	const entries = await Promise.all(
		files.map(async file => {
			const hash = await fileFingerprint(path.resolve(cwd, file));
			return hash === undefined ? undefined : ([file, hash] as const);
		}),
	);
	return Object.fromEntries(entries.filter((entry): entry is readonly [string, string] => entry !== undefined));
}

function selectSourceIndexes(value: unknown, maximum: number): number[] {
	return Array.isArray(value)
		? [
				...new Set(
					value
						.map(finiteInteger)
						.filter((index): index is number => index !== undefined && index >= 0 && index < maximum),
				),
			]
		: [];
}

/** Executes validated, activity-gated work for each canonical dream task. */
export class ContextDreamTaskExecutor {
	readonly #store: ContextStore;
	readonly #settings: Settings;
	readonly #runner: ContextAgentRunner;
	readonly #sessionManager: SessionManager;
	readonly #getMemoryAdapter: () => ContextMemoryAdapter | undefined;
	readonly #getProjectId: () => string | undefined;
	readonly #getSessionId: () => string | undefined;
	readonly #getCwd: () => string;

	constructor(options: ContextDreamTaskExecutorOptions) {
		this.#store = options.store;
		this.#settings = options.settings;
		this.#runner = options.runner;
		this.#sessionManager = options.sessionManager;
		this.#getMemoryAdapter = options.getMemoryAdapter;
		this.#getProjectId = options.getProjectId;
		this.#getSessionId = options.getSessionId;
		this.#getCwd = options.getCwd;
	}

	async run(task: ContextDreamTaskName, options: ContextDreamTaskRunOptions): Promise<ContextDreamTaskWorkResult> {
		const settings = options.settings ?? this.#settings;
		const definition = CONTEXT_DREAM_TASKS[task];
		if (definition.needsMemory && !this.#getMemoryAdapter()?.available) {
			return { changed: 0, summary: `${task}: skipped because Mnemopi is unavailable` };
		}
		switch (task) {
			case "map-memories":
				return this.#mapMemories(definition, settings, options.signal);
			case "verify":
				return this.#verify(definition, settings, false, options.signal);
			case "verify-broad":
				return this.#verify(definition, settings, true, options.signal);
			case "curate":
				return this.#curate(definition, settings, options.signal);
			case "classify-memories":
				return this.#classify(definition, settings, options.signal);
			case "retrospective":
				return this.#retrospective(definition, settings, options.signal);
			case "maintain-docs":
				return this.#maintainDocs(definition, settings, options.forced, options.signal);
			case "promote-primers":
				return this.#promotePrimers(definition, settings, options.signal);
			case "refresh-primers":
				return this.#refreshPrimers(definition, settings, options.signal);
			case "evaluate-smart-notes":
				return this.#evaluateSmartNotes(definition, settings, options.signal);
			case "review-user-memories":
				return this.#reviewUserMemories(definition, settings, options.signal);
		}
	}

	async #runAgent(
		definition: ContextDreamTaskDefinition,
		settings: Settings,
		payload: unknown,
		signal?: AbortSignal,
		allowedWritePaths?: readonly string[],
	): Promise<Record<string, unknown>> {
		const configuredModel = settings.get(definition.modelPath) as string | undefined;
		const selectors = configuredModel?.trim() ? [configuredModel.trim()] : undefined;
		const candidates = this.#runner.resolveCandidates("dreamer", true, selectors);
		if (candidates.length === 0) throw new Error(`No model is available for dream task ${definition.name}`);
		const userPrompt = prompt.render(dreamerTurnTemplate, {
			task: definition.name,
			instructions: definition.instructions,
			language: settings.get("contextManager.language"),
			payload: escapeXmlText(JSON.stringify(payload, null, 2)),
		});
		let lastError = `${definition.name} returned no valid output`;
		for (const candidate of candidates) {
			try {
				const output = await this.#runner.run({
					candidate: { ...candidate, role: `dreamer:${definition.name}` },
					systemPrompt: dreamerSystemPrompt,
					userPrompt,
					toolNames: definition.toolNames,
					...(allowedWritePaths ? { allowedWritePaths } : {}),
					timeoutMs: Math.max(1, settings.get(definition.timeoutPath) as number) * 60_000,
					signal,
				});
				return parseRoot(output);
			} catch (error) {
				if (signal?.aborted) throw error;
				lastError = error instanceof Error ? error.message : String(error);
			}
		}
		throw new Error(lastError);
	}

	#memory(): ContextMemoryAdapter {
		const adapter = this.#getMemoryAdapter();
		if (!adapter?.available) throw new Error("Mnemopi is unavailable");
		return adapter;
	}

	async #mapMemories(
		definition: ContextDreamTaskDefinition,
		settings: Settings,
		signal?: AbortSignal,
	): Promise<ContextDreamTaskWorkResult> {
		const adapter = this.#memory();
		const candidates = adapter
			.list("project")
			.filter(record => {
				const metadata = managedMetadata(record);
				return !metadata.fileIndependent && (metadata.backingFiles?.length ?? 0) === 0;
			})
			.slice(0, MAX_MEMORY_INPUT);
		if (candidates.length === 0) return { changed: 0, summary: "map-memories: no unmapped project memories" };
		const root = await this.#runAgent(definition, settings, { memories: candidates.map(memoryInput) }, signal);
		const byId = new Map(candidates.map(record => [record.id, record]));
		let changed = 0;
		for (const action of records(root.actions)) {
			const id = typeof action.id === "string" ? action.id : "";
			const record = byId.get(id);
			if (!record || action.action !== "map" || typeof action.fileIndependent !== "boolean") continue;
			const backingFiles = await normalizeBackingFiles(this.#getCwd(), strings(action.backingFiles));
			if (!action.fileIndependent && backingFiles.length === 0) continue;
			const fileHashes = await backingFileHashes(this.#getCwd(), backingFiles);
			if (
				adapter.patch(id, {
					metadata: patchedMetadata(record, {
						backingFiles,
						fileHashes,
						fileIndependent: action.fileIndependent,
						verifiedAt: Date.now(),
						sourceTask: definition.name,
					}),
				}).status === "updated"
			) {
				changed++;
			}
		}
		return { changed, summary: `map-memories: mapped ${changed}/${candidates.length} memories` };
	}

	async #verify(
		definition: ContextDreamTaskDefinition,
		settings: Settings,
		broad: boolean,
		signal?: AbortSignal,
	): Promise<ContextDreamTaskWorkResult> {
		const adapter = this.#memory();
		const now = Date.now();
		const all = adapter.list("project");
		const candidates: ContextMemoryMaintenanceRecord[] = [];
		for (const record of all) {
			const metadata = managedMetadata(record);
			if (broad) {
				if (!metadata.verifiedAt || now - metadata.verifiedAt >= STALE_VERIFICATION_MS) candidates.push(record);
			} else if (metadata.backingFiles && metadata.backingFiles.length > 0) {
				const currentHashes = await backingFileHashes(this.#getCwd(), metadata.backingFiles);
				if (JSON.stringify(currentHashes) !== JSON.stringify(metadata.fileHashes ?? {})) candidates.push(record);
			}
			if (candidates.length >= 25) break;
		}
		if (candidates.length === 0) {
			return { changed: 0, summary: `${definition.name}: no memories require verification` };
		}
		const root = await this.#runAgent(
			definition,
			settings,
			{
				memories: candidates.map(record => ({ ...memoryInput(record), managed: managedMetadata(record) })),
			},
			signal,
		);
		const byId = new Map(candidates.map(record => [record.id, record]));
		let changed = 0;
		for (const action of records(root.actions)) {
			const id = typeof action.id === "string" ? action.id : "";
			const record = byId.get(id);
			if (!record || typeof action.action !== "string") continue;
			if (action.action === "invalidate") {
				if (adapter.edit("invalidate", id).status === "invalidated") changed++;
				continue;
			}
			if (action.action !== "keep" && action.action !== "update") continue;
			const previous = managedMetadata(record);
			const requestedFiles =
				action.backingFiles === undefined ? (previous.backingFiles ?? []) : strings(action.backingFiles);
			const backingFiles = await normalizeBackingFiles(this.#getCwd(), requestedFiles);
			const fileIndependent =
				typeof action.fileIndependent === "boolean"
					? action.fileIndependent
					: (previous.fileIndependent ?? backingFiles.length === 0);
			if (!fileIndependent && backingFiles.length === 0) continue;
			const content =
				action.action === "update" && typeof action.content === "string" ? action.content.trim() : undefined;
			if (action.action === "update" && !content) continue;
			const result = adapter.patch(id, {
				...(content ? { content } : {}),
				metadata: patchedMetadata(record, {
					backingFiles,
					fileHashes: await backingFileHashes(this.#getCwd(), backingFiles),
					fileIndependent,
					verifiedAt: now,
					sourceTask: definition.name,
				}),
			});
			if (result.status === "updated") changed++;
		}
		return { changed, summary: `${definition.name}: applied ${changed}/${candidates.length} verification actions` };
	}

	async #curate(
		definition: ContextDreamTaskDefinition,
		settings: Settings,
		signal?: AbortSignal,
	): Promise<ContextDreamTaskWorkResult> {
		const adapter = this.#memory();
		const memories = adapter.list("project").slice(0, 100);
		if (memories.length < 2) return { changed: 0, summary: "curate: fewer than two project memories" };
		const root = await this.#runAgent(definition, settings, { memories: memories.map(memoryInput) }, signal);
		const validIds = new Set(memories.map(record => record.id));
		const consumed = new Set<string>();
		let changed = 0;
		for (const action of records(root.actions)) {
			if (action.action === "merge") {
				const ids = strings(action.ids).filter(id => validIds.has(id) && !consumed.has(id));
				if (ids.length < 2) continue;
				const mergedId = await adapter.merge("project", ids);
				if (!mergedId) continue;
				for (const id of ids) consumed.add(id);
				changed += ids.length;
			} else if (action.action === "invalidate" && typeof action.id === "string") {
				if (!validIds.has(action.id) || consumed.has(action.id)) continue;
				if (adapter.edit("invalidate", action.id).status === "invalidated") {
					consumed.add(action.id);
					changed++;
				}
			}
		}
		return { changed, summary: `curate: changed ${changed} project memories` };
	}

	async #classify(
		definition: ContextDreamTaskDefinition,
		settings: Settings,
		signal?: AbortSignal,
	): Promise<ContextDreamTaskWorkResult> {
		const adapter = this.#memory();
		const memories = adapter
			.list("project")
			.filter(
				record => !record.memoryType || ["unknown", "context", "project"].includes(record.memoryType.toLowerCase()),
			)
			.slice(0, MAX_MEMORY_INPUT);
		if (memories.length === 0) return { changed: 0, summary: "classify-memories: no unknown memories" };
		const root = await this.#runAgent(definition, settings, { memories: memories.map(memoryInput) }, signal);
		const validIds = new Set(memories.map(record => record.id));
		let changed = 0;
		for (const action of records(root.actions)) {
			if (typeof action.id !== "string" || !validIds.has(action.id) || typeof action.memoryType !== "string")
				continue;
			const memoryType = action.memoryType.toUpperCase();
			if (!PROJECT_MEMORY_TYPES.has(memoryType)) continue;
			if (adapter.patch(action.id, { memoryType }).status === "updated") changed++;
		}
		return { changed, summary: `classify-memories: classified ${changed}/${memories.length} memories` };
	}

	async #retrospective(
		definition: ContextDreamTaskDefinition,
		settings: Settings,
		signal?: AbortSignal,
	): Promise<ContextDreamTaskWorkResult> {
		const projectId = this.#getProjectId();
		if (!projectId) return { changed: 0, summary: "retrospective: project unavailable" };
		const watermarkKey = `dreamer:${projectId}:retrospective-watermark`;
		const watermark = Number(this.#store.getMeta(watermarkKey) ?? 0);
		const signals = this.#sessionManager
			.getBranch()
			.filter(entry => entry.type === "message" && entry.message.role === "user")
			.map(entry => ({
				timestamp: entry.type === "message" ? entry.message.timestamp : 0,
				text: entry.type === "message" ? userMessageText(entry.message) : "",
			}))
			.filter(item => item.timestamp > watermark && item.text && CORRECTION_SIGNAL.test(item.text))
			.map((item, index) => ({ index, timestamp: item.timestamp, text: truncate(item.text, 4_000) }));
		if (signals.length === 0) {
			this.#store.setMeta(watermarkKey, String(Date.now()));
			return { changed: 0, summary: "retrospective: no new correction signals" };
		}
		const root = await this.#runAgent(definition, settings, { corrections: signals }, signal);
		const adapter = this.#memory();
		const existing = new Set(adapter.list().map(record => normalizedContent(record.content)));
		let changed = 0;
		for (const memory of records(root.memories)) {
			if (memory.scope !== "project" && memory.scope !== "user") continue;
			const content = typeof memory.content === "string" ? memory.content.trim() : "";
			const category = typeof memory.category === "string" ? memory.category.trim() : "";
			const sourceIndexes = selectSourceIndexes(memory.sourceIndexes, signals.length);
			if (!content || !category || sourceIndexes.length === 0 || existing.has(normalizedContent(content))) continue;
			if (memory.scope === "user" && !USER_MEMORY_TYPES.has(category)) continue;
			const id = await adapter.remember(memory.scope as ContextMemoryScope, {
				content,
				source: definition.name,
				memoryType: category,
				metadata: { sourceIndexes, managedContext: { sourceTask: definition.name } },
			});
			if (id) {
				existing.add(normalizedContent(content));
				changed++;
			}
		}
		this.#store.setMeta(watermarkKey, String(Date.now()));
		return { changed, summary: `retrospective: retained ${changed} durable memories` };
	}

	async #maintainDocs(
		definition: ContextDreamTaskDefinition,
		settings: Settings,
		forced: boolean,
		signal?: AbortSignal,
	): Promise<ContextDreamTaskWorkResult> {
		const cwd = this.#getCwd();
		const files = ["ARCHITECTURE.md", "STRUCTURE.md"] as const;
		const before = Object.fromEntries(
			await Promise.all(files.map(async file => [file, await fileFingerprint(path.join(cwd, file))] as const)),
		);
		const allowCreate = forced || Boolean((settings.get(definition.schedulePath) as string).trim());
		if (!allowCreate && Object.values(before).every(value => value === undefined)) {
			return { changed: 0, summary: "maintain-docs: root documents do not exist and creation is disabled" };
		}
		await this.#runAgent(
			definition,
			settings,
			{ allowCreate, files: files.map(file => ({ path: file, exists: before[file] !== undefined })) },
			signal,
			files,
		);
		const after = Object.fromEntries(
			await Promise.all(files.map(async file => [file, await fileFingerprint(path.join(cwd, file))] as const)),
		);
		const changed = files.filter(file => before[file] !== after[file]).length;
		return { changed, summary: `maintain-docs: changed ${changed} root documents` };
	}

	async #promotePrimers(
		definition: ContextDreamTaskDefinition,
		settings: Settings,
		signal?: AbortSignal,
	): Promise<ContextDreamTaskWorkResult> {
		const threshold = settings.get("contextManager.dreamer.tasks.promote-primers.promotionThreshold");
		const questions = this.#sessionManager
			.getBranch()
			.filter(entry => entry.type === "message" && entry.message.role === "user")
			.map(entry => (entry.type === "message" ? userMessageText(entry.message) : ""))
			.filter(text => /[?？]\s*$/.test(text));
		const groups = new Map<string, { text: string; indexes: number[] }>();
		questions.forEach((text, index) => {
			const key = normalizedContent(text);
			const group = groups.get(key) ?? { text, indexes: [] };
			group.indexes.push(index);
			groups.set(key, group);
		});
		const recurring = [...groups.values()]
			.filter(group => group.indexes.length >= threshold)
			.map((group, index) => ({ index, content: truncate(group.text, 2_000), count: group.indexes.length }));
		if (recurring.length === 0) return { changed: 0, summary: "promote-primers: no recurring questions" };
		const root = await this.#runAgent(definition, settings, { recurringQuestions: recurring }, signal);
		const adapter = this.#memory();
		const existing = new Set(adapter.list("user").map(record => normalizedContent(record.content)));
		let changed = 0;
		for (const memory of records(root.memories)) {
			const content = typeof memory.content === "string" ? memory.content.trim() : "";
			const sourceIndexes = selectSourceIndexes(memory.sourceIndexes, recurring.length);
			if (!content || sourceIndexes.length === 0 || existing.has(normalizedContent(content))) continue;
			const id = await adapter.remember("user", {
				content,
				source: definition.name,
				memoryType: "instruction",
				metadata: {
					kind: "primer",
					sourceIndexes,
					managedContext: { kind: "primer", sourceTask: definition.name, verifiedAt: Date.now() },
				},
			});
			if (id) {
				existing.add(normalizedContent(content));
				changed++;
			}
		}
		return { changed, summary: `promote-primers: promoted ${changed} primers` };
	}

	async #refreshPrimers(
		definition: ContextDreamTaskDefinition,
		settings: Settings,
		signal?: AbortSignal,
	): Promise<ContextDreamTaskWorkResult> {
		const adapter = this.#memory();
		const now = Date.now();
		const primers = adapter
			.list("user")
			.filter(record => {
				const metadata = metadataRecord(record);
				const managed = managedMetadata(record);
				return (
					(metadata.kind === "primer" || managed.kind === "primer") &&
					(!managed.verifiedAt || now - managed.verifiedAt >= STALE_VERIFICATION_MS)
				);
			})
			.slice(0, 25);
		if (primers.length === 0) return { changed: 0, summary: "refresh-primers: no stale primers" };
		const root = await this.#runAgent(definition, settings, { primers: primers.map(memoryInput) }, signal);
		const byId = new Map(primers.map(record => [record.id, record]));
		let changed = 0;
		for (const action of records(root.actions)) {
			const id = typeof action.id === "string" ? action.id : "";
			const record = byId.get(id);
			if (!record || typeof action.action !== "string") continue;
			if (action.action === "invalidate") {
				if (adapter.edit("invalidate", id).status === "invalidated") changed++;
				continue;
			}
			if (action.action !== "keep" && action.action !== "update") continue;
			const content =
				action.action === "update" && typeof action.content === "string" ? action.content.trim() : undefined;
			if (action.action === "update" && !content) continue;
			if (
				adapter.patch(id, {
					...(content ? { content } : {}),
					metadata: patchedMetadata(record, { kind: "primer", verifiedAt: now, sourceTask: definition.name }),
				}).status === "updated"
			) {
				changed++;
			}
		}
		return { changed, summary: `refresh-primers: refreshed ${changed}/${primers.length} primers` };
	}

	async #evaluateSmartNotes(
		definition: ContextDreamTaskDefinition,
		settings: Settings,
		signal?: AbortSignal,
	): Promise<ContextDreamTaskWorkResult> {
		const projectId = this.#getProjectId();
		const sessionId = this.#getSessionId();
		if (!projectId || !sessionId) return { changed: 0, summary: "evaluate-smart-notes: session unavailable" };
		const notes = this.#store
			.listNotes(projectId, sessionId)
			.filter(note => note.status === "pending")
			.slice(0, 50);
		if (notes.length === 0) return { changed: 0, summary: "evaluate-smart-notes: no pending notes" };
		const recentUserMessages = this.#sessionManager
			.getBranch()
			.filter(entry => entry.type === "message" && entry.message.role === "user")
			.slice(-5)
			.map(entry => (entry.type === "message" ? truncate(userMessageText(entry.message), 2_000) : ""));
		const root = await this.#runAgent(
			definition,
			settings,
			{
				notes: notes.map(note => ({
					id: note.id,
					category: note.category,
					content: note.content,
					surfaceCondition: note.surfaceCondition,
				})),
				recentUserMessages,
				currentTime: new Date().toISOString(),
			},
			signal,
		);
		const byId = new Map(notes.map(note => [note.id, note]));
		let changed = 0;
		for (const action of records(root.actions)) {
			const id = typeof action.id === "string" ? action.id : "";
			const note = byId.get(id);
			if (!note || typeof action.action !== "string" || action.action === "keep-pending") continue;
			const status = action.action === "activate" ? "active" : action.action === "dismiss" ? "dismissed" : undefined;
			if (!status) continue;
			this.#store.upsertNote({
				id: note.id,
				projectId,
				scope: note.scope,
				category: note.category,
				content: note.content,
				status,
				...(note.sessionId ? { sessionId: note.sessionId } : {}),
				...(note.surfaceCondition ? { surfaceCondition: note.surfaceCondition } : {}),
			});
			changed++;
		}
		return { changed, summary: `evaluate-smart-notes: resolved ${changed}/${notes.length} notes` };
	}

	async #reviewUserMemories(
		definition: ContextDreamTaskDefinition,
		settings: Settings,
		signal?: AbortSignal,
	): Promise<ContextDreamTaskWorkResult> {
		const threshold = settings.get("contextManager.dreamer.tasks.review-user-memories.promotionThreshold");
		const facts = this.#store.listUnpromotedUserFacts();
		const grouped = new Map<string, ContextSessionFactRecord[]>();
		for (const fact of facts) {
			const key = normalizedContent(fact.text);
			const group = grouped.get(key) ?? [];
			group.push(fact);
			grouped.set(key, group);
		}
		const candidates = [...grouped.values()]
			.filter(group => group.length >= threshold || group.some(fact => fact.retrievalCount >= threshold))
			.flat();
		if (candidates.length === 0) return { changed: 0, summary: "review-user-memories: no recurring user facts" };
		const root = await this.#runAgent(
			definition,
			settings,
			{
				facts: candidates.map(fact => ({
					id: fact.id,
					content: fact.text,
					category: fact.category,
					retrievalCount: fact.retrievalCount,
				})),
			},
			signal,
		);
		const byId = new Map(candidates.map(fact => [fact.id, fact]));
		const adapter = this.#memory();
		const existing = new Set(adapter.list("user").map(record => normalizedContent(record.content)));
		let changed = 0;
		for (const memory of records(root.memories)) {
			const category = typeof memory.category === "string" ? memory.category : "";
			const content = typeof memory.content === "string" ? memory.content.trim() : "";
			const sourceIds = strings(memory.sourceIds).filter(id => byId.has(id));
			if (
				!USER_MEMORY_TYPES.has(category) ||
				!content ||
				sourceIds.length === 0 ||
				existing.has(normalizedContent(content))
			)
				continue;
			const canonicalId = await adapter.remember("user", {
				content,
				source: definition.name,
				memoryType: category,
				metadata: { sourceFactIds: sourceIds, managedContext: { sourceTask: definition.name } },
			});
			if (!canonicalId) continue;
			for (const factId of sourceIds) {
				this.#store.markSessionFactPromoted(factId, canonicalId, [
					{ kind: "dreamer-review", task: definition.name },
				]);
			}
			existing.add(normalizedContent(content));
			changed++;
		}
		return { changed, summary: `review-user-memories: promoted ${changed} user memories` };
	}
}
