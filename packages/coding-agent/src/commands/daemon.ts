/**
 * Manage the scheduler daemon.
 */
import { Args, Command, Flags, renderCommandHelp } from "@oh-my-pi/pi-utils/cli";
import { initTheme } from "../modes/theme/theme";
import { SchedulerDbStorage } from "../scheduler/storage";
import {
	clearDaemonPid,
	getSchedulerDbPath,
	getSchedulerLogPath,
	getSchedulerPidPath,
	isDaemonRunning,
	readDaemonPid,
	stopDaemon,
	waitForDaemonStart,
	waitForDaemonStop,
	writeDaemonPid,
} from "../scheduler/types";

const ACTIONS: string[] = ["start", "stop", "status", "restart"];

export default class Daemon extends Command {
	static description = "Manage the scheduler daemon";

	static args = {
		action: Args.string({
			description: "Daemon action",
			required: false,
			options: ACTIONS,
		}),
	};

	static flags = {
		foreground: Flags.boolean({ description: "Run in foreground" }),
		verbose: Flags.boolean({ description: "Verbose output" }),
	};

	static examples = [
		"# Start daemon in background\n  omp daemon start",
		"# Start daemon in foreground\n  omp daemon start --foreground",
		"# Stop daemon\n  omp daemon stop",
		"# Check daemon status\n  omp daemon status",
		"# Restart daemon\n  omp daemon restart",
	];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Daemon);
		if (!args.action) {
			renderCommandHelp("omp", "daemon", Daemon);
			return;
		}

		await initTheme();

		switch (args.action) {
			case "start":
				await this.#handleStart(flags);
				break;
			case "stop":
				await this.#handleStop();
				break;
			case "status":
				await this.#handleStatus(flags);
				break;
			case "restart":
				await this.#handleRestart(flags);
				break;
			default:
				process.stderr.write(`Unknown action: ${args.action}\n`);
				process.exitCode = 1;
		}
	}

	async #handleStart(flags: Record<string, unknown>): Promise<void> {
		const pidPath = getSchedulerPidPath();

		if (isDaemonRunning(pidPath)) {
			const pid = readDaemonPid(pidPath);
			process.stderr.write(`Daemon is already running (PID ${pid}).\n`);
			process.exitCode = 1;
			return;
		}

		if (flags.foreground) {
			await runDaemonLoop();
			return;
		}

		// Background mode: spawn detached process
		const logPath = getSchedulerLogPath();
		const ompBinary = process.argv[1] ?? "omp";

		const fs = await import("node:fs");
		const { spawn } = await import("node:child_process");

		const logDir = logPath.substring(0, logPath.lastIndexOf("/"));
		if (!fs.existsSync(logDir)) {
			fs.mkdirSync(logDir, { recursive: true });
		}

		const out = fs.openSync(logPath, "a");
		const err = fs.openSync(logPath, "a");

		const child = spawn(process.execPath, [ompBinary, "daemon", "start", "--foreground"], {
			detached: true,
			stdio: ["ignore", out, err],
		});

		child.unref();
		fs.closeSync(out);
		fs.closeSync(err);

		// Child process writes its own PID; wait and confirm
		const started = await waitForDaemonStart(pidPath, 5000);
		if (started) {
			const pid = readDaemonPid(pidPath);
			process.stdout.write(`Daemon started (PID ${pid}).\n`);
		} else {
			process.stderr.write(`Daemon failed to start. Check logs at ${logPath}\n`);
			process.exitCode = 1;
		}
	}

	async #handleStop(): Promise<void> {
		const pidPath = getSchedulerPidPath();
		const pid = readDaemonPid(pidPath);

		if (!pid || !isDaemonRunning(pidPath)) {
			process.stderr.write("Daemon is not running.\n");
			process.exitCode = 1;
			return;
		}

		if (stopDaemon(pid)) {
			process.stdout.write(`Stopping daemon (PID ${pid})...\n`);
			const stopped = await waitForDaemonStop(pidPath, 10000);
			if (stopped) {
				process.stdout.write("Daemon stopped.\n");
			} else {
				process.stderr.write("Daemon did not stop gracefully.\n");
				process.exitCode = 1;
			}
		} else {
			process.stderr.write("Failed to send stop signal to daemon.\n");
			process.exitCode = 1;
		}
	}

	async #handleStatus(flags: Record<string, unknown>): Promise<void> {
		const pidPath = getSchedulerPidPath();
		const pid = readDaemonPid(pidPath);
		const running = isDaemonRunning(pidPath);
		let taskCount = 0;

		try {
			const storage = new SchedulerDbStorage(getSchedulerDbPath());
			taskCount = storage.listTasks().length;
			storage.close();
		} catch {
			// ignore storage errors for status
		}

		const status = {
			running,
			pid: running ? pid : undefined,
			taskCount,
		};

		if (flags.json) {
			process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
			return;
		}

		if (running) {
			process.stdout.write(`Status: running\n`);
			process.stdout.write(`PID:    ${pid}\n`);
		} else {
			process.stdout.write(`Status: stopped\n`);
		}
		process.stdout.write(`Tasks:  ${taskCount}\n`);
	}

	async #handleRestart(flags: Record<string, unknown>): Promise<void> {
		try {
			await this.#handleStop();
		} catch {
			// ignore stop errors on restart
		}
		process.exitCode = undefined;
		await this.#handleStart(flags);
	}
}

async function runDaemonLoop(): Promise<void> {
	const { Cron } = await import("croner");
	const { getNextRun } = await import("../scheduler/types");
	const pidPath = getSchedulerPidPath();
	writeDaemonPid(pidPath, process.pid);

	type CronJob = { stop(): void };

	const storage = new SchedulerDbStorage(getSchedulerDbPath());
	const jobs = new Map<string, { cron: string; job: CronJob }>();

	function scheduleTask(task: import("../scheduler/types").ScheduledTask): void {
		const nextRun = getNextRun(task.cron);
		storage.updateTask(task.id, { nextRunAt: nextRun ? nextRun.getTime() : undefined });

		const job = new Cron(task.cron, async () => {
			await executeTask(task.id);
		});
		jobs.set(task.id, { cron: task.cron, job });
	}

	async function executeTask(taskId: string): Promise<void> {
		const task = storage.getTask(taskId);
		if (!task || task.status !== "active") return;

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

			const currentTask = storage.getTask(task.id);
			if (currentTask) {
				const nextRun = getNextRun(task.cron);
				storage.updateTask(task.id, {
					lastRunAt: Date.now(),
					nextRunAt: nextRun ? nextRun.getTime() : undefined,
					runCount: currentTask.runCount + 1,
					failCount: exitCode === 0 ? currentTask.failCount : currentTask.failCount + 1,
					updatedAt: Date.now(),
				});
			}
		} catch (err) {
			storage.updateExecution(exec.id, {
				endedAt: Date.now(),
				exitCode: 1,
				stderr: err instanceof Error ? err.message : String(err),
				status: "failure",
			});
			const currentTask = storage.getTask(task.id);
			if (currentTask) {
				storage.updateTask(task.id, {
					lastRunAt: Date.now(),
					failCount: currentTask.failCount + 1,
					updatedAt: Date.now(),
				});
			}
		}
	}

	function refreshTasks(): void {
		const tasks = storage.listTasks().filter(t => t.status === "active");
		const currentIds = new Set(tasks.map(t => t.id));

		// Remove jobs for inactive/deleted tasks
		for (const [id, entry] of jobs) {
			if (!currentIds.has(id)) {
				entry.job.stop();
				jobs.delete(id);
			}
		}

		// Add or update jobs
		for (const task of tasks) {
			const entry = jobs.get(task.id);
			if (!entry) {
				scheduleTask(task);
			} else if (entry.cron !== task.cron) {
				entry.job.stop();
				scheduleTask(task);
			}
		}
	}

	// Initial load
	refreshTasks();

	// Refresh every 30 seconds to pick up new/modified tasks
	const refreshInterval = setInterval(refreshTasks, 30000);

	function shutdown(): void {
		clearInterval(refreshInterval);
		for (const [, entry] of jobs) {
			entry.job.stop();
		}
		storage.close();
		clearDaemonPid(pidPath);
		process.exit(0);
	}

	process.on("SIGTERM", shutdown);
	process.on("SIGINT", shutdown);

	// Keep alive
	// eslint-disable-next-line @typescript-eslint/no-empty-function
	await new Promise(() => {});
}
