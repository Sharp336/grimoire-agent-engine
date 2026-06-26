import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";
import type {
	AdvisorInvestigationUpdateBatch,
	InvestigationRecord,
	InvestigationRequestInput,
} from "./types";

let requestCounter = 0;
let tempCounter = 0;


function formatInvestigationUpdate(record: InvestigationRecord): string {
	const status = record.status === "ready" ? "ready" : "failed";
	const summary = record.summary ?? record.error ?? "No summary was provided.";
	const artifact = record.artifactUrl ? ` Artifact: ${record.artifactUrl}` : "";
	const error = record.error && record.status === "failed" ? ` Error: ${record.error}` : "";
	return `- ${record.id} (${status}, ${record.mode}, ${record.risk}): ${summary}${artifact}${error}`;
}

export class EvidenceStore {
	#lock: Promise<void> = Promise.resolve();
	readonly #requestsPath: string;
	readonly #evidenceDir: string;

	constructor(private readonly artifactsDir: string, private readonly sessionId: string | undefined) {
		this.#evidenceDir = path.join(artifactsDir, "evidence");
		this.#requestsPath = path.join(this.#evidenceDir, "requests.json");
	}

	static fromArtifactsDir(artifactsDir: string | null | undefined, sessionId?: string): EvidenceStore | null {
		if (!artifactsDir) return null;
		return new EvidenceStore(artifactsDir, sessionId);
	}

	async create(input: InvestigationRequestInput): Promise<InvestigationRecord> {
		return await this.#withLock(async () => {
			const records = await this.#readRecords();
			const now = Date.now();
			const record: InvestigationRecord = {
				...input,
				id: `ev-${Date.now().toString(36)}-${requestCounter++}`,
				status: "queued",
				requestedBy: "advisor",
				createdAt: now,
				updatedAt: now,
				advisorDelivery: "pending",
			};
			if (this.sessionId) record.sessionId = this.sessionId;
			records.push(record);
			await this.#writeRecords(records);
			return record;
		});
	}

	async update(
		id: string,
		patch: Partial<Omit<InvestigationRecord, "id" | "createdAt">>,
	): Promise<InvestigationRecord | null> {
		return await this.#withLock(async () => {
			const records = await this.#readRecords();
			const index = records.findIndex(record => record.id === id);
			if (index < 0) return null;
			const current = records[index];
			const updated: InvestigationRecord = {
				...current,
				...patch,
				id: current.id,
				createdAt: current.createdAt,
				updatedAt: Date.now(),
			};
			records[index] = updated;
			await this.#writeRecords(records);
			return updated;
		});
	}

	async get(id: string): Promise<InvestigationRecord | null> {
		return await this.#withLock(async () => {
			const records = await this.#readRecords();
			return records.find(record => record.id === id) ?? null;
		});
	}

	async list(): Promise<InvestigationRecord[]> {
		return await this.#withLock(async () => await this.#readRecords());
	}

	async reconcileStale(): Promise<InvestigationRecord[]> {
		return await this.#withLock(async () => {
			const records = await this.#readRecords();
			let changed = false;
			const now = Date.now();
			const reconciled = records.map(record => {
				const status = record.status === "running" ? "queued" : record.status;
				const advisorDelivery = record.advisorDelivery === "claimed" ? "pending" : record.advisorDelivery;
				if (status === record.status && advisorDelivery === record.advisorDelivery) return record;
				changed = true;
				return { ...record, status, advisorDelivery, updatedAt: now };
			});
			if (changed) await this.#writeRecords(reconciled);
			return reconciled;
		});
	}

	async claimForAdvisor(limit?: number): Promise<AdvisorInvestigationUpdateBatch | null> {
		return await this.#withLock(async () => {
			const records = await this.#readRecords();
			const max = limit ?? Number.POSITIVE_INFINITY;
			const claimed: InvestigationRecord[] = [];
			const now = Date.now();
			for (let index = 0; index < records.length && claimed.length < max; index++) {
				const record = records[index];
				if ((record.status === "ready" || record.status === "failed") && record.advisorDelivery === "pending") {
					const updated: InvestigationRecord = { ...record, advisorDelivery: "claimed", updatedAt: now };
					records[index] = updated;
					claimed.push(updated);
				}
			}
			if (claimed.length === 0) return null;
			await this.#writeRecords(records);
			return {
				ids: claimed.map(record => record.id),
				text: claimed.map(formatInvestigationUpdate).join("\n"),
			};
		});
	}

	async releaseAdvisorClaims(ids: readonly string[]): Promise<void> {
		await this.#withLock(async () => {
			if (ids.length === 0) return;
			const idSet = new Set(ids);
			const records = await this.#readRecords();
			let changed = false;
			const now = Date.now();
			const updated = records.map(record => {
				if (!idSet.has(record.id) || record.advisorDelivery !== "claimed") return record;
				changed = true;
				return { ...record, advisorDelivery: "pending" as const, updatedAt: now };
			});
			if (changed) await this.#writeRecords(updated);
		});
	}

	async markDeliveredToAdvisor(ids: readonly string[]): Promise<void> {
		await this.#withLock(async () => {
			if (ids.length === 0) return;
			const idSet = new Set(ids);
			const records = await this.#readRecords();
			let changed = false;
			const now = Date.now();
			const updated = records.map(record => {
				if (!idSet.has(record.id)) return record;
				if (record.advisorDelivery !== "claimed" && record.advisorDelivery !== "pending") return record;
				changed = true;
				return { ...record, advisorDelivery: "delivered" as const, updatedAt: now };
			});
			if (changed) await this.#writeRecords(updated);
		});
	}

	async #withLock<T>(work: () => Promise<T>): Promise<T> {
		const prior = this.#lock;
		const { promise: next, resolve } = Promise.withResolvers<void>();
		this.#lock = prior.then(() => next, () => next);
		await prior;
		try {
			return await work();
		} finally {
			resolve();
		}
	}

	async #readRecords(): Promise<InvestigationRecord[]> {
		try {
			const text = await Bun.file(this.#requestsPath).text();
			if (text.trim().length === 0) return [];
			return JSON.parse(text) as InvestigationRecord[];
		} catch (error) {
			if (isEnoent(error)) return [];
			throw error;
		}
	}

	async #writeRecords(records: readonly InvestigationRecord[]): Promise<void> {
		await fs.mkdir(this.#evidenceDir, { recursive: true });
		const tmpPath = `${this.#requestsPath}.${process.pid}.${Date.now()}.${tempCounter++}.tmp`;
		try {
			await Bun.write(tmpPath, `${JSON.stringify(records, null, 2)}\n`);
			await fs.rename(tmpPath, this.#requestsPath);
		} finally {
			await fs.rm(tmpPath, { force: true });
		}
	}
}
