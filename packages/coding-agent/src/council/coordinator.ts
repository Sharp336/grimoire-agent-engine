import { AgentBusyError } from "@oh-my-pi/pi-agent-core";
import { logger, prompt } from "@oh-my-pi/pi-utils";
import type { ModelRegistry } from "../config/model-registry";
import type { Settings } from "../config/settings";
import adjudicationRepairTemplate from "../prompts/council/adjudication-repair.md" with { type: "text" };
import adjudicationRoundOneTemplate from "../prompts/council/adjudication-round-1.md" with { type: "text" };
import adjudicationRoundTwoTemplate from "../prompts/council/adjudication-round-2.md" with { type: "text" };
import memberTaskTemplate from "../prompts/council/member-task.md" with { type: "text" };
import plannerTaskTemplate from "../prompts/council/planner-task.md" with { type: "text" };
import councilSummaryTemplate from "../prompts/council/summary.md" with { type: "text" };
import { MAIN_AGENT_ID } from "../registry/agent-registry";
import type { AgentSession } from "../session/agent-session";
import type { SessionManager } from "../session/session-manager";
import { withSessionSpawnPermit } from "../task";
import {
	runStructuredSubagent,
	type StructuredSubagentRequest,
	type StructuredSubagentResult,
} from "../task/structured-subagent";
import type { AgentProgress } from "../task/types";
import type { ToolSession } from "../tools";
import { sha256CouncilContent } from "./hash";
import {
	type CouncilDispatchPlan,
	type CouncilMainDispatchSnapshot,
	councilDispatchWarnings,
	preflightCouncilDispatch,
	preflightCouncilMainDispatch,
	resolveCouncilMainEffort,
} from "./preflight";
import { inspectPromisedCouncilPublication, publishCouncilPlan } from "./publication";
import {
	type CouncilAdjudication,
	type CouncilFinding,
	type CouncilPlannerOutput,
	type CouncilReport,
	validateCouncilAdjudication,
	validateCouncilPlannerOutput,
	validateIncomingCouncilReport,
	validatePersistedCouncilReport,
} from "./schema";
import {
	COUNCIL_MANIFEST_VERSION,
	type CouncilInstructionSnapshot,
	type CouncilManifest,
	type CouncilPlannerSnapshot,
	type CouncilResolvedRosterMember,
	type CouncilRoundMemberRecord,
	isCouncilResumeCompatible,
	isCouncilTerminalState,
	parseCouncilInstructionSnapshot,
	parseCouncilManifest,
} from "./state";
import { type CouncilStorage, createCouncilStorage } from "./storage";

export const COUNCIL_ADJUDICATION_INJECTION_CAP = 80_000;
const COUNCIL_CANCEL_DRAIN_TIMEOUT_MS = 5_000;
const COUNCIL_PROGRESS_OUTPUT_LIMIT = 8;
const COUNCIL_PROGRESS_LINE_LIMIT = 500;
const COUNCIL_MEMBER_FAILURE_SANITIZE_LIMIT = 4_000;
const COUNCIL_SUMMARY_WARNING_COUNT_LIMIT = 8;
const COUNCIL_SUMMARY_WARNING_CHAR_LIMIT = 500;
const PLANNER_METADATA_MARKER = "council-planner-metadata";
const ADJUDICATION_METADATA_MARKER = "council-adjudication-metadata";

export interface CouncilCoordinatorHost {
	session: AgentSession;
	toolSession: ToolSession;
	sessionManager: SessionManager;
	settings: Settings;
	modelRegistry: ModelRegistry;
	onStateChange?: (snapshot: CouncilManifest) => void;
	now?: () => string | Date;
	runId?: string | (() => string);
}

export interface CouncilMemberLiveProgress {
	round: number;
	role: string;
	order: number;
	attempt: number;
	status: AgentProgress["status"];
	lastIntent?: string;
	currentTool?: string;
	currentToolArgs?: string;
	recentOutput: string[];
	requests: number;
	tokens: number;
	cost: number;
	retryState?: AgentProgress["retryState"];
}

export interface CouncilCoordinatorSnapshot {
	manifest: CouncilManifest;
	members: CouncilMemberLiveProgress[];
	mainTurnOwned: boolean;
}

type CoordinatorListener = (snapshot: CouncilCoordinatorSnapshot) => void;

interface PersistedPlannerMetadata {
	assumptions: string[];
	blockers: string[];
	evidenceVersion: "1.0.0";
}

interface PersistedAdjudicationMetadata {
	adjudication: CouncilAdjudication;
}

interface RoundLedger {
	reports: Array<CouncilReport | undefined>;
	failures: Array<{ role: string; reason: string } | undefined>;
}

interface BoundedCouncilReports {
	text: string;
	overflowCount: number;
	overflowIds: string;
}

interface CoordinatorRegistryEntry {
	coordinator: CouncilCoordinator;
	session: AgentSession;
	toolSession: ToolSession;
	sessionManager: SessionManager;
}

const coordinators = new Map<string, CoordinatorRegistryEntry>();
const activeCoordinators = new Map<string, CouncilCoordinator>();
const executingCoordinators = new WeakSet<CouncilCoordinator>();

function modelIdentity(model: { provider: string; id: string }): string {
	return `${model.provider}/${model.id}`;
}

function nullableEffort(effort: unknown): string | null {
	return typeof effort === "string" ? effort : null;
}

function encodeMetadata(marker: string, value: unknown): string {
	return `\n\n<!-- ${marker}:${Buffer.from(JSON.stringify(value)).toString("base64")} -->\n`;
}

function decodeMetadataFrame<T>(content: string, marker: string): { content: string; metadata: T } {
	const prefix = `\n\n<!-- ${marker}:`;
	const suffix = " -->\n";
	const frameIndex = content.lastIndexOf(prefix);
	if (frameIndex < 0 || !content.endsWith(suffix)) throw new Error(`Council artifact is missing ${marker}`);
	const encoded = content.slice(frameIndex + prefix.length, -suffix.length);
	if (!/^[A-Za-z0-9+/=]+$/.test(encoded)) throw new Error(`Council artifact has invalid ${marker}`);
	return {
		content: content.slice(0, frameIndex),
		metadata: JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as T,
	};
}

function decodeMetadata<T>(content: string, marker: string): T {
	return decodeMetadataFrame<T>(content, marker).metadata;
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string | undefined {
	return error && typeof error === "object" && "code" in error && typeof error.code === "string"
		? error.code
		: undefined;
}

function usageCost(result: StructuredSubagentResult["result"]): number {
	const usage = result.usage;
	if (!usage || typeof usage !== "object" || !("cost" in usage)) return 0;
	const cost = usage.cost;
	if (typeof cost === "number" && Number.isFinite(cost) && cost >= 0) return cost;
	if (
		cost &&
		typeof cost === "object" &&
		"total" in cost &&
		typeof cost.total === "number" &&
		Number.isFinite(cost.total)
	) {
		return Math.max(0, cost.total);
	}
	return 0;
}

function rosterFromPlan(plan: CouncilDispatchPlan): CouncilResolvedRosterMember[] {
	return plan.members.map(member => ({
		role: member.role,
		enabled: true,
		order: member.order,
		requestedSelector: member.requestedSelector,
		resolvedModel: modelIdentity(member.model),
		effort: nullableEffort(member.effort),
		lens: member.lens,
	}));
}

function plannerFromPlan(plan: CouncilDispatchPlan): CouncilPlannerSnapshot {
	return {
		requestedSelector: plan.planner.requestedSelector,
		resolvedModel: modelIdentity(plan.planner.model),
		effort: nullableEffort(plan.planner.effort),
	};
}

function blankMember(member: CouncilResolvedRosterMember): CouncilRoundMemberRecord {
	return {
		role: member.role,
		order: member.order,
		status: "pending",
		attempts: 0,
		startedAt: null,
		finishedAt: null,
		artifact: null,
		resolvedModel: null,
		authFallbackUsed: false,
		failureReason: null,
		findingIds: [],
	};
}

function sameJson(left: unknown, right: unknown): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

function abortError(): Error {
	const error = new Error("Council run cancelled");
	error.name = "AbortError";
	return error;
}

function isAbort(error: unknown, signal: AbortSignal): boolean {
	return signal.aborted || (error instanceof Error && error.name === "AbortError");
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) return Promise.reject(abortError());
	const deferred = Promise.withResolvers<T>();
	const abort = () => deferred.reject(abortError());
	signal.addEventListener("abort", abort, { once: true });
	void promise.then(deferred.resolve, deferred.reject);
	return deferred.promise.finally(() => signal.removeEventListener("abort", abort));
}

function severityRank(finding: CouncilFinding): number {
	switch (finding.severity) {
		case "critical":
			return 0;
		case "high":
			return 1;
		case "medium":
			return 2;
		case "low":
			return 3;
	}
}

function boundedReports(ledger: RoundLedger, maxChars: number): BoundedCouncilReports {
	const failureRecords = ledger.failures.flatMap((failure, index) =>
		failure
			? [
					{
						role: failure.role,
						slot: index + 1,
						prefix: `Member ${failure.role} (slot ${index + 1}) failed: `,
						reason: failure.reason
							.slice(0, COUNCIL_MEMBER_FAILURE_SANITIZE_LIMIT)
							.replace(/[\u0000-\u001f\u007f]+/g, " ")
							.replace(/\s+/g, " ")
							.trim(),
					},
				]
			: [],
	);
	const failures: string[] = [];
	const separatorChars = Math.max(0, failureRecords.length - 1);
	const prefixChars = failureRecords.reduce((total, failure) => total + failure.prefix.length, 0);
	if (prefixChars + separatorChars <= maxChars) {
		let reasonChars = maxChars - prefixChars - separatorChars;
		for (const [index, failure] of failureRecords.entries()) {
			const remainingFailures = failureRecords.length - index;
			const allocation = Math.min(1_000, Math.floor(reasonChars / remainingFailures));
			const reason = failure.reason || "unknown failure";
			const clipped = reason.slice(0, allocation);
			failures.push(failure.prefix + clipped);
			reasonChars -= clipped.length;
		}
	} else {
		let compactChars = 0;
		for (const failure of failureRecords) {
			const line = `[slot ${failure.slot}:${failure.role}]`;
			const required = line.length + (failures.length > 0 ? 1 : 0);
			if (compactChars + required > maxChars) break;
			failures.push(line);
			compactChars += required;
		}
	}
	const findings = ledger.reports
		.flatMap(
			(report, slot) => report?.findings.map(finding => ({ finding, slot, readiness: report.readiness })) ?? [],
		)
		.sort((left, right) => severityRank(left.finding) - severityRank(right.finding) || left.slot - right.slot);
	const included = [...failures];
	let used = failures.reduce((total, line) => total + line.length, 0) + Math.max(0, failures.length - 1);
	const omittedIds: string[] = [];
	for (const item of findings) {
		const chunk = JSON.stringify({ slot: item.slot + 1, readiness: item.readiness, finding: item.finding });
		const separator = included.length > 0 ? 1 : 0;
		if (used + separator + chunk.length <= maxChars) {
			included.push(chunk);
			used += separator + chunk.length;
		} else {
			omittedIds.push(item.finding.id);
		}
	}
	return { text: included.join("\n"), overflowCount: omittedIds.length, overflowIds: omittedIds.join(", ") };
}

export class CouncilCoordinator {
	readonly #host: CouncilCoordinatorHost;
	readonly #listeners = new Set<CoordinatorListener>();
	readonly #liveMembers = new Map<string, CouncilMemberLiveProgress>();
	#storage: CouncilStorage | undefined;
	#abortController: AbortController | undefined;
	#checkpointTail: Promise<void> = Promise.resolve();
	#summarySentFor: string | undefined;
	#summaryDelivery: { runId: string; promise: Promise<void> } | undefined;
	#mainTurnGeneration = 0;
	#ownedMainTurn: number | undefined;
	#handlerGeneration: number | undefined;
	#resumeExecution = false;
	#executionInFlight = false;
	#setupInFlight = false;
	#executionSettlement: PromiseWithResolvers<void> | undefined;

	completion: Promise<void> | undefined;
	snapshot: CouncilManifest | undefined;

	constructor(host: CouncilCoordinatorHost) {
		this.#host = host;
	}

	#setExecutionInFlight(active: boolean): void {
		this.#executionInFlight = active;
		if (active) executingCoordinators.add(this);
		else executingCoordinators.delete(this);
	}

	get executionInFlight(): boolean {
		return this.#executionInFlight;
	}

	get setupInFlight(): boolean {
		return this.#setupInFlight;
	}

	get coordinatorSnapshot(): CouncilCoordinatorSnapshot | undefined {
		return this.#buildCoordinatorSnapshot();
	}

	subscribe(listener: CoordinatorListener): () => void {
		this.#listeners.add(listener);
		const current = this.#buildCoordinatorSnapshot();
		if (current) this.#notifyOne(listener, current);
		return () => this.#listeners.delete(listener);
	}

	#setOwnedMainTurn(generation: number | undefined): void {
		if (this.#ownedMainTurn === generation) return;
		this.#ownedMainTurn = generation;
		this.#emit();
	}

	async start(task: string): Promise<CouncilManifest> {
		if (this.#executionInFlight) throw new Error("The prior council execution is still settling");
		this.#setExecutionInFlight(true);
		this.#abortController = new AbortController();
		this.#executionSettlement = Promise.withResolvers<void>();
		this.#setupInFlight = true;
		let dispatch: CouncilDispatchPlan | undefined;
		let beganExecution = false;
		try {
			dispatch = await preflightCouncilDispatch(this.#host, task);
			this.#abortController.signal.throwIfAborted();
			const activeCoordinator = activeCoordinators.get(dispatch.sessionId);
			if (activeCoordinator && activeCoordinator !== this) {
				throw new Error(`A council run is already active for session ${dispatch.sessionId}`);
			}
			activeCoordinators.set(dispatch.sessionId, this);
			this.#assertAdjudicationSurface();
			this.#storage = createCouncilStorage(this.#host.toolSession);
			const existing = await this.#storage.list();
			this.#abortController.signal.throwIfAborted();
			const active = existing.find(manifest => !isCouncilTerminalState(manifest.state));
			if (active) throw new Error(`Council run ${active.runId} is already active for this session`);
			const manifest = await this.#initialManifest(dispatch);
			const created = await this.#storage.create(manifest);
			this.snapshot = created;
			this.#abortController.signal.throwIfAborted();
			this.#liveMembers.clear();
			this.#emit();
			this.#resumeExecution = false;
			this.#begin(dispatch);
			beganExecution = true;
			this.#setupInFlight = false;
			return structuredClone(this.snapshot);
		} catch (error) {
			if (
				isAbort(error, this.#abortController.signal) &&
				this.snapshot &&
				!isCouncilTerminalState(this.snapshot.state)
			) {
				await this.#interrupt("cancel", errorText(error));
				await this.#sendSummary();
			}
			if (dispatch && activeCoordinators.get(dispatch.sessionId) === this) {
				activeCoordinators.delete(dispatch.sessionId);
			}
			throw error;
		} finally {
			if (!beganExecution) {
				this.#setupInFlight = false;
				this.#setExecutionInFlight(false);
				this.#executionSettlement?.resolve();
			}
		}
	}

	async status(): Promise<CouncilManifest | undefined> {
		if (this.snapshot) {
			if (isCouncilTerminalState(this.snapshot.state)) await this.#sendSummary();
			return structuredClone(this.snapshot);
		}
		this.#storage ??= createCouncilStorage(this.#host.toolSession);
		const manifests = await this.#storage.list();
		const latest = manifests.sort(
			(a, b) => Date.parse(b.timestamps.createdAt) - Date.parse(a.timestamps.createdAt),
		)[0];
		if (!latest) return undefined;
		this.snapshot = latest;
		this.#liveMembers.clear();
		this.#emit();
		await this.#sendSummary();
		return structuredClone(latest);
	}

	async cancelForSessionTransition(): Promise<void> {
		if (!this.#setupInFlight && this.snapshot && !isCouncilTerminalState(this.snapshot.state)) {
			await this.cancel();
			if (this.#executionInFlight) {
				throw new Error(`Council cancellation timed out after ${COUNCIL_CANCEL_DRAIN_TIMEOUT_MS}ms`);
			}
			return;
		}
		if (!this.#executionInFlight) return;
		this.#abortController?.abort();
		const drains: Promise<unknown>[] = [];
		if (this.#ownsCurrentMainTurn()) {
			drains.push(this.#host.session.abort().then(() => this.#host.session.waitForIdle()));
		}
		if (this.#executionSettlement) drains.push(this.#executionSettlement.promise);
		if (drains.length === 0) return;
		const settled = await Promise.race([
			Promise.allSettled(drains).then(() => true),
			Bun.sleep(COUNCIL_CANCEL_DRAIN_TIMEOUT_MS).then(() => false),
		]);
		if (!settled) throw new Error(`Council cancellation timed out after ${COUNCIL_CANCEL_DRAIN_TIMEOUT_MS}ms`);
	}

	async cancel(): Promise<CouncilManifest> {
		if (this.#setupInFlight) {
			await this.cancelForSessionTransition();
			throw abortError();
		}
		const manifest = this.snapshot ? structuredClone(this.snapshot) : await this.status();
		if (!manifest) throw new Error("No council run exists for this session");
		if (isCouncilTerminalState(manifest.state)) return manifest;
		const cancellingCheckpoint = this.#setState("cancelling");
		this.#abortController?.abort();
		let drainFailure: unknown;
		const observe = (operation: Promise<unknown>) =>
			operation.catch(error => {
				drainFailure ??= error;
			});
		const drains: Promise<unknown>[] = [observe(cancellingCheckpoint)];
		if (this.#ownsCurrentMainTurn()) {
			drains.push(observe(this.#host.session.abort().then(() => this.#host.session.waitForIdle())));
		}
		if (this.completion) drains.push(observe(this.completion));
		const timeout = Bun.sleep(COUNCIL_CANCEL_DRAIN_TIMEOUT_MS);
		await Promise.race([Promise.all(drains), timeout]);
		if (this.snapshot && !isCouncilTerminalState(this.snapshot.state)) {
			await Promise.race([observe(this.#interrupt("cancel", "Council run cancelled")), timeout]);
		}
		if (drainFailure) throw drainFailure;
		return structuredClone(this.snapshot!);
	}

	async resume(runId?: string): Promise<CouncilManifest> {
		if (this.#executionInFlight) throw new Error("The prior council execution is still settling");
		this.#setExecutionInFlight(true);
		this.#abortController = new AbortController();
		this.#executionSettlement = Promise.withResolvers<void>();
		this.#setupInFlight = true;
		let dispatch: CouncilDispatchPlan | undefined;
		let beganExecution = false;
		try {
			this.#storage = createCouncilStorage(this.#host.toolSession);
			const manifest = runId
				? await this.#storage.load(runId)
				: (await this.#storage.list()).sort(
						(a, b) => Date.parse(b.timestamps.createdAt) - Date.parse(a.timestamps.createdAt),
					)[0];
			this.#abortController.signal.throwIfAborted();
			if (!manifest) throw new Error("No council run exists for this session");
			if (manifest.state === "completed" || manifest.state === "completed-degraded")
				return structuredClone(manifest);
			if (manifest.state === "failed" && manifest.failure?.phase === "planner-schema") {
				throw new Error("A structurally invalid council planner result is terminal and cannot be resumed");
			}
			if (manifest.state === "failed" && manifest.failure?.code === "EEXIST") {
				throw new Error("A council publication collision is terminal and cannot be resumed");
			}
			dispatch = await preflightCouncilDispatch(this.#host, manifest.task, {
				promisedOutputPath: manifest.outputPath,
			});
			this.#abortController.signal.throwIfAborted();
			const activeCoordinator = activeCoordinators.get(dispatch.sessionId);
			if (activeCoordinator && activeCoordinator !== this) {
				throw new Error(`A council run is already active for session ${dispatch.sessionId}`);
			}
			activeCoordinators.set(dispatch.sessionId, this);
			const persistedInstructions = await this.#loadInstructionSnapshot(manifest);
			await this.#assertResumeIdentity(manifest, dispatch, persistedInstructions);
			this.#applyInstructionSnapshot(dispatch, persistedInstructions);
			this.#abortController.signal.throwIfAborted();
			this.snapshot = structuredClone(manifest);
			this.#liveMembers.clear();
			await this.#assertResumePublicationAvailable(manifest, dispatch);
			this.#assertAdjudicationSurface();
			delete this.snapshot.failure;
			delete this.snapshot.timestamps.finishedAt;
			delete this.snapshot.timestamps.interruptedAt;
			this.snapshot.mainSnapshot = {
				model: modelIdentity(dispatch.main.model),
				effort: nullableEffort(dispatch.main.effort),
				capturedAt: this.#now(),
				instructionSha256: manifest.instructionSnapshot.sha256,
			};
			this.snapshot.state = this.snapshot.planVersions.length === 0 ? "planning" : "reviewing";
			await this.#checkpoint();
			this.#abortController.signal.throwIfAborted();
			this.#setupInFlight = false;
			this.#resumeExecution = true;
			this.#begin(dispatch);
			beganExecution = true;
			return structuredClone(this.snapshot);
		} catch (error) {
			if (
				isAbort(error, this.#abortController.signal) &&
				this.snapshot &&
				!isCouncilTerminalState(this.snapshot.state)
			) {
				await this.#interrupt("cancel", errorText(error));
				await this.#sendSummary();
			}
			if (dispatch && activeCoordinators.get(dispatch.sessionId) === this) {
				activeCoordinators.delete(dispatch.sessionId);
			}
			throw error;
		} finally {
			if (!beganExecution) {
				this.#setupInFlight = false;
				this.#setExecutionInFlight(false);
				this.#executionSettlement?.resolve();
			}
		}
	}

	#begin(dispatch: CouncilDispatchPlan): void {
		if (!this.#abortController) throw new Error("Council execution abort controller is unavailable");
		this.#setupInFlight = false;
		this.#setExecutionInFlight(true);
		this.completion = this.#executeGuarded(dispatch, this.#abortController.signal);
	}

	async #executeGuarded(dispatch: CouncilDispatchPlan, signal: AbortSignal): Promise<void> {
		try {
			await this.#execute(dispatch, signal);
		} catch (error) {
			if (isAbort(error, signal)) {
				if (this.snapshot && !isCouncilTerminalState(this.snapshot.state)) {
					await this.#interrupt("cancel", errorText(error));
				}
			} else if (this.snapshot && !isCouncilTerminalState(this.snapshot.state)) {
				await this.#fail("coordinator", error, errorCode(error));
			}
		} finally {
			this.#setOwnedMainTurn(undefined);
			this.#handlerGeneration = undefined;
			if (this.snapshot && activeCoordinators.get(this.snapshot.sessionId) === this) {
				activeCoordinators.delete(this.snapshot.sessionId);
			}
			try {
				await this.#sendSummary();
			} finally {
				this.#setExecutionInFlight(false);
				this.#executionSettlement?.resolve();
			}
		}
	}

	async #execute(dispatch: CouncilDispatchPlan, signal: AbortSignal): Promise<void> {
		const planner = await this.#loadOrRunPlanner(dispatch, signal);
		signal.throwIfAborted();
		let plan = planner.plan;
		let priorAdjudication: CouncilAdjudication | undefined;
		let finalAllowedDuplicateTargetIds: string[] = [];
		for (let roundNumber = 1; roundNumber <= dispatch.rounds; roundNumber++) {
			const allowedDuplicateTargetIds =
				priorAdjudication?.dispositions
					.filter(disposition => disposition.disposition !== "duplicate")
					.map(disposition => disposition.id) ?? [];
			if (roundNumber === dispatch.rounds) finalAllowedDuplicateTargetIds = allowedDuplicateTargetIds;
			const existingVersion = this.snapshot!.planVersions.find(version => version.round === roundNumber);
			if (existingVersion) {
				const stored = await this.#storage!.readArtifact(existingVersion.artifact);
				const persisted = decodeMetadata<PersistedAdjudicationMetadata>(
					stored,
					ADJUDICATION_METADATA_MARKER,
				).adjudication;
				const round = this.snapshot!.rounds[roundNumber - 1]!;
				const expectedIds = round.members.flatMap(member => member.findingIds);
				priorAdjudication = validateCouncilAdjudication(persisted, expectedIds, allowedDuplicateTargetIds);
				plan = priorAdjudication.plan;
				continue;
			}
			this.#assertAdjudicationBaseFits(dispatch, roundNumber, planner, priorAdjudication);
			const ledger = await this.#runRound(dispatch, roundNumber, plan, signal);
			signal.throwIfAborted();
			const adjudication = await this.#adjudicate(dispatch, roundNumber, planner, priorAdjudication, ledger, signal);
			signal.throwIfAborted();
			const expectedIds = ledger.reports.flatMap(report => report?.findings.map(finding => finding.id) ?? []);
			validateCouncilAdjudication(adjudication, expectedIds, allowedDuplicateTargetIds);
			const finalRound = roundNumber === dispatch.rounds;
			const artifactContent =
				adjudication.plan +
				encodeMetadata(ADJUDICATION_METADATA_MARKER, { adjudication } satisfies PersistedAdjudicationMetadata);
			const artifact = await this.#storage!.writeArtifact(
				this.snapshot!.runId,
				`round${roundNumber}.md`,
				artifactContent,
			);
			signal.throwIfAborted();
			this.snapshot!.planVersions.push({
				version: this.snapshot!.planVersions.length + 1,
				round: roundNumber,
				kind: finalRound ? "final" : "round",
				artifact,
				createdAt: this.#now(),
			});
			signal.throwIfAborted();
			plan = adjudication.plan;
			priorAdjudication = adjudication;
			if (!finalRound) this.snapshot!.state = "round-transition";
			await this.#checkpoint();
			signal.throwIfAborted();
		}
		const finalRound = this.snapshot!.rounds[this.snapshot!.rounds.length - 1]!;
		const finalIds = finalRound.members.flatMap(member => member.findingIds);
		validateCouncilAdjudication(priorAdjudication, finalIds, finalAllowedDuplicateTargetIds);
		const published = await publishCouncilPlan({
			repoRoot: this.snapshot!.repoRoot,
			outputPath: this.snapshot!.outputPath,
			content: plan,
			now: this.#now(),
			resume: this.#resumeExecution,
			signal,
		});
		signal.throwIfAborted();
		this.snapshot!.published = {
			path: published.path,
			sha256: published.sha256,
			bytes: published.bytes,
			publishedAt: published.publishedAt,
		};
		await this.#checkpoint();
		signal.throwIfAborted();
		await this.#settle(this.snapshot!.degraded ? "completed-degraded" : "completed");
	}

	async #loadOrRunPlanner(dispatch: CouncilDispatchPlan, signal: AbortSignal): Promise<CouncilPlannerOutput> {
		const draft = this.snapshot!.planVersions.find(version => version.kind === "draft");
		if (draft) {
			const stored = await this.#storage!.readArtifact(draft.artifact);
			signal.throwIfAborted();
			const frame = decodeMetadataFrame<PersistedPlannerMetadata>(stored, PLANNER_METADATA_MARKER);
			return validateCouncilPlannerOutput({ plan: frame.content, ...frame.metadata });
		}
		await this.#setState("planning");
		const assignment = prompt.render(plannerTaskTemplate, { task: dispatch.task, repositoryRoot: dispatch.repoRoot });
		let result: StructuredSubagentResult;
		try {
			result = await this.#runChild(
				{
					...dispatch.plannerRequest,
					assignment,
					identity: { label: `Council planner ${this.snapshot!.runId}`, inspectOnly: true },
					index: 0,
					signal,
				},
				signal,
			);
		} catch (error) {
			if (isAbort(error, signal)) throw abortError();
			await this.#fail("planner", error, errorCode(error));
			throw error;
		}
		if (!this.snapshot || isCouncilTerminalState(this.snapshot.state)) throw abortError();
		this.#captureUsage(result);
		await this.#checkpoint();
		signal.throwIfAborted();
		try {
			this.#assertPinnedModel(result, modelIdentity(dispatch.planner.model));
		} catch (error) {
			await this.#fail("planner", error, errorCode(error));
			throw error;
		}
		const structuredOutput = result.result.structuredOutput;
		let planner: CouncilPlannerOutput | undefined;
		if (structuredOutput?.status === "invalid" && structuredOutput.data !== undefined) {
			try {
				planner = validateCouncilPlannerOutput(structuredOutput.data);
			} catch (error) {
				await this.#fail("planner-schema", error, "COUNCIL_PLANNER_INVALID");
				throw error;
			}
		}
		try {
			this.#assertChildResult(result, modelIdentity(dispatch.planner.model));
		} catch (error) {
			await this.#fail("planner", error, errorCode(error));
			throw error;
		}
		if (!planner) {
			try {
				planner = validateCouncilPlannerOutput(structuredOutput?.data);
			} catch (error) {
				await this.#fail("planner-schema", error, "COUNCIL_PLANNER_INVALID");
				throw error;
			}
		}
		const metadata: PersistedPlannerMetadata = {
			assumptions: planner.assumptions,
			blockers: planner.blockers,
			evidenceVersion: planner.evidenceVersion,
		};
		const artifact = await this.#storage!.writeArtifact(
			this.snapshot!.runId,
			"draft.md",
			planner.plan + encodeMetadata(PLANNER_METADATA_MARKER, metadata),
		);
		signal.throwIfAborted();
		this.snapshot!.planVersions.push({ version: 1, round: 0, kind: "draft", artifact, createdAt: this.#now() });
		await this.#checkpoint();
		signal.throwIfAborted();
		return planner;
	}

	async #runRound(
		dispatch: CouncilDispatchPlan,
		roundNumber: number,
		plan: string,
		signal: AbortSignal,
	): Promise<RoundLedger> {
		await this.#setState("reviewing");
		signal.throwIfAborted();
		const round = this.snapshot!.rounds[roundNumber - 1]!;
		const ledger: RoundLedger = {
			reports: new Array(round.members.length),
			failures: new Array(round.members.length),
		};
		const launchSlots: number[] = [];
		for (const [slot, member] of round.members.entries()) {
			if (member.status === "succeeded" && member.artifact) {
				const candidate = JSON.parse(await this.#storage!.readArtifact(member.artifact));
				ledger.reports[slot] = validatePersistedCouncilReport(
					candidate,
					(roundNumber - 1) * round.members.length + slot,
				);
			} else if (member.status === "failed") {
				ledger.failures[slot] = {
					role: member.role,
					reason: member.failureReason ?? `${member.role} did not complete`,
				};
			} else {
				launchSlots.push(slot);
			}
		}
		if (launchSlots.length > 0) {
			round.status = "running";
			round.startedAt ??= this.#now();
			round.finishedAt = null;
			for (const slot of launchSlots) {
				const member = round.members[slot]!;
				member.status = "running";
				member.attempts++;
				member.startedAt = this.#now();
				member.finishedAt = null;
				member.artifact = null;
				member.failureReason = null;
				member.findingIds = [];
			}
			await this.#checkpoint();
			signal.throwIfAborted();
			await Promise.allSettled(
				launchSlots.map(slot => this.#runMember(dispatch, roundNumber, slot, plan, ledger, signal)),
			);
			signal.throwIfAborted();
		}
		if (round.status !== "settled") {
			round.status = "settled";
			round.finishedAt = this.#now();
			for (const member of round.members) {
				if (member.status === "running") {
					member.status = signal.aborted ? "cancelled" : "failed";
					member.finishedAt = this.#now();
					member.failureReason = signal.aborted
						? "Council run cancelled"
						: "Council member ended without a result";
				}
			}
			await this.#checkpoint();
		}
		signal.throwIfAborted();
		return ledger;
	}

	async #runMember(
		dispatch: CouncilDispatchPlan,
		roundNumber: number,
		slot: number,
		plan: string,
		ledger: RoundLedger,
		signal: AbortSignal,
	): Promise<void> {
		const round = this.snapshot!.rounds[roundNumber - 1]!;
		const record = round.members[slot]!;
		const member = dispatch.members[slot]!;
		const globalSlot = (roundNumber - 1) * round.members.length + slot;
		const prefix = this.#slotPrefix(globalSlot);
		let schemaRetry = false;
		try {
			for (;;) {
				const assignment = prompt.render(memberTaskTemplate, {
					task: dispatch.task,
					repositoryRoot: dispatch.repoRoot,
					round: roundNumber,
					lens: member.lens,
					plan,
					idPrefix: prefix,
				});
				const request: StructuredSubagentRequest = {
					...dispatch.memberRequests[slot]!,
					assignment,
					identity: { label: `Council ${member.role} r${roundNumber}`, inspectOnly: true },
					index: globalSlot + 1,
					signal,
					onProgress: progress => this.#captureProgress(roundNumber, record, progress),
				};
				const result = await this.#runChild(request, signal);
				if (!this.snapshot || isCouncilTerminalState(this.snapshot.state)) throw abortError();
				record.resolvedModel = result.result.resolvedModel ?? null;
				record.authFallbackUsed = result.result.authFallbackUsed === true;
				this.#captureUsage(result);
				await this.#checkpoint();
				signal.throwIfAborted();
				this.#assertPinnedModel(result, modelIdentity(member.model));
				const validationStatus = result.result.structuredOutput?.status;
				if (validationStatus !== "invalid") {
					this.#assertChildResult(result, modelIdentity(member.model));
				}
				let report: CouncilReport;
				try {
					report = validateIncomingCouncilReport(result.result.structuredOutput?.data, globalSlot);
				} catch (error) {
					if (!schemaRetry && !result.result.aborted && validationStatus === "invalid") {
						schemaRetry = true;
						record.attempts++;
						await this.#checkpoint();
						signal.throwIfAborted();
						continue;
					}
					throw error;
				}
				this.#assertChildResult(result, modelIdentity(member.model));
				const artifact = await this.#storage!.writeArtifact(
					this.snapshot!.runId,
					`${member.role}-r${roundNumber}.json`,
					`${JSON.stringify(report, null, 2)}\n`,
				);
				signal.throwIfAborted();
				record.status = "succeeded";
				record.finishedAt = this.#now();
				record.artifact = artifact;
				record.findingIds = report.findings.map(finding => finding.id);
				ledger.reports[slot] = report;
				this.#liveMembers.delete(this.#setttleMemberProgressKey(roundNumber, record.order));
				this.#settleRoundIfLast(round);
				await this.#checkpoint();
				return;
			}
		} catch (error) {
			if (!this.snapshot || isCouncilTerminalState(this.snapshot.state)) return;
			record.status = signal.aborted ? "cancelled" : "failed";
			record.finishedAt = this.#now();
			record.artifact = null;
			record.failureReason = errorText(error);
			record.findingIds = [];
			ledger.failures[slot] = { role: record.role, reason: record.failureReason };
			this.snapshot!.degraded = true;
			this.#liveMembers.delete(this.#setttleMemberProgressKey(roundNumber, record.order));
			this.#settleRoundIfLast(round);
			await this.#checkpoint();
		}
	}

	#setttleMemberProgressKey(round: number, order: number): string {
		return `${round}:${order}`;
	}

	#captureProgress(round: number, record: CouncilRoundMemberRecord, progress: AgentProgress): void {
		if (!this.snapshot || isCouncilTerminalState(this.snapshot.state)) return;
		const recentOutput = progress.recentOutput
			.slice(-COUNCIL_PROGRESS_OUTPUT_LIMIT)
			.map(line => line.slice(0, COUNCIL_PROGRESS_LINE_LIMIT));
		this.#liveMembers.set(this.#setttleMemberProgressKey(round, record.order), {
			round,
			role: record.role,
			order: record.order,
			attempt: record.attempts,
			status: progress.status,
			lastIntent: progress.lastIntent,
			currentToolArgs: progress.currentToolArgs,
			currentTool: progress.currentTool,
			recentOutput,
			requests: progress.requests,
			tokens: progress.tokens,
			cost: progress.cost,
			retryState: progress.retryState ? { ...progress.retryState } : undefined,
		});
		this.#emit();
	}

	#settleRoundIfLast(round: CouncilManifest["rounds"][number]): void {
		if (round.members.some(member => member.status === "running" || member.status === "pending")) return;
		round.status = "settled";
		round.finishedAt = this.#now();
	}

	#renderAdjudicationAssignment(
		dispatch: CouncilDispatchPlan,
		roundNumber: number,
		planner: CouncilPlannerOutput,
		prior: CouncilAdjudication | undefined,
		reports: BoundedCouncilReports,
	): string {
		const template = roundNumber === 1 ? adjudicationRoundOneTemplate : adjudicationRoundTwoTemplate;
		const plannerBasis =
			roundNumber === 1
				? planner
				: {
						revisedPlan: prior?.plan,
						planner: {
							assumptions: planner.assumptions,
							blockers: planner.blockers,
							evidenceVersion: planner.evidenceVersion,
						},
					};
		return prompt.render(template, {
			task: dispatch.task,
			repositoryRoot: dispatch.repoRoot,
			plannerOutput: JSON.stringify(plannerBasis),
			reports: reports.text,
			overflowCount: reports.overflowCount,
			overflowIds: reports.overflowIds,
		});
	}

	#assertAdjudicationBaseFits(
		dispatch: CouncilDispatchPlan,
		roundNumber: number,
		planner: CouncilPlannerOutput,
		prior: CouncilAdjudication | undefined,
	): void {
		const noReports: BoundedCouncilReports = { text: "", overflowCount: 0, overflowIds: "" };
		const assignment = this.#renderAdjudicationAssignment(dispatch, roundNumber, planner, prior, noReports);
		const repair = prompt.render(adjudicationRepairTemplate, { assignment });
		if (
			assignment.length > COUNCIL_ADJUDICATION_INJECTION_CAP ||
			repair.length > COUNCIL_ADJUDICATION_INJECTION_CAP
		) {
			throw new Error("Council adjudication fixed context exceeds the bounded injection cap");
		}
	}

	async #adjudicate(
		dispatch: CouncilDispatchPlan,
		roundNumber: number,
		planner: CouncilPlannerOutput,
		prior: CouncilAdjudication | undefined,
		ledger: RoundLedger,
		signal: AbortSignal,
	): Promise<CouncilAdjudication> {
		await this.#setState("awaiting-main");
		const expectedIds = ledger.reports.flatMap(report => report?.findings.map(finding => finding.id) ?? []);
		const priorIds =
			prior?.dispositions
				.filter(disposition => disposition.disposition !== "duplicate")
				.map(disposition => disposition.id) ?? [];
		const renderAssignment = (reports: BoundedCouncilReports) =>
			this.#renderAdjudicationAssignment(dispatch, roundNumber, planner, prior, reports);
		const noReports: BoundedCouncilReports = { text: "", overflowCount: 0, overflowIds: "" };
		const emptyAssignment = renderAssignment(noReports);
		const emptyRepair = prompt.render(adjudicationRepairTemplate, { assignment: emptyAssignment });
		let reportCap = COUNCIL_ADJUDICATION_INJECTION_CAP - emptyRepair.length;
		if (reportCap < 0) throw new Error("Council adjudication fixed context exceeds the bounded injection cap");
		let reports = boundedReports(ledger, reportCap);
		let assignment = renderAssignment(reports);
		let repairAssignment = prompt.render(adjudicationRepairTemplate, { assignment });
		while (repairAssignment.length > COUNCIL_ADJUDICATION_INJECTION_CAP && reportCap > 0) {
			reportCap = Math.max(0, reportCap - (repairAssignment.length - COUNCIL_ADJUDICATION_INJECTION_CAP));
			reports = boundedReports(ledger, reportCap);
			assignment = renderAssignment(reports);
			repairAssignment = prompt.render(adjudicationRepairTemplate, { assignment });
		}
		if (
			assignment.length > COUNCIL_ADJUDICATION_INJECTION_CAP ||
			repairAssignment.length > COUNCIL_ADJUDICATION_INJECTION_CAP
		) {
			throw new Error("Council adjudication context exceeds the bounded injection cap");
		}
		for (let repair = 0; repair < 2; repair++) {
			let accepted: CouncilAdjudication | undefined;
			const generation = ++this.#mainTurnGeneration;
			let handlerOpen = true;
			const handler = async (payload: string) => {
				if (
					!handlerOpen ||
					signal.aborted ||
					this.#handlerGeneration !== generation ||
					this.#ownedMainTurn !== generation
				) {
					return {
						content: [{ type: "text" as const, text: "Council adjudication is no longer active." }],
						isError: true,
					};
				}
				try {
					const candidate = JSON.parse(payload) as unknown;
					const validated = validateCouncilAdjudication(candidate, expectedIds, priorIds);
					if (accepted) {
						return {
							content: [{ type: "text" as const, text: "Council adjudication was already accepted." }],
							isError: true,
						};
					}
					accepted = validated;
					return { content: [{ type: "text" as const, text: "Council adjudication accepted." }] };
				} catch (error) {
					return {
						content: [{ type: "text" as const, text: `Invalid council adjudication: ${errorText(error)}` }],
						isError: true,
					};
				}
			};
			if (this.#host.toolSession.peekCouncilHandler?.())
				throw new Error("Another council adjudication handler is active");
			this.#handlerGeneration = generation;
			this.#host.toolSession.setCouncilHandler!(handler);
			let promptError: unknown;
			try {
				await this.#setState("adjudicating");
				const content = repair === 0 ? assignment : repairAssignment;
				this.snapshot!.adjudicationBudget.injectedChars = content.length;
				await this.#checkpoint();
				await this.#promptMainWhenIdle(dispatch, content, generation, signal);
			} catch (error) {
				promptError = error;
			} finally {
				handlerOpen = false;
				if (this.#handlerGeneration === generation) {
					if (this.#host.toolSession.peekCouncilHandler?.() === handler) {
						this.#host.toolSession.setCouncilHandler?.(null);
					}
					this.#handlerGeneration = undefined;
				}
				if (this.#ownedMainTurn === generation) this.#setOwnedMainTurn(undefined);
			}
			signal.throwIfAborted();
			if (accepted) return accepted;
			if (promptError) throw promptError;
		}
		signal.throwIfAborted();
		const error = new Error("Main ended two adjudication turns without a valid council payload");
		await this.#fail("adjudication", error, "COUNCIL_ADJUDICATION_MISSING");
		throw error;
	}

	async #promptMainWhenIdle(
		dispatch: CouncilDispatchPlan,
		content: string,
		generation: number,
		signal: AbortSignal,
	): Promise<void> {
		for (;;) {
			await abortable(this.#host.session.waitForIdle(), signal);
			if (signal.aborted) throw abortError();
			const main = await abortable(preflightCouncilMainDispatch(this.#host), signal);
			if (signal.aborted) throw abortError();
			let identityChanged = false;
			try {
				await this.#host.session.promptCustomMessage(
					{
						customType: "council-adjudication",
						content,
						display: false,
						details: { runId: this.snapshot!.runId, generation },
					},
					{
						onPromptStart: () => {
							const current = this.#host.session.model;
							const currentEffort = current
								? resolveCouncilMainEffort(current, this.#host.session.thinkingLevel)
								: undefined;
							if (
								!current ||
								modelIdentity(current) !== modelIdentity(main.model) ||
								nullableEffort(currentEffort) !== nullableEffort(main.effort)
							) {
								identityChanged = true;
								throw new Error("Council Main model or effort changed during adjudication turn acquisition");
							}
							this.#recordLiveMain(dispatch, main);
							this.#setOwnedMainTurn(generation);
						},
					},
				);
				return;
			} catch (error) {
				this.#setOwnedMainTurn(undefined);
				if (identityChanged || error instanceof AgentBusyError) continue;
				throw error;
			}
		}
	}

	#recordLiveMain(dispatch: CouncilDispatchPlan, main: CouncilMainDispatchSnapshot): void {
		const warningCandidates = councilDispatchWarnings(dispatch.members, main);
		for (const warning of warningCandidates) {
			if (!this.snapshot!.warnings.includes(warning)) this.snapshot!.warnings.push(warning);
		}
		if (warningCandidates.length > 0) this.snapshot!.degraded = true;
		this.snapshot!.mainSnapshot = {
			model: modelIdentity(main.model),
			effort: nullableEffort(main.effort),
			capturedAt: this.#now(),
			instructionSha256: this.snapshot!.instructionSnapshot.sha256,
		};
	}

	#ownsCurrentMainTurn(): boolean {
		return this.#ownedMainTurn !== undefined && this.#ownedMainTurn === this.#handlerGeneration;
	}

	async #runChild(request: StructuredSubagentRequest, signal: AbortSignal): Promise<StructuredSubagentResult> {
		return withSessionSpawnPermit(this.#host.toolSession, signal, () =>
			runStructuredSubagent({ ...request, signal }),
		);
	}

	#assertPinnedModel(result: StructuredSubagentResult, expectedModel: string): void {
		const child = result.result;
		if (child.authFallbackUsed) throw new Error("Pinned council child used an authentication fallback");
		if (
			!child.resolvedModel ||
			(child.resolvedModel !== expectedModel && !child.resolvedModel.startsWith(`${expectedModel}:`))
		) {
			throw new Error(
				`Pinned council child resolved to ${child.resolvedModel ?? "an unknown model"} instead of ${expectedModel}`,
			);
		}
	}

	#assertChildResult(result: StructuredSubagentResult, expectedModel: string): void {
		this.#assertPinnedModel(result, expectedModel);
		const child = result.result;
		if (child.exitCode !== 0 || child.error || child.aborted) {
			throw new Error(child.abortReason ?? child.error ?? (child.stderr || "Council child failed"));
		}
	}

	#captureUsage(result: StructuredSubagentResult): void {
		this.snapshot!.usage.requests += result.result.requests;
		this.snapshot!.usage.tokens += result.result.tokens;
		this.snapshot!.usage.cost += usageCost(result.result);
	}

	async #setState(state: CouncilManifest["state"]): Promise<void> {
		if (!this.snapshot || isCouncilTerminalState(this.snapshot.state)) return;
		this.snapshot.state = state;
		await this.#checkpoint();
	}

	async #settle(state: "completed" | "completed-degraded"): Promise<void> {
		if (!this.snapshot || isCouncilTerminalState(this.snapshot.state)) return;
		this.#liveMembers.clear();
		this.snapshot.state = state;
		this.snapshot.timestamps.finishedAt = this.#now();
		await this.#checkpoint();
	}

	async #interrupt(phase: string, reason: string): Promise<void> {
		if (!this.snapshot || isCouncilTerminalState(this.snapshot.state)) return;
		const now = this.#now();
		for (const round of this.snapshot.rounds) {
			if (round.status !== "running") continue;
			round.status = "interrupted";
			round.finishedAt = now;
			for (const member of round.members) {
				if (member.status !== "running") continue;
				member.status = "interrupted";
				member.finishedAt = now;
				member.failureReason ??= reason;
			}
		}
		this.#liveMembers.clear();
		this.snapshot.state = "interrupted";
		this.snapshot.failure = { phase, reason, code: "COUNCIL_INTERRUPTED", time: now };
		this.snapshot.timestamps.finishedAt = now;
		this.snapshot.timestamps.interruptedAt = now;
		await this.#checkpoint();
	}

	async #fail(phase: string, error: unknown, code?: string): Promise<void> {
		if (!this.snapshot || isCouncilTerminalState(this.snapshot.state)) return;
		const now = this.#now();
		for (const round of this.snapshot.rounds) {
			if (round.status !== "running") continue;
			round.status = "interrupted";
			round.finishedAt = now;
			for (const member of round.members) {
				if (member.status !== "running") continue;
				member.status = "interrupted";
				member.finishedAt = now;
				member.failureReason ??= errorText(error);
			}
		}
		this.#liveMembers.clear();
		this.snapshot.state = "failed";
		this.snapshot.failure = { phase, reason: errorText(error), ...(code ? { code } : {}), time: now };
		this.snapshot.timestamps.finishedAt = now;
		await this.#checkpoint();
	}

	async #checkpoint(): Promise<void> {
		if (!this.snapshot || !this.#storage) throw new Error("Council storage is unavailable");
		const snapshot = parseCouncilManifest(structuredClone(this.snapshot));
		const operation = this.#checkpointTail.then(async () => {
			const persisted = await this.#storage!.checkpoint(snapshot);
			if (this.snapshot) this.snapshot.timestamps.updatedAt = persisted.timestamps.updatedAt;
			this.#emit();
		});
		this.#checkpointTail = operation.catch(() => {});
		await operation;
	}

	async #initialManifest(dispatch: CouncilDispatchPlan): Promise<CouncilManifest> {
		if (!this.#storage) throw new Error("Council storage is unavailable");
		const now = this.#now();
		const roster = rosterFromPlan(dispatch);
		const runId =
			typeof this.#host.runId === "function" ? this.#host.runId() : (this.#host.runId ?? Bun.randomUUIDv7());
		const instructionContent = `${JSON.stringify(dispatch.instructions)}\n`;
		const instructionArtifact = await this.#storage.createArtifact(runId, "instructions.json", instructionContent);
		this.#abortController?.signal.throwIfAborted();
		return parseCouncilManifest({
			version: COUNCIL_MANIFEST_VERSION,
			runId,
			sessionId: dispatch.sessionId,
			mainAgentId: MAIN_AGENT_ID,
			state: "dispatching",
			task: dispatch.task,
			repoRoot: dispatch.repoRoot,
			outputPath: dispatch.publicationTarget.relativePath,
			timestamps: { createdAt: now, updatedAt: now, startedAt: now },
			config: structuredClone(dispatch.config),
			roster,
			planner: plannerFromPlan(dispatch),
			mainSnapshot: {
				model: modelIdentity(dispatch.main.model),
				effort: nullableEffort(dispatch.main.effort),
				capturedAt: now,
				instructionSha256: instructionArtifact.sha256,
			},
			instructionSnapshot: {
				artifact: instructionArtifact,
				sha256: instructionArtifact.sha256,
			},
			rounds: Array.from({ length: dispatch.rounds }, (_, index) => ({
				round: index + 1,
				status: "pending",
				startedAt: null,
				finishedAt: null,
				members: roster.map(blankMember),
			})),
			planVersions: [],
			usage: { requests: 0, tokens: 0, cost: 0 },
			adjudicationBudget: { injectedChars: 0, cap: COUNCIL_ADJUDICATION_INJECTION_CAP },
			warnings: [...dispatch.warnings],
			degraded: dispatch.warnings.length > 0,
		});
	}

	async #assertResumeIdentity(
		manifest: CouncilManifest,
		dispatch: CouncilDispatchPlan,
		persistedInstructions: CouncilInstructionSnapshot,
	): Promise<void> {
		const roster = rosterFromPlan(dispatch);
		const planner = plannerFromPlan(dispatch);
		const mismatches: string[] = [];
		if (!isCouncilResumeCompatible(manifest, { roster, planner })) mismatches.push("roster/planner");
		if (!sameJson(manifest.config, dispatch.config)) mismatches.push("config");
		if (manifest.task !== dispatch.task) mismatches.push("task");
		if (manifest.repoRoot !== dispatch.repoRoot) mismatches.push("repository root");
		const currentInstructionSha = sha256CouncilContent(`${JSON.stringify(dispatch.instructions)}\n`);
		if (
			manifest.instructionSnapshot.sha256 !== currentInstructionSha ||
			!sameJson(persistedInstructions, dispatch.instructions)
		) {
			mismatches.push("instruction snapshot");
		}
		if (mismatches.length > 0) throw new Error(`Council resume refused: immutable ${mismatches.join(", ")} changed`);
	}

	async #assertResumePublicationAvailable(manifest: CouncilManifest, dispatch: CouncilDispatchPlan): Promise<void> {
		if (!this.#storage || !this.snapshot) throw new Error("Council storage is unavailable");
		const finalVersion = manifest.planVersions.find(version => version.kind === "final");
		let expected: { sha256: string; bytes: number } | undefined;
		if (finalVersion) {
			const stored = await this.#storage.readArtifact(finalVersion.artifact);
			const frame = decodeMetadataFrame<PersistedAdjudicationMetadata>(stored, ADJUDICATION_METADATA_MARKER);
			const plan = frame.metadata.adjudication?.plan;
			if (typeof plan !== "string") throw new Error("Council final artifact is missing its adjudicated plan");
			expected = {
				sha256: sha256CouncilContent(plan),
				bytes: Buffer.byteLength(plan),
			};
		}
		const status = await inspectPromisedCouncilPublication(dispatch.repoRoot, manifest.outputPath, expected);
		if (status !== "collision") return;
		const error = new Error(`Council publication target already exists: ${manifest.outputPath}`);
		const now = this.#now();
		this.snapshot.state = "failed";
		this.snapshot.failure = { phase: "publication", reason: error.message, code: "EEXIST", time: now };
		this.snapshot.timestamps.finishedAt = now;
		delete this.snapshot.timestamps.interruptedAt;
		await this.#checkpoint();
		await this.#sendSummary();
		throw error;
	}

	async #loadInstructionSnapshot(manifest: CouncilManifest): Promise<CouncilInstructionSnapshot> {
		if (!this.#storage) throw new Error("Council storage is unavailable");
		const content = await this.#storage.readArtifact(manifest.instructionSnapshot.artifact);
		const candidate: unknown = JSON.parse(content);
		return parseCouncilInstructionSnapshot(candidate, manifest.repoRoot);
	}

	#applyInstructionSnapshot(dispatch: CouncilDispatchPlan, snapshot: CouncilInstructionSnapshot): void {
		dispatch.instructions = structuredClone(snapshot);
		dispatch.plannerRequest.additionalContextFiles = structuredClone(snapshot.contextFiles);
		for (const request of dispatch.memberRequests) {
			request.additionalContextFiles = structuredClone(snapshot.contextFiles);
		}
	}

	#assertAdjudicationSurface(): void {
		if (!this.#host.toolSession.setCouncilHandler || !this.#host.toolSession.peekCouncilHandler) {
			throw new Error("Council adjudication requires the ToolSession council handler surface");
		}
		if (this.#host.toolSession.peekCouncilHandler()) {
			throw new Error("Another council adjudication handler is already active");
		}
	}

	#slotPrefix(slotIndex: number): string {
		let remainder = slotIndex;
		let prefix = "";
		do {
			prefix = String.fromCharCode(65 + (remainder % 26)) + prefix;
			remainder = Math.floor(remainder / 26) - 1;
		} while (remainder >= 0);
		return prefix;
	}

	#now(): string {
		const value = this.#host.now?.() ?? new Date();
		return typeof value === "string" ? new Date(value).toISOString() : value.toISOString();
	}

	#buildCoordinatorSnapshot(): CouncilCoordinatorSnapshot | undefined {
		if (!this.snapshot) return undefined;
		return {
			manifest: structuredClone(this.snapshot),
			members: [...this.#liveMembers.values()].map(progress => structuredClone(progress)),
			mainTurnOwned: this.#ownsCurrentMainTurn(),
		};
	}

	#emit(): void {
		if (!this.snapshot) return;
		const manifest = structuredClone(this.snapshot);
		try {
			this.#host.onStateChange?.(manifest);
		} catch (error) {
			logger.warn("Council state listener failed", { error: errorText(error) });
		}
		const snapshot = this.#buildCoordinatorSnapshot()!;
		for (const listener of this.#listeners) this.#notifyOne(listener, snapshot);
	}

	#notifyOne(listener: CoordinatorListener, snapshot: CouncilCoordinatorSnapshot): void {
		try {
			listener(structuredClone(snapshot));
		} catch (error) {
			logger.warn("Council coordinator subscriber failed", { error: errorText(error) });
		}
	}

	async #sendSummary(): Promise<void> {
		if (
			!this.snapshot ||
			!isCouncilTerminalState(this.snapshot.state) ||
			this.#summarySentFor === this.snapshot.runId
		)
			return;
		const runId = this.snapshot.runId;
		if (this.#summaryDelivery) {
			await this.#summaryDelivery.promise;
			if (this.#summarySentFor !== runId) await this.#sendSummary();
			return;
		}
		const manifest = structuredClone(this.snapshot);
		const promise = this.#deliverSummary(manifest);
		this.#summaryDelivery = { runId, promise };
		try {
			await promise;
		} finally {
			if (this.#summaryDelivery?.promise === promise) this.#summaryDelivery = undefined;
		}
	}

	async #deliverSummary(manifest: CouncilManifest): Promise<void> {
		if (this.#host.sessionManager.getSessionId() !== manifest.sessionId) return;
		const runId = manifest.runId;
		const alreadyPersisted = this.#host.session.messages.some(message => {
			if (message.role !== "custom" || message.customType !== "council-summary") return false;
			const details = message.details;
			return Boolean(details && typeof details === "object" && "runId" in details && details.runId === runId);
		});
		if (alreadyPersisted) {
			this.#summarySentFor = runId;
			return;
		}
		const succeeded = manifest.rounds
			.flatMap(round => round.members)
			.filter(member => member.status === "succeeded").length;
		const failed = manifest.rounds
			.flatMap(round => round.members)
			.filter(member => member.status === "failed").length;
		const rawWarnings = [
			...manifest.warnings,
			...(manifest.degraded ? ["Council completed with degradation."] : []),
			...(manifest.failure ? [manifest.failure.reason] : []),
		];
		const warningLimit =
			rawWarnings.length > COUNCIL_SUMMARY_WARNING_COUNT_LIMIT
				? COUNCIL_SUMMARY_WARNING_COUNT_LIMIT - 1
				: COUNCIL_SUMMARY_WARNING_COUNT_LIMIT;
		const boundedWarnings = rawWarnings.slice(0, warningLimit).map(warning =>
			warning
				.replace(/[\u0000-\u001f\u007f]+/g, " ")
				.replace(/\s+/g, " ")
				.trim()
				.slice(0, COUNCIL_SUMMARY_WARNING_CHAR_LIMIT),
		);
		if (rawWarnings.length > warningLimit) {
			boundedWarnings.push(`${rawWarnings.length - warningLimit} additional warnings omitted.`);
		}
		const warnings = boundedWarnings.filter(Boolean).join(" ");
		const taskPreview = manifest.task.replace(/\s+/g, " ").trim().slice(0, 160);
		const finalUrl = manifest.published ? manifest.outputPath : "not published";
		const manifestUrl = this.#storage!.artifactUrl(runId, "manifest.json");
		const content = prompt.render(councilSummaryTemplate, {
			outcome: manifest.state,
			taskPreview,
			succeeded,
			failed,
			finalUrl,
			manifestUrl,
			warnings,
		});
		try {
			const deliveryReceipt = { delivered: false };
			await this.#host.session.sendCustomMessage(
				{
					customType: "council-summary",
					display: true,
					content,
					details: { runId, manifestUrl, finalUrl: manifest.published ? manifest.outputPath : undefined },
				},
				{ deliverAs: "nextTurn", expectedSessionId: manifest.sessionId, deliveryReceipt },
			);
			if (deliveryReceipt.delivered) this.#summarySentFor = runId;
		} catch (error) {
			logger.warn("Council summary delivery failed", { error: errorText(error) });
		}
	}
}

export function getCouncilCoordinator(host: CouncilCoordinatorHost): CouncilCoordinator {
	const sessionId = host.sessionManager.getSessionId();
	const existing = coordinators.get(sessionId);
	if (existing) {
		const sameBinding =
			existing.session === host.session &&
			existing.toolSession === host.toolSession &&
			existing.sessionManager === host.sessionManager;
		if (sameBinding || executingCoordinators.has(existing.coordinator)) return existing.coordinator;
	}
	const coordinator = new CouncilCoordinator(host);
	coordinators.set(sessionId, {
		coordinator,
		session: host.session,
		toolSession: host.toolSession,
		sessionManager: host.sessionManager,
	});
	return coordinator;
}

export function resetCouncilCoordinatorsForTests(): void {
	coordinators.clear();
	activeCoordinators.clear();
}
