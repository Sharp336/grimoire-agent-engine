/**
 * Scheduling engine that manages active cron jobs using croner.
 */
import { logger } from "@oh-my-pi/pi-utils";
import { Cron } from "croner";
import type { EngineOptions, ScheduledTask, SchedulerStorage } from "./types";
import { getNextRun, parseSchedule } from "./types";

export class SchedulerEngine {
	readonly #storage: SchedulerStorage;
	readonly #onTrigger: (task: ScheduledTask, executionId: string) => Promise<void>;
	readonly #cronJobs = new Map<string, Cron>();
	readonly #intervals = new Map<string, NodeJS.Timeout>();
	readonly #timeouts = new Map<string, NodeJS.Timeout>();
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

		for (const interval of this.#intervals.values()) {
			clearInterval(interval);
		}
		this.#intervals.clear();

		for (const timeout of this.#timeouts.values()) {
			clearTimeout(timeout);
		}
		this.#timeouts.clear();

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

		const parsed = parseSchedule(task.cron);
		const scheduleType = task.scheduleType ?? parsed.type ?? "cron";

		if (scheduleType === "interval" && parsed.intervalMs) {
			const interval = setInterval(async () => {
				if (!this.#running) return;
				await this.#handleTrigger(task.id);
			}, parsed.intervalMs);
			this.#intervals.set(task.id, interval);
			this.#taskMap.set(task.id, task);
			this.#storage.updateTask(task.id, { nextRunAt: Date.now() + parsed.intervalMs });
		} else if (scheduleType === "once") {
			const target = parsed.nextRunAt ?? task.nextRunAt ?? Date.now();
			const delay = target - Date.now();
			if (delay > 0) {
				const timeout = setTimeout(async () => {
					if (!this.#running) return;
					await this.#handleTrigger(task.id);
					// Auto-disable one-shot jobs after execution
					this.#storage.updateTask(task.id, { status: "disabled" });
				}, delay);
				this.#timeouts.set(task.id, timeout);
				this.#taskMap.set(task.id, task);
				this.#storage.updateTask(task.id, { nextRunAt: target });
			} else {
				logger.warn("One-shot task scheduled for the past, disabling", { taskId: task.id });
				this.#storage.updateTask(task.id, { status: "disabled" });
			}
		} else {
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
	}

	unschedule(taskId: string): void {
		const job = this.#cronJobs.get(taskId);
		if (job) {
			job.stop();
			this.#cronJobs.delete(taskId);
		}

		const interval = this.#intervals.get(taskId);
		if (interval) {
			clearInterval(interval);
			this.#intervals.delete(taskId);
		}

		const timeout = this.#timeouts.get(taskId);
		if (timeout) {
			clearTimeout(timeout);
			this.#timeouts.delete(taskId);
		}

		this.#taskMap.delete(taskId);
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
