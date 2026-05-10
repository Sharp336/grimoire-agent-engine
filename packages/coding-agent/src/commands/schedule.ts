/**
 * Manage scheduled cron tasks.
 */
import { Args, Command, Flags, renderCommandHelp } from "@oh-my-pi/pi-utils/cli";
import { initTheme } from "../modes/theme/theme";
import { executeScheduledCommand } from "../scheduler/executor";
import { SchedulerDbStorage } from "../scheduler/storage";
import {
	formatExecutionRow,
	formatTaskRow,
	getNextRun,
	getSchedulerDbPath,
	getSchedulerPidPath,
	isDaemonRunning,
	parseSchedule,
	type ScheduleAction,
} from "../scheduler/types";

const ACTIONS: ScheduleAction[] = ["add", "diagnose", "list", "remove", "run", "enable", "disable", "logs"];

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
		type: Flags.string({ description: "Task type: shell (default) or agent", options: ["shell", "agent"] }),
		timeout: Flags.integer({ description: "Timeout in milliseconds (default: 30000)" }),
		json: Flags.boolean({ description: "Output JSON" }),
	};

	static examples = [
		"# Add a new scheduled task\n  omp schedule add backup '0 2 * * *' bun run scripts/backup.ts",
		"# Add an interval task\n  omp schedule add health '5m' --type shell 'curl http://localhost/health'",
		"# Add a one-shot reminder\n  omp schedule add remind '+30m' --type agent 'review the PRs'",
		"# List all tasks\n  omp schedule list",
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
				case "diagnose":
					await this.#handleDiagnose(args, flags, storage);
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
			process.stderr.write("Usage: omp schedule add <name> <schedule> <command...>\n");
			process.stderr.write("  Schedule: cron expr, interval (5m, 1h), or one-shot (+30m, ISO timestamp)\n");
			process.exitCode = 1;
			return;
		}

		const parsed = parseSchedule(cron);
		if (parsed.error) {
			process.stderr.write(`Invalid schedule: ${parsed.error}\n`);
			process.exitCode = 1;
			return;
		}

		if (process.env._OMP_SCHEDULE_EXECUTING) {
			process.stderr.write("Cannot create schedules from within a scheduled task execution.\n");
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
		const nextRun =
			parsed.type === "cron"
				? getNextRun(parsed.schedule)
				: parsed.nextRunAt
					? new Date(parsed.nextRunAt)
					: undefined;
		const task = storage.addTask({
			name,
			description: (flags.description as string | undefined) ?? undefined,
			cron: parsed.schedule,
			command,
			scheduleType: parsed.type,
			taskType: (flags.type as "shell" | "agent" | undefined) ?? "shell",
			timeoutMs:
				(flags.timeout as number | undefined) ??
				((flags.type as string | undefined) === "agent" ? 120_000 : 30_000),
			status: "active",
			createdAt: Date.now(),
			updatedAt: Date.now(),
			nextRunAt: nextRun ? nextRun.getTime() : parsed.nextRunAt,
			runCount: 0,
			failCount: 0,
		});

		process.stdout.write(`Task "${task.name}" added successfully.\n`);
		process.stdout.write(
			`Type: ${parsed.type} | Next run: ${nextRun ? nextRun.toLocaleString() : parsed.nextRunAt ? new Date(parsed.nextRunAt).toLocaleString() : "—"}\n`,
		);
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

		process.stdout.write(
			`NAME                 TYPE    STATUS     CRON                 NEXT RUN             LAST RUN\n`,
		);
		process.stdout.write(`${"─".repeat(96)}\n`);
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
			process.env._OMP_SCHEDULE_EXECUTING = "1";
			const { exitCode, output, stderr, timedOut } = await executeScheduledCommand(task.command, {
				taskType: task.taskType,
				timeoutMs: task.timeoutMs,
			});
			delete process.env._OMP_SCHEDULE_EXECUTING;

			storage.updateExecution(exec.id, {
				endedAt: Date.now(),
				exitCode,
				output: timedOut ? `[TIMED OUT after ${task.timeoutMs ?? 30_000}ms]\n${output}` : output,
				stderr: timedOut ? `[TIMED OUT]\n${stderr}` : stderr,
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
			delete process.env._OMP_SCHEDULE_EXECUTING;
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

		const parsed = parseSchedule(task.cron);
		let nextRunAt: number | undefined;
		if (parsed.type === "cron") {
			const next = getNextRun(task.cron);
			nextRunAt = next ? next.getTime() : undefined;
		} else if (parsed.type === "interval" && parsed.intervalMs) {
			nextRunAt = Date.now() + parsed.intervalMs;
		} else {
			nextRunAt = task.nextRunAt;
		}
		storage.updateTask(task.id, {
			status: "active",
			nextRunAt,
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

	async #handleDiagnose(
		_args: Record<string, unknown>,
		flags: Record<string, unknown>,
		storage: SchedulerDbStorage,
	): Promise<void> {
		const tasks = storage.listTasks();
		const total = tasks.length;
		const active = tasks.filter(t => t.status === "active").length;
		const paused = tasks.filter(t => t.status === "paused").length;
		const disabled = tasks.filter(t => t.status === "disabled").length;

		const pidPath = getSchedulerPidPath();
		const daemonRunning = isDaemonRunning(pidPath);

		// Check for stale running executions (> 5 minutes without end)
		const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;
		let staleExecutions = 0;
		for (const task of tasks) {
			const execs = storage.getExecutions(task.id, 3);
			for (const exec of execs) {
				if (exec.status === "running" && exec.startedAt < fiveMinutesAgo) {
					staleExecutions++;
				}
			}
		}

		// Count recent failures (last 24h)
		const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
		let recentFailures = 0;
		let recentSuccesses = 0;
		for (const task of tasks) {
			const execs = storage.getExecutions(task.id, 10);
			for (const exec of execs) {
				if (exec.startedAt >= oneDayAgo) {
					if (exec.status === "failure") recentFailures++;
					if (exec.status === "success") recentSuccesses++;
				}
			}
		}

		const lines: string[] = [];
		lines.push("## Scheduler Diagnosis");
		lines.push("");
		lines.push(`Daemon: ${daemonRunning ? "running" : "stopped"}`);
		lines.push(`Tasks: ${total} total (${active} active, ${paused} paused, ${disabled} disabled)`);
		lines.push(`Recent executions (24h): ${recentSuccesses} success, ${recentFailures} failure`);
		if (staleExecutions > 0) {
			lines.push(`⚠ Stale executions: ${staleExecutions} stuck in "running" for > 5 min`);
		}
		lines.push("");

		// Per-task health check
		for (const task of tasks) {
			const execs = storage.getExecutions(task.id, 5);
			const failCount = execs.filter(e => e.status === "failure").length;
			const timeoutCount = execs.filter(
				e => e.status === "failure" && (e.output?.includes("[TIMED OUT]") || e.stderr?.includes("[TIMED OUT]")),
			).length;
			const stuck = execs.some(e => e.status === "running" && e.startedAt < fiveMinutesAgo);

			if (failCount > 0 || stuck) {
				lines.push(`Task "${task.name}":`);
				if (stuck)
					lines.push(
						`  - Stuck execution (started ${new Date(execs.find(e => e.status === "running")!.startedAt).toLocaleString()})`,
					);
				if (timeoutCount > 0) lines.push(`  - ${timeoutCount} timeout(s) in last ${execs.length} runs`);
				if (failCount > timeoutCount) lines.push(`  - ${failCount - timeoutCount} non-timeout failure(s)`);
				lines.push("");
			}
		}

		if (flags.json) {
			process.stdout.write(
				`${JSON.stringify(
					{
						daemonRunning,
						taskCounts: { total, active, paused, disabled },
						recentExecutions: { success: recentSuccesses, failure: recentFailures },
						staleExecutions,
					},
					null,
					2,
				)}\n`,
			);
			return;
		}

		process.stdout.write(lines.join("\n").trimEnd() + "\n");
	}
}
