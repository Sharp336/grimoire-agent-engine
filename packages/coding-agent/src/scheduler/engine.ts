/**
 * Scheduling engine that manages active cron jobs using croner.
 */
import { logger } from "@oh-my-pi/pi-utils";
import { Cron } from "croner";
import type { EngineOptions, ScheduledTask, SchedulerStorage } from "./types";
import { getNextRun } from "./types";

export class SchedulerEngine {
	readonly #storage: SchedulerStorage;
	readonly #onTrigger: (task: ScheduledTask, executionId: string) => Promise<void>;
	readonly #cronJobs = new Map<string, Cron>();
	readonly #taskMap = new Map<string, ScheduledTask>();
	#running = false;

	constructor(options: EngineOptions) {
		this.#storage = options.storage;
		this.#onTrigger = options.onTrigger;
	}

	start(): void {
		if (this.#running) return;
		this.#running = true;

		const tasks = this.#storage.listTasks();
		for (const task of tasks) {
			if (task.status === "active") {
				this.schedule(task);
			}
		}

		logger.debug("Scheduler engine started", { taskCount: this.#cronJobs.size });
	}

	stop(): void {
		if (!this.#running) return;
		this.#running = false;

		for (const job of this.#cronJobs.values()) {
			job.stop();
		}
		this.#cronJobs.clear();
		this.#taskMap.clear();

		logger.debug("Scheduler engine stopped");
	}

	reload(): void {
		if (!this.#running) return;

		const tasks = this.#storage.listTasks();
		const activeIds = new Set<string>();

		for (const task of tasks) {
			if (task.status === "active") {
				activeIds.add(task.id);
				const existing = this.#taskMap.get(task.id);
				if (!existing || existing.cron !== task.cron || existing.command !== task.command) {
					this.schedule(task);
				}
			}
		}

		for (const [id, job] of this.#cronJobs) {
			if (!activeIds.has(id)) {
				job.stop();
				this.#cronJobs.delete(id);
				this.#taskMap.delete(id);
			}
		}

		logger.debug("Scheduler engine reloaded", { taskCount: this.#cronJobs.size });
	}

	schedule(task: ScheduledTask): void {
		this.unschedule(task.id);
		if (task.status !== "active") return;

		const cron = new Cron(task.cron, async () => {
			if (!this.#running) return;
			await this.#handleTrigger(task.id);
		});

		this.#cronJobs.set(task.id, cron);
		this.#taskMap.set(task.id, task);

		const nextRun = getNextRun(task.cron);
		if (nextRun) {
			this.#storage.updateTask(task.id, { nextRunAt: nextRun.getTime() });
		}
	}

	unschedule(taskId: string): void {
		const job = this.#cronJobs.get(taskId);
		if (job) {
			job.stop();
			this.#cronJobs.delete(taskId);
			this.#taskMap.delete(taskId);
		}
	}

	getActiveTaskIds(): string[] {
		return Array.from(this.#cronJobs.keys());
	}

	async #handleTrigger(taskId: string): Promise<void> {
		const task = this.#taskMap.get(taskId);
		if (!task || !this.#running) return;

		const exec = this.#storage.recordExecution({
			taskId: task.id,
			startedAt: Date.now(),
			status: "running",
		});

		try {
			await this.#onTrigger(task, exec.id);
		} catch (error) {
			logger.error("Task trigger failed", { taskId: task.id, error: String(error) });
			this.#storage.updateExecution(exec.id, {
				status: "failure",
				endedAt: Date.now(),
			});
		} finally {
			const nextRun = getNextRun(task.cron);
			const currentTask = this.#storage.getTask(task.id);
			this.#storage.updateTask(task.id, {
				lastRunAt: Date.now(),
				runCount: (currentTask?.runCount ?? 0) + 1,
				nextRunAt: nextRun?.getTime(),
			});
		}
	}
}
