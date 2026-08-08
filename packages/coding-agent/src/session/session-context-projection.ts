import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { Message } from "@oh-my-pi/pi-ai";
import { logger } from "@oh-my-pi/pi-utils";
import type { OutputMeta } from "../tools/output-meta";
import type { SessionEntry } from "./session-entries";

export type ContextInclusionReason =
	| "active-branch"
	| "before-reset"
	| "compacted"
	| "provider-replacement-history"
	| "retry-recovery"
	| "prewalk-plan-model-excluded"
	| "invalid-custom-content"
	| "unsafe-assistant-turn"
	| "dangling-tool-call"
	| "metadata-only"
	| "generated-compaction-summary"
	| "generated-branch-summary"
	| "generated-archive"
	| "pending-turn"
	| "provider-transform"
	| "system-prompt";

export interface ContextVisibility {
	persisted: boolean;
	display: boolean;
	model: boolean;
}

export interface ContextBranchIdentity {
	entryId: string;
	entryType: SessionEntry["type"];
	parentId: string | null;
	position: number | null;
	active: boolean;
}

export interface ContextAssemblySource {
	id: string;
	category: "stored" | "generated" | "turn" | "system";
	kind: string;
	content?: AgentMessage | string;
	branch?: ContextBranchIdentity;
	visibility: ContextVisibility;
	inclusion: { included: boolean; reason: ContextInclusionReason };
	outputMeta?: OutputMeta;
	requestId?: string;
	sessionId?: string;
	leafId?: string | null;
	metadata?: Readonly<Record<string, unknown>>;
}

export type ContextAssemblyRelation =
	| { kind: "branch-order"; sourceId: string; position: number }
	| {
			kind: "generated-from" | "replaces" | "reset-excludes" | "system-fold";
			sourceIds: readonly string[];
			targetIds: readonly string[];
			reason?: string;
	  };

export interface SystemPromptLogicalSource {
	id: string;
	kind:
		| "default"
		| "custom"
		| "system-file"
		| "append"
		| "context-file"
		| "skill"
		| "rule"
		| "always-apply-rule"
		| "workspace"
		| "tools"
		| "environment"
		| "personality"
		| "active-repository"
		| "computer-safety"
		| "turn-override";
	content?: string;
	path?: string;
	name?: string;
	metadata?: Readonly<Record<string, unknown>>;
	foldedInto: readonly number[];
}

export interface ProviderTransformRelation {
	kind: "preserved" | "dropped" | "split" | "merged" | "rewritten";
	sourceIds: readonly string[];
	transformedMessageIndexes: readonly number[];
	providerMessageIndexes: readonly number[];
}
export interface ContextTransformLineage {
	sourceIds: readonly string[];
	transformedMessageIndexes: readonly number[];
	rewritten: boolean;
}

export interface ContextTokenEvidence {
	kind: "provider-aggregate";
	tokens: number;
	source: "provider-usage";
}

export interface ContextAssemblySnapshot {
	revision: number;
	sessionId?: string;
	leafId: string | null;
	requestId?: string;
	sources: readonly ContextAssemblySource[];
	relations: readonly ContextAssemblyRelation[];
	systemPrompt: {
		logicalSources: readonly SystemPromptLogicalSource[];
		rendered: readonly string[];
	};
	provider?: {
		systemPrompt?: readonly string[];
		messages: readonly Message[];
		relations: readonly ProviderTransformRelation[];
	};
	tokenEvidence?: readonly ContextTokenEvidence[];
}

export interface ContextAssemblySnapshotReader {
	read(): ContextAssemblySnapshot;
	subscribe(listener: (snapshot: ContextAssemblySnapshot) => void): () => void;
}

const sourceIdsByMessage = new WeakMap<object, readonly string[]>();
const requestIdByMessage = new WeakMap<object, string>();

export function contextSourceIdsForMessage(message: AgentMessage): readonly string[] {
	return sourceIdsByMessage.get(message) ?? [];
}

export function setContextSourceIdsForMessage(message: AgentMessage, sourceIds: readonly string[]): void {
	sourceIdsByMessage.set(message, sourceIds);
}

export function contextRequestIdForMessages(messages: readonly AgentMessage[]): string | undefined {
	for (let index = messages.length - 1; index >= 0; index--) {
		const requestId = requestIdByMessage.get(messages[index]);
		if (requestId) return requestId;
	}
	return undefined;
}

function setContextRequestIdForMessage(message: AgentMessage, requestId: string | undefined): void {
	if (requestId) requestIdByMessage.set(message, requestId);
}
/** Transfers already-captured lineage across equivalent ordered session arrays without inspecting rendered content. */
export function bindContextMessageSources(source: readonly AgentMessage[], target: readonly AgentMessage[]): void {
	if (source.length !== target.length) return;
	for (let index = 0; index < source.length; index++) {
		if (source[index].role !== target[index].role) return;
	}
	for (let index = 0; index < source.length; index++) {
		setContextSourceIdsForMessage(target[index], contextSourceIdsForMessage(source[index]));
	}
}

function outputMetaForMessage(message: AgentMessage): OutputMeta | undefined {
	if (message.role === "bashExecution" || message.role === "pythonExecution") return message.meta;
	if (message.role !== "toolResult") return undefined;
	const details = message.details;
	if (!details || typeof details !== "object" || !("meta" in details)) return undefined;
	const meta = details.meta;
	return meta && typeof meta === "object" ? (meta as OutputMeta) : undefined;
}

function storedVisibility(entry: SessionEntry, active: boolean): ContextVisibility {
	if (!active) return { persisted: true, display: false, model: false };
	if (entry.type === "message") {
		return {
			persisted: true,
			display: entry.message.role !== "custom" || entry.message.display,
			model: false,
		};
	}
	if (entry.type === "custom_message") return { persisted: true, display: entry.display, model: false };
	return {
		persisted: true,
		display: entry.type === "compaction" || entry.type === "branch_summary",
		model: false,
	};
}

/** Records authoritative branch entries while context assembly decides their effective model representation. */
export class StoredContextAssemblyBuilder {
	readonly #sources: ContextAssemblySource[];
	readonly #sourceById = new Map<string, ContextAssemblySource>();
	readonly #relations: ContextAssemblyRelation[];
	readonly #leafId: string | null;

	constructor(path: readonly SessionEntry[], leafId: string | null, entries: readonly SessionEntry[] = path) {
		this.#leafId = leafId;
		const activePositionById = new Map(path.map((entry, position) => [entry.id, position]));
		this.#sources = entries.map(entry => {
			const position = activePositionById.get(entry.id) ?? null;
			const active = position !== null;
			const source: ContextAssemblySource = {
				id: `entry:${entry.id}`,
				category: "stored",
				kind: entry.type,
				branch: {
					entryId: entry.id,
					entryType: entry.type,
					parentId: entry.parentId,
					position,
					active,
				},
				visibility: storedVisibility(entry, active),
				inclusion: { included: false, reason: "metadata-only" },
			};
			this.#sourceById.set(source.id, source);
			return source;
		});
		this.#relations = path.map((entry, position) => ({
			kind: "branch-order" as const,
			sourceId: `entry:${entry.id}`,
			position,
		}));
	}

	includeEntry(entry: SessionEntry, message: AgentMessage, reason: ContextInclusionReason = "active-branch"): void {
		const source = this.#sourceById.get(`entry:${entry.id}`);
		if (!source) return;
		source.kind = message.role === "custom" ? message.customType : message.role;
		source.content = message;
		source.outputMeta = outputMetaForMessage(message);
		source.visibility.model = true;
		source.inclusion = { included: true, reason };
		setContextSourceIdsForMessage(message, [source.id]);
	}

	excludeEntry(entry: SessionEntry, reason: ContextInclusionReason): void {
		const source = this.#sourceById.get(`entry:${entry.id}`);
		if (!source) return;
		source.visibility.model = false;
		source.inclusion = { included: false, reason };
	}

	addGenerated(
		id: string,
		kind: string,
		message: AgentMessage | undefined,
		fromSourceIds: readonly string[],
		reason: ContextInclusionReason,
		visibility: ContextVisibility,
		metadata?: Readonly<Record<string, unknown>>,
	): string {
		const source: ContextAssemblySource = {
			id,
			category: "generated",
			kind,
			content: message,
			visibility,
			inclusion: { included: visibility.model, reason },
			outputMeta: message ? outputMetaForMessage(message) : undefined,
			metadata,
		};
		this.#sources.push(source);
		this.#sourceById.set(id, source);
		this.#relations.push({ kind: "generated-from", sourceIds: fromSourceIds, targetIds: [id] });
		if (message) setContextSourceIdsForMessage(message, [id]);
		return id;
	}

	addRelation(relation: ContextAssemblyRelation): void {
		this.#relations.push(relation);
	}

	replaceMessage(previous: AgentMessage, replacement: AgentMessage): void {
		const sourceIds = contextSourceIdsForMessage(previous);
		setContextSourceIdsForMessage(replacement, sourceIds);
		for (const sourceId of sourceIds) {
			const source = this.#sourceById.get(sourceId);
			if (source) {
				source.content = replacement;
				source.outputMeta = outputMetaForMessage(replacement);
			}
		}
	}

	dropMessage(message: AgentMessage, reason: ContextInclusionReason): void {
		for (const sourceId of contextSourceIdsForMessage(message)) {
			const source = this.#sourceById.get(sourceId);
			if (!source) continue;
			source.visibility.model = false;
			source.inclusion = { included: false, reason };
		}
	}

	finish(): ContextAssemblySnapshot {
		return {
			revision: 0,
			leafId: this.#leafId,
			sources: this.#sources,
			relations: this.#relations,
			systemPrompt: { logicalSources: [], rendered: [] },
		};
	}
}
/** Carries source identity through context hooks by identity, with ordered 1:1 fallback and no content matching. */
export function relateContextTransform(
	before: readonly AgentMessage[],
	after: readonly AgentMessage[],
): ContextTransformLineage[] {
	const beforeIndexByIdentity = new Map<AgentMessage, number>();
	for (let index = 0; index < before.length; index++) beforeIndexByIdentity.set(before[index], index);
	const matchedBefore = new Set<number>();
	const matchedAfter = new Set<number>();
	const lineage: ContextTransformLineage[] = [];
	for (let index = 0; index < after.length; index++) {
		const beforeIndex = beforeIndexByIdentity.get(after[index]);
		if (beforeIndex === undefined) continue;
		matchedBefore.add(beforeIndex);
		matchedAfter.add(index);
		const sourceIds = contextSourceIdsForMessage(before[beforeIndex]);
		setContextSourceIdsForMessage(after[index], sourceIds);
		setContextRequestIdForMessage(after[index], requestIdByMessage.get(before[beforeIndex]));
		lineage.push({ sourceIds, transformedMessageIndexes: [index], rewritten: false });
	}
	const unmatchedBefore = before.flatMap((message, index) => (matchedBefore.has(index) ? [] : [message]));
	const unmatchedAfterIndexes = after.flatMap((_message, index) => (matchedAfter.has(index) ? [] : [index]));
	if (unmatchedBefore.length === unmatchedAfterIndexes.length) {
		for (let index = 0; index < unmatchedBefore.length; index++) {
			const sourceIds = contextSourceIdsForMessage(unmatchedBefore[index]);
			const transformedIndex = unmatchedAfterIndexes[index];
			setContextSourceIdsForMessage(after[transformedIndex], sourceIds);
			lineage.push({ sourceIds, transformedMessageIndexes: [transformedIndex], rewritten: true });
			setContextRequestIdForMessage(after[transformedIndex], requestIdByMessage.get(unmatchedBefore[index]));
		}
	} else if (unmatchedBefore.length === 0) {
		const requestId = contextRequestIdForMessages(before);
		for (const index of unmatchedAfterIndexes) {
			const sourceId = `provider-transform:${requestId ?? "unbound"}:${index}`;
			setContextSourceIdsForMessage(after[index], [sourceId]);
			setContextRequestIdForMessage(after[index], requestId);
			lineage.push({ sourceIds: [sourceId], transformedMessageIndexes: [index], rewritten: true });
		}
	} else if (unmatchedBefore.length > 0 || unmatchedAfterIndexes.length > 0) {
		const sourceIds = [...new Set(unmatchedBefore.flatMap(message => contextSourceIdsForMessage(message)))];
		for (const index of unmatchedAfterIndexes) setContextSourceIdsForMessage(after[index], sourceIds);
		lineage.push({ sourceIds, transformedMessageIndexes: unmatchedAfterIndexes, rewritten: true });
		const requestId = contextRequestIdForMessages(unmatchedBefore);
		for (const index of unmatchedAfterIndexes) setContextRequestIdForMessage(after[index], requestId);
	}
	return lineage;
}

/** Reconciles canonical conversion fragments with the final provider pipeline without reverse-parsing content. */
export function reconcileProviderRelations(
	canonicalMessages: readonly Message[],
	finalMessages: readonly Message[],
	relations: readonly ProviderTransformRelation[],
): ProviderTransformRelation[] {
	if (canonicalMessages === finalMessages) return [...relations];
	const finalIndexByIdentity = new Map<Message, number>();
	for (let index = 0; index < finalMessages.length; index++) finalIndexByIdentity.set(finalMessages[index], index);
	const retained = canonicalMessages.map(message => finalIndexByIdentity.get(message));
	const hasIdentityEvidence = retained.some(index => index !== undefined);
	if (!hasIdentityEvidence) {
		if (canonicalMessages.length === finalMessages.length) {
			return relations.map(relation => ({
				...relation,
				kind: relation.kind === "dropped" ? "dropped" : "rewritten",
			}));
		}
		const activeRelations = relations.filter(relation => relation.providerMessageIndexes.length > 0);
		const sourceIds = [...new Set(activeRelations.flatMap(relation => relation.sourceIds))];
		const transformedMessageIndexes = [
			...new Set(activeRelations.flatMap(relation => relation.transformedMessageIndexes)),
		];
		const providerMessageIndexes = finalMessages.map((_message, index) => index);
		const kind =
			providerMessageIndexes.length === 0
				? "dropped"
				: sourceIds.length > 1 && providerMessageIndexes.length === 1
					? "merged"
					: sourceIds.length === 1 && providerMessageIndexes.length > 1
						? "split"
						: "rewritten";
		return [{ kind, sourceIds, transformedMessageIndexes, providerMessageIndexes }];
	}
	const orderedOneToOne = canonicalMessages.length === finalMessages.length;
	return relations.map(relation => {
		let usedOrderedFallback = false;
		const providerMessageIndexes = relation.providerMessageIndexes.flatMap(index => {
			const retainedIndex = retained[index];
			if (retainedIndex !== undefined) return [retainedIndex];
			if (orderedOneToOne && finalMessages[index] !== undefined) {
				usedOrderedFallback = true;
				return [index];
			}
			return [];
		});
		const kind =
			providerMessageIndexes.length === 0
				? "dropped"
				: relation.sourceIds.length > 1 && providerMessageIndexes.length === 1
					? "merged"
					: relation.sourceIds.length === 1 && providerMessageIndexes.length > 1
						? "split"
						: relation.kind === "preserved" && !usedOrderedFallback
							? "preserved"
							: "rewritten";
		return { ...relation, kind, providerMessageIndexes };
	});
}

export interface CaptureTurnContextOptions {
	sessionId: string;
	leafId: string | null;
	requestId: string;
	stored: ContextAssemblySnapshot;
	messages: readonly AgentMessage[];
	systemPrompt: readonly string[];
	logicalSystemSources?: readonly SystemPromptLogicalSource[];
	tokenEvidence?: readonly ContextTokenEvidence[];
}

/** Session-owned capture module; presentation adapters only need the read/subscribe interface. */
export class SessionContextProjection implements ContextAssemblySnapshotReader {
	#snapshot: ContextAssemblySnapshot = Object.freeze({
		revision: 0,
		leafId: null,
		sources: Object.freeze([]),
		relations: Object.freeze([]),
		systemPrompt: Object.freeze({ logicalSources: Object.freeze([]), rendered: Object.freeze([]) }),
	});
	#systemSources: readonly SystemPromptLogicalSource[] = [];
	#listeners = new Set<(snapshot: ContextAssemblySnapshot) => void>();

	read(): ContextAssemblySnapshot {
		return this.#snapshot;
	}

	subscribe(listener: (snapshot: ContextAssemblySnapshot) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	setSystemPrompt(logicalSources: readonly SystemPromptLogicalSource[]): void {
		this.#systemSources = Object.freeze(
			logicalSources.map(source =>
				Object.freeze({
					...source,
					metadata: source.metadata ? Object.freeze({ ...source.metadata }) : undefined,
					foldedInto: Object.freeze([...source.foldedInto]),
				}),
			),
		);
	}
	currentSystemSources(): readonly SystemPromptLogicalSource[] {
		return this.#systemSources;
	}

	reset(sessionId: string, leafId: string | null): void {
		this.#publish({
			revision: this.#snapshot.revision + 1,
			sessionId,
			leafId,
			sources: [],
			relations: [],
			systemPrompt: { logicalSources: [], rendered: [] },
		});
	}

	captureTurn(options: CaptureTurnContextOptions): void {
		const logicalSystemSources = options.logicalSystemSources ?? this.#systemSources;
		const storedSources: ContextAssemblySource[] = options.stored.sources.map(source => ({
			...source,
			requestId: options.requestId,
			sessionId: options.sessionId,
			leafId: options.leafId,
		}));
		const turnSources = options.messages.map((message, index) => {
			setContextRequestIdForMessage(message, options.requestId);
			const sourceId = `turn:${options.requestId}:${index}`;
			setContextSourceIdsForMessage(message, [sourceId]);
			const display = message.role !== "custom" || message.display;
			return {
				id: sourceId,
				category: "turn" as const,
				kind: message.role === "custom" ? message.customType : message.role,
				content: message,
				visibility: { persisted: false, display, model: true },
				inclusion: { included: true, reason: "pending-turn" as const },
				outputMeta: outputMetaForMessage(message),
				requestId: options.requestId,
				sessionId: options.sessionId,
				leafId: options.leafId,
			} satisfies ContextAssemblySource;
		});
		const systemSources: ContextAssemblySource[] = logicalSystemSources.map(source => ({
			id: `system:${source.id}`,
			category: "system",
			kind: source.kind,
			content: source.content,
			visibility: { persisted: false, display: false, model: true },
			inclusion: { included: true, reason: "system-prompt" },
			metadata: source.metadata,
			requestId: options.requestId,
			sessionId: options.sessionId,
			leafId: options.leafId,
		}));
		const systemRelations: ContextAssemblyRelation[] = logicalSystemSources.map(source => ({
			kind: "system-fold",
			sourceIds: [`system:${source.id}`],
			targetIds: source.foldedInto.map(index => `system-rendered:${index}`),
		}));
		this.#publish({
			revision: this.#snapshot.revision + 1,
			sessionId: options.sessionId,
			leafId: options.leafId,
			requestId: options.requestId,
			sources: [...storedSources, ...systemSources, ...turnSources],
			relations: [...options.stored.relations, ...systemRelations],
			systemPrompt: { logicalSources: logicalSystemSources, rendered: options.systemPrompt },
			tokenEvidence: options.tokenEvidence,
		});
	}

	captureProvider(
		requestId: string | undefined,
		messages: readonly Message[],
		relations: readonly ProviderTransformRelation[],
		transformedMessages: readonly AgentMessage[] = [],
		systemPrompt?: readonly string[],
	): void {
		if (!requestId || requestId !== this.#snapshot.requestId) return;
		const knownSourceIds = new Set(this.#snapshot.sources.map(source => source.id));
		const generatedSources: ContextAssemblySource[] = [];
		for (const message of transformedMessages) {
			for (const sourceId of contextSourceIdsForMessage(message)) {
				if (knownSourceIds.has(sourceId)) continue;
				knownSourceIds.add(sourceId);
				generatedSources.push({
					id: sourceId,
					category: "generated",
					kind: message.role === "custom" ? message.customType : message.role,
					content: message,
					visibility: {
						persisted: false,
						display: message.role !== "custom" || message.display,
						model: true,
					},
					inclusion: { included: true, reason: "provider-transform" },
					outputMeta: outputMetaForMessage(message),
					requestId,
					sessionId: this.#snapshot.sessionId,
					leafId: this.#snapshot.leafId,
				});
			}
		}
		this.#publish({
			...this.#snapshot,
			revision: this.#snapshot.revision + 1,
			sources: [...this.#snapshot.sources, ...generatedSources],
			provider: { messages, relations, systemPrompt },
		});
	}

	#publish(snapshot: ContextAssemblySnapshot): void {
		const sources = snapshot.sources.map(source =>
			Object.freeze({
				...source,
				branch: source.branch ? Object.freeze({ ...source.branch }) : undefined,
				visibility: Object.freeze({ ...source.visibility }),
				inclusion: Object.freeze({ ...source.inclusion }),
				metadata: source.metadata ? Object.freeze({ ...source.metadata }) : undefined,
			}),
		);
		const relations = snapshot.relations.map(relation =>
			relation.kind === "branch-order"
				? Object.freeze({ ...relation })
				: Object.freeze({
						...relation,
						sourceIds: Object.freeze([...relation.sourceIds]),
						targetIds: Object.freeze([...relation.targetIds]),
					}),
		);
		const logicalSources = snapshot.systemPrompt.logicalSources.map(source =>
			Object.freeze({
				...source,
				metadata: source.metadata ? Object.freeze({ ...source.metadata }) : undefined,
				foldedInto: Object.freeze([...source.foldedInto]),
			}),
		);
		const provider = snapshot.provider
			? Object.freeze({
					systemPrompt: snapshot.provider.systemPrompt
						? Object.freeze([...snapshot.provider.systemPrompt])
						: undefined,
					messages: Object.freeze([...snapshot.provider.messages]),
					relations: Object.freeze(
						snapshot.provider.relations.map(relation =>
							Object.freeze({
								...relation,
								sourceIds: Object.freeze([...relation.sourceIds]),
								transformedMessageIndexes: Object.freeze([...relation.transformedMessageIndexes]),
								providerMessageIndexes: Object.freeze([...relation.providerMessageIndexes]),
							}),
						),
					),
				})
			: undefined;
		const frozen: ContextAssemblySnapshot = Object.freeze({
			...snapshot,
			sources: Object.freeze(sources),
			relations: Object.freeze(relations),
			systemPrompt: Object.freeze({
				logicalSources: Object.freeze(logicalSources),
				rendered: Object.freeze([...snapshot.systemPrompt.rendered]),
			}),
			provider,
			tokenEvidence: snapshot.tokenEvidence
				? Object.freeze(snapshot.tokenEvidence.map(evidence => Object.freeze({ ...evidence })))
				: undefined,
		});
		this.#snapshot = frozen;
		for (const listener of this.#listeners) {
			try {
				listener(frozen);
			} catch (error) {
				logger.warn("Context assembly snapshot listener failed", { error: String(error) });
			}
		}
	}
}
