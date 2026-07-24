import * as path from "node:path";
import { prompt, Snowflake } from "@oh-my-pi/pi-utils";
import consultSideChannel from "../../prompts/system/consult-side-channel.md" with { type: "text" };
import consultUserPrompt from "../../prompts/system/consult-user.md" with { type: "text" };
import { AgentRegistry, MAIN_AGENT_ID } from "../../registry/agent-registry";
import {
	registerPersistedConsultation,
	registerPersistedConsultations,
	retryPersistedConsultationTitle,
} from "../../registry/persisted-agents";
import type { ReadOnlySideRequestSnapshot } from "../../session/agent-session-types";
import {
	CONSULTATION_STATUS_MESSAGE_TYPE,
	CONSULTATION_THREAD_CUSTOM_TYPE,
	CONSULTATION_TURN_CUSTOM_TYPE,
	type ConsultationThreadRecord,
	type ConsultationTurnRecord,
	consultationAgentId,
	consultationThreadMetadata,
	consultationThreadTitlePresentation,
	consultationTranscriptStem,
	consultationTurnStates,
	fallbackConsultationTitle,
	replayCompletedConsultationMessages,
} from "../../session/consultation";
import { assistantMessageWithReplyText } from "../../session/ephemeral-turn";
import { loadEntriesFromFile } from "../../session/session-loader";
import { SessionManager } from "../../session/session-manager";
import { copyToClipboard } from "../../utils/clipboard";
import { BtwPanelComponent, type ConsultationPanelStatus, type ConsultationPanelView } from "../components/btw-panel";
import type { InteractiveModeContext } from "../types";

export interface ConsultationThreadHandle {
	consultationId: string;
	sessionFile: string;
	ownerId: string;
}

interface KnownConsultationThread extends ConsultationThreadHandle {
	fullId: string;
	lastActivity: number;
}

interface ConsultRequest {
	component: BtwPanelComponent | undefined;
	abortController: AbortController;
	consultationId: string;
	turnId: string;
	question: string;
	promptText: string;
	startedAt: number;
	ownerId: string;
	thread: ConsultationThreadHandle | undefined;
	/** Canonical generated subject; presentation fallback lives only in the view. */
	generatedTitle: string | undefined;
	latestView: ConsultationPanelView;
	visibleView: ConsultationPanelView;
}

function isInSessionTree(sessionFile: string, treeRoot: string): boolean {
	const relative = path.relative(treeRoot, path.resolve(sessionFile));
	return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export class ConsultController {
	#activeRequest: ConsultRequest | undefined;
	#activeTurnRequest: ConsultRequest | undefined;
	#activeTurn: Promise<void> | undefined;
	#activeThread: ConsultationThreadHandle | undefined;
	#mostRecentThread: ConsultationThreadHandle | undefined;
	#selectedThreadView: ConsultationPanelView | undefined;
	#switchBarrier: Promise<void> = Promise.resolve();
	#copyInFlight = false;

	constructor(private readonly ctx: InteractiveModeContext) {}

	hasActiveRequest(): boolean {
		return this.#activeRequest !== undefined;
	}

	hasVisibleTurn(): boolean {
		return this.#activeRequest !== undefined;
	}

	hasActiveTurn(): boolean {
		return this.#activeTurn !== undefined;
	}

	getActiveThread(): ConsultationThreadHandle | undefined {
		return this.#activeThread && { ...this.#activeThread };
	}

	getActiveTurnId(): string | undefined {
		return this.#activeTurnRequest?.turnId;
	}

	getVisibleTurnPresentation():
		| {
				consultationId: string;
				title: string;
				turnIndex: number;
				turnCount: number;
				isLatest: boolean;
				status: ConsultationPanelStatus;
		  }
		| undefined {
		const view = this.#activeRequest?.visibleView ?? this.#selectedThreadView;
		if (!view) return undefined;
		return {
			consultationId: view.threadId,
			title: view.title,
			turnIndex: view.turnIndex,
			turnCount: view.turnCount,
			isLatest: view.isLatest,
			status: view.status,
		};
	}

	canCopy(): boolean {
		return this.canCopyVisibleTurn();
	}

	canCopyVisibleTurn(): boolean {
		return !this.#copyInFlight && this.#activeRequest?.component?.isCopyable() === true;
	}

	async handleCopy(): Promise<boolean> {
		return this.handleCopyVisibleTurn();
	}

	async handleCopyVisibleTurn(): Promise<boolean> {
		const copyText = this.#activeRequest?.component?.getCopyText();
		if (!this.canCopyVisibleTurn() || !copyText) return false;
		this.#copyInFlight = true;
		try {
			await copyToClipboard(copyText);
			this.ctx.showStatus("Copied /consult answer to clipboard");
			return true;
		} catch (error) {
			this.ctx.showError(error instanceof Error ? error.message : String(error));
			return true;
		} finally {
			this.#copyInFlight = false;
		}
	}

	canCancelVisibleTurn(): boolean {
		const request = this.#activeRequest;
		return (
			request !== undefined &&
			request === this.#activeTurnRequest &&
			request.visibleView.isLatest &&
			!request.abortController.signal.aborted &&
			!["saved", "cancelled", "failed"].includes(request.latestView.status)
		);
	}

	async cancelVisibleTurn(): Promise<boolean> {
		if (!this.canCancelVisibleTurn()) return false;
		const request = this.#activeRequest;
		const turn = this.#activeTurn;
		if (!request || !turn) return false;
		request.abortController.abort();
		await turn;
		return true;
	}

	canOpenVisibleTranscript(): boolean {
		return this.#activeRequest?.thread !== undefined;
	}

	async openVisibleTranscript(): Promise<boolean> {
		const thread = this.#activeRequest?.thread;
		if (!thread) return false;
		this.ctx.openConsultationTranscript(thread);
		return true;
	}

	canQuoteVisibleAnswerInParent(): boolean {
		const request = this.#activeRequest;
		return (
			request !== undefined &&
			["saved", "cancelled", "failed"].includes(request.visibleView.status) &&
			request.component?.isCopyable() === true
		);
	}

	async quoteVisibleAnswerInParent(): Promise<boolean> {
		const request = this.#activeRequest;
		const answer = request?.component?.getCopyText();
		if (!request || !answer || !this.canQuoteVisibleAnswerInParent()) return false;
		this.#closeActiveRequest(false);
		return this.ctx.prepareQuotedConsultationAnswerInParent(answer, request.thread);
	}

	canAskMainAboutVisibleAnswer(): boolean {
		const request = this.#activeRequest;
		return (
			request !== undefined &&
			["saved", "cancelled", "failed"].includes(request.visibleView.status) &&
			request.component?.isCopyable() === true
		);
	}

	async askMainAboutVisibleAnswer(): Promise<boolean> {
		const request = this.#activeRequest;
		const answer = request?.component?.getCopyText();
		if (!request || !answer || !this.canAskMainAboutVisibleAnswer()) return false;
		this.#closeActiveRequest(false);
		return this.ctx.prepareAskMainConsultationDraft(answer, request.thread);
	}

	async showPreviousTurn(): Promise<boolean> {
		return this.#moveVisibleTurn(-1);
	}

	async showNextTurn(): Promise<boolean> {
		return this.#moveVisibleTurn(1);
	}

	async showLatestTurn(): Promise<boolean> {
		const moved = await this.#moveVisibleTurn(Number.POSITIVE_INFINITY);
		const followed =
			this.#activeRequest?.visibleView.isLatest === true &&
			(this.#activeRequest.component?.followConsultationAnswer() ?? false);
		return moved || followed;
	}

	scrollVisibleAnswer(delta: number): boolean {
		return this.#activeRequest?.component?.scrollConsultationAnswer(delta) ?? false;
	}

	scrollVisibleAnswerPage(direction: -1 | 1): boolean {
		return this.#activeRequest?.component?.scrollConsultationAnswerPage(direction) ?? false;
	}

	handleEscape(): boolean {
		return this.returnToParent();
	}

	returnToParent(): boolean {
		if (!this.#activeRequest) return false;
		this.#closeActiveRequest(false);
		this.ctx.restoreParentEditorFromConsult();
		return true;
	}

	dispose(): void {
		this.#closeActiveRequest(true);
		this.ctx.restoreParentEditorFromConsult();
	}

	/**
	 * Enter an unbound consultation composer. The next submitted question creates
	 * a new durable thread rather than implicitly resuming the last one.
	 */
	async newComposer(): Promise<void> {
		await this.#serializeSwitch(async () => {
			await this.#cancelActiveTurn();
			this.#activeThread = undefined;
			this.#selectedThreadView = undefined;
			this.ctx.beginConsultComposer();
		});
	}

	/** Leave the visible result and prepare an unbound composer for a new thread. */
	async startNewConsultation(): Promise<boolean> {
		await this.newComposer();
		return true;
	}

	/**
	 * Select a durable thread for the consultation composer. An omitted id picks
	 * the last selected thread, falling back to the newest known transcript.
	 */
	async resume(threadId?: string): Promise<void> {
		const requestedId = threadId?.trim();
		const runningThread = this.#activeRequest ? undefined : this.#activeTurnRequest?.thread;
		if (
			runningThread &&
			(!requestedId ||
				requestedId.toLowerCase() === "latest" ||
				requestedId === runningThread.consultationId ||
				requestedId === `consult:${runningThread.consultationId}` ||
				requestedId.endsWith(`/consult:${runningThread.consultationId}`))
		) {
			await this.#selectThread(runningThread);
			return;
		}
		const thread = await this.#resolveThread(requestedId);
		if (!thread) return;
		await this.#selectThread(thread);
	}

	/** Open the compact consultation picker supplied by InteractiveMode. */
	async pick(): Promise<void> {
		const treeRoot = await this.#discoverKnownThreads();
		const threads = this.#knownThreads(treeRoot).map(
			({ fullId: _fullId, lastActivity: _lastActivity, ...thread }) => thread,
		);
		if (!threads.length) {
			this.ctx.showError("No durable consultations found; start one with /consult <question>.");
			return;
		}
		const selected = await this.ctx.showConsultPicker(threads);
		if (selected) await this.#selectThread(selected);
	}

	/** Submit from the focused consultation composer. */
	async submitCurrentThread(question: string): Promise<void> {
		const thread = this.#activeThread;
		if (thread) await this.appendTurn(thread, question);
		else await this.startNewThread(question);
	}

	/** Abort, persist the terminal record, flush, and close before another writer can start. */
	async cancelBeforeSwitch(): Promise<void> {
		await this.#serializeSwitch(async () => {
			await this.#cancelActiveTurn();
		});
	}

	/** Start a new durable consultation thread. */
	async start(question: string): Promise<void> {
		await this.startNewThread(question);
	}

	/** Start a new durable thread even when a prior thread is selected. */
	async startNewThread(question: string): Promise<void> {
		if (!question.trim()) {
			this.ctx.showStatus("Usage: /consult <question>");
			return;
		}
		const requestSnapshot = this.ctx.session.captureReadOnlySideRequestSnapshot();
		if (!requestSnapshot) {
			this.ctx.showError("No active model available for /consult.");
			return;
		}
		await this.#serializeSwitch(async () => {
			await this.#cancelActiveTurn();
			this.#activeThread = undefined;
			this.#selectedThreadView = undefined;
			this.ctx.beginConsultComposer();
			this.#startTurn(question, undefined, requestSnapshot);
		});
	}

	/** Append a turn only to an explicitly selected durable consultation. */
	async appendTurn(thread: ConsultationThreadHandle, question: string): Promise<void> {
		if (!question.trim()) {
			this.ctx.showStatus("Usage: /consult <question>");
			return;
		}
		if (
			this.#activeTurnRequest?.thread?.consultationId === thread.consultationId &&
			!this.#activeTurnRequest.abortController.signal.aborted
		) {
			throw new Error("Consultation is still running; use ? to cancel it before submitting a follow-up.");
		}
		await this.#serializeSwitch(async () => {
			await this.#cancelActiveTurn();
			this.#activateThread(thread);
			this.#startTurn(question, thread);
		});
	}

	async #selectThread(thread: ConsultationThreadHandle): Promise<void> {
		const runningRequest = this.#activeTurnRequest;
		if (runningRequest?.thread?.consultationId === thread.consultationId) {
			this.#activateThread(thread);
			this.#selectedThreadView = undefined;
			runningRequest.visibleView = { ...runningRequest.latestView };
			runningRequest.component = this.#createPanel(runningRequest.question, runningRequest.visibleView);
			this.#activeRequest = runningRequest;
			this.#mountPanel(runningRequest);
			this.ctx.beginConsultComposer(thread);
			return;
		}
		await this.#serializeSwitch(async () => {
			await this.#cancelActiveTurn();
			const views = await this.#loadPersistedViews(thread).catch(() => []);
			const latestView = views.at(-1);
			if (!latestView) {
				this.ctx.showError(`Consultation consult:${thread.consultationId} has no persisted turns.`);
				return;
			}
			this.#activateThread(thread);
			this.#selectedThreadView = latestView;
			this.#showPersistedThread(thread, latestView);
			this.ctx.beginConsultComposer(thread);
		});
	}

	#showPersistedThread(thread: ConsultationThreadHandle, view: ConsultationPanelView): void {
		// Persisted records from an older/failed title attempt may not carry a
		// usable presentation title. Keep the resumed panel renderable while the
		// lazy canonical retry runs.
		const presentedView =
			typeof view.title === "string" && view.title.trim()
				? view
				: { ...view, title: fallbackConsultationTitle(view.question) };
		const request: ConsultRequest = {
			component: this.#createPanel(presentedView.question, presentedView),
			abortController: new AbortController(),
			consultationId: thread.consultationId,
			turnId: "",
			question: presentedView.question,
			promptText: "",
			startedAt: Date.now(),
			ownerId: thread.ownerId,
			thread: { ...thread },
			generatedTitle: undefined,
			latestView: { ...presentedView, isLatest: true },
			visibleView: { ...presentedView },
		};
		this.#activeRequest = request;
		this.#mountPanel(request);
	}

	#startTurn(
		question: string,
		thread?: ConsultationThreadHandle,
		capturedRequestSnapshot?: ReadOnlySideRequestSnapshot,
	): void {
		const trimmedQuestion = question.trim();
		if (!trimmedQuestion) {
			this.ctx.showStatus("Usage: /consult <question>");
			return;
		}
		const session = this.ctx.session;
		const requestSnapshot = capturedRequestSnapshot ?? session.captureReadOnlySideRequestSnapshot();
		if (!requestSnapshot) {
			this.ctx.showError("No active model available for /consult.");
			return;
		}
		const consultationId = thread?.consultationId ?? Snowflake.next().toString();
		const title =
			thread && this.#selectedThreadView?.threadId === consultationId
				? this.#selectedThreadView.title
				: fallbackConsultationTitle(trimmedQuestion);
		const initialView = {
			threadId: consultationId,
			title,
			turnIndex: thread ? 0 : 1,
			turnCount: thread ? 0 : 1,
			status: "saving-boundary",
			question: trimmedQuestion,
			answer: "",
			isLatest: true,
		} satisfies ConsultationPanelView;
		const request: ConsultRequest = {
			component: this.#createPanel(trimmedQuestion, initialView),
			abortController: new AbortController(),
			consultationId,
			turnId: Snowflake.next().toString(),
			question: trimmedQuestion,
			promptText: prompt.render(consultUserPrompt, { question: trimmedQuestion }),
			startedAt: Date.now(),
			ownerId: thread?.ownerId ?? session.getAgentId() ?? MAIN_AGENT_ID,
			thread,
			generatedTitle: undefined,
			latestView: initialView,
			visibleView: initialView,
		};
		this.#mountPanel(request);
		this.#activeRequest = request;
		const turn = this.#runRequest(request, session, requestSnapshot);
		this.#activeTurn = turn;
		this.#activeTurnRequest = request;
		void turn.finally(() => {
			if (this.#activeTurn === turn) this.#activeTurn = undefined;
			if (this.#activeTurnRequest === request) this.#activeTurnRequest = undefined;
		});
	}

	#activateThread(thread: ConsultationThreadHandle): void {
		this.#activeThread = { ...thread };
		this.#mostRecentThread = { ...thread };
	}

	#updateLatestView(request: ConsultRequest, update: Partial<ConsultationPanelView>): void {
		request.latestView = { ...request.latestView, ...update, isLatest: true };
		if (request.visibleView.isLatest) this.#showView(request, request.latestView);
	}

	#showView(request: ConsultRequest, view: ConsultationPanelView): void {
		request.visibleView = { ...view };
		if (this.#activeRequest !== request) return;
		request.component?.setConsultationView(request.visibleView);
	}

	/**
	 * Keep token-rate updates inside the mounted consultation component. The
	 * first delta changes the visible status and is a deliberate structural
	 * transition; subsequent deltas only mutate the panel's reply Markdown.
	 */
	#appendLatestText(request: ConsultRequest, delta: string, answer: string): void {
		request.latestView = {
			...request.latestView,
			answer,
			status: "streaming-turn",
			isLatest: true,
		};
		if (!request.visibleView.isLatest) return;
		request.visibleView = { ...request.latestView };
		if (this.#activeRequest !== request) return;
		request.component?.appendConsultationText(delta);
	}

	#createPanel(question: string, consultation: ConsultationPanelView): BtwPanelComponent | undefined {
		const ui = this.ctx.ui;
		if (!ui || typeof ui.requestComponentRender !== "function") return undefined;
		return new BtwPanelComponent({
			question,
			tui: ui,
			commandLabel: "/consult",
			allowBranch: false,
			consultation,
		});
	}

	#mountPanel(request: ConsultRequest): void {
		const container = this.ctx.btwContainer;
		if (
			!request.component ||
			!container ||
			typeof container.clear !== "function" ||
			typeof container.addChild !== "function"
		) {
			return;
		}
		container.clear();
		container.addChild(request.component);
		this.ctx.ui?.requestRender?.();
	}

	async #moveVisibleTurn(direction: number): Promise<boolean> {
		const request = this.#activeRequest;
		const thread = request?.thread;
		if (!request || !thread) return false;
		const turns = await this.#loadPersistedViews(thread);
		if (this.#activeRequest !== request || turns.length === 0) return false;

		const latestIndex = turns.length - 1;
		if (turns[latestIndex]?.turnIndex === request.latestView.turnIndex) {
			turns[latestIndex] = request.latestView;
		}
		const currentIndex = turns.findIndex(turn => turn.turnIndex === request.visibleView.turnIndex);
		const targetIndex =
			direction === Number.POSITIVE_INFINITY
				? latestIndex
				: Math.min(latestIndex, Math.max(0, (currentIndex < 0 ? latestIndex : currentIndex) + direction));
		if (targetIndex === currentIndex) return false;
		const target = turns[targetIndex];
		if (!target) return false;
		this.#showView(request, target);
		return true;
	}

	async #loadPersistedViews(thread: ConsultationThreadHandle): Promise<ConsultationPanelView[]> {
		const entries = await loadEntriesFromFile(thread.sessionFile);
		const states = consultationTurnStates(entries, thread.consultationId);
		if (states.length === 0) return [];
		const { displayTitle: title } = consultationThreadTitlePresentation(entries, thread.consultationId);
		const stateById = new Map(states.map(state => [state.turn.turnId, state]));
		const startIndexByTurnId = new Map<string, number>();

		for (let index = 0; index < entries.length; index++) {
			const entry = entries[index];
			if (entry?.type !== "custom" || entry.customType !== CONSULTATION_TURN_CUSTOM_TYPE) continue;
			const record = entry.data as { turnId?: unknown } | undefined;
			if (
				typeof record !== "object" ||
				record === null ||
				typeof record.turnId !== "string" ||
				!stateById.has(record.turnId) ||
				startIndexByTurnId.has(record.turnId)
			) {
				continue;
			}
			startIndexByTurnId.set(record.turnId, index);
		}

		return states.map((state, stateIndex) => {
			const startIndex = startIndexByTurnId.get(state.turn.turnId) ?? -1;
			let answer = state.terminal?.partialAnswer ?? "";
			if (state.terminal?.status === "completed" && startIndex >= 0) {
				for (let index = startIndex + 1; index < entries.length; index++) {
					const entry = entries[index];
					if (entry?.type === "custom" && entry.customType === CONSULTATION_TURN_CUSTOM_TYPE) {
						const record = entry.data as { turnId?: unknown } | undefined;
						if (
							typeof record === "object" &&
							record !== null &&
							typeof record.turnId === "string" &&
							record.turnId !== state.turn.turnId
						) {
							break;
						}
					}
					if (entry?.type !== "message" || entry.message.role !== "assistant") continue;
					answer = entry.message.content
						.filter(content => content.type === "text")
						.map(content => content.text)
						.join("")
						.trim();
					break;
				}
			}
			const status: ConsultationPanelStatus =
				state.terminal?.status === "completed"
					? "saved"
					: state.terminal?.status === "cancelled"
						? "cancelled"
						: state.terminal?.status === "failed"
							? "failed"
							: "streaming-turn";
			return {
				threadId: thread.consultationId,
				title,
				turnIndex: state.turn.turnIndex,
				turnCount: states.length,
				status,
				question: state.turn.question,
				answer,
				isLatest: stateIndex === states.length - 1,
			};
		});
	}

	#knownThreads(treeRoot: string | undefined): KnownConsultationThread[] {
		return AgentRegistry.global()
			.list()
			.flatMap(ref => {
				if (
					ref.kind !== "consultation" ||
					!ref.sessionFile ||
					(treeRoot !== undefined && !isInSessionTree(ref.sessionFile, treeRoot))
				)
					return [];
				const marker = ref.id.lastIndexOf("/consult:");
				const consultationId = marker >= 0 ? ref.id.slice(marker + "/consult:".length) : "";
				if (!consultationId) return [];
				return [
					{
						consultationId,
						sessionFile: ref.sessionFile,
						ownerId: ref.parentId ?? ref.id.slice(0, marker),
						fullId: ref.id,
						lastActivity: ref.lastActivity,
					},
				];
			})
			.sort((a, b) => b.lastActivity - a.lastActivity || a.fullId.localeCompare(b.fullId));
	}

	async #resolveThread(threadId?: string): Promise<ConsultationThreadHandle | undefined> {
		const treeRoot = await this.#discoverKnownThreads();
		const requestedId = threadId?.trim();
		if (!requestedId || requestedId.toLowerCase() === "latest") {
			const threads = this.#knownThreads(treeRoot);
			const mostRecent =
				this.#mostRecentThread &&
				threads.find(
					thread =>
						thread.consultationId === this.#mostRecentThread?.consultationId &&
						thread.sessionFile === this.#mostRecentThread?.sessionFile,
				);
			if (mostRecent) return { ...mostRecent };

			const [thread] = await Promise.all(
				threads.map(async candidate => {
					const entries = await loadEntriesFromFile(candidate.sessionFile).catch(() => []);
					const lastTurnActivity = consultationTurnStates(entries, candidate.consultationId).reduce(
						(latest, state) => Math.max(latest, state.terminal?.finishedAt ?? state.turn.startedAt),
						Number.NEGATIVE_INFINITY,
					);
					return { candidate, activity: Math.max(candidate.lastActivity, lastTurnActivity) };
				}),
			).then(candidates =>
				candidates.sort((a, b) => b.activity - a.activity || a.candidate.fullId.localeCompare(b.candidate.fullId)),
			);
			if (thread) return { ...thread.candidate };
			this.ctx.showError("No durable consultations found; start one with /consult <question>.");
			return undefined;
		}

		const threads = this.#knownThreads(treeRoot);
		const fullMatch = threads.find(thread => thread.fullId === requestedId);
		if (fullMatch) return { ...fullMatch };

		const shortId = requestedId.startsWith("consult:") ? requestedId.slice("consult:".length) : requestedId;
		const matches = threads.filter(
			thread => thread.consultationId.endsWith(shortId) || thread.consultationId.startsWith(shortId),
		);
		if (matches.length === 1) return { ...matches[0] };
		if (matches.length > 1) {
			this.ctx.showError(`Consultation id "${requestedId}" is ambiguous; use its full id.`);
			return undefined;
		}
		this.ctx.showError(`Consultation "${requestedId}" not found.`);
		return undefined;
	}
	async #discoverKnownThreads(): Promise<string | undefined> {
		const session = this.ctx.session;
		const ownerId = session?.getAgentId?.() ?? MAIN_AGENT_ID;
		const sessionFile = session?.sessionManager?.getSessionFile?.() ?? this.ctx.sessionManager?.getSessionFile?.();
		await registerPersistedConsultations(AgentRegistry.global(), sessionFile, ownerId);
		return sessionFile?.endsWith(".jsonl") ? path.resolve(sessionFile.slice(0, -".jsonl".length)) : undefined;
	}
	async #serializeSwitch<T>(operation: () => Promise<T>): Promise<T> {
		const { promise, resolve: release } = Promise.withResolvers<void>();
		const previous = this.#switchBarrier;
		this.#switchBarrier = promise;
		await previous;
		try {
			return await operation();
		} finally {
			release();
		}
	}

	async #cancelActiveTurn(): Promise<void> {
		const request = this.#activeTurnRequest;
		if (request && !request.abortController.signal.aborted) request.abortController.abort();
		this.#closeActiveRequest(true);
		const turn = this.#activeTurn;
		if (turn) await turn;
	}

	/**
	 * Title generation is deliberately detached from the paid side turn. The
	 * transcript has already recorded the first completed answer, so a cancelled
	 * panel or parent switch cannot turn a display fallback into a false success.
	 */
	#scheduleFirstTurnTitle(request: ConsultRequest, session: InteractiveModeContext["session"]): void {
		const thread = request.thread;
		if (!thread || request.generatedTitle) return;
		void retryPersistedConsultationTitle(AgentRegistry.global(), {
			ownerId: request.ownerId,
			consultationId: request.consultationId,
			sessionFile: thread.sessionFile,
			session,
			onGenerated: title => {
				request.generatedTitle = title;
				this.#updateLatestView(request, { title });
			},
		});
	}

	async #runRequest(
		request: ConsultRequest,
		session: InteractiveModeContext["session"],
		requestSnapshot: ReadOnlySideRequestSnapshot,
	): Promise<void> {
		let durable = false;
		let terminalWritten = false;
		let terminalFlushed = false;
		let createdThread = false;
		let manager: SessionManager | undefined;
		let threadRecord: ConsultationThreadRecord | undefined;
		let partialAnswer = "";
		const developerReminder = consultSideChannel;
		try {
			if (request.thread) {
				manager = await SessionManager.open(request.thread.sessionFile, undefined, undefined, {
					suppressBreadcrumb: true,
				});
				threadRecord = consultationThreadMetadata(manager.getEntries(), request.consultationId);
				if (!threadRecord) throw new Error(`Consultation thread ${request.consultationId} not found`);
			} else {
				const child = await session.createCommittedChildSession(
					consultationTranscriptStem(request.consultationId),
					{
						materializeParent: true,
					},
				);
				manager = child.manager;
				createdThread = true;
				request.thread = {
					consultationId: request.consultationId,
					sessionFile: child.sessionFile,
					ownerId: request.ownerId,
				};
				if (this.#activeRequest === request) {
					this.#activateThread(request.thread);
					this.ctx.setActiveConsultThread(request.thread);
				}
				threadRecord = {
					version: 1,
					consultationId: request.consultationId,
					parentSessionId: child.parentSessionId,
					parentLeafId: child.parentLeafId,
					createdAt: request.startedAt,
				};
				manager.appendCustomEntry(CONSULTATION_THREAD_CUSTOM_TYPE, threadRecord);
				if (!child.hasCommittedContext) {
					this.#updateLatestView(request, { contextNotice: "No committed parent context" });
				}
			}
			if (!threadRecord) throw new Error(`Consultation thread ${request.consultationId} not found`);
			const threadManager = manager;
			if (!threadManager) throw new Error(`Consultation thread ${request.consultationId} manager not found`);
			this.#registerThread(request, false);

			const previousMessages = [
				...threadManager.buildSessionContextAt(threadRecord.parentLeafId).messages,
				...replayCompletedConsultationMessages(threadManager.getEntries(), request.consultationId),
			];
			const existingTurns = consultationTurnStates(threadManager.getEntries(), request.consultationId);
			const turnIndex = (existingTurns.at(-1)?.turn.turnIndex ?? 0) + 1;
			this.#updateLatestView(request, {
				turnIndex,
				turnCount: existingTurns.length + 1,
				status: "saving-boundary",
			});
			const running: ConsultationTurnRecord = {
				version: 1,
				consultationId: request.consultationId,
				turnId: request.turnId,
				turnIndex,
				question: request.question,
				promptText: request.promptText,
				provider: requestSnapshot.model.provider,
				model: requestSnapshot.model.id,
				status: "running",
				startedAt: request.startedAt,
			};
			threadManager.appendMessage({
				role: "user",
				content: [{ type: "text", text: request.question }],
				attribution: "user",
				timestamp: Date.now(),
			});
			threadManager.appendCustomEntry(CONSULTATION_TURN_CUSTOM_TYPE, running);
			await threadManager.flush();
			durable = true;
			this.#updateLatestView(request, { status: "consulting-model" });
			if (request.abortController.signal.aborted) throw new Error("cancelled");

			const result = await session.runReadOnlySideTurn({
				request: requestSnapshot,
				messages: previousMessages,
				promptText: request.promptText,
				developerReminder,
				signal: request.abortController.signal,
				onTextDelta: delta => {
					partialAnswer += delta;
					if (request.latestView.status !== "streaming-turn") {
						this.#updateLatestView(request, { answer: partialAnswer, status: "streaming-turn" });
					} else {
						this.#appendLatestText(request, delta, partialAnswer);
					}
				},
			});
			if (request.abortController.signal.aborted) throw new Error("cancelled");
			const answer = result.replyText;
			this.#updateLatestView(request, { answer, status: "saving" });
			threadManager.appendMessage(assistantMessageWithReplyText(result.assistantMessage, answer));
			let terminal: ConsultationTurnRecord;
			if (!answer) {
				const error = "Consultation returned no text; tool calls are disabled.";
				threadManager.appendCustomMessageEntry(CONSULTATION_STATUS_MESSAGE_TYPE, error, true);
				terminal = { ...running, status: "failed", finishedAt: Date.now(), error };
			} else {
				terminal = { ...running, status: "completed", finishedAt: Date.now() };
			}
			threadManager.appendCustomEntry(CONSULTATION_TURN_CUSTOM_TYPE, terminal);
			terminalWritten = true;
			await threadManager.flush();
			terminalFlushed = true;
			await threadManager.close();
			manager = undefined;
			if (answer && turnIndex === 1) this.#scheduleFirstTurnTitle(request, session);
			this.#updateLatestView(request, { status: answer ? "saved" : "failed" });
			this.#registerThread(request);
		} catch (error) {
			if (!manager) {
				if (terminalFlushed) {
					this.ctx.showStatus(
						`Consultation saved at ${request.thread?.sessionFile}; Agent Hub registration failed: ${
							error instanceof Error ? error.message : String(error)
						}`,
					);
				} else if (this.#activeRequest === request) {
					this.#updateLatestView(request, { status: "failed" });
				}
				return;
			}
			if (!durable) {
				const sessionFile = request.thread?.sessionFile;
				if (createdThread && sessionFile) {
					await manager.dropSession(sessionFile).catch(() => {});
					this.#unregisterThread(request);
				} else {
					await manager.close().catch(() => {});
					this.#registerThread(request);
				}
				manager = undefined;
				if (this.#activeRequest === request) this.#updateLatestView(request, { status: "failed" });
				return;
			}
			const cancelled = request.abortController.signal.aborted;
			const message = cancelled ? "Consultation cancelled." : error instanceof Error ? error.message : String(error);
			if (!terminalWritten) {
				const visible = partialAnswer
					? `${partialAnswer}\n\n[${cancelled ? "Consultation cancelled." : `Consultation failed: ${message}`}]`
					: `[${cancelled ? "Consultation cancelled." : `Consultation failed: ${message}`}]`;
				const states = consultationTurnStates(manager.getEntries(), request.consultationId);
				const running = states.at(-1)?.turn;
				if (running) {
					manager.appendMessage({
						role: "custom",
						customType: CONSULTATION_STATUS_MESSAGE_TYPE,
						content: visible,
						display: true,
						timestamp: Date.now(),
					});
					manager.appendCustomEntry(CONSULTATION_TURN_CUSTOM_TYPE, {
						...running,
						status: cancelled ? "cancelled" : "failed",
						finishedAt: Date.now(),
						error: cancelled ? undefined : message,
						partialAnswer: partialAnswer || undefined,
					} satisfies ConsultationTurnRecord);
					terminalWritten = true;
					try {
						await manager.flush();
						terminalFlushed = true;
					} catch (terminalError) {
						this.ctx.showStatus(
							`Consultation saved at ${request.thread?.sessionFile}; terminal persistence failed: ${
								terminalError instanceof Error ? terminalError.message : String(terminalError)
							}`,
						);
					}
				}
			}
			await manager.close().catch(() => {});
			manager = undefined;
			if (terminalFlushed) {
				try {
					this.#registerThread(request);
				} catch (registrationError) {
					this.ctx.showStatus(
						`Consultation saved at ${request.thread?.sessionFile}; Agent Hub registration failed: ${
							registrationError instanceof Error ? registrationError.message : String(registrationError)
						}`,
					);
				}
			}
			if (this.#activeRequest === request) {
				this.#updateLatestView(request, {
					answer: partialAnswer,
					status: cancelled ? "cancelled" : "failed",
				});
			}
		} finally {
			if (manager) await manager.close().catch(() => {});
		}
	}

	#registerThread(request: ConsultRequest, parked = true): void {
		if (!request.thread) throw new Error("Consultation thread was not created");
		registerPersistedConsultation(AgentRegistry.global(), {
			ownerId: request.ownerId,
			consultationId: request.consultationId,
			sessionFile: request.thread.sessionFile,
			generatedTitle: request.generatedTitle,
			displayTitle: request.latestView.title,
			parked,
		});
		if (parked) this.ctx.showStatus(`Consultation saved as consult:${request.consultationId}; open /hub to view it.`);
	}

	#unregisterThread(request: ConsultRequest): void {
		if (!request.thread) return;
		const registry = AgentRegistry.global();
		const id = consultationAgentId(request.ownerId, request.consultationId);
		const ref = registry.get(id);
		if (ref?.kind === "consultation" && ref.sessionFile === request.thread.sessionFile) {
			registry.unregister(id, ref);
		}
	}

	#closeActiveRequest(abort: boolean): void {
		const request = this.#activeRequest;
		if (!request) return;
		this.#activeRequest = undefined;
		if (abort && !request.abortController.signal.aborted) request.abortController.abort();
		request.component?.close();
		const container = this.ctx.btwContainer;
		if (container && typeof container.clear === "function") container.clear();
		this.ctx.ui?.requestRender?.();
	}
}
