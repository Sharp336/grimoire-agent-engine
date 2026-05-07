/**
 * Manage scheduled cron tasks.
 */
import { Args, Command, Flags, renderCommandHelp } from "@oh-my-pi/pi-utils/cli";
import { initTheme } from "../modes/theme/theme";
import { SchedulerDbStorage } from "../scheduler/storage";
import {
	formatExecutionRow,
	formatTaskRow,
	getNextRun,
	getSchedulerDbPath,
	type ScheduleAction,
	validateCron,
} from "../scheduler/types";

const ACTIONS: ScheduleAction[] = ["add", "list", "remove", "run", "enable", "disable", "logs"];

export default class Schedule extends Command {
	static description = "Manage scheduled cron tasks";

	static args = {
		action: Args.string({
			description: "Schedule action",
			required: false,
			options: ACTIONS,
		}),
		name: Args.string({
			description: "Task name",
			required: false,
		}),
		cron: Args.string({
			description: "Cron expression (for add)",
			required: false,
		}),
		command: Args.string({
			description: "Command to run (for add)",
			required: false,
			multiple: true,
		}),
	};

	static flags = {
		description: Flags.string({ description: "Task description" }),
		json: Flags.boolean({ description: "Output JSON" }),
	};

	static examples = [
		"# Add a new scheduled task\n  omp schedule add backup '0 2 * * *' omp --print 'backup script'",
		"# List all tasks\n  omp schedule list",
		"# Remove a task\n  omp schedule remove backup",
		"# Run a task immediately\n  omp schedule run backup",
		"# Enable/disable a task\n  omp schedule enable backup",
		"# View recent logs\n  omp schedule logs backup",
	];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Schedule);
		if (!args.action) {
			renderCommandHelp("omp", "schedule", Schedule);
			return;
		}

		await initTheme();

		const storage = new SchedulerDbStorage(getSchedulerDbPath());
		try {
			switch (args.action as ScheduleAction) {
				case "add":
					await this.#handleAdd(args, flags, storage);
					break;
				case "list":
					await this.#handleList(args, flags, storage);
					break;
				case "remove":
					await this.#handleRemove(args, flags, storage);
					break;
				case "run":
					await this.#handleRun(args, flags, storage);
					break;
				case "enable":
					await this.#handleEnable(args, flags, storage);
					break;
				case "disable":
					await this.#handleDisable(args, flags, storage);
					break;
				case "logs":
					await this.#handleLogs(args, flags, storage);
					break;
			}
		} finally {
			storage.close();
		}
	}

	async #handleAdd(
		args: Record<string, unknown>,
		flags: Record<string, unknown>,
		storage: SchedulerDbStorage,
	): Promise<void> {
		const name = args.name as string | undefined;
		const cron = args.cron as string | undefined;
		const commandParts = args.command as string[] | undefined;

		if (!name || !cron || !commandParts || commandParts.length === 0) {
			process.stderr.write("Usage: omp schedule add <name> <cron> <command...>\n");
			process.exitCode = 1;
			return;
		}

		const validation = validateCron(cron);
		if (!validation.valid) {
			process.stderr.write(`Invalid cron expression: ${validation.error}\n`);
			process.exitCode = 1;
			return;
		}

		const existing = storage.getTaskByName(name);
		if (existing) {
			process.stderr.write(`Task "${name}" already exists.\n`);
			process.exitCode = 1;
			return;
		}

		const command = commandParts.join(" ");
		const nextRun = getNextRun(cron);
		const task = storage.addTask({
			name,
			description: (flags.description as string | undefined) ?? undefined,
			cron,
			command,
			status: "active",
			createdAt: Date.now(),
			updatedAt: Date.now(),
			nextRunAt: nextRun ? nextRun.getTime() : undefined,
			runCount: 0,
			failCount: 0,
		});

		process.stdout.write(`Task "${task.name}" added successfully.\n`);
		process.stdout.write(`Next run: ${nextRun ? nextRun.toLocaleString() : "—"}\n`);
	}

	async #handleList(
		_args: Record<string, unknown>,
		flags: Record<string, unknown>,
		storage: SchedulerDbStorage,
	): Promise<void> {
		const tasks = storage.listTasks();

		if (flags.json) {
			process.stdout.write(`${JSON.stringify(tasks, null, 2)}\n`);
			return;
		}

		if (tasks.length === 0) {
			process.stdout.write("No scheduled tasks.\n");
			return;
		}

		process.stdout.write(`NAME                 STATUS     CRON                 NEXT RUN             LAST RUN\n`);
		process.stdout.write(`${"─".repeat(90)}\n`);
		for (const task of tasks) {
			process.stdout.write(`${formatTaskRow(task)}\n`);
		}
	}

	async #handleRemove(
		args: Record<string, unknown>,
		_flags: Record<string, unknown>,
		storage: SchedulerDbStorage,
	): Promise<void> {
		const name = args.name as string | undefined;
		if (!name) {
			process.stderr.write("Usage: omp schedule remove <name>\n");
			process.exitCode = 1;
			return;
		}

		const task = storage.getTaskByName(name);
		if (!task) {
			process.stderr.write(`Task "${name}" not found.\n`);
			process.exitCode = 1;
			return;
		}

		storage.deleteTask(task.id);
		process.stdout.write(`Task "${name}" removed successfully.\n`);
	}

	async #handleRun(
		args: Record<string, unknown>,
		_flags: Record<string, unknown>,
		storage: SchedulerDbStorage,
	): Promise<void> {
		const name = args.name as string | undefined;
		if (!name) {
			process.stderr.write("Usage: omp schedule run <name>\n");
			process.exitCode = 1;
			return;
		}

		const task = storage.getTaskByName(name);
		if (!task) {
			process.stderr.write(`Task "${name}" not found.\n`);
			process.exitCode = 1;
			return;
		}

		const exec = storage.recordExecution({
			taskId: task.id,
			startedAt: Date.now(),
			status: "running",
		});

		try {
			const proc = Bun.spawn(["sh", "-c", task.command], {
				stdout: "pipe",
				stderr: "pipe",
			});
			const [stdout, stderr] = await Promise.all([
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
			]);
			const exitCode = proc.exitCode ?? 1;

			storage.updateExecution(exec.id, {
				endedAt: Date.now(),
				exitCode,
				output: stdout,
				stderr,
				status: exitCode === 0 ? "success" : "failure",
			});

			storage.updateTask(task.id, {
				lastRunAt: Date.now(),
				runCount: task.runCount + 1,
				failCount: exitCode === 0 ? task.failCount : task.failCount + 1,
				updatedAt: Date.now(),
			});

			if (exitCode !== 0) {
				process.stderr.write(`Task "${name}" failed with exit code ${exitCode}.\n`);
				process.exitCode = exitCode;
				return;
			}

			process.stdout.write(`Task "${name}" completed successfully.\n`);
		} catch (err) {
			storage.updateExecution(exec.id, {
				endedAt: Date.now(),
				exitCode: 1,
				stderr: err instanceof Error ? err.message : String(err),
				status: "failure",
			});
			storage.updateTask(task.id, {
				lastRunAt: Date.now(),
				failCount: task.failCount + 1,
				updatedAt: Date.now(),
			});
			process.stderr.write(`Task "${name}" failed: ${err instanceof Error ? err.message : String(err)}\n`);
			process.exitCode = 1;
		}
	}

	async #handleEnable(
		args: Record<string, unknown>,
		_flags: Record<string, unknown>,
		storage: SchedulerDbStorage,
	): Promise<void> {
		const name = args.name as string | undefined;
		if (!name) {
			process.stderr.write("Usage: omp schedule enable <name>\n");
			process.exitCode = 1;
			return;
		}

		const task = storage.getTaskByName(name);
		if (!task) {
			process.stderr.write(`Task "${name}" not found.\n`);
			process.exitCode = 1;
			return;
		}

		const nextRun = getNextRun(task.cron);
		storage.updateTask(task.id, {
			status: "active",
			nextRunAt: nextRun ? nextRun.getTime() : undefined,
			updatedAt: Date.now(),
		});
		process.stdout.write(`Task "${name}" enabled.\n`);
	}

	async #handleDisable(
		args: Record<string, unknown>,
		_flags: Record<string, unknown>,
		storage: SchedulerDbStorage,
	): Promise<void> {
		const name = args.name as string | undefined;
		if (!name) {
			process.stderr.write("Usage: omp schedule disable <name>\n");
			process.exitCode = 1;
			return;
		}

		const task = storage.getTaskByName(name);
		if (!task) {
			process.stderr.write(`Task "${name}" not found.\n`);
			process.exitCode = 1;
			return;
		}

		storage.updateTask(task.id, {
			status: "disabled",
			nextRunAt: undefined,
			updatedAt: Date.now(),
		});
		process.stdout.write(`Task "${name}" disabled.\n`);
	}

	async #handleLogs(
		args: Record<string, unknown>,
		flags: Record<string, unknown>,
		storage: SchedulerDbStorage,
	): Promise<void> {
		const name = args.name as string | undefined;
		if (!name) {
			process.stderr.write("Usage: omp schedule logs <name>\n");
			process.exitCode = 1;
			return;
		}

		const task = storage.getTaskByName(name);
		if (!task) {
			process.stderr.write(`Task "${name}" not found.\n`);
			process.exitCode = 1;
			return;
		}

		const executions = storage.getExecutions(task.id, 20);

		if (flags.json) {
			process.stdout.write(`${JSON.stringify(executions, null, 2)}\n`);
			return;
		}

		if (executions.length === 0) {
			process.stdout.write(`No executions found for task "${name}".\n`);
			return;
		}

		process.stdout.write(`ID                 STATUS   DURATION EXIT\n`);
		process.stdout.write(`${"─".repeat(50)}\n`);
		for (const exec of executions) {
			process.stdout.write(`${formatExecutionRow(exec)}\n`);
		}
	}
}
