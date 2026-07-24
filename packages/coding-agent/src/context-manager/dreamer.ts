import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isBunTestRuntime, isEnoent, logger } from "@oh-my-pi/pi-utils";
import { CronExpressionParser } from "cron-parser";
import type { Settings } from "../config/settings";
import type { SessionManager } from "../session/session-manager";
import {
	CONTEXT_DREAM_TASK_NAMES,
	CONTEXT_DREAM_TASKS,
	type ContextDreamTaskDefinition,
	type ContextDreamTaskName,
	isContextDreamTaskName,
} from "./dreamer-registry";
import type { ContextDreamTaskExecutor } from "./dreamer-tasks";
import type { ContextMemoryAdapter, ContextMemoryMaintenanceRecord } from "./memory";
import { sanitizeContextStatusText } from "./report";
import type { ContextStore } from "./storage";
import type { ContextDreamerStatus, ContextDreamRunResult, ContextJobRecord } from "./types";

const JOB_KIND = "maintenance";
const LEASE_MS = 30_000;
const LOOP_INTERVAL_MS = 15 * 60 * 1000;
const MAX_RETRY_MS = 60 * 60 * 1000;

export interface ContextDreamerOptions {
	readonly store: ContextStore;
	readonly settings: Settings;
	readonly executor: ContextDreamTaskExecutor;
	readonly sessionManager: SessionManager;
	readonly getMemoryAdapter: () => ContextMemoryAdapter | undefined;
	readonly ownerId: string;
	readonly getProjectId: () => string | undefined;
	readonly getSessionId: () => string | undefined;
	readonly getCwd: () => string;
	readonly notify?: (level: "info" | "warning", message: string) => void;
}

function dreamerEnabled(settings: Settings): boolean {
	return settings.get("contextManager.dreamer.enabled");
}

function settingSchedule(settings: Settings, definition: ContextDreamTaskDefinition): string {
	return (settings.get(definition.schedulePath) as string).trim();
}

function nextOccurrence(schedule: string, now: number): number {
	return CronExpressionParser.parse(schedule, { currentDate: new Date(now), tz: "UTC" })
		.next()
		.getTime();
}

function scheduledJobId(projectId: string, task: ContextDreamTaskName): string {
	return `dream:${projectId}:${task}`;
}

function scheduledPayload(schedule: string): Readonly<Record<string, unknown>> {
	return { recurring: true, schedule };
}

function jobSchedule(job: ContextJobRecord): string | undefined {
	if (!job.payload || typeof job.payload !== "object" || Array.isArray(job.payload)) return undefined;
	const schedule = (job.payload as Readonly<Record<string, unknown>>).schedule;
	return typeof schedule === "string" ? schedule : undefined;
}

function maxUpdatedAt(records: readonly { readonly updatedAt: number }[]): number {
	return records.reduce((maximum, record) => Math.max(maximum, record.updatedAt), 0);
}
function memoryFingerprint(records: readonly ContextMemoryMaintenanceRecord[]): string {
	const hasher = new Bun.CryptoHasher("sha256");
	for (const record of records) {
		hasher.update(record.id);
		hasher.update("\0");
		hasher.update(record.content);
		hasher.update("\0");
		hasher.update(record.memoryType ?? "");
		hasher.update("\0");
		hasher.update(JSON.stringify(record.metadata ?? null));
	}
	return `${records.length}:${hasher.digest("hex")}`;
}

/** Owns persistent recurring dream jobs and executes each job under a recoverable SQLite lease. */
export class ContextDreamer {
	static readonly #backgroundCandidates = new Set<ContextDreamer>();
	static #backgroundOwner: ContextDreamer | undefined;

	readonly #store: ContextStore;
	readonly #settings: Settings;
	readonly #executor: ContextDreamTaskExecutor;
	readonly #sessionManager: SessionManager;
	readonly #getMemoryAdapter: () => ContextMemoryAdapter | undefined;
	readonly #ownerId: string;
	readonly #getProjectId: () => string | undefined;
	readonly #getSessionId: () => string | undefined;
	readonly #getCwd: () => string;
	readonly #notify: (level: "info" | "warning", message: string) => void;
	readonly #inFlight = new Map<string, Promise<ContextDreamRunResult>>();
	readonly #abortController = new AbortController();
	#loop: Promise<void> | undefined;
	#wakeLoop: (() => void) | undefined;
	#disposing = false;

	constructor(options: ContextDreamerOptions) {
		this.#store = options.store;
		this.#settings = options.settings;
		this.#executor = options.executor;
		this.#sessionManager = options.sessionManager;
		this.#getMemoryAdapter = options.getMemoryAdapter;
		this.#ownerId = options.ownerId;
		this.#getProjectId = options.getProjectId;
		this.#getSessionId = options.getSessionId;
		this.#getCwd = options.getCwd;
		this.#notify = options.notify ?? (() => {});
	}

	start(): void {
		if (this.#loop || this.#disposing || isBunTestRuntime()) return;
		ContextDreamer.#backgroundCandidates.add(this);
		const owner = ContextDreamer.#backgroundOwner;
		if (owner && owner !== this && !owner.#disposing) return;
		ContextDreamer.#backgroundOwner = this;
		this.#loop = this.#runLoop();
	}

	async runNow(
		tasks: readonly ContextDreamTaskName[],
		options: { readonly force?: boolean; readonly signal?: AbortSignal } = {},
	): Promise<ContextDreamRunResult[]> {
		if (this.#disposing) {
			return tasks.map(task => ({ task, status: "skipped", changed: 0, summary: `${task}: disposing` }));
		}
		const projectId = this.#getProjectId();
		if (!projectId) {
			return tasks.map(task => ({
				task,
				status: "skipped",
				changed: 0,
				summary: `${task}: project unavailable`,
			}));
		}
		const results: ContextDreamRunResult[] = [];
		for (const task of [...new Set(tasks)]) {
			if (!options.force && !dreamerEnabled(this.#settings)) {
				results.push({ task, status: "skipped", changed: 0, summary: `${task}: disabled` });
				continue;
			}
			if (!options.force && !(await this.#activityChanged(projectId, task))) {
				results.push({ task, status: "skipped", changed: 0, summary: `${task}: no relevant activity` });
				continue;
			}
			const job = this.#store.enqueueJob({
				projectId,
				sessionId: this.#getSessionId(),
				kind: JOB_KIND,
				task,
				payload: { recurring: false, forced: options.force ?? false },
			});
			const execution = this.#executeJob(job, task, options.force ?? false, options.signal);
			this.#inFlight.set(job.id, execution);
			try {
				results.push(await execution);
			} finally {
				this.#inFlight.delete(job.id);
			}
		}
		return results;
	}

	status(): ContextDreamerStatus {
		const projectId = this.#getProjectId();
		const recentJobs = projectId
			? this.#store
					.listJobs(projectId)
					.filter(job => job.kind === JOB_KIND)
					.slice(-20)
			: [];
		const schedules = CONTEXT_DREAM_TASK_NAMES.filter(task =>
			settingSchedule(this.#settings, CONTEXT_DREAM_TASKS[task]),
		)
			.map(task => {
				const schedule = settingSchedule(this.#settings, CONTEXT_DREAM_TASKS[task]);
				return schedule ? `${task}=${schedule}` : `${task}=manual`;
			})
			.join(", ");
		return {
			active:
				dreamerEnabled(this.#settings) &&
				!this.#disposing &&
				this.#loop !== undefined &&
				ContextDreamer.#backgroundOwner === this,
			running: [...this.#inFlight.keys()]
				.map(jobId => this.#store.getJob(jobId)?.task)
				.filter((task): task is ContextDreamTaskName => typeof task === "string" && isContextDreamTaskName(task)),
			scheduleSummary: schedules || "disabled",
			recentJobs,
		};
	}

	beginDispose(): void {
		if (this.#disposing) return;
		this.#disposing = true;
		this.#abortController.abort(new Error("Context dreamer disposed"));
		this.#wakeLoop?.();
		ContextDreamer.#backgroundCandidates.delete(this);
		if (ContextDreamer.#backgroundOwner === this) {
			ContextDreamer.#backgroundOwner = undefined;
			ContextDreamer.#backgroundCandidates.values().next().value?.start();
		}
	}

	async dispose(timeoutMs: number): Promise<void> {
		this.beginDispose();
		const pending = [...this.#inFlight.values()];
		if (this.#loop)
			pending.push(
				this.#loop.then(() => ({
					task: "verify" as const,
					status: "skipped" as const,
					changed: 0,
					summary: "loop stopped",
				})),
			);
		if (pending.length > 0) {
			const timeout = Promise.withResolvers<void>();
			const timer = setTimeout(timeout.resolve, Math.max(1, timeoutMs));
			timer.unref?.();
			await Promise.race([Promise.allSettled(pending), timeout.promise]);
			clearTimeout(timer);
		}
	}

	async #runLoop(): Promise<void> {
		while (!this.#abortController.signal.aborted) {
			try {
				await this.#tick();
			} catch (error) {
				logger.debug("Managed-context dream scheduler tick failed", {
					error: error instanceof Error ? error.message : String(error),
				});
			}
			await this.#waitForNextTick();
		}
	}
	async #waitForNextTick(): Promise<void> {
		if (this.#abortController.signal.aborted) return;
		const wait = Promise.withResolvers<void>();
		this.#wakeLoop = wait.resolve;
		const timer = setTimeout(wait.resolve, LOOP_INTERVAL_MS);
		timer.unref?.();
		await wait.promise;
		clearTimeout(timer);
		if (this.#wakeLoop === wait.resolve) this.#wakeLoop = undefined;
	}

	async #tick(): Promise<void> {
		const projectId = this.#getProjectId();
		if (!projectId || this.#disposing) return;
		const now = Date.now();
		this.#store.recoverExpiredJobLeases(now);
		await this.#syncSchedules(projectId, now);
		const maxConcurrent = 2;
		if (this.#inFlight.size >= maxConcurrent) return;
		const due = this.#store
			.listJobs(projectId)
			.filter(
				job =>
					job.kind === JOB_KIND &&
					typeof job.task === "string" &&
					isContextDreamTaskName(job.task) &&
					jobSchedule(job) !== undefined &&
					(job.nextDueAt ?? Number.POSITIVE_INFINITY) <= now &&
					!this.#inFlight.has(job.id),
			)
			.slice(0, maxConcurrent - this.#inFlight.size);
		for (const job of due) {
			const task = job.task;
			if (!task || !isContextDreamTaskName(task)) continue;
			const promise = this.#runScheduledJob(job, task)
				.catch(error => {
					const message = error instanceof Error ? error.message : String(error);
					this.#store.releaseJobLease(job.id, this.#leaseOwner(job.id), "failed", Date.now() + 60_000);
					this.#notify("warning", sanitizeContextStatusText(`${task}: ${message}`));
					logger.debug("Managed-context scheduled dream failed", { task, error: message });
					return {
						task,
						status: "failed" as const,
						changed: 0,
						summary: `${task}: ${message}`,
						jobId: job.id,
					};
				})
				.finally(() => {
					this.#inFlight.delete(job.id);
				});
			this.#inFlight.set(job.id, promise);
		}
	}

	async #syncSchedules(projectId: string, now: number): Promise<void> {
		if (!dreamerEnabled(this.#settings)) return;
		for (const task of CONTEXT_DREAM_TASK_NAMES) {
			const definition = CONTEXT_DREAM_TASKS[task];
			const schedule = settingSchedule(this.#settings, definition);
			if (!schedule) continue;
			const id = scheduledJobId(projectId, task);
			const existing = this.#store.getJob(id);
			if (
				existing &&
				jobSchedule(existing) === schedule &&
				existing.status !== "cancelled" &&
				(existing.nextDueAt !== undefined ||
					(existing.status === "failed" && existing.lastError?.startsWith("Invalid schedule:")))
			) {
				continue;
			}
			try {
				this.#store.ensureJob(
					{
						id,
						projectId,
						sessionId: this.#getSessionId(),
						kind: JOB_KIND,
						task,
						payload: scheduledPayload(schedule),
						nextDueAt: nextOccurrence(schedule, now),
					},
					now,
				);
			} catch (error) {
				const invalid = this.#store.ensureJob(
					{
						id,
						projectId,
						sessionId: this.#getSessionId(),
						kind: JOB_KIND,
						task,
						payload: scheduledPayload(schedule),
						nextDueAt: now,
					},
					now,
				);
				const message = error instanceof Error ? error.message : String(error);
				const leaseOwner = this.#leaseOwner(invalid.id);
				if (this.#store.tryAcquireJobLease(invalid.id, leaseOwner, LEASE_MS, now)) {
					this.#store.finishJob(invalid.id, leaseOwner, "failed", {
						error: `Invalid schedule: ${message}`,
					});
				}
				this.#notify("warning", sanitizeContextStatusText(`${task}: invalid schedule: ${message}`));
			}
		}
	}

	async #runScheduledJob(job: ContextJobRecord, task: ContextDreamTaskName): Promise<ContextDreamRunResult> {
		const definition = CONTEXT_DREAM_TASKS[task];
		const schedule = jobSchedule(job);
		const configuredSchedule = settingSchedule(this.#settings, definition);
		if (!schedule || configuredSchedule !== schedule || !dreamerEnabled(this.#settings)) {
			const leaseOwner = this.#leaseOwner(job.id);
			if (this.#store.tryAcquireJobLease(job.id, leaseOwner, LEASE_MS)) {
				this.#store.releaseJobLease(job.id, leaseOwner, "paused");
			}
			return { task, status: "skipped", changed: 0, summary: `${task}: schedule disabled`, jobId: job.id };
		}
		if (!(await this.#activityChanged(job.projectId, task))) {
			const leaseOwner = this.#leaseOwner(job.id);
			if (this.#store.tryAcquireJobLease(job.id, leaseOwner, LEASE_MS)) {
				this.#store.releaseJobLease(job.id, leaseOwner, "pending", nextOccurrence(schedule, Date.now()));
			}
			return { task, status: "skipped", changed: 0, summary: `${task}: no relevant activity`, jobId: job.id };
		}
		const result = await this.#executeJob(job, task, false);
		if (result.status === "succeeded") {
			const leaseOwner = this.#leaseOwner(job.id);
			this.#store.updateJobProgress(job.id, leaseOwner, 1);
			this.#store.releaseJobLease(job.id, leaseOwner, "pending", nextOccurrence(schedule, Date.now()));
		} else if (result.status === "failed") {
			const backoff = Math.min(MAX_RETRY_MS, 1_000 * 2 ** Math.min(10, job.attempt));
			const cronDue = nextOccurrence(schedule, Date.now());
			this.#store.releaseJobLease(
				job.id,
				this.#leaseOwner(job.id),
				"failed",
				Math.min(cronDue, Date.now() + backoff),
			);
		}
		if (result.status === "succeeded" && result.changed > 0) {
			this.#notify("info", sanitizeContextStatusText(result.summary));
		} else if (result.status === "failed") {
			this.#notify("warning", sanitizeContextStatusText(result.summary));
		}
		return result;
	}

	#leaseOwner(jobId: string): string {
		return `${this.#ownerId}:${jobId}`;
	}

	#cancelPendingManualJob(job: ContextJobRecord, leaseOwner: string, reason: string): void {
		if (jobSchedule(job) !== undefined) return;
		if (this.#store.tryAcquireJobLease(job.id, leaseOwner, LEASE_MS)) {
			this.#store.finishJob(job.id, leaseOwner, "cancelled", { error: reason });
		}
	}

	async #executeJob(
		job: ContextJobRecord,
		task: ContextDreamTaskName,
		forced: boolean,
		externalSignal?: AbortSignal,
	): Promise<ContextDreamRunResult> {
		const leaseOwner = this.#leaseOwner(job.id);
		const domain = CONTEXT_DREAM_TASKS[task].domain;
		if (!this.#store.tryAcquireJobDomainLease(job.projectId, domain, leaseOwner, LEASE_MS)) {
			const summary = `${task}: ${domain} lease held by another process`;
			this.#cancelPendingManualJob(job, leaseOwner, summary);
			return {
				task,
				status: "skipped",
				changed: 0,
				summary,
				jobId: job.id,
			};
		}
		if (!this.#store.tryAcquireJobLease(job.id, leaseOwner, LEASE_MS)) {
			this.#store.releaseJobDomainLease(job.projectId, domain, leaseOwner);
			return {
				task,
				status: "skipped",
				changed: 0,
				summary: `${task}: job lease held by another process`,
				jobId: job.id,
			};
		}
		const signal = externalSignal
			? AbortSignal.any([externalSignal, this.#abortController.signal])
			: this.#abortController.signal;
		const heartbeat = setInterval(() => {
			this.#store.heartbeatJobLease(job.id, leaseOwner, LEASE_MS);
			this.#store.heartbeatJobDomainLease(job.projectId, domain, leaseOwner, LEASE_MS);
		}, LEASE_MS / 3);
		heartbeat.unref();
		try {
			this.#store.updateJobProgress(job.id, leaseOwner, 0.1);
			const output = await this.#executor.run(task, { forced, settings: this.#settings, signal });
			await this.#markActivity(job.projectId, task);
			if (jobSchedule(job) === undefined) {
				this.#store.finishJob(job.id, leaseOwner, "succeeded", { progress: 1 });
			}
			return { task, status: "succeeded", changed: output.changed, summary: output.summary, jobId: job.id };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (jobSchedule(job) === undefined) {
				this.#store.finishJob(job.id, leaseOwner, "failed", { error: message });
			}
			return { task, status: "failed", changed: 0, summary: `${task}: ${message}`, jobId: job.id };
		} finally {
			clearInterval(heartbeat);
			this.#store.releaseJobDomainLease(job.projectId, domain, leaseOwner);
		}
	}

	async #activityChanged(projectId: string, task: ContextDreamTaskName): Promise<boolean> {
		const current = await this.#activityFingerprint(projectId, task);
		return this.#store.getMeta(`dreamer:${projectId}:activity:${task}`) !== current;
	}

	async #markActivity(projectId: string, task: ContextDreamTaskName): Promise<void> {
		this.#store.setMeta(`dreamer:${projectId}:activity:${task}`, await this.#activityFingerprint(projectId, task));
	}

	async #activityFingerprint(projectId: string, task: ContextDreamTaskName): Promise<string> {
		const sessionId = this.#getSessionId();
		switch (CONTEXT_DREAM_TASKS[task].activity) {
			case "project-memory": {
				const memories = this.#getMemoryAdapter()?.list("project") ?? [];
				return `project:${memoryFingerprint(memories)}`;
			}
			case "user-memory": {
				const memories = this.#getMemoryAdapter()?.list("user") ?? [];
				return `user:${memoryFingerprint(memories)}`;
			}
			case "session-facts": {
				const facts = this.#store.listUnpromotedUserFacts();
				return `facts:${facts.length}:${maxUpdatedAt(facts)}`;
			}
			case "notes": {
				const notes = this.#store.listNotes(projectId, sessionId).filter(note => note.status === "pending");
				return `notes:${notes.length}:${maxUpdatedAt(notes)}`;
			}
			case "docs": {
				const states = await Promise.all(
					["ARCHITECTURE.md", "STRUCTURE.md"].map(async file => {
						try {
							const stat = await fs.stat(path.join(this.#getCwd(), file));
							return `${file}:${stat.size}:${stat.mtimeMs}`;
						} catch (error) {
							if (isEnoent(error)) return `${file}:missing`;
							throw error;
						}
					}),
				);
				return states.join("|");
			}
			case "messages": {
				const branch = this.#sessionManager.getBranch();
				const last = branch.at(-1);
				return `messages:${branch.length}:${last?.id ?? "none"}:${last?.timestamp ?? 0}`;
			}
		}
	}
}
