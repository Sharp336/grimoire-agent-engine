/**
 * `omp board` — Task Manager kanban board.
 *
 * Renders a kanban table to stdout using `Bun.stringWidth` for column
 * alignment. Non-interactive table — an interactive TUI board is a later
 * enhancement using `@oh-my-pi/pi-tui`.
 */

import * as path from "node:path";
import { getProjectDir } from "@oh-my-pi/pi-utils";
import { Args, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { Settings, settings } from "../config/settings";
import { generateKanbanBoardWithMetadata, renderKanbanTable } from "../task-manager/board";
import { Core } from "../task-manager/core";

export default class BoardCommand extends Command {
	static description = "View Task Manager kanban board";

	static args = {
		action: Args.string({ description: "Board action (view, export)", required: false }),
		file: Args.string({ description: "Export file path", required: false }),
	};

	static flags = {
		force: Flags.boolean({ description: "Overwrite existing export file" }),
		readme: Flags.boolean({ description: "Include README header in export" }),
		"export-version": Flags.string({ description: "Export format version" }),
	};

	async run(): Promise<void> {
		await Settings.init({ cwd: getProjectDir() });
		if (settings.get("tasks.taskManager") !== true) {
			process.stderr.write("Task Manager is disabled. Enable with: omp config set tasks.taskManager true\n");
			process.exitCode = 1;
			return;
		}

		const { args, flags } = await this.parse(BoardCommand);
		const action = args.action ?? "view";

		const core = new Core(getProjectDir());
		await core.ensureConfigLoaded();
		const tasks = await core.listTasks();

		if (action === "export") {
			const filePath = args.file;
			if (!filePath) {
				process.stderr.write("Error: export file path required\n");
				process.exitCode = 1;
				return;
			}
			const metadata = generateKanbanBoardWithMetadata(tasks, core.config.statuses);
			const header = flags.readme
				? `# Task Manager — powered by Oh My Pi\n\nGenerated: ${metadata.generatedAt}\nTotal tasks: ${metadata.totalTasks}\n\n`
				: `Task Manager — powered by Oh My Pi\n\nGenerated: ${metadata.generatedAt}\nTotal tasks: ${metadata.totalTasks}\n\n`;

			const table = renderKanbanTable({ columns: metadata.columns, totalTasks: metadata.totalTasks });
			const content = `${header}${table}\n`;

			const fullPath = path.resolve(filePath);
			if (!flags.force && (await Bun.file(fullPath).exists())) {
				process.stderr.write(`Error: ${fullPath} already exists. Use --force to overwrite.\n`);
				process.exitCode = 1;
				return;
			}
			await Bun.write(fullPath, content);
			process.stdout.write(`Exported board to ${fullPath}\n`);
			return;
		}

		// Default: view
		if (tasks.length === 0) {
			process.stdout.write("No tasks found. Create some with `omp task create`.\n");
			return;
		}

		const board = generateKanbanBoardWithMetadata(tasks, core.config.statuses);
		process.stdout.write(`\nTask Manager — Kanban Board (${board.totalTasks} tasks)\n\n`);
		process.stdout.write(`${renderKanbanTable({ columns: board.columns, totalTasks: board.totalTasks })}\n`);
	}
}
