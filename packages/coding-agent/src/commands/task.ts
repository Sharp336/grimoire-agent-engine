/**
 * `omp task` — Task Manager CLI command.
 *
 * Dispatches to subcommands: init, create, list, view, edit, archive, delete,
 * search, draft, promote, demote, milestone, doc, decision, overview, cleanup.
 *
 * Uses omp's `Command`/`Flags`/`Args` from `@oh-my-pi/pi-utils/cli`.
 * For interactive prompts (init wizard), uses `node:readline/promises`.
 */
import { stdin, stdout } from "node:process";
import * as readline from "node:readline/promises";
import { getProjectDir } from "@oh-my-pi/pi-utils";
import { Args, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { ModelRegistry } from "../config/model-registry";
import { Settings, settings } from "../config/settings";
import { discoverAuthStorage, loadCliExtensionProviders } from "../sdk";
import { Core } from "../task-manager/core";
import { serializeTask } from "../task-manager/markdown/serializer";
import { SearchService } from "../task-manager/search";
import { generateAcceptanceCriteria, generateOverview } from "../task-manager/task-mgr-consumers";

const SUBCOMMANDS = [
	"init",
	"create",
	"list",
	"view",
	"edit",
	"archive",
	"delete",
	"search",
	"draft",
	"promote",
	"demote",
	"milestone",
	"doc",
	"decision",
	"overview",
	"cleanup",
] as const;
type Subcommand = (typeof SUBCOMMANDS)[number];
export default class TaskCommand extends Command {
	static description = "Manage markdown-native project tasks";
	static args = {
		subcommand: Args.string({
			description: `Task action (${SUBCOMMANDS.join(", ")})`,
			required: false,
			options: [...SUBCOMMANDS],
		}),
		id: Args.string({ description: "Task ID or name", required: false, multiple: true }),
	};
	static flags = {
		// Init
		defaults: Flags.boolean({ description: "Use defaults (non-interactive)" }),
		"no-git": Flags.boolean({ description: "Skip git setup" }),
		// Create
		desc: Flags.string({ char: "d", description: "Description" }),
		assignee: Flags.string({ char: "a", description: "Assignee" }),
		status: Flags.string({ char: "s", description: "Status" }),
		labels: Flags.string({ char: "l", description: "Comma-separated labels" }),
		priority: Flags.string({ description: "Priority" }),
		plan: Flags.string({ description: "Implementation plan" }),
		ac: Flags.string({ description: "Comma-separated acceptance criteria" }),
		dep: Flags.string({ description: "Comma-separated dependencies" }),
		parent: Flags.string({ description: "Parent task ID" }),
		draft: Flags.boolean({ description: "Create as draft" }),
		ai: Flags.boolean({ description: "Auto-generate AC and plan via taskMgr model (Phase 2)" }),
		// List / search
		plain: Flags.boolean({ description: "Plain text output (no color)" }),
		limit: Flags.integer({ description: "Limit results" }),
		// Edit
		comment: Flags.string({ description: "Add a comment" }),
		"comment-author": Flags.string({ description: "Comment author" }),
		// Search
		search: Flags.string({ description: "Search query for list filter" }),
	};
	async run(): Promise<void> {
		await Settings.init({ cwd: getProjectDir() });
		if (settings.get("tasks.taskManager") !== true) {
			process.stderr.write("Task Manager is disabled. Enable with: omp config set tasks.taskManager true\n");
			process.exitCode = 1;
			return;
		}
		const { args, flags } = await this.parse(TaskCommand);
		const subcommand = args.subcommand as Subcommand | undefined;
		if (!subcommand) {
			this.#printHelp();
			return;
		}
		const idArgs = Array.isArray(args.id) ? args.id : args.id ? [args.id] : [];
		const core = new Core(getProjectDir());
		switch (subcommand) {
			case "init":
				await this.#init(core, idArgs, flags);
				break;
			case "create":
				await this.#create(core, idArgs, flags);
				break;
			case "list":
				await this.#list(core, flags);
				break;
			case "view":
				await this.#view(core, idArgs, flags);
				break;
			case "edit":
				await this.#edit(core, idArgs, flags);
				break;
			case "archive":
				await this.#archive(core, idArgs);
				break;
			case "delete":
				await this.#delete(core, idArgs);
				break;
			case "search":
				await this.#search(core, idArgs, flags);
				break;
			case "draft":
				await this.#createDraft(core, idArgs);
				break;
			case "promote":
				await this.#setDraft(core, idArgs, false);
				break;
			case "demote":
				await this.#setDraft(core, idArgs, true);
				break;
			case "milestone":
				await this.#milestone(core, idArgs, flags);
				break;
			case "doc":
				await this.#doc(core, idArgs, flags);
				break;
			case "decision":
				await this.#decision(core, idArgs, flags);
				break;
			case "overview":
				await this.#overview(core);
				break;
			case "cleanup":
				process.stdout.write("Task cleanup is available in Phase 2.\n");
				break;
		}
	}
	// ─── init ───────────────────────────────────────────────────────────────
	async #init(core: Core, idArgs: string[], flags: Record<string, unknown>): Promise<void> {
		let name = idArgs[0] ?? "";
		if (!flags.defaults && !name) {
			const rl = readline.createInterface({ input: stdin, output: stdout });
			try {
				name = (await rl.question("Project name: ")).trim() || "Project";
			} finally {
				rl.close();
			}
		}
		name = name || "Project";
		const config = await core.initializeProject(name, Boolean(flags.defaults), !flags["no-git"]);
		process.stdout.write(`Initialized Task Manager in ${core.fs.rootDir}/.omp/tasks/\n`);
		process.stdout.write(`Project: ${config.projectName}\n`);
	}
	// ─── create ──────────────────────────────────────────────────────────────
	async #create(core: Core, idArgs: string[], flags: Record<string, unknown>): Promise<void> {
		const title = idArgs.join(" ");
		if (!title) {
			process.stderr.write("Error: title is required\n");
			process.exitCode = 1;
			return;
		}
		const labels = flags.labels
			? String(flags.labels)
					.split(",")
					.map(s => s.trim())
					.filter(Boolean)
			: [];
		const ac = flags.ac
			? String(flags.ac)
					.split(",")
					.map(s => s.trim())
					.filter(Boolean)
			: [];
		const dep = flags.dep
			? String(flags.dep)
					.split(",")
					.map(s => s.trim())
					.filter(Boolean)
			: [];
		let aiAc = ac;
		let aiPlan = flags.plan as string | null;
		if (flags.ai) {
			const authStorage = await discoverAuthStorage();
			const modelRegistry = new ModelRegistry(authStorage);
			await loadCliExtensionProviders(modelRegistry, settings, getProjectDir());
			const generated = await generateAcceptanceCriteria(core, modelRegistry, settings, title, flags.desc as string);
			if (generated) {
				if (generated.acceptanceCriteria.length > 0) aiAc = generated.acceptanceCriteria;
				if (generated.taskPlan) aiPlan = generated.taskPlan;
			}
			authStorage.close();
		}
		const task = await core.createTask({
			title,
			description: flags.desc as string | undefined,
			status: flags.status as string | undefined,
			assignee: flags.assignee as string | null,
			labels,
			priority: flags.priority as string | null,
			parentTaskId: flags.parent as string | null,
			dependencies: dep,
			acceptanceCriteria: aiAc,
			taskPlan: aiPlan,
			draft: Boolean(flags.draft),
		});
		process.stdout.write(`Created task ${task.id}: ${task.title}\n`);
		if (!flags.plain) {
			process.stdout.write(`  Status: ${task.status}\n`);
			if (task.assignee) process.stdout.write(`  Assignee: ${task.assignee}\n`);
			if (task.labels.length > 0) process.stdout.write(`  Labels: ${task.labels.join(", ")}\n`);
		}
	}
	// ─── list ───────────────────────────────────────────────────────────────
	async #list(core: Core, flags: Record<string, unknown>): Promise<void> {
		const tasks = await core.listTasks({
			status: flags.status as string | null,
			assignee: flags.assignee as string | null,
			parentTaskId: flags.parent as string | null,
			limit: flags.limit as number | null,
		});
		if (tasks.length === 0) {
			process.stdout.write("No tasks found.\n");
			return;
		}
		if (flags.plain) {
			for (const task of tasks) {
				process.stdout.write(`${task.id}\t${task.status}\t${task.title}\n`);
			}
			return;
		}
		for (const task of tasks) {
			const draftTag = task.draft ? " [draft]" : "";
			process.stdout.write(`${task.id}  [${task.status}]  ${task.title}${draftTag}\n`);
			if (task.assignee) process.stdout.write(`    assignee: ${task.assignee}\n`);
			if (task.labels.length > 0) process.stdout.write(`    labels: ${task.labels.join(", ")}\n`);
		}
	}
	// ─── view ───────────────────────────────────────────────────────────────
	async #view(core: Core, idArgs: string[], flags: Record<string, unknown>): Promise<void> {
		const id = idArgs[0];
		if (!id) {
			process.stderr.write("Error: task ID required\n");
			process.exitCode = 1;
			return;
		}
		const task = await core.loadTask(id);
		const content = serializeTask(task);
		if (flags.plain) {
			process.stdout.write(`${content}\n`);
			return;
		}
		process.stdout.write(`\n${task.id}: ${task.title}\n`);
		process.stdout.write(`${"─".repeat(Math.max(task.id.length + task.title.length + 2, 40))}\n`);
		process.stdout.write(`Status:     ${task.status}\n`);
		if (task.assignee) process.stdout.write(`Assignee:   ${task.assignee}\n`);
		if (task.priority) process.stdout.write(`Priority:   ${task.priority}\n`);
		if (task.labels.length > 0) process.stdout.write(`Labels:     ${task.labels.join(", ")}\n`);
		if (task.milestone) process.stdout.write(`Milestone:  ${task.milestone}\n`);
		if (task.parentTaskId) process.stdout.write(`Parent:     ${task.parentTaskId}\n`);
		if (task.dependencies.length > 0) process.stdout.write(`Depends on: ${task.dependencies.join(", ")}\n`);
		if (task.description) process.stdout.write(`\n${task.description}\n`);
		if (task.acceptanceCriteria.length > 0) {
			process.stdout.write(`\nAcceptance Criteria:\n`);
			for (const ac of task.acceptanceCriteria) {
				process.stdout.write(`  [${ac.checked ? "x" : " "}] ${ac.text}\n`);
			}
		}
		if (task.notes) process.stdout.write(`\nNotes:\n${task.notes}\n`);
		if (task.comments.length > 0) {
			process.stdout.write(`\nComments:\n`);
			for (const c of task.comments) {
				process.stdout.write(`  ${c.author} (${c.createdDate}): ${c.text}\n`);
			}
		}
	}
	// ─── edit ───────────────────────────────────────────────────────────────
	async #edit(core: Core, idArgs: string[], flags: Record<string, unknown>): Promise<void> {
		const id = idArgs[0];
		if (!id) {
			process.stderr.write("Error: task ID required\n");
			process.exitCode = 1;
			return;
		}
		const labels = flags.labels
			? String(flags.labels)
					.split(",")
					.map(s => s.trim())
					.filter(Boolean)
			: undefined;
		if (flags.comment) {
			const author = (flags["comment-author"] as string) ?? "unknown";
			await core.addComment(id, author, flags.comment as string);
			process.stdout.write(`Added comment to ${id}\n`);
			return;
		}
		const update: Record<string, unknown> = {};
		if (flags.desc !== undefined) update.description = flags.desc;
		if (flags.status !== undefined) update.status = flags.status;
		if (flags.assignee !== undefined) update.assignee = flags.assignee;
		if (labels !== undefined) update.labels = labels;
		if (flags.priority !== undefined) update.priority = flags.priority;
		if (flags.milestone !== undefined) update.milestone = flags.milestone;
		if (flags.plan !== undefined) update.taskPlan = flags.plan;
		if (flags.notes !== undefined) update.notes = flags.notes;
		if (flags["final-summary"] !== undefined) update.finalSummary = flags["final-summary"];
		await core.updateTask(id, update);
		process.stdout.write(`Updated task ${id}\n`);
	}
	// ─── archive ────────────────────────────────────────────────────────────
	async #archive(core: Core, idArgs: string[]): Promise<void> {
		const id = idArgs[0];
		if (!id) {
			process.stderr.write("Error: task ID required\n");
			process.exitCode = 1;
			return;
		}
		await core.archiveTask(id);
		process.stdout.write(`Archived task ${id}\n`);
	}
	// ─── delete ─────────────────────────────────────────────────────────────
	async #delete(core: Core, idArgs: string[]): Promise<void> {
		const id = idArgs[0];
		if (!id) {
			process.stderr.write("Error: task ID required\n");
			process.exitCode = 1;
			return;
		}
		await core.deleteTask(id);
		process.stdout.write(`Deleted task ${id}\n`);
	}
	// ─── search ─────────────────────────────────────────────────────────────
	async #search(core: Core, idArgs: string[], flags: Record<string, unknown>): Promise<void> {
		const query = idArgs.join(" ");
		if (!query) {
			process.stderr.write("Error: search query required\n");
			process.exitCode = 1;
			return;
		}
		const search = new SearchService(core);
		const results = await search.search(query, {
			filters: { status: flags.status as string | null, priority: flags.priority as string | null },
			limit: flags.limit as number | null,
		});
		if (results.length === 0) {
			process.stdout.write("No matches found.\n");
			return;
		}
		for (const result of results) {
			if (flags.plain) {
				process.stdout.write(`${result.id}\t${result.type}\t${result.status}\t${result.title}\n`);
			} else {
				process.stdout.write(`${result.id}  [${result.type}]  ${result.title}  (${result.status})\n`);
			}
		}
	}
	// ─── draft / promote / demote ───────────────────────────────────────────
	async #setDraft(core: Core, idArgs: string[], draft: boolean): Promise<void> {
		const id = idArgs[0];
		if (!id) {
			process.stderr.write("Error: task ID required\n");
			process.exitCode = 1;
			return;
		}
		await core.updateTask(id, { draft } as never);
		process.stdout.write(`${draft ? "Marked" : "Promoted"} task ${id}\n`);
	}
	async #createDraft(core: Core, idArgs: string[]): Promise<void> {
		const title = idArgs.join(" ");
		if (!title) {
			process.stderr.write("Error: title is required\n");
			process.exitCode = 1;
			return;
		}
		const task = await core.createTask({ title, draft: true });
		process.stdout.write(`Created draft ${task.id}: ${task.title}\n`);
	}

	// ─── milestone / doc / decision (Phase 2 stubs) ─────────────────────────
	async #milestone(core: Core, idArgs: string[], flags: Record<string, unknown>): Promise<void> {
		const action = idArgs[0];
		if (action === "list") {
			const milestones = await core.listMilestones();
			if (milestones.length === 0) {
				process.stdout.write("No milestones found.\n");
				return;
			}
			for (const m of milestones) {
				process.stdout.write(`${m.id}  [${m.status}]  ${m.name}\n`);
				if (m.description) process.stdout.write(`    ${m.description}\n`);
			}
			return;
		}
		if (action === "add") {
			const name = idArgs.slice(1).join(" ");
			if (!name) {
				process.stderr.write("Error: milestone name required\n");
				process.exitCode = 1;
				return;
			}
			const desc = (flags.description as string) ?? "";
			const m = await core.createMilestone(name, desc);
			process.stdout.write(`Created milestone ${m.id}: ${m.name}\n`);
			return;
		}
		process.stdout.write("Milestone rename/remove/archive available in Phase 2.\n");
	}
	async #doc(core: Core, idArgs: string[], flags: Record<string, unknown>): Promise<void> {
		const action = idArgs[0];
		if (action === "list") {
			const docs = await core.listDocuments();
			if (docs.length === 0) {
				process.stdout.write("No documents found.\n");
				return;
			}
			for (const doc of docs) {
				process.stdout.write(`${doc.id}  [${doc.type}]  ${doc.title}\n`);
			}
			return;
		}
		if (action === "create") {
			const title = idArgs.slice(1).join(" ");
			if (!title) {
				process.stderr.write("Error: document title required\n");
				process.exitCode = 1;
				return;
			}
			const type = (flags.type as string) ?? "doc";
			const tags = flags.tags
				? String(flags.tags)
						.split(",")
						.map(s => s.trim())
						.filter(Boolean)
				: [];
			const doc = await core.createDocument(title, type, "", tags);
			process.stdout.write(`Created document ${doc.id}: ${doc.title}\n`);
			return;
		}
		process.stdout.write("Document view/search/update available in Phase 2.\n");
	}
	async #decision(core: Core, idArgs: string[], flags: Record<string, unknown>): Promise<void> {
		const title = idArgs.join(" ");
		if (!title) {
			process.stderr.write("Error: decision title required\n");
			process.exitCode = 1;
			return;
		}
		const status = (flags.status as string) ?? "proposed";
		const decision = await core.createDecision(title, status);
		process.stdout.write(`Created decision ${decision.id}: ${decision.title}\n`);
	}
	// ─── overview ───────────────────────────────────────────────────────────
	async #overview(core: Core): Promise<void> {
		const authStorage = await discoverAuthStorage();
		const modelRegistry = new ModelRegistry(authStorage);
		await loadCliExtensionProviders(modelRegistry, settings, getProjectDir());
		try {
			const overview = await generateOverview(core, modelRegistry, settings);
			process.stdout.write(`${overview}\n`);
		} finally {
			authStorage.close();
		}
	}
	// ─── help ────────────────────────────────────────────────────────────────
	#printHelp(): void {
		process.stdout.write(`omp task — Task Manager
USAGE
  omp task <subcommand> [args] [flags]
SUBCOMMANDS
  init [name]              Initialize Task Manager in the current project
  create [title]           Create a new task
  list                     List tasks
  view [id]                View a task
  edit [id]                Edit a task
  archive [id]             Archive a task
  delete [id]              Delete a task (hard delete + git rm)
  search [query]           Search tasks, docs, and decisions
  draft [title]            Create a draft task
  promote [id]             Promote a draft to a real task
  demote [id]              Demote a task to a draft
  milestone <action>       Manage milestones (list, add)
  doc <action>             Manage documents (list, create)
  decision create [title]  Create a decision record
  overview                 AI-assisted project overview (Phase 2)
  cleanup                  Clean up stale data (Phase 2)
FLAGS
  --defaults               Use defaults for init (non-interactive)
  -d, --desc <text>        Description
  -a, --assignee <name>    Assignee
  -s, --status <status>    Status
  -l, --labels <csv>       Comma-separated labels
  --priority <p>           Priority
  --plan <text>            Implementation plan
  --ac <csv>               Comma-separated acceptance criteria
  --dep <csv>              Comma-separated dependencies
  --parent <id>            Parent task ID
  --draft                  Create as draft
  --plain                  Plain text output
  --limit <n>              Limit results
  --comment <text>         Add a comment (edit)
  --comment-author <name>  Comment author (edit)
Enable with: omp config set tasks.taskManager true
`);
	}
}
