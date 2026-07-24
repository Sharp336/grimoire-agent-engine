import * as fs from "node:fs";
import * as path from "node:path";
import { ADVISOR_TRANSCRIPT_FILENAME, isAdvisorTranscriptName } from "../advisor/transcript-recorder";
import type { AgentSession } from "../session/agent-session";
import {
	CONSULTATION_STATUS_MESSAGE_TYPE,
	CONSULTATION_TITLE_CUSTOM_TYPE,
	CONSULTATION_TITLE_STATE_CUSTOM_TYPE,
	CONSULTATION_TURN_CUSTOM_TYPE,
	type ConsultationThreadRecord,
	type ConsultationTitleRecord,
	type ConsultationTitleStateRecord,
	type ConsultationTurnRecord,
	consultationAgentId,
	consultationFirstTurnConversation,
	consultationThreadTitle,
	consultationThreadTitlePresentation,
	consultationTurnStates,
	formatConsultationDisplayName,
	latestTerminalConsultationTurn,
	lookupConsultationThread,
	parseConsultationTranscriptName,
} from "../session/consultation";
import { loadEntriesFromFile } from "../session/session-loader";
import { SessionManager } from "../session/session-manager";
import { persistedVibeChildIds } from "../vibe/runtime";
import { type AgentRegistry, MAIN_AGENT_ID } from "./agent-registry";

/**
 * Child ids owned by the Vibe roster persisted in this session file. Vibe
 * workers are revived through the Vibe registry's own journal, so the generic
 * persisted-subagent scan must not register them as plain `sub` refs.
 */
async function readPersistedVibeChildIds(sessionFile: string): Promise<Set<string>> {
	let sessionManager: SessionManager;
	try {
		sessionManager = await SessionManager.open(sessionFile, undefined, undefined, { suppressBreadcrumb: true });
	} catch {
		return new Set();
	}
	try {
		return persistedVibeChildIds(sessionManager.getEntries());
	} finally {
		await sessionManager.close();
	}
}

export interface PersistedConsultationState {
	thread: ConsultationThreadRecord;
	latestTurn: ConsultationTurnRecord | undefined;
	generatedTitle: string | undefined;
	displayTitle: string;
	currentStatus: "running" | "completed" | "failed" | "cancelled";
}

interface ConsultationDisplayTitle {
	generatedTitle: string | undefined;
	displayTitle: string | undefined;
}

const consultationTitles = new WeakMap<AgentRegistry, Map<string, ConsultationDisplayTitle>>();
const pendingConsultationTitleRetries = new Map<string, Promise<void>>();
let consultationTitleRetryTail = Promise.resolve();

function titlesFor(registry: AgentRegistry): Map<string, ConsultationDisplayTitle> {
	let titles = consultationTitles.get(registry);
	if (!titles) {
		titles = new Map();
		consultationTitles.set(registry, titles);
	}
	return titles;
}

function isLiveLocalConsultation(
	registry: AgentRegistry,
	ownerId: string,
	consultationId: string,
	sessionFile: string,
): boolean {
	const ref = registry.get(consultationAgentId(ownerId, consultationId));
	return (
		ref?.kind === "consultation" &&
		ref.status === "running" &&
		ref.sessionFile !== null &&
		path.resolve(ref.sessionFile) === path.resolve(sessionFile)
	);
}

/**
 * A running side turn has no surviving worker after a process restart. Append
 * its terminal cancellation before any registry or resume UI reads the file so
 * recovery cannot present stale output as live streaming.
 */
async function finalizeInterruptedConsultationTurns(sessionFile: string, consultationId: string) {
	const manager = await SessionManager.open(sessionFile, undefined, undefined, { suppressBreadcrumb: true });
	try {
		const interruptedTurns = consultationTurnStates(manager.getEntries(), consultationId)
			.filter(state => state.terminal === undefined)
			.map(state => state.turn);
		if (interruptedTurns.length === 0) return manager.getEntries();

		const finishedAt = Date.now();
		for (const turn of interruptedTurns) {
			manager.appendMessage({
				role: "custom",
				customType: CONSULTATION_STATUS_MESSAGE_TYPE,
				content: "[Consultation interrupted by process exit.]",
				display: true,
				timestamp: finishedAt,
			});
			manager.appendCustomEntry(CONSULTATION_TURN_CUSTOM_TYPE, {
				...turn,
				status: "cancelled",
				finishedAt,
			} satisfies ConsultationTurnRecord);
		}
		await manager.flush();
		return manager.getEntries();
	} finally {
		await manager.close().catch(() => {});
	}
}

function refreshConsultationDisplayNames(registry: AgentRegistry, ownerId: string): void {
	const prefix = `${ownerId}/consult:`;
	const refs = registry.list().filter(ref => ref.kind === "consultation" && ref.parentId === ownerId);
	const consultationIds = refs
		.map(ref => (ref.id.startsWith(prefix) ? ref.id.slice(prefix.length) : undefined))
		.filter((id): id is string => id !== undefined);
	const titles = titlesFor(registry);
	for (const ref of refs) {
		const consultationId = ref.id.startsWith(prefix) ? ref.id.slice(prefix.length) : undefined;
		if (!consultationId) continue;
		ref.displayName = formatConsultationDisplayName(
			titles.get(ref.id)?.displayTitle,
			consultationId,
			consultationIds,
		);
	}
}

export function registerPersistedConsultation(
	registry: AgentRegistry,
	options: {
		ownerId: string;
		consultationId: string;
		sessionFile: string;
		generatedTitle?: string;
		displayTitle?: string;
		state?: PersistedConsultationState;
		parked?: boolean;
	},
): void {
	const id = consultationAgentId(options.ownerId, options.consultationId);
	const existing = registry.get(id);
	if (existing && existing.kind !== "consultation") return;
	const sessionChanged = existing?.sessionFile !== options.sessionFile;
	const prior = sessionChanged ? undefined : titlesFor(registry).get(id);
	const generatedTitle = options.generatedTitle ?? options.state?.generatedTitle ?? prior?.generatedTitle;
	const displayTitle = options.displayTitle ?? options.state?.displayTitle ?? generatedTitle ?? prior?.displayTitle;
	const titles = titlesFor(registry);
	titles.set(id, { generatedTitle, displayTitle });
	const status =
		options.parked || (options.state !== undefined && options.state.currentStatus !== "running")
			? "parked"
			: "running";
	if (existing?.sessionFile === options.sessionFile) {
		registry.setStatus(id, status);
		refreshConsultationDisplayNames(registry, options.ownerId);
		return;
	}
	if (existing) registry.unregister(id);
	registry.register({
		id,
		displayName: formatConsultationDisplayName(displayTitle, options.consultationId),
		kind: "consultation",
		parentId: options.ownerId,
		session: null,
		sessionFile: options.sessionFile,
		status,
	});
	refreshConsultationDisplayNames(registry, options.ownerId);
}

/**
 * Generate a missing consultation subject from the persisted first completed
 * exchange. Calls share one process-wide lane so an Agent Hub scan cannot
 * amplify title-model requests; a completed title is checked again under that
 * lane before any provider work begins.
 */
export function retryPersistedConsultationTitle(
	registry: AgentRegistry,
	options: {
		ownerId: string;
		consultationId: string;
		sessionFile: string;
		session: AgentSession;
		onGenerated?: (title: string) => void;
	},
): Promise<void> {
	const key = path.resolve(options.sessionFile);
	const pending = pendingConsultationTitleRetries.get(key);
	if (pending) return pending;

	const retry = consultationTitleRetryTail.then(() => persistCanonicalConsultationTitle(registry, options));
	const settled = retry.catch(() => {});
	pendingConsultationTitleRetries.set(key, settled);
	consultationTitleRetryTail = settled;
	void settled.then(() => {
		if (pendingConsultationTitleRetries.get(key) === settled) {
			pendingConsultationTitleRetries.delete(key);
		}
	});
	return settled;
}

async function persistCanonicalConsultationTitle(
	registry: AgentRegistry,
	options: {
		ownerId: string;
		consultationId: string;
		sessionFile: string;
		session: AgentSession;
		onGenerated?: (title: string) => void;
	},
): Promise<void> {
	const manager = await SessionManager.open(options.sessionFile, undefined, undefined, { suppressBreadcrumb: true });
	try {
		const entries = manager.getEntries();
		if (consultationThreadTitle(entries, options.consultationId)) return;
		const conversation = consultationFirstTurnConversation(entries, options.consultationId);
		if (!conversation) return;

		manager.appendCustomEntry(CONSULTATION_TITLE_STATE_CUSTOM_TYPE, {
			version: 1,
			consultationId: options.consultationId,
			status: "pending",
			attemptedAt: Date.now(),
		});
		await manager.flush();

		let title: string | null;
		try {
			title = await options.session.generateConsultationTitle(conversation.question, conversation.answer);
		} catch (error) {
			manager.appendCustomEntry(CONSULTATION_TITLE_STATE_CUSTOM_TYPE, {
				version: 1,
				consultationId: options.consultationId,
				status: "failed",
				attemptedAt: Date.now(),
				error: error instanceof Error ? error.message : String(error),
			} satisfies ConsultationTitleStateRecord);
			await manager.flush();
			return;
		}
		if (!title) {
			manager.appendCustomEntry(CONSULTATION_TITLE_STATE_CUSTOM_TYPE, {
				version: 1,
				consultationId: options.consultationId,
				status: "failed",
				attemptedAt: Date.now(),
				error: "Canonical title service returned no subject.",
			} satisfies ConsultationTitleStateRecord);
			await manager.flush();
			return;
		}

		manager.appendCustomEntry(CONSULTATION_TITLE_CUSTOM_TYPE, {
			version: 1,
			consultationId: options.consultationId,
			source: "canonical",
			title,
			createdAt: Date.now(),
		} satisfies ConsultationTitleRecord);
		await manager.flush();

		const presentation = consultationThreadTitlePresentation(manager.getEntries(), options.consultationId);
		if (!presentation.generatedTitle) return;
		registerPersistedConsultation(registry, {
			ownerId: options.ownerId,
			consultationId: options.consultationId,
			sessionFile: options.sessionFile,
			generatedTitle: presentation.generatedTitle,
			displayTitle: presentation.displayTitle,
			parked: !isLiveLocalConsultation(registry, options.ownerId, options.consultationId, options.sessionFile),
		});
		options.onGenerated?.(presentation.generatedTitle);
	} finally {
		await manager.close().catch(() => {});
	}
}
/** Register persisted subagent and advisor transcripts as parked registry refs. */
export async function registerPersistedSubagents(
	registry: AgentRegistry,
	sessionFile: string | null | undefined,
): Promise<void> {
	if (!sessionFile?.endsWith(".jsonl")) return;
	const vibeOwnedIds = await readPersistedVibeChildIds(sessionFile);
	const root = sessionFile.slice(0, -6);
	await registerPersistedTranscriptsFromDir(registry, root, MAIN_AGENT_ID, {
		includeAgents: true,
		vibeOwnedIds,
	});
}

/**
 * Register only consultation transcripts beneath a persisted session's artifact
 * tree. This is the lazy discovery path used by consultation controls before
 * their first registry lookup after a restart.
 */
export async function registerPersistedConsultations(
	registry: AgentRegistry,
	sessionFile: string | null | undefined,
	ownerId: string,
): Promise<void> {
	if (!sessionFile?.endsWith(".jsonl")) return;
	const root = sessionFile.slice(0, -6);
	await registerPersistedTranscriptsFromDir(registry, root, ownerId, { includeAgents: false });
}

async function registerPersistedTranscriptsFromDir(
	registry: AgentRegistry,
	dir: string,
	ownerId: string,
	options: { includeAgents: boolean; vibeOwnedIds?: ReadonlySet<string> },
): Promise<void> {
	let entries: fs.Dirent[];
	try {
		entries = await fs.promises.readdir(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		if (!entry.isFile() || !entry.name.endsWith(".jsonl") || entry.name.includes(".bak")) continue;
		const sessionFile = path.join(dir, entry.name);
		const consultationId = parseConsultationTranscriptName(entry.name);
		if (consultationId) {
			// A consultation registered as running belongs to this process. Agent Hub
			// discovery is not recovery in that case: leave its durable turn open for
			// the local worker to finish instead of appending a false cancellation.
			const liveLocal = isLiveLocalConsultation(registry, ownerId, consultationId, sessionFile);
			const sessionEntries = liveLocal
				? await loadEntriesFromFile(sessionFile).catch(() => [])
				: await finalizeInterruptedConsultationTurns(sessionFile, consultationId).catch(() =>
						loadEntriesFromFile(sessionFile).catch(() => []),
					);
			const lookup = lookupConsultationThread(sessionEntries, consultationId);
			const thread = lookup.hasCollision ? undefined : lookup.thread;
			if (!thread) {
				if (liveLocal || lookup.hasCollision || !options.includeAgents) continue;
			} else {
				const turnStates = consultationTurnStates(sessionEntries, consultationId);
				const latestTurn = latestTerminalConsultationTurn(sessionEntries, consultationId);
				const currentTurn = turnStates[turnStates.length - 1];
				const title = consultationThreadTitlePresentation(sessionEntries, consultationId);
				registerPersistedConsultation(registry, {
					ownerId,
					consultationId,
					sessionFile,
					state: {
						thread,
						generatedTitle: title.generatedTitle,
						displayTitle: title.displayTitle,
						latestTurn,
						currentStatus: currentTurn?.terminal?.status ?? currentTurn?.turn.status ?? "running",
					},
					parked: !liveLocal,
				});
				const ownerSession = registry.get(ownerId)?.session;
				if (!title.generatedTitle && ownerSession) {
					void retryPersistedConsultationTitle(registry, {
						ownerId,
						consultationId,
						sessionFile,
						session: ownerSession,
					});
				}
				continue;
			}
		}
		// The advisor transcript is observability-only: register it as a non-peer
		// `advisor` kind under its owning session so the Hub can show its read-only
		// transcript, but it never joins agent-facing rosters and is not revivable.
		if (isAdvisorTranscriptName(entry.name)) {
			if (!options.includeAgents) continue;
			const owner = ownerId;
			// `__advisor.jsonl` → the default advisor (no slug); `__advisor.<slug>.jsonl`
			// → a named advisor, keyed and labeled by its slug.
			const slug =
				entry.name === ADVISOR_TRANSCRIPT_FILENAME ? "" : entry.name.slice("__advisor.".length, -".jsonl".length);
			const advisorId = slug ? `${owner}/advisor:${slug}` : `${owner}/advisor`;
			const displayName = slug ? `advisor:${slug}` : "advisor";
			const existing = registry.get(advisorId);
			// Never clobber a non-advisor ref that happens to share this id (a freak
			// user task literally named `<owner>/advisor`): leave it, skip the advisor.
			if (existing && existing.kind !== "advisor") continue;
			if (existing?.sessionFile !== sessionFile) {
				// The id is reused across `/new`; refresh it to the current session's file.
				if (existing) registry.unregister(advisorId);
				registry.register({
					id: advisorId,
					displayName,
					kind: "advisor",
					parentId: owner,
					session: null,
					sessionFile,
					status: "parked",
				});
			}
			continue;
		}
		const id = entry.name.slice(0, -6);
		if (options.vibeOwnedIds?.has(id) && registry.get(id)?.sessionFile !== sessionFile) continue;
		if (options.includeAgents && !registry.get(id)) {
			registry.register({
				id,
				displayName: id,
				kind: "sub",
				parentId: ownerId,
				session: null,
				sessionFile,
				status: "parked",
			});
		}
		await registerPersistedTranscriptsFromDir(registry, path.join(dir, id), id, options);
	}
}
