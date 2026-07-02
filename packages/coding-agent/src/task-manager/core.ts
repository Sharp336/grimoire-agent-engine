/**
 * Core Task Manager — task CRUD, config loading, and entity operations.
 *
 * Strips TUI rendering and MCP server methods from the source. Keeps only
 * data operations: createTask, loadTask, updateTask, listTasks, archiveTask,
 * deleteTask (NEW — hard delete + git rm), ensureConfigLoaded, ensureConfigMigrated.
 */

import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";
import { DEFAULT_INIT_CONFIG } from "./constants";
import { ContentStore } from "./content-store";
import { FileSystem } from "./file-system";
import { GitOperations } from "./git-ops";
import { parseDecision, parseDocument, parseMilestone, parseTask } from "./markdown/parser";
import {
	makeComment,
	serializeDecision,
	serializeDocument,
	serializeMilestone,
	serializeTask,
} from "./markdown/serializer";
import { Sequences } from "./sequences";
import type {
	Decision,
	Document,
	Milestone,
	Task,
	TaskConfig,
	TaskCreateInput,
	TaskListFilter,
	TaskUpdateInput,
} from "./types";

const CONFIG_VERSION = 1;

export class Core {
	readonly fs: FileSystem;
	readonly git: GitOperations;
	readonly content = new ContentStore();
	#config: TaskConfig | null = null;
	#sequences: Sequences | null = null;

	constructor(rootDir: string = process.cwd()) {
		this.fs = new FileSystem(rootDir);
		this.git = new GitOperations(rootDir, true);
	}

	// ─── Config ─────────────────────────────────────────────────────────────

	get config(): TaskConfig {
		if (!this.#config) throw new Error("Task Manager config not loaded — call ensureConfigLoaded() first");
		return this.#config;
	}

	get sequences(): Sequences {
		if (!this.#sequences) throw new Error("Task Manager config not loaded — call ensureConfigLoaded() first");
		return this.#sequences;
	}

	async ensureConfigLoaded(): Promise<TaskConfig> {
		if (this.#config) return this.#config;
		const raw = await this.fs.readConfig();
		if (raw) {
			const parsed = YAML.parse(raw) as TaskConfig;
			this.#config = { ...DEFAULT_INIT_CONFIG, ...parsed };
		} else {
			this.#config = { ...DEFAULT_INIT_CONFIG };
		}
		this.fs.setConfig(this.#config);
		this.#sequences = new Sequences(this.#config, this.fs.rootDir);
		return this.#config;
	}

	async ensureConfigMigrated(): Promise<void> {
		const config = await this.ensureConfigLoaded();
		const raw = await this.fs.readConfig();
		if (!raw) return;
		const parsed = YAML.parse(raw) as Record<string, unknown>;
		if ((parsed._version as number | undefined) === CONFIG_VERSION) return;
		const migrated: TaskConfig & { _version?: number } = { ...config, _version: CONFIG_VERSION };
		await this.fs.writeConfig(YAML.stringify(migrated, null, 2));
	}

	// ─── Init ────────────────────────────────────────────────────────────────

	async initializeProject(name: string, _defaults: boolean = false, enableGit: boolean = true): Promise<TaskConfig> {
		const baseConfig: TaskConfig = {
			...DEFAULT_INIT_CONFIG,
			projectName: name,
		};
		const config: TaskConfig = enableGit
			? baseConfig
			: { ...baseConfig, git: { ...baseConfig.git, enabled: false, autoCommit: false } };

		this.fs.setConfig(config);
		this.#config = config;
		this.#sequences = new Sequences(config, this.fs.rootDir);

		await this.fs.ensureDirs();
		await this.fs.writeConfig(YAML.stringify({ ...config, _version: CONFIG_VERSION }, null, 2));

		if (config.git.enabled && (await this.git.isRepo())) {
			const gitignore = path.join(this.fs.rootDir, ".gitignore");
			const lockLine = `${config.files.sequences}.lock`;
			try {
				const existing = await Bun.file(gitignore).text();
				if (!existing.includes(lockLine)) {
					await Bun.write(gitignore, `${existing.trimEnd()}\n${lockLine}\n`);
				}
			} catch (err) {
				if (isEnoent(err)) {
					await Bun.write(gitignore, `${lockLine}\n`);
				} else {
					throw err;
				}
			}
		}

		return config;
	}

	// ─── Task CRUD ──────────────────────────────────────────────────────────

	async createTask(input: TaskCreateInput): Promise<Task> {
		await this.ensureConfigLoaded();
		const id = await this.sequences.next("task");
		const now = new Date().toISOString();

		const task: Task = {
			id,
			title: input.title,
			description: input.description ?? "",
			status: input.status ?? this.config.defaultStatus,
			assignee: input.assignee ?? null,
			labels: input.labels ?? [],
			priority: input.priority ?? null,
			parentTaskId: input.parentTaskId ?? null,
			dependencies: input.dependencies ?? [],
			createdAt: now,
			updatedAt: now,
			milestone: input.milestone ?? null,
			taskPlan: input.taskPlan ?? null,
			acceptanceCriteria: (input.acceptanceCriteria ?? []).map(text => ({ text, checked: false })),
			definitionOfDone: (input.definitionOfDone ?? []).map(text => ({ text, checked: false })),
			comments: [],
			notes: null,
			finalSummary: null,
			draft: input.draft ?? false,
			archived: false,
			archivedAt: null,
			milestoneOrder: null,
		};

		const content = serializeTask(task);
		await this.fs.writeEntity("tasks", id, content);
		this.content.set("tasks", id, task);

		if (this.config.git.autoCommit) {
			const filePath = this.fs.filePathFor("tasks", id);
			await this.git.addAndCommit([filePath], `${this.config.git.commitPrefix} create ${id}`);
		}

		return task;
	}

	/**
	 * Resolve a short numeric ID (e.g. "1") to its full prefixed form (e.g. "task-1")
	 * by checking if the raw ID exists, then trying `${prefix}-${id}`.
	 */
	async resolveTaskId(id: string): Promise<string> {
		await this.ensureConfigLoaded();
		if (await this.fs.entityExists("tasks", id)) return id;
		const prefixed = `${this.config.prefixes.task}-${id}`;
		if (await this.fs.entityExists("tasks", prefixed)) return prefixed;
		return id; // let loadTask throw the not-found error
	}

	async loadTask(id: string): Promise<Task> {
		const resolvedId = await this.resolveTaskId(id);
		await this.ensureConfigLoaded();
		const cached = this.content.get("tasks", resolvedId);
		if (cached) return cached;
		const raw = await this.fs.readEntity("tasks", resolvedId);
		const task = parseTask(raw);
		this.content.set("tasks", resolvedId, task);
		return task;
	}

	async updateTask(id: string, input: TaskUpdateInput): Promise<Task> {
		const task = await this.loadTask(id);
		const filtered = Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined));
		const updated: Task = {
			...task,
			...filtered,
			updatedAt: new Date().toISOString(),
		};
		const content = serializeTask(updated);
		await this.fs.writeEntity("tasks", task.id, content);
		this.content.set("tasks", task.id, updated);

		if (this.config.git.autoCommit) {
			const filePath = this.fs.filePathFor("tasks", task.id);
			await this.git.addAndCommit([filePath], `${this.config.git.commitPrefix} update ${task.id}`);
		}

		return updated;
	}

	async listTasks(filter?: TaskListFilter): Promise<Task[]> {
		await this.ensureConfigLoaded();
		const ids = await this.fs.listEntityFiles("tasks");
		const tasks: Task[] = [];
		for (const id of ids) {
			try {
				const task = await this.loadTask(id);
				if (task.archived) continue;
				tasks.push(task);
			} catch {
				// Skip files that fail to parse
			}
		}

		let filtered = tasks;
		if (filter?.status) filtered = filtered.filter(t => t.status === filter.status);
		if (filter?.assignee) filtered = filtered.filter(t => t.assignee === filter.assignee);
		if (filter?.parentTaskId) filtered = filtered.filter(t => t.parentTaskId === filter.parentTaskId);
		if (filter?.labels && filter.labels.length > 0) {
			filtered = filtered.filter(t => filter.labels!.some(l => t.labels.includes(l)));
		}
		if (filter?.limit) filtered = filtered.slice(0, filter.limit);

		return filtered;
	}

	async archiveTask(id: string): Promise<void> {
		const task = await this.loadTask(id);
		const archived: Task = {
			...task,
			archived: true,
			archivedAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		};
		const content = serializeTask(archived);
		await this.fs.writeEntity("tasks", task.id, content);
		await this.fs.archiveEntity("tasks", task.id);
		this.content.delete("tasks", task.id);

		if (this.config.git.autoCommit) {
			const oldPath = this.fs.filePathFor("tasks", task.id);
			const newPath = this.fs.archivePathFor("tasks", task.id);
			await this.git.addAndCommit([oldPath, newPath], `${this.config.git.commitPrefix} archive ${task.id}`);
		}
	}

	// ─── deleteTask (NEW — hard delete + git rm) ──────────────────────────────

	async deleteTask(id: string): Promise<void> {
		await this.ensureConfigLoaded();
		const resolvedId = await this.resolveTaskId(id);
		const exists = await this.fs.entityExists("tasks", resolvedId);
		if (!exists) throw new Error(`Task not found: ${id}`);

		await this.fs.deleteEntity("tasks", resolvedId);
		this.content.delete("tasks", resolvedId);

		if (this.config.git.enabled && (await this.git.isRepo())) {
			const filePath = this.fs.filePathFor("tasks", resolvedId);
			await this.git.rm([filePath]);
			await this.git.commit([filePath], `${this.config.git.commitPrefix} delete ${resolvedId}`);
		}
	}

	// ─── Task edit helpers ───────────────────────────────────────────────────

	async addComment(id: string, author: string, text: string): Promise<Task> {
		const task = await this.loadTask(id);
		const comment = makeComment(author, text);
		return this.updateTask(id, { comments: [...task.comments, comment] } as Partial<Task>);
	}

	// ─── Decisions ───────────────────────────────────────────────────────────

	async createDecision(
		title: string,
		status: string = "proposed",
		context: string = "",
		decision: string = "",
	): Promise<Decision> {
		await this.ensureConfigLoaded();
		const id = await this.sequences.next("decision");
		const now = new Date().toISOString();
		const entity: Decision = {
			id,
			title,
			status,
			context,
			decision,
			consequences: null,
			createdAt: now,
			updatedAt: now,
			tags: [],
		};
		const content = serializeDecision(entity);
		await this.fs.writeEntity("decisions", id, content);
		this.content.set("decisions", id, entity);
		return entity;
	}

	async loadDecision(id: string): Promise<Decision> {
		await this.ensureConfigLoaded();
		const cached = this.content.get("decisions", id);
		if (cached) return cached;
		const raw = await this.fs.readEntity("decisions", id);
		const entity = parseDecision(raw);
		this.content.set("decisions", id, entity);
		return entity;
	}

	// ─── Documents ───────────────────────────────────────────────────────────

	async createDocument(
		title: string,
		type: string = "doc",
		content: string = "",
		tags: string[] = [],
		filePath: string | null = null,
	): Promise<Document> {
		await this.ensureConfigLoaded();
		const id = await this.sequences.next("document");
		const now = new Date().toISOString();
		const entity: Document = {
			id,
			title,
			type,
			tags,
			path: filePath,
			content,
			createdAt: now,
			updatedAt: now,
		};
		const serialized = serializeDocument(entity);
		await this.fs.writeEntity("documents", id, serialized);
		this.content.set("documents", id, entity);
		return entity;
	}

	async loadDocument(id: string): Promise<Document> {
		await this.ensureConfigLoaded();
		const cached = this.content.get("documents", id);
		if (cached) return cached;
		const raw = await this.fs.readEntity("documents", id);
		const entity = parseDocument(raw);
		this.content.set("documents", id, entity);
		return entity;
	}

	async listDocuments(): Promise<Document[]> {
		await this.ensureConfigLoaded();
		const ids = await this.fs.listEntityFiles("documents");
		const docs: Document[] = [];
		for (const id of ids) {
			try {
				docs.push(await this.loadDocument(id));
			} catch {
				// Skip files that fail to parse
			}
		}
		return docs;
	}

	// ─── Milestones ──────────────────────────────────────────────────────────

	async createMilestone(name: string, description: string = ""): Promise<Milestone> {
		await this.ensureConfigLoaded();
		const id = await this.sequences.next("milestone");
		const now = new Date().toISOString();
		const entity: Milestone = {
			id,
			name,
			description,
			status: "active",
			createdAt: now,
			updatedAt: now,
			archived: false,
			archivedAt: null,
		};
		const content = serializeMilestone(entity);
		await this.fs.writeEntity("milestones", id, content);
		this.content.set("milestones", id, entity);
		return entity;
	}

	async loadMilestone(id: string): Promise<Milestone> {
		await this.ensureConfigLoaded();
		const cached = this.content.get("milestones", id);
		if (cached) return cached;
		const raw = await this.fs.readEntity("milestones", id);
		const entity = parseMilestone(raw);
		this.content.set("milestones", id, entity);
		return entity;
	}

	async listMilestones(): Promise<Milestone[]> {
		await this.ensureConfigLoaded();
		const ids = await this.fs.listEntityFiles("milestones");
		const milestones: Milestone[] = [];
		for (const id of ids) {
			try {
				milestones.push(await this.loadMilestone(id));
			} catch {
				// Skip files that fail to parse
			}
		}
		return milestones;
	}
}
