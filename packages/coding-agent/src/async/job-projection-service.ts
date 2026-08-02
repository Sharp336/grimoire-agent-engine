import type { AgentLifecycleManager } from "../registry/agent-lifecycle";
import type { AgentRegistry } from "../registry/agent-registry";
import { USER_INTERRUPT_LABEL } from "../session/messages";
import { truncateTailBytes } from "../session/streaming-output";
import { MAX_OUTPUT_BYTES } from "../task/types";
import type { AgentActivitySnapshot, CancelOutcome, JobSnapshot } from "../tools/hub/types";
import type { AsyncJob, AsyncJobManager } from "./job-manager";

export const MAX_RPC_CANCEL_JOB_IDS = 64;

export interface JobProjectionHost {
	manager: AsyncJobManager;
	ownerId: string | undefined;
	registry?: AgentRegistry;
	lifecycle?: AgentLifecycleManager;
}

export interface JobProjectionSnapshot {
	jobs: JobSnapshot[];
	agents: AgentActivitySnapshot[];
}

/** Shared owner-filtered job view and cancellation boundary used by hub and RPC. */
export class JobProjectionService {
	readonly #host: JobProjectionHost;

	constructor(host: JobProjectionHost) {
		this.#host = host;
	}

	subscribe(listener: () => void): () => void {
		const unsubscribeJobs = this.#host.manager.subscribe(listener);
		const unsubscribeRegistry = this.#host.registry?.onChange(listener);
		return () => {
			unsubscribeJobs();
			unsubscribeRegistry?.();
		};
	}

	#visible(job: AsyncJob | undefined): job is AsyncJob {
		if (!job) return false;
		return this.#host.ownerId === undefined || job.ownerId === this.#host.ownerId;
	}

	#project(job: AsyncJob, now = Date.now()): JobSnapshot {
		let resolvedModel: string | undefined;
		if (job.type === "task") {
			const progress = job.latestDetails?.progress;
			if (Array.isArray(progress)) {
				let selected: Record<string, unknown> | undefined;
				for (const value of progress) {
					if (!value || typeof value !== "object") continue;
					const candidate = value as Record<string, unknown>;
					selected ??= candidate;
					if (candidate.id === job.id) {
						selected = candidate;
						break;
					}
				}
				if (typeof selected?.resolvedModel === "string" && selected.resolvedModel.trim()) {
					resolvedModel = selected.resolvedModel.trim();
				}
			}
		}
		const resultBytes = job.resultText === undefined ? 0 : Buffer.byteLength(job.resultText, "utf8");
		const errorBytes = job.errorText === undefined ? 0 : Buffer.byteLength(job.errorText, "utf8");
		return {
			id: job.id,
			type: job.type,
			status: job.status,
			label: job.label,
			durationMs: Math.max(0, now - job.startTime),
			...(job.queued ? { queued: true } : {}),
			...(resolvedModel ? { resolvedModel } : {}),
			...(job.resultText !== undefined
				? {
						resultText: truncateTailBytes(job.resultText, MAX_OUTPUT_BYTES).text,
						...(resultBytes > MAX_OUTPUT_BYTES ? { resultTruncated: true } : {}),
					}
				: {}),
			...(job.errorText !== undefined
				? {
						errorText: truncateTailBytes(job.errorText, MAX_OUTPUT_BYTES).text,
						...(errorBytes > MAX_OUTPUT_BYTES ? { errorTruncated: true } : {}),
					}
				: {}),
		};
	}

	get(jobId: string): JobSnapshot | undefined {
		const job = this.#host.manager.getJob(jobId);
		return this.#visible(job) ? this.#project(job) : undefined;
	}

	project(jobs: readonly AsyncJob[]): JobSnapshot[] {
		const now = Date.now();
		return jobs.filter(job => this.#visible(job)).map(job => this.#project(job, now));
	}

	list(): JobProjectionSnapshot {
		const filter = this.#host.ownerId ? { ownerId: this.#host.ownerId } : undefined;
		const jobs = this.project(this.#host.manager.getAllJobs(filter));
		return { jobs, agents: this.#runningAgentsOutsideJobs() };
	}

	#runningAgentsOutsideJobs(): AgentActivitySnapshot[] {
		const registry = this.#host.registry;
		if (!registry) return [];
		const filter = this.#host.ownerId ? { ownerId: this.#host.ownerId } : undefined;
		const covered = new Set<string>();
		for (const job of this.#host.manager.getRunningJobs(filter)) {
			covered.add(job.id);
			if (job.agentId) covered.add(job.agentId);
		}
		const now = Date.now();
		const out: AgentActivitySnapshot[] = [];
		for (const ref of registry.list()) {
			if (ref.kind !== "sub" || ref.status !== "running") continue;
			if (ref.id === this.#host.ownerId || covered.has(ref.id)) continue;
			out.push({
				id: ref.id,
				...(ref.parentId ? { parentId: ref.parentId } : {}),
				...(ref.activity ? { activity: ref.activity } : {}),
				ageMs: Math.max(0, now - ref.createdAt),
			});
		}
		return out;
	}

	async cancel(jobIds: readonly string[]): Promise<CancelOutcome[]> {
		if (jobIds.length > MAX_RPC_CANCEL_JOB_IDS) {
			throw new Error(`At most ${MAX_RPC_CANCEL_JOB_IDS} background jobs may be cancelled at once`);
		}
		const outcomes: CancelOutcome[] = [];
		const filter = this.#host.ownerId ? { ownerId: this.#host.ownerId } : undefined;
		for (const id of jobIds) {
			const existing = this.#host.manager.getJob(id);
			if (!this.#visible(existing)) {
				outcomes.push(await this.#cancelAgentRegistration(id));
				continue;
			}
			if (existing.status !== "running") {
				const registration = await this.#cancelAgentRegistration(id);
				outcomes.push(
					registration.status === "cancelled"
						? registration
						: {
								id,
								status: "already_completed",
								message: `Background job ${id} is already ${existing.status}.`,
							},
				);
				continue;
			}
			outcomes.push(
				this.#host.manager.cancel(id, filter)
					? { id, status: "cancelled", message: `Cancelled background job ${id}.` }
					: { id, status: "already_completed", message: `Background job ${id} is already completed.` },
			);
		}
		return outcomes;
	}

	async #cancelAgentRegistration(id: string): Promise<CancelOutcome> {
		const registry = this.#host.registry;
		const ref = registry?.get(id);
		if (ref?.kind !== "sub") return { id, status: "not_found", message: `Background job not found: ${id}` };
		if (id === this.#host.ownerId) return { id, status: "not_found", message: `Cannot cancel yourself (${id}).` };
		if (this.#host.ownerId && ref.parentId !== this.#host.ownerId) {
			return { id, status: "not_found", message: `Agent ${id} was not spawned by you and cannot be cancelled.` };
		}
		try {
			if (ref.status === "running" && ref.session) await ref.session.abort({ reason: USER_INTERRUPT_LABEL });
			if (this.#host.lifecycle) await this.#host.lifecycle.release(id);
			else {
				await ref.session?.dispose();
				registry?.unregister(id);
			}
		} catch (error) {
			return {
				id,
				status: "already_completed",
				message: `Agent ${id} could not be fully cancelled: ${error instanceof Error ? error.message : String(error)}.`,
			};
		}
		return { id, status: "cancelled", message: `Cancelled agent ${id} (killed session, dropped registration).` };
	}
}
