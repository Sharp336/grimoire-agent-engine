import type { AgentTelemetryConfig } from "@oh-my-pi/pi-agent-core";
import { logger } from "@oh-my-pi/pi-utils";
import type { ModelRegistry } from "../config/model-registry";
import type { Settings } from "../config/settings";
import type { LocalProtocolOptions } from "../internal-urls";
import type { AuthStorage } from "../session/auth-storage";
import type { ArtifactManager } from "../session/artifacts";
import type { EventBus } from "../utils/event-bus";
import { EvidenceStore } from "./store";
import type { AdvisorInvestigationUpdateBatch, InvestigationMode, InvestigationRecord, InvestigationRequestInput } from "./types";
import { EvidenceWorkerFailure, runEvidenceWorker } from "./worker";

export interface EvidenceBrokerOptions {
	cwd: () => string;
	settings: Settings;
	artifactManager: ArtifactManager | null;
	artifactsDir: () => string | null;
	sessionId: () => string | null;
	modelRegistry: ModelRegistry;
	authStorage: AuthStorage;
	eventBus?: EventBus;
	localProtocolOptions?: LocalProtocolOptions;
	parentTelemetry?: AgentTelemetryConfig;
	onUpdateReady?: () => void;
}

export const ADVISOR_CODE_INVESTIGATIONS_DISABLED_MESSAGE =
	"Advisor code investigations are disabled. Enable advisor.investigations.exec to run this mode in an isolated snapshot.";

const CODE_EXECUTION_MODES: Record<InvestigationMode, boolean> = {
	docs: false,
	web: false,
	source: false,
	code_experiment: true,
	reproduction: true,
	compatibility: true,
	benchmark: true,
	browser_probe: true,
};

export class EvidenceBroker {
	readonly #dispatching = new Set<string>();
	readonly #options: EvidenceBrokerOptions;
	readonly #store: EvidenceStore;

	private constructor(options: EvidenceBrokerOptions, store: EvidenceStore) {
		this.#options = options;
		this.#store = store;
	}

	static create(options: EvidenceBrokerOptions): EvidenceBroker | null {
		const store = EvidenceStore.fromArtifactsDir(options.artifactsDir(), options.sessionId() ?? undefined);
		if (!store) return null;
		return new EvidenceBroker(options, store);
	}

	async request(input: InvestigationRequestInput): Promise<InvestigationRecord> {
		if (CODE_EXECUTION_MODES[input.mode] && !this.#options.settings.get("advisor.investigations.exec")) {
			throw new Error(ADVISOR_CODE_INVESTIGATIONS_DISABLED_MESSAGE);
		}
		const record = await this.#store.create(input);
		this.#scheduleDispatch(record.id);
		return record;
	}

	async claimAdvisorUpdates(): Promise<AdvisorInvestigationUpdateBatch | null> {
		return await this.#store.claimForAdvisor();
	}

	async releaseAdvisorUpdates(ids: readonly string[]): Promise<void> {
		await this.#store.releaseAdvisorClaims(ids);
	}

	async markAdvisorUpdatesDelivered(ids: readonly string[]): Promise<void> {
		await this.#store.markDeliveredToAdvisor(ids);
	}

	async reconcile(): Promise<void> {
		const records = await this.#store.reconcileStale();
		const queuedIds = records.filter(record => record.status === "queued").map(record => record.id);
		for (const id of queuedIds) {
			this.#scheduleDispatch(id);
		}
		if (
			records.some(
				record =>
					(record.status === "ready" || record.status === "failed") && record.advisorDelivery === "pending",
			)
		) {
			this.#options.onUpdateReady?.();
		}
	}

	#scheduleDispatch(id: string): void {
		try {
			void this.#dispatch(id).catch(err => {
				logger.debug("evidence dispatch scheduling failed", { id, err: String(err) });
			});
		} catch (err) {
			logger.debug("evidence dispatch scheduling failed", { id, err: String(err) });
		}
	}

	async #dispatch(id: string): Promise<void> {
		if (this.#dispatching.has(id)) return;
		this.#dispatching.add(id);
		try {
			const record = await this.#store.get(id);
			if (!record || record.status !== "queued") return;
			if (CODE_EXECUTION_MODES[record.mode] && !this.#options.settings.get("advisor.investigations.exec")) {
				await this.#failRecord(record, ADVISOR_CODE_INVESTIGATIONS_DISABLED_MESSAGE);
				this.#options.onUpdateReady?.();
				return;
			}
			if (!this.#options.artifactManager) {
				await this.#store.update(record.id, {
					status: "failed",
					error: "Evidence artifact storage is unavailable for this session.",
					advisorDelivery: "pending",
				});
				this.#options.onUpdateReady?.();
				return;
			}
			const running = await this.#store.update(record.id, { status: "running", advisorDelivery: "pending" });
			if (!running) return;
			try {
				const result = await runEvidenceWorker({ ...this.#options, record: running });
				const artifactId = await this.#options.artifactManager.save(result.artifactBody, "evidence");
				const patch: Partial<Omit<InvestigationRecord, "id" | "createdAt">> = {
					status: "ready",
					artifactId,
					artifactUrl: `artifact://${artifactId}`,
					summary: result.summary,
					advisorDelivery: "pending",
				};
				if (result.baseRevision !== undefined) patch.baseRevision = result.baseRevision;
				await this.#store.update(record.id, patch);
			} catch (error) {
				if (error instanceof EvidenceWorkerFailure) {
					await this.#storeWorkerFailure(record, error);
				} else {
					await this.#failRecord(record, error instanceof Error ? error.message : String(error));
				}
			}
			this.#options.onUpdateReady?.();
		} finally {
			this.#dispatching.delete(id);
		}
	}

	async #storeWorkerFailure(record: InvestigationRecord, failure: EvidenceWorkerFailure): Promise<void> {
		if (!this.#options.artifactManager) {
			await this.#failRecord(record, failure.message);
			return;
		}
		try {
			const artifactId = await this.#options.artifactManager.save(failure.result.artifactBody, "evidence");
			const patch: Partial<Omit<InvestigationRecord, "id" | "createdAt">> = {
				status: "failed",
				artifactId,
				artifactUrl: `artifact://${artifactId}`,
				summary: failure.result.summary,
				error: failure.message,
				advisorDelivery: "pending",
			};
			if (failure.result.baseRevision !== undefined) patch.baseRevision = failure.result.baseRevision;
			await this.#store.update(record.id, patch);
		} catch (error) {
			await this.#failRecord(record, error instanceof Error ? error.message : String(error));
		}
	}

	async #failRecord(record: InvestigationRecord, error: string): Promise<void> {
		await this.#store.update(record.id, {
			status: "failed",
			error,
			summary: error,
			advisorDelivery: "pending",
		});
	}
}
