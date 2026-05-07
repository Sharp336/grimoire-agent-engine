/**
 * Scheduler daemon that persists tasks in SQLite and runs them via cron.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";
import { SchedulerEngine } from "./engine";
import { executeScheduledCommand } from "./executor";
import { SchedulerDbStorage } from "./storage";
import type { DaemonOptions, DaemonStatus, ScheduledTask } from "./types";
import {
	clearDaemonPid,
	getSchedulerLogPath,
	getSchedulerPidPath,
	isDaemonRunning,
	readDaemonPid,
	writeDaemonPid,
} from "./types";

export class SchedulerDaemon {
	readonly #dbPath: string;
	readonly #ompBinary: string;
	readonly #foreground: boolean;
	#storage?: SchedulerDbStorage;
	#engine?: SchedulerEngine;
	#pidPath: string;
	#started = false;

	constructor(options: DaemonOptions) {
		this.#dbPath = options.dbPath;
		this.#ompBinary = options.ompBinary;
		this.#foreground = options.foreground ?? false;
		this.#pidPath = getSchedulerPidPath();
	}

	start(): void {
		if (this.#started) {
			logger.warn("Daemon already started");
			return;
		}

		if (!this.#foreground) {
			this.#daemonize();
			return;
		}

		if (isDaemonRunning(this.#pidPath)) {
			logger.warn("Scheduler daemon is already running", { pid: readDaemonPid(this.#pidPath) });
			return;
		}

		this.#storage = new SchedulerDbStorage(this.#dbPath);
		this.#engine = new SchedulerEngine({
			storage: this.#storage,
			onTrigger: this.#onTrigger.bind(this),
		});

		this.#engine.start();
		writeDaemonPid(this.#pidPath, process.pid);
		this.#started = true;

		this.#setupSignalHandlers();

		logger.debug("Scheduler daemon started", { pid: process.pid });
	}

	stop(): void {
		if (!this.#started) return;

		this.#engine?.stop();
		this.#engine = undefined;

		clearDaemonPid(this.#pidPath);

		this.#storage?.close();
		this.#storage = undefined;

		this.#started = false;

		logger.debug("Scheduler daemon stopped");
	}

	getStatus(): DaemonStatus {
		return {
			running: this.#started,
			pid: this.#started ? process.pid : undefined,
			taskCount: this.#engine ? this.#engine.getActiveTaskIds().length : 0,
			startedAt: this.#started ? Date.now() : undefined,
		};
	}

	async #onTrigger(task: ScheduledTask, executionId: string): Promise<void> {
		if (!this.#storage) return;

		const { exitCode, output, stderr, timedOut } = await executeScheduledCommand(task.command, {
			taskType: task.taskType,
			timeoutMs: task.timeoutMs,
			ompBinary: this.#ompBinary,
		});
		const endedAt = Date.now();

		this.#storage.updateExecution(executionId, {
			status: exitCode === 0 ? "success" : "failure",
			exitCode,
			output: timedOut
				? `[TIMED OUT after ${task.timeoutMs ?? 30_000}ms]
${output}`
				: output,
			stderr: timedOut
				? `[TIMED OUT]
${stderr}`
				: stderr,
			endedAt,
		});

		if (exitCode !== 0 || timedOut) {
			const currentTask = this.#storage.getTask(task.id);
			if (currentTask) {
				this.#storage.updateTask(task.id, {
					failCount: currentTask.failCount + 1,
				});
			}
			logger.warn("Task execution failed", { taskId: task.id, exitCode, executionId, timedOut });
		} else {
			logger.debug("Task execution succeeded", { taskId: task.id, executionId });
		}
	}

	#daemonize(): void {
		const logPath = getSchedulerLogPath();
		fs.mkdirSync(path.dirname(logPath), { recursive: true });
		const logFd = fs.openSync(logPath, "a");

		const args = process.argv.slice(2);
		if (!args.includes("--foreground")) {
			args.push("--foreground");
		}

		const isScript =
			this.#ompBinary.endsWith(".ts") || this.#ompBinary.endsWith(".js") || this.#ompBinary.endsWith(".mjs");
		const cmd = isScript ? [process.execPath, this.#ompBinary] : [this.#ompBinary];

		const proc = Bun.spawn([...cmd, ...args], {
			detached: true,
			stdout: logFd,
			stderr: logFd,
			stdin: "ignore",
		});

		proc.unref();

		logger.debug("Scheduler daemon spawned in background", { pid: proc.pid });
	}

	#setupSignalHandlers(): void {
		const gracefulShutdown = () => {
			logger.debug("Received shutdown signal, stopping daemon");
			this.stop();
			process.exit(0);
		};

		process.once("SIGTERM", gracefulShutdown);
		process.once("SIGINT", gracefulShutdown);
	}
}
