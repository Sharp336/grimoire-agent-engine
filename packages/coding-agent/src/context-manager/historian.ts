import { countTokens } from "@oh-my-pi/pi-agent-core";
import type { SessionEntry } from "@oh-my-pi/pi-agent-core/compaction/entries";
import { logger, prompt } from "@oh-my-pi/pi-utils";
import type { Settings } from "../config/settings";
import historianEditorSystemTemplate from "../prompts/context-manager/historian-editor-system.md" with { type: "text" };
import historianEditorTurnTemplate from "../prompts/context-manager/historian-editor-turn.md" with { type: "text" };
import historianSystemTemplate from "../prompts/context-manager/historian-system.md" with { type: "text" };
import historianTurnTemplate from "../prompts/context-manager/historian-turn.md" with { type: "text" };
import type { SessionManager } from "../session/session-manager";
import type { ContextAgentRunner } from "./agent-runner";
import {
	HistorianValidationError,
	type ParsedHistorianOutput,
	parseHistorianEditorOutput,
	parseHistorianOutput,
} from "./historian-output";
import { buildReductionUnits, type ReductionUnit } from "./reduction-units";
import type { ContextStore } from "./storage";
import type {
	ContextCompartmentInput,
	ContextCompartmentRecord,
	ContextHistorianRunResult,
	ContextSessionFactInput,
	ContextSessionRecord,
	ContextSessionRuntimeRecord,
	MessageTagRecord,
} from "./types";

const HISTORIAN_VERSION = 1;
const HISTORIAN_LEASE_MARGIN_MS = 30_000;
const HISTORIAN_HEARTBEAT_MS = 10_000;
const COMMIT_HASH = /\b(?=[0-9a-f]{7,40}\b)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/i;

export interface HistorianChunk {
	readonly units: readonly ReductionUnit[];
	readonly tags: readonly MessageTagRecord[];
	readonly entries: readonly SessionEntry[];
	readonly tokenCount: number;
	readonly commitClusters: number;
}

export interface HistorianTriggerDecision {
	readonly shouldRun: boolean;
	readonly blocking: boolean;
	readonly reason?: "forced" | "pressure" | "chunk" | "commit-clusters";
	readonly chunk?: HistorianChunk;
}

export interface HistorianCoordinatorOptions {
	readonly settings: Settings;
	readonly store: ContextStore;
	readonly sessionManager: SessionManager;
}

interface HistorianRunContext {
	readonly session: ContextSessionRecord;
	readonly runtime: ContextSessionRuntimeRecord;
	readonly visibleEntryIds: ReadonlySet<string>;
	readonly chunk: HistorianChunk;
	readonly signal?: AbortSignal;
	readonly merge?: boolean;
}

interface HistorianRecompContext {
	readonly session: ContextSessionRecord;
	readonly runtime: ContextSessionRuntimeRecord;
	readonly visibleEntryIds: ReadonlySet<string>;
	readonly requestId: string;
	readonly startTag: number;
	readonly endTag: number;
	readonly chunks: readonly HistorianChunk[];
	readonly signal?: AbortSignal;
}

function messageText(entry: SessionEntry): string {
	return entry.type === "message" ? JSON.stringify(entry.message) : "";
}

function countCommitClusters(units: readonly ReductionUnit[], entryById: ReadonlyMap<string, SessionEntry>): number {
	let clusters = 0;
	let previousMatched = false;
	for (const unit of units) {
		const matched = unit.entryIds.some(entryId => {
			const entry = entryById.get(entryId);
			return entry ? COMMIT_HASH.test(messageText(entry)) : false;
		});
		if (matched && !previousMatched) clusters++;
		previousMatched = matched;
	}
	return clusters;
}

function clamp(value: number, minimum: number, maximum: number): number {
	return Math.min(maximum, Math.max(minimum, value));
}

export function buildHistorianChunk(
	branch: readonly SessionEntry[],
	tags: readonly MessageTagRecord[],
	compartments: readonly ContextCompartmentRecord[],
	protectedTagCount: number,
	chunkTokenBudget: number,
): HistorianChunk | undefined {
	const activeTags = tags.filter(tag => tag.supersededAt === undefined && tag.entryId !== undefined);
	const tagByOrdinal = new Map(activeTags.map(tag => [tag.tagOrdinal, tag]));
	const entryById = new Map(branch.map(entry => [entry.id, entry]));
	const positionByEntryId = new Map(branch.map((entry, index) => [entry.id, index]));
	let coveredThroughPosition = -1;
	for (const compartment of compartments) {
		const endTag = tagByOrdinal.get(compartment.endTag);
		const position = endTag?.entryId ? positionByEntryId.get(endTag.entryId) : undefined;
		if (position !== undefined) coveredThroughPosition = Math.max(coveredThroughPosition, position);
	}
	const units: ReductionUnit[] = [];
	for (const unit of buildReductionUnits(branch, tags, protectedTagCount)) {
		const firstTag = tagByOrdinal.get(unit.tagOrdinals[0]);
		const firstPosition = firstTag?.entryId ? positionByEntryId.get(firstTag.entryId) : undefined;
		if (firstPosition === undefined || firstPosition <= coveredThroughPosition) continue;
		if (unit.protectionReasons.length > 0 || unit.tagOrdinals.length === 0) break;
		units.push(unit);
	}
	if (units.length === 0) return undefined;
	const selected: ReductionUnit[] = [];
	let tokenCount = 0;
	for (const unit of units) {
		const unitTokens = unit.tagOrdinals.reduce((sum, tag) => sum + (tagByOrdinal.get(tag)?.tokenCount ?? 0), 0);
		if (selected.length > 0 && tokenCount + unitTokens > Math.max(1, chunkTokenBudget)) break;
		selected.push(unit);
		tokenCount += unitTokens;
	}
	const selectedTags = selected
		.flatMap(unit => unit.tagOrdinals)
		.map(tag => tagByOrdinal.get(tag))
		.filter((tag): tag is MessageTagRecord => tag !== undefined);
	const selectedEntryIds = new Set(selected.flatMap(unit => unit.entryIds));
	const entries = branch.filter(entry => selectedEntryIds.has(entry.id));
	return {
		units: selected,
		tags: selectedTags,
		entries,
		tokenCount,
		commitClusters: countCommitClusters(selected, entryById),
	};
}

export function buildHistorianRangeChunk(
	branch: readonly SessionEntry[],
	tags: readonly MessageTagRecord[],
	targetTags: ReadonlySet<number>,
	protectedTagCount: number,
): HistorianChunk | undefined {
	const tagByOrdinal = new Map(
		tags.filter(tag => tag.supersededAt === undefined && tag.entryId !== undefined).map(tag => [tag.tagOrdinal, tag]),
	);
	const units = buildReductionUnits(branch, tags, protectedTagCount).filter(unit =>
		unit.tagOrdinals.some(tag => targetTags.has(tag)),
	);
	if (units.length === 0 || units.some(unit => unit.protectionReasons.length > 0)) return undefined;
	const selectedTags = units
		.flatMap(unit => unit.tagOrdinals)
		.map(tag => tagByOrdinal.get(tag))
		.filter((tag): tag is MessageTagRecord => tag !== undefined);
	const selectedEntryIds = new Set(units.flatMap(unit => unit.entryIds));
	const entries = branch.filter(entry => selectedEntryIds.has(entry.id));
	const entryById = new Map(branch.map(entry => [entry.id, entry]));
	return {
		units,
		tags: selectedTags,
		entries,
		tokenCount: selectedTags.reduce((sum, tag) => sum + tag.tokenCount, 0),
		commitClusters: countCommitClusters(units, entryById),
	};
}

export function buildHistorianRangeChunks(
	branch: readonly SessionEntry[],
	tags: readonly MessageTagRecord[],
	targetTags: ReadonlySet<number>,
	protectedTagCount: number,
	chunkTokenBudget: number,
): HistorianChunk[] {
	const tagByOrdinal = new Map(
		tags.filter(tag => tag.supersededAt === undefined && tag.entryId !== undefined).map(tag => [tag.tagOrdinal, tag]),
	);
	const selectedUnits = buildReductionUnits(branch, tags, protectedTagCount).filter(unit =>
		unit.tagOrdinals.some(tag => targetTags.has(tag)),
	);
	if (selectedUnits.length === 0 || selectedUnits.some(unit => unit.protectionReasons.length > 0)) return [];
	const groups: ReductionUnit[][] = [];
	let group: ReductionUnit[] = [];
	let groupTokens = 0;
	for (const unit of selectedUnits) {
		const unitTokens = unit.tagOrdinals.reduce((sum, tag) => sum + (tagByOrdinal.get(tag)?.tokenCount ?? 0), 0);
		if (group.length > 0 && groupTokens + unitTokens > Math.max(1, chunkTokenBudget)) {
			groups.push(group);
			group = [];
			groupTokens = 0;
		}
		group.push(unit);
		groupTokens += unitTokens;
	}
	if (group.length > 0) groups.push(group);
	const entryById = new Map(branch.map(entry => [entry.id, entry]));
	return groups.map(units => {
		const chunkTags = units
			.flatMap(unit => unit.tagOrdinals)
			.map(tag => tagByOrdinal.get(tag))
			.filter((tag): tag is MessageTagRecord => tag !== undefined);
		const entryIds = new Set(units.flatMap(unit => unit.entryIds));
		return {
			units,
			tags: chunkTags,
			entries: branch.filter(entry => entryIds.has(entry.id)),
			tokenCount: chunkTags.reduce((sum, tag) => sum + tag.tokenCount, 0),
			commitClusters: countCommitClusters(units, entryById),
		};
	});
}

export function decideHistorianTrigger(
	runtime: ContextSessionRuntimeRecord,
	chunk: HistorianChunk | undefined,
	chunkTokenThreshold: number,
	force = false,
	commitClusterMinClusters = 3,
): HistorianTriggerDecision {
	if (!chunk) return { shouldRun: false, blocking: false };
	if (force) return { shouldRun: true, blocking: true, reason: "forced", chunk };
	if (runtime.totalTokens >= runtime.executeThresholdTokens) {
		return { shouldRun: true, blocking: true, reason: "pressure", chunk };
	}
	if (chunk.tokenCount >= Math.max(1, chunkTokenThreshold)) {
		return { shouldRun: true, blocking: false, reason: "chunk", chunk };
	}
	const commitTailThreshold = clamp(runtime.executeThresholdTokens * 0.05, 5_000, 50_000);
	if (
		commitClusterMinClusters > 0 &&
		chunk.commitClusters >= commitClusterMinClusters &&
		chunk.tokenCount >= commitTailThreshold
	) {
		return { shouldRun: true, blocking: false, reason: "commit-clusters", chunk };
	}
	return { shouldRun: false, blocking: false, chunk };
}

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function sourceDate(entry: SessionEntry | undefined): string {
	if (!entry) return new Date(0).toISOString();
	if (entry.type === "message" && Number.isFinite(entry.message.timestamp)) {
		return new Date(entry.message.timestamp).toISOString();
	}
	const parsed = Date.parse(entry.timestamp);
	return Number.isFinite(parsed) ? new Date(parsed).toISOString() : new Date(0).toISOString();
}

function sourceHash(tags: readonly MessageTagRecord[]): string {
	const hasher = new Bun.CryptoHasher("sha256");
	for (const tag of tags) hasher.update(`${tag.tagOrdinal}:${tag.contentHash}\n`);
	return hasher.digest("hex");
}

function serializeCanonicalRecords(chunk: HistorianChunk): string {
	const tagByEntryId = new Map(
		chunk.tags.filter(tag => tag.entryId !== undefined).map(tag => [tag.entryId!, tag.tagOrdinal]),
	);
	return JSON.stringify(
		chunk.entries.map(entry => ({
			tag: tagByEntryId.get(entry.id),
			entryId: entry.id,
			timestamp: entry.timestamp,
			message: entry.type === "message" ? entry.message : entry,
		})),
		null,
		2,
	);
}

function applyEditorOutput(original: ParsedHistorianOutput, editorText: string): ParsedHistorianOutput {
	const edits = parseHistorianEditorOutput(editorText, original);
	return {
		compartments: original.compartments.map((compartment, index) => ({ ...compartment, ...edits[index] })),
		facts: original.facts,
	};
}

/** Coordinates historian candidate fallback, validation, staging, publication, and DB-backed single-flight. */
export class HistorianCoordinator {
	readonly #settings: Settings;
	readonly #store: ContextStore;
	readonly #sessionManager: SessionManager;
	readonly #ownerId = `historian:${process.pid}:${Bun.randomUUIDv7()}`;
	readonly #inFlight = new Map<string, Promise<ContextHistorianRunResult>>();
	readonly #abortController = new AbortController();
	#runner: ContextAgentRunner | undefined;
	#disposing = false;

	constructor(options: HistorianCoordinatorOptions) {
		this.#settings = options.settings;
		this.#store = options.store;
		this.#sessionManager = options.sessionManager;
	}

	setRunner(runner: ContextAgentRunner): void {
		this.#runner = runner;
	}

	running(sessionId: string): boolean {
		return this.#inFlight.has(sessionId);
	}

	plan(
		session: ContextSessionRecord,
		runtime: ContextSessionRuntimeRecord,
		branch: readonly SessionEntry[],
		tags: readonly MessageTagRecord[],
		visibleEntryIds: ReadonlySet<string>,
		force = false,
		protectedTagCount = this.#settings.get("contextManager.protectedTags"),
	): HistorianTriggerDecision {
		if (this.#disposing || !this.#settings.get("contextManager.historian.enabled")) {
			return { shouldRun: false, blocking: false };
		}
		if (this.#store.hasPendingHistorianPublication(session.id, session.activeGeneration)) {
			return { shouldRun: false, blocking: false };
		}
		const compartments = this.#store.listActiveCompartments(session.id, session.activeGeneration, visibleEntryIds);
		const chunk = buildHistorianChunk(
			branch,
			tags,
			compartments,
			protectedTagCount,
			this.#settings.get("contextManager.historian.chunkTokens"),
		);
		const commitClusterMinClusters = this.#settings.get("contextManager.commitCluster.enabled")
			? Math.max(1, Math.floor(this.#settings.get("contextManager.commitCluster.minClusters")))
			: 0;
		return decideHistorianTrigger(
			runtime,
			chunk,
			this.#settings.get("contextManager.historian.chunkTokens"),
			force,
			commitClusterMinClusters,
		);
	}

	mergeOldest(
		session: ContextSessionRecord,
		runtime: ContextSessionRuntimeRecord,
		branch: readonly SessionEntry[],
		tags: readonly MessageTagRecord[],
		visibleEntryIds: ReadonlySet<string>,
		omittedCompartmentIds: readonly string[],
		signal?: AbortSignal,
	): Promise<ContextHistorianRunResult> {
		if (
			omittedCompartmentIds.length === 0 ||
			this.#store.hasPendingHistorianPublication(session.id, session.activeGeneration)
		) {
			return Promise.resolve({ status: "noop", compartments: 0, facts: 0 });
		}
		const compartments = this.#store
			.listActiveCompartments(session.id, session.activeGeneration, visibleEntryIds)
			.sort((left, right) => left.startTag - right.startTag);
		const omitted = new Set(omittedCompartmentIds);
		const omittedIndex = compartments.findIndex(compartment => omitted.has(compartment.id));
		if (omittedIndex < 0 || compartments.length < 2) {
			return Promise.resolve({ status: "noop", compartments: 0, facts: 0 });
		}
		const pairStart = omittedIndex < compartments.length - 1 ? omittedIndex : omittedIndex - 1;
		const pair = compartments.slice(pairStart, pairStart + 2);
		const chunk = buildHistorianRangeChunk(
			branch,
			tags,
			new Set(pair.flatMap(compartment => compartment.tagOrdinals)),
			this.#settings.get("contextManager.protectedTags"),
		);
		if (!chunk) return Promise.resolve({ status: "noop", compartments: 0, facts: 0 });
		return this.run(session, runtime, visibleEntryIds, chunk, signal, { merge: true });
	}

	recomp(
		session: ContextSessionRecord,
		runtime: ContextSessionRuntimeRecord,
		branch: readonly SessionEntry[],
		tags: readonly MessageTagRecord[],
		visibleEntryIds: ReadonlySet<string>,
		range?: { readonly startTag: number; readonly endTag: number },
		signal?: AbortSignal,
	): Promise<ContextHistorianRunResult> {
		if (this.#disposing || !this.#runner) {
			return Promise.resolve({ status: "unavailable", compartments: 0, facts: 0 });
		}
		const existingRun = this.#inFlight.get(session.id);
		if (existingRun) return existingRun;
		if (
			range &&
			(!Number.isSafeInteger(range.startTag) ||
				!Number.isSafeInteger(range.endTag) ||
				range.startTag < 1 ||
				range.endTag < range.startTag)
		) {
			return Promise.resolve({
				status: "failed",
				compartments: 0,
				facts: 0,
				error: "Invalid recomp tag range",
			});
		}
		const activeCompartments = this.#store.listActiveCompartments(
			session.id,
			session.activeGeneration,
			visibleEntryIds,
		);
		let startTag = range?.startTag;
		let endTag = range?.endTag;
		if (range) {
			const overlapping = activeCompartments.filter(
				compartment => compartment.endTag >= range.startTag && compartment.startTag <= range.endTag,
			);
			if (overlapping.length > 0) {
				startTag = Math.min(...overlapping.map(compartment => compartment.startTag));
				endTag = Math.max(...overlapping.map(compartment => compartment.endTag));
			}
		}
		const eligibleUnits: ReductionUnit[] = [];
		for (const unit of buildReductionUnits(branch, tags, this.#settings.get("contextManager.protectedTags"))) {
			if (unit.protectionReasons.length > 0) break;
			if (unit.tagOrdinals.length > 0) eligibleUnits.push(unit);
		}
		const targetTags = new Set(
			eligibleUnits
				.flatMap(unit => unit.tagOrdinals)
				.filter(tag => (startTag === undefined || tag >= startTag) && (endTag === undefined || tag <= endTag)),
		);
		if (targetTags.size === 0) {
			return Promise.resolve({ status: "noop", compartments: 0, facts: 0 });
		}
		startTag = Math.min(...targetTags);
		endTag = Math.max(...targetTags);
		const requestId = `recomp:${session.id}:${session.activeGeneration}:${startTag}-${endTag}`;
		const otherRequests = this.#store
			.listHistorianStagingRequests(session.id)
			.filter(existingRequest => existingRequest !== requestId);
		if (otherRequests.length > 0) {
			return Promise.resolve({
				status: "busy",
				compartments: 0,
				facts: 0,
				error: `Another historian staging request is pending: ${otherRequests[0]}`,
			});
		}
		let staged = this.#store.listStagedCompartments(requestId);
		const currentTags = new Map(tags.map(tag => [tag.tagOrdinal, tag]));
		const stagingValid = staged.every(compartment => {
			const rangeTags = compartment.tagOrdinals
				.map(tag => currentTags.get(tag))
				.filter((tag): tag is MessageTagRecord => tag !== undefined);
			return rangeTags.length === compartment.tagOrdinals.length && sourceHash(rangeTags) === compartment.sourceHash;
		});
		if (!stagingValid) {
			this.#store.discardHistorianStaging(requestId);
			staged = [];
		}
		const coveredTags = new Set(staged.flatMap(compartment => compartment.tagOrdinals));
		const allChunks = buildHistorianRangeChunks(
			branch,
			tags,
			targetTags,
			this.#settings.get("contextManager.protectedTags"),
			this.#settings.get("contextManager.historian.chunkTokens"),
		);
		const chunks = allChunks.filter(chunk => !chunk.tags.every(tag => coveredTags.has(tag.tagOrdinal)));
		if (
			chunks.some(
				chunk =>
					chunk.tags.some(tag => coveredTags.has(tag.tagOrdinal)) &&
					!chunk.tags.every(tag => coveredTags.has(tag.tagOrdinal)),
			)
		) {
			this.#store.discardHistorianStaging(requestId);
			staged = [];
			coveredTags.clear();
		}
		const promise = this.#runRecompOwned({
			session,
			runtime,
			visibleEntryIds,
			requestId,
			startTag,
			endTag,
			chunks: staged.length === 0 ? allChunks : chunks,
			signal,
		})
			.catch(
				(error): ContextHistorianRunResult => ({
					status: "failed",
					compartments: 0,
					facts: 0,
					error: describeError(error),
				}),
			)
			.finally(() => {
				if (this.#inFlight.get(session.id) === promise) this.#inFlight.delete(session.id);
			});
		this.#inFlight.set(session.id, promise);
		return promise;
	}

	run(
		session: ContextSessionRecord,
		runtime: ContextSessionRuntimeRecord,
		visibleEntryIds: ReadonlySet<string>,
		chunk: HistorianChunk,
		signal?: AbortSignal,
		options: { readonly merge?: boolean } = {},
	): Promise<ContextHistorianRunResult> {
		if (this.#disposing || !this.#runner) {
			return Promise.resolve({ status: "unavailable", compartments: 0, facts: 0 });
		}
		const existing = this.#inFlight.get(session.id);
		if (existing) return existing;
		const promise = this.#runOwned({
			session,
			runtime,
			visibleEntryIds,
			chunk,
			signal,
			merge: options.merge,
		})
			.catch((error): ContextHistorianRunResult => {
				logger.warn("Managed context historian crashed outside its publication guard", {
					sessionId: session.id,
					error: describeError(error),
				});
				return { status: "failed", compartments: 0, facts: 0, error: describeError(error) };
			})
			.finally(() => {
				if (this.#inFlight.get(session.id) === promise) this.#inFlight.delete(session.id);
			});
		this.#inFlight.set(session.id, promise);
		return promise;
	}

	async #runRecompOwned(context: HistorianRecompContext): Promise<ContextHistorianRunResult> {
		const runner = this.#runner;
		if (!runner) return { status: "unavailable", compartments: 0, facts: 0 };
		const jobId = `historian:${context.session.id}`;
		this.#store.ensureJob({
			id: jobId,
			projectId: context.session.projectId,
			sessionId: context.session.id,
			kind: "recomp",
			task: context.requestId,
			payload: { requestId: context.requestId, remainingPasses: context.chunks.length },
		});
		const timeoutMs = Math.max(1, this.#settings.get("contextManager.historian.timeoutMs"));
		const leaseTtlMs = timeoutMs + HISTORIAN_LEASE_MARGIN_MS;
		if (!this.#store.tryAcquireJobLease(jobId, this.#ownerId, leaseTtlMs)) {
			return { status: "busy", compartments: 0, facts: 0 };
		}
		const runAbort = new AbortController();
		const forwardAbort = (): void => runAbort.abort(context.signal?.reason);
		const disposeAbort = (): void => runAbort.abort(this.#abortController.signal.reason);
		context.signal?.addEventListener("abort", forwardAbort, { once: true });
		this.#abortController.signal.addEventListener("abort", disposeAbort, { once: true });
		let leaseOwned = true;
		const heartbeat = setInterval(() => {
			if (!this.#store.heartbeatJobLease(jobId, this.#ownerId, leaseTtlMs)) {
				leaseOwned = false;
				runAbort.abort(new Error("Historian recomp lease ownership was lost"));
			}
		}, HISTORIAN_HEARTBEAT_MS);
		try {
			let append = this.#store.listStagedCompartments(context.requestId).length > 0;
			for (const chunk of context.chunks) {
				const chunkTags = new Set(chunk.tags.map(tag => tag.tagOrdinal));
				const continuity = this.#store
					.listActiveCompartments(context.session.id, context.session.activeGeneration, context.visibleEntryIds)
					.filter(compartment => !compartment.tagOrdinals.some(tag => chunkTags.has(tag)));
				const validated = await this.#invokeHistorian(runner, chunk, continuity, timeoutMs, runAbort.signal, false);
				const inputs = this.#buildStorageInputs(
					{
						session: context.session,
						runtime: context.runtime,
						visibleEntryIds: context.visibleEntryIds,
						chunk,
						signal: runAbort.signal,
					},
					validated,
				);
				this.#store.stageHistorianResult(context.requestId, inputs.compartments, inputs.facts, append);
				append = true;
				if (!leaseOwned || !this.#store.heartbeatJobLease(jobId, this.#ownerId, leaseTtlMs)) {
					throw new Error("Historian recomp lease expired before the next pass");
				}
			}
			if (!leaseOwned || !this.#store.heartbeatJobLease(jobId, this.#ownerId, leaseTtlMs)) {
				throw new Error("Historian recomp lease expired before publication");
			}
			const published = this.#store.publishHistorianResult(
				context.requestId,
				context.session.id,
				context.session.activeGeneration,
			);
			if (!this.#store.finishJob(jobId, this.#ownerId, "succeeded")) {
				throw new Error("Historian recomp published after lease ownership was lost");
			}
			return {
				status: "published",
				compartments: published.compartments,
				facts: published.facts,
				startTag: context.startTag,
				endTag: context.endTag,
			};
		} catch (error) {
			if (runAbort.signal.aborted) {
				this.#store.releaseJobLease(jobId, this.#ownerId, "pending");
			} else {
				this.#store.finishJob(jobId, this.#ownerId, "failed", { error: describeError(error) });
			}
			logger.warn("Managed context recomp failed without replacing active history", {
				sessionId: context.session.id,
				requestId: context.requestId,
				error: describeError(error),
			});
			return { status: "failed", compartments: 0, facts: 0, error: describeError(error) };
		} finally {
			clearInterval(heartbeat);
			context.signal?.removeEventListener("abort", forwardAbort);
			this.#abortController.signal.removeEventListener("abort", disposeAbort);
		}
	}

	async #runOwned(context: HistorianRunContext): Promise<ContextHistorianRunResult> {
		const runner = this.#runner;
		if (!runner) return { status: "unavailable", compartments: 0, facts: 0 };
		const jobId = `historian:${context.session.id}`;
		this.#store.ensureJob({
			id: jobId,
			projectId: context.session.projectId,
			sessionId: context.session.id,
			kind: "historian",
			task: context.merge ? "merge" : "incremental",
			payload: { startTag: context.chunk.tags[0]?.tagOrdinal, endTag: context.chunk.tags.at(-1)?.tagOrdinal },
		});
		const timeoutMs = Math.max(1, this.#settings.get("contextManager.historian.timeoutMs"));
		const leaseTtlMs = timeoutMs + HISTORIAN_LEASE_MARGIN_MS;
		if (!this.#store.tryAcquireJobLease(jobId, this.#ownerId, leaseTtlMs)) {
			return { status: "busy", compartments: 0, facts: 0 };
		}
		const runAbort = new AbortController();
		const forwardAbort = (): void => runAbort.abort(context.signal?.reason);
		const disposeAbort = (): void => runAbort.abort(this.#abortController.signal.reason);
		context.signal?.addEventListener("abort", forwardAbort, { once: true });
		this.#abortController.signal.addEventListener("abort", disposeAbort, { once: true });
		let leaseOwned = true;
		const heartbeat = setInterval(() => {
			if (!this.#store.heartbeatJobLease(jobId, this.#ownerId, leaseTtlMs)) {
				leaseOwned = false;
				runAbort.abort(new Error("Historian lease ownership was lost"));
			}
		}, HISTORIAN_HEARTBEAT_MS);
		const requestId = `${jobId}:${Bun.randomUUIDv7()}`;
		try {
			const chunkTagSet = new Set(context.chunk.tags.map(tag => tag.tagOrdinal));
			const existingCompartments = this.#store
				.listActiveCompartments(context.session.id, context.session.activeGeneration, context.visibleEntryIds)
				.filter(compartment => !compartment.tagOrdinals.some(tag => chunkTagSet.has(tag)));
			const validated = await this.#invokeHistorian(
				runner,
				context.chunk,
				existingCompartments,
				timeoutMs,
				runAbort.signal,
				context.merge === true,
			);
			const inputs = this.#buildStorageInputs(context, validated);
			this.#store.stageHistorianResult(requestId, inputs.compartments, inputs.facts);
			if (!leaseOwned || !this.#store.heartbeatJobLease(jobId, this.#ownerId, leaseTtlMs)) {
				throw new Error("Historian lease expired before publication");
			}
			const published = this.#store.publishHistorianResult(
				requestId,
				context.session.id,
				context.session.activeGeneration,
			);
			if (!this.#store.finishJob(jobId, this.#ownerId, "succeeded")) {
				throw new Error("Historian publication succeeded after lease ownership was lost");
			}
			return {
				status: "published",
				compartments: published.compartments,
				facts: published.facts,
				startTag: context.chunk.tags[0]?.tagOrdinal,
				endTag: context.chunk.tags.at(-1)?.tagOrdinal,
			};
		} catch (error) {
			try {
				this.#store.discardHistorianStaging(requestId);
				this.#store.finishJob(jobId, this.#ownerId, "failed", { error: describeError(error) });
			} catch {
				// The controller may have closed a failed derived store while this hidden run was aborting.
			}
			logger.warn("Managed context historian failed", {
				sessionId: context.session.id,
				error: describeError(error),
			});
			return { status: "failed", compartments: 0, facts: 0, error: describeError(error) };
		} finally {
			clearInterval(heartbeat);
			context.signal?.removeEventListener("abort", forwardAbort);
			this.#abortController.signal.removeEventListener("abort", disposeAbort);
		}
	}

	async #invokeHistorian(
		runner: ContextAgentRunner,
		chunk: HistorianChunk,
		existingCompartments: readonly ContextCompartmentRecord[],
		timeoutMs: number,
		signal: AbortSignal,
		merge: boolean,
	): Promise<ParsedHistorianOutput> {
		const toolNames = this.#settings.get("contextManager.historian.tools");
		const systemPrompt = prompt.render(historianSystemTemplate, { toolNames });
		const tagSequence = chunk.tags.map(tag => tag.tagOrdinal);
		const baseTemplateContext = {
			repair: false,
			merge,
			language: this.#settings.get("contextManager.language"),
			tag_sequence: tagSequence.join(", "),
			canonical_records: serializeCanonicalRecords(chunk),
			existing_compartments: JSON.stringify(
				existingCompartments.map(compartment => ({
					startTag: compartment.startTag,
					endTag: compartment.endTag,
					title: compartment.title,
					p3: compartment.p3,
				})),
				null,
				2,
			),
		};
		const validateOutput = (text: string): ParsedHistorianOutput => {
			const output = parseHistorianOutput(text, tagSequence);
			if (merge && output.compartments.length !== 1) {
				throw new HistorianValidationError("Historian merge pass must return exactly one compartment");
			}
			return output;
		};
		const candidates = runner.resolveCandidates("historian", true);
		if (candidates.length === 0) throw new Error("No model is available for the historian role");
		let lastError = "Historian candidates returned no valid output";
		for (const candidate of candidates) {
			let output: string;
			try {
				output = await runner.run({
					candidate,
					systemPrompt,
					userPrompt: prompt.render(historianTurnTemplate, baseTemplateContext),
					toolNames,
					timeoutMs,
					signal,
				});
			} catch (error) {
				lastError = `${candidate.selector}: ${describeError(error)}`;
				continue;
			}
			let validated: ParsedHistorianOutput;
			try {
				validated = validateOutput(output);
			} catch (error) {
				const validationError = describeError(error);
				try {
					const repaired = await runner.run({
						candidate,
						systemPrompt,
						userPrompt: prompt.render(historianTurnTemplate, {
							...baseTemplateContext,
							repair: true,
							validation_error: validationError,
							previous_response: output,
						}),
						toolNames,
						timeoutMs,
						signal,
					});
					validated = validateOutput(repaired);
				} catch (repairError) {
					lastError = `${candidate.selector}: ${describeError(repairError)}`;
					continue;
				}
			}
			if (this.#settings.get("contextManager.historian.twoPass")) {
				try {
					const edited = await runner.run({
						candidate,
						systemPrompt: prompt.render(historianEditorSystemTemplate),
						userPrompt: prompt.render(historianEditorTurnTemplate, {
							validated_result: JSON.stringify(validated, null, 2),
						}),
						timeoutMs,
						signal,
					});
					validated = applyEditorOutput(validated, edited);
				} catch (error) {
					if (!(error instanceof HistorianValidationError)) {
						logger.debug("Historian editor failed; keeping validated first pass", {
							error: describeError(error),
						});
					}
				}
			}
			return validated;
		}
		throw new Error(lastError);
	}

	#buildStorageInputs(
		context: HistorianRunContext,
		validated: ParsedHistorianOutput,
	): {
		readonly compartments: readonly ContextCompartmentInput[];
		readonly facts: readonly ContextSessionFactInput[];
	} {
		const tagPosition = new Map(context.chunk.tags.map((tag, index) => [tag.tagOrdinal, index]));
		const entryById = new Map(context.chunk.entries.map(entry => [entry.id, entry]));
		const compartmentInputs = validated.compartments.map(compartment => {
			const start = tagPosition.get(compartment.startTag);
			const end = tagPosition.get(compartment.endTag);
			if (start === undefined || end === undefined) throw new Error("Validated historian range disappeared");
			const rangeTags = context.chunk.tags.slice(start, end + 1);
			return {
				sessionId: context.session.id,
				scopeLeafEntryId: this.#sessionManager.getLeafId() ?? context.session.currentLeafEntryId ?? "",
				startTag: compartment.startTag,
				endTag: compartment.endTag,
				tagOrdinals: rangeTags.map(tag => tag.tagOrdinal),
				title: compartment.title,
				p1: compartment.p1,
				p2: compartment.p2,
				p3: compartment.p3,
				startDate: sourceDate(entryById.get(rangeTags[0]?.entryId ?? "")),
				endDate: sourceDate(entryById.get(rangeTags.at(-1)?.entryId ?? "")),
				p1Tokens: countTokens(compartment.p1),
				p2Tokens: countTokens(compartment.p2),
				p3Tokens: countTokens(compartment.p3),
				sourceHash: sourceHash(rangeTags),
				historianVersion: HISTORIAN_VERSION,
				generation: context.session.activeGeneration,
			} satisfies ContextCompartmentInput;
		});
		const factInputs = validated.facts.map(fact => ({
			sessionId: context.session.id,
			projectId: context.session.projectId,
			generation: context.session.activeGeneration,
			text: fact.text,
			category: fact.type,
			confidence: fact.confidence,
			scope: fact.scope,
			startTag: Math.min(...fact.sourceTags),
			endTag: Math.max(...fact.sourceTags),
			sourceTags: fact.sourceTags,
		})) satisfies ContextSessionFactInput[];
		return { compartments: compartmentInputs, facts: factInputs };
	}

	beginDispose(): void {
		if (this.#disposing) return;
		this.#disposing = true;
		this.#abortController.abort(new Error("Historian coordinator is disposing"));
	}

	async dispose(timeoutMs = 5_000): Promise<void> {
		this.beginDispose();
		if (this.#inFlight.size === 0) return;
		await Promise.race([Promise.allSettled(this.#inFlight.values()), Bun.sleep(Math.max(1, timeoutMs))]);
	}
}
