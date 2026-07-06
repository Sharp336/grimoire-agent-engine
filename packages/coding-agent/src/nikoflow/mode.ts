import { humanGateAccepted } from "./gates";
import { assertNikoflowRoleRails } from "./roles";
import {
	advancePhase,
	currentPhase,
	currentTicket,
	isHumanGatePhase,
	mintGateRequest,
	type NikoflowPhase,
	type NikoflowRole,
	type NikoflowState,
	PHASE_ROLE,
} from "./state";
import { getNextTicket, markStatus, validateTicketDag } from "./tickets";

const MAX_GATE_HOLD_FOLLOW_UPS = 3;

export interface MinimalToolCallContext {
	toolCall: { name?: string; toolName?: string };
	args: Record<string, unknown>;
}

export interface BeforeToolCallResult {
	block?: boolean;
	reason?: string;
}

export type BeforeToolCall = (
	context: MinimalToolCallContext,
	signal?: AbortSignal,
) => Promise<BeforeToolCallResult | undefined> | BeforeToolCallResult | undefined;

export type OnTurnEnd<TMessages = unknown, TContext = unknown> = (
	messages: TMessages,
	signal?: AbortSignal,
	context?: TContext,
) => Promise<void> | void;

export type OnBeforeYield = () => Promise<void> | void;
export type ToolChoiceGetter<TDirective = unknown> = () => TDirective | undefined;
export type NikoflowStateGateAdvance = (
	state: NikoflowState,
) => Promise<unknown | null | undefined> | unknown | null | undefined;
export type NikoflowAdvisorReviewSeverity = "nit" | "concern" | "blocker";

export interface NikoflowAdvisorReviewNote {
	note: string;
	severity?: NikoflowAdvisorReviewSeverity;
}

export interface NikoflowAdvisorReview {
	gateId: string;
	reviewed: true;
	notes: readonly NikoflowAdvisorReviewNote[];
}

export type NikoflowAdvisorReviewRequest = (
	state: NikoflowState,
) => Promise<unknown | null | undefined> | unknown | null | undefined;
export type NikoflowAdvisorGateAdvance = (state: NikoflowState, review: NikoflowAdvisorReview) => Promise<void> | void;
export type NikoflowAdvisorBlock = (state: NikoflowState, review: NikoflowAdvisorReview) => Promise<void> | void;
export type NikoflowGateExternalAction = (state: NikoflowState, message: string) => Promise<void> | void;

export interface NikoflowToolPolicy {
	hasFailingTest?: () => boolean;
}

export interface NikoflowCallbackBundleOptions<TMessages = unknown, TContext = unknown, TDirective = unknown> {
	getState: () => NikoflowState | null | undefined;
	isGateSatisfied: (state: NikoflowState) => boolean;
	enqueueFollowUp: (message: string) => void | Promise<void>;
	policy?: NikoflowToolPolicy;
	beforeToolCall?: BeforeToolCall;
	onTurnEnd?: OnTurnEnd<TMessages, TContext>;
	afterTurnEnd?: OnTurnEnd<TMessages, TContext>;
	onBeforeYield?: OnBeforeYield;
	getToolChoice?: ToolChoiceGetter<TDirective>;
	nikoflowToolChoice?: ToolChoiceGetter<TDirective>;
	advanceHumanGate?: OnTurnEnd<TMessages, TContext>;
	advanceExecuteGate?: NikoflowStateGateAdvance;
	requestAdvisorReview?: NikoflowAdvisorReviewRequest;
	advanceAdvisorGate?: NikoflowAdvisorGateAdvance;
	onAdvisorBlock?: NikoflowAdvisorBlock;
	onGateNeedsExternalAction?: NikoflowGateExternalAction;
	afterBeforeYield?: OnBeforeYield;
}

export interface NikoflowCallbackBundle<TMessages = unknown, TContext = unknown, TDirective = unknown> {
	beforeToolCall: BeforeToolCall;
	onTurnEnd?: OnTurnEnd<TMessages, TContext>;
	onBeforeYield: OnBeforeYield;
	getToolChoice?: ToolChoiceGetter<TDirective>;
}

export interface NikoflowCallbackHost<TMessages = unknown, TContext = unknown, TDirective = unknown> {
	beforeToolCall?: BeforeToolCall;
	getOnTurnEnd?: () => OnTurnEnd<TMessages, TContext> | undefined;
	setOnTurnEnd?: (fn: OnTurnEnd<TMessages, TContext> | undefined) => void;
	getOnBeforeYield?: () => OnBeforeYield | undefined;
	setOnBeforeYield?: (fn: OnBeforeYield | undefined) => void;
	getGetToolChoice?: () => ToolChoiceGetter<TDirective> | undefined;
	setGetToolChoice?: (fn: ToolChoiceGetter<TDirective> | undefined) => void;
}

export interface InstalledNikoflowCallbacks<TMessages = unknown, TContext = unknown, TDirective = unknown> {
	bundle: NikoflowCallbackBundle<TMessages, TContext, TDirective>;
	uninstall: () => void;
}

export interface NikoflowSessionModel {
	provider: string;
	id: string;
}

export interface NikoflowSessionResolvedRole<TModel extends NikoflowSessionModel, TThinking = unknown> {
	model?: TModel | null;
	thinkingLevel?: TThinking;
	explicitThinkingLevel: boolean;
}

export interface NikoflowSessionRoleEntry<TModel extends NikoflowSessionModel, TThinking = unknown> {
	role: NikoflowRole;
	model: TModel;
	thinkingLevel?: TThinking;
	explicitThinkingLevel: boolean;
}

export interface NikoflowHumanGateAdvanceOptions<TMessage> {
	isGenuineUserTurn: (message: TMessage) => boolean;
	messageTimestamp: (message: TMessage) => number | undefined;
	nextGateRequestId: () => string;
	now: () => number;
}

export interface NikoflowAgentSessionHost<
	TMessages = unknown,
	TContext = unknown,
	TDirective = unknown,
	TModel extends NikoflowSessionModel = NikoflowSessionModel,
	TThinking = unknown,
> extends NikoflowCallbackHost<TMessages, TContext, TDirective> {
	resolveRoleModelWithThinking: (role: NikoflowRole) => NikoflowSessionResolvedRole<TModel, TThinking>;
	applyRoleModel: (entry: NikoflowSessionRoleEntry<TModel, TThinking>) => Promise<void> | void;
}

export interface NikoflowPhaseTransition {
	prevPhase: NikoflowPhase | null;
	nextPhase: NikoflowPhase;
}

export interface NikoflowPhaseEntryHost<
	TModel extends NikoflowSessionModel = NikoflowSessionModel,
	TThinking = unknown,
> {
	resolveRoleModelWithThinking: (role: NikoflowRole) => NikoflowSessionResolvedRole<TModel, TThinking>;
	applyRoleModel: (entry: NikoflowSessionRoleEntry<TModel, TThinking>) => Promise<void> | void;
	setState?: (state: NikoflowState) => Promise<void> | void;
	sendNikoflowContext?: (state: NikoflowState, transition: NikoflowPhaseTransition) => Promise<void> | void;
	requestAdvisorReview?: NikoflowAdvisorReviewRequest;
}

export interface NikoflowPhaseEntryOptions {
	nextGateRequestId: () => string;
	now: () => number;
	mintGate?: boolean;
	sendContext?: boolean;
	requestAdvisorReview?: boolean;
}

export interface NikoflowPhaseEntryResult {
	state: NikoflowState;
	advisorReview?: unknown | null;
}

function isTicketLoopState(state: NikoflowState): boolean {
	return state.depth !== "tactical" && state.tickets.length > 0;
}

function activateNextTicket(state: NikoflowState): NikoflowState {
	if (currentPhase(state) !== "execute" || !isTicketLoopState(state)) return state;
	const active = currentTicket(state);
	if (active && active.status !== "done") return state;
	const nextTicket = getNextTicket(state.tickets);
	if (!nextTicket) return state;
	const tickets = nextTicket.status === "todo" ? markStatus(state.tickets, nextTicket.id, "red") : state.tickets;
	return { ...state, tickets, activeTicketId: nextTicket.id };
}

export async function enterNikoflowPhase<
	TModel extends NikoflowSessionModel = NikoflowSessionModel,
	TThinking = unknown,
>(
	host: NikoflowPhaseEntryHost<TModel, TThinking>,
	prevPhase: NikoflowPhase | null,
	nextPhase: NikoflowPhase | null,
	state: NikoflowState,
	options: NikoflowPhaseEntryOptions,
): Promise<NikoflowPhaseEntryResult> {
	if (!nextPhase) {
		await host.setState?.(state);
		return { state };
	}

	const role = PHASE_ROLE[nextPhase];
	const resolved = host.resolveRoleModelWithThinking(role);
	if (resolved.model) {
		await host.applyRoleModel({
			role,
			model: resolved.model,
			thinkingLevel: resolved.thinkingLevel,
			explicitThinkingLevel: resolved.explicitThinkingLevel,
		});
	}

	let entered = activateNextTicket({ ...state, phaseTurnStarted: false });
	if (options.mintGate !== false && (isHumanGatePhase(entered) || nextPhase === "verify")) {
		entered = mintGateRequest(entered, options.nextGateRequestId(), options.now());
	}

	await host.setState?.(entered);
	const transition = { prevPhase, nextPhase };
	if (options.sendContext !== false) {
		await host.sendNikoflowContext?.(entered, transition);
	}

	const advisorReview =
		nextPhase === "verify" && options.requestAdvisorReview !== false
			? await host.requestAdvisorReview?.(entered)
			: undefined;
	return { state: entered, advisorReview };
}

const DIRECT_WRITE_TOOLS = new Set(["apply_patch", "edit", "multi_edit", "str_replace_editor", "write", "write_file"]);

const SHELL_TOOLS = new Set(["bash", "exec", "exec_command", "run_command", "shell", "terminal"]);

function toolName(context: MinimalToolCallContext): string {
	return (context.toolCall.name ?? context.toolCall.toolName ?? "").toLowerCase();
}

function commandText(args: Record<string, unknown>): string {
	const command = args.command ?? args.cmd ?? args.script;
	return typeof command === "string" ? command : "";
}

export function isWriteTool(context: MinimalToolCallContext): boolean {
	const name = toolName(context);
	if (DIRECT_WRITE_TOOLS.has(name)) return true;
	if (!SHELL_TOOLS.has(name)) return false;

	const command = commandText(context.args);
	return (
		/(^|[;&|]\s*)(apply_patch|cat\s+>|chmod|chown|cp|mkdir|mv|rm|sed\s+-i|tee|touch)\b/.test(command) ||
		/(^|[;&|]\s*)(bun|npm|pnpm|yarn)\s+(add|i|install|remove)\b/.test(command) ||
		/(^|[;&|]\s*)git\s+(apply|checkout|clean|commit|merge|rebase|reset|switch)\b/.test(command) ||
		/(^|[^<>])>>?($|[^>&])/.test(command)
	);
}

export function nikoflowToolViolation(
	state: NikoflowState | null | undefined,
	context: MinimalToolCallContext,
	_policy: NikoflowToolPolicy = {},
): string | null {
	const phase = state ? currentPhase(state) : null;
	if (!phase) return null;

	if (phase === "grilling" && isWriteTool(context)) {
		return "Nikoflow grilling is read-only; write-capable tools are blocked until the plan gate advances.";
	}
	return null;
}

export function ensureNikoflowHumanGate<TMessage>(
	state: NikoflowState,
	options: Pick<NikoflowHumanGateAdvanceOptions<TMessage>, "nextGateRequestId" | "now">,
): NikoflowState {
	if (!isHumanGatePhase(state)) return state;
	if (state.gateRequestId && state.gateMintedAt !== null) return state;
	return mintGateRequest(state, options.nextGateRequestId(), options.now());
}

export function advanceNikoflowHumanGate<TMessage>(
	state: NikoflowState,
	messages: readonly TMessage[],
	options: NikoflowHumanGateAdvanceOptions<TMessage>,
): NikoflowState {
	if (!isHumanGatePhase(state)) return state;
	if (!state.gateRequestId || state.gateMintedAt === null) {
		return state;
	}
	const gateMintedAt = state.gateMintedAt;
	const hasLaterUserTurn = messages.some(message => {
		if (!options.isGenuineUserTurn(message)) return false;
		return humanGateAccepted(gateMintedAt, options.messageTimestamp(message));
	});
	if (!hasLaterUserTurn) return state;
	return advancePhase(state);
}

export function advanceNikoflowExecuteGate(
	state: NikoflowState,
	_options?: Pick<NikoflowHumanGateAdvanceOptions<unknown>, "nextGateRequestId" | "now">,
): NikoflowState {
	if (currentPhase(state) !== "execute") return state;
	if (!state.phaseTurnStarted) return state;
	if (!isTicketLoopState(state)) return advancePhase(state);

	const validation = validateTicketDag(state.tickets);
	if (!validation.ok) return state;

	const active = currentTicket(state);
	const ticket = active && active.status !== "done" ? active : getNextTicket(state.tickets);
	if (!ticket) return advancePhase(state);
	if (state.gateRequestId) return state;
	if (!_options?.nextGateRequestId) return state;
	const tickets = markStatus(state.tickets, ticket.id, "review");
	return mintGateRequest(
		{ ...state, tickets, activeTicketId: ticket.id },
		_options.nextGateRequestId(),
		_options.now?.() ?? null,
	);
}

function advanceNikoflowTicketAdvisorGate(state: NikoflowState, review: NikoflowAdvisorReview): NikoflowState {
	if (currentPhase(state) !== "execute") return state;
	if (state.gateRequestId !== review.gateId) return state;
	if (nikoflowAdvisorReviewBlockers(review).length > 0) return state;

	const active = currentTicket(state);
	if (!active) return state;
	const doneTickets = markStatus(state.tickets, active.id, "done");
	const nextTicket = getNextTicket(doneTickets);
	if (!nextTicket) {
		return advancePhase({ ...state, tickets: doneTickets, activeTicketId: null });
	}
	const tickets = nextTicket.status === "todo" ? markStatus(doneTickets, nextTicket.id, "red") : doneTickets;
	return {
		...state,
		tickets,
		activeTicketId: nextTicket.id,
		gateRequestId: null,
		gateMintedAt: null,
		phaseTurnStarted: false,
	};
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function normalizeAdvisorReviewNote(value: unknown): NikoflowAdvisorReviewNote | null {
	const rec = asRecord(value);
	if (!rec || typeof rec.note !== "string" || rec.note.trim().length === 0) return null;
	const note: NikoflowAdvisorReviewNote = { note: rec.note };
	if (rec.severity === "nit" || rec.severity === "concern" || rec.severity === "blocker") {
		note.severity = rec.severity;
	}
	return note;
}

export function normalizeNikoflowAdvisorReview(value: unknown, state: NikoflowState): NikoflowAdvisorReview | null {
	const rec = asRecord(value);
	if (rec?.reviewed !== true || typeof rec.gateId !== "string") return null;
	if (state.gateRequestId !== rec.gateId) return null;
	if (!Array.isArray(rec.notes)) return null;
	const notes = rec.notes
		.map(normalizeAdvisorReviewNote)
		.filter((note): note is NikoflowAdvisorReviewNote => note !== null);
	if (notes.length === 0) return null;
	return { gateId: rec.gateId, reviewed: true, notes };
}

export function nikoflowAdvisorReviewBlockers(review: NikoflowAdvisorReview): string[] {
	return review.notes.filter(note => note.severity === "blocker").map(note => note.note);
}

export function advanceNikoflowAdvisorGate(state: NikoflowState, review: NikoflowAdvisorReview): NikoflowState {
	if (currentPhase(state) === "execute") return advanceNikoflowTicketAdvisorGate(state, review);
	if (currentPhase(state) !== "verify") return state;
	if (state.gateRequestId !== review.gateId) return state;
	if (nikoflowAdvisorReviewBlockers(review).length > 0) return state;
	return advancePhase(state);
}

export function createNikoflowBeforeToolCall(
	getState: () => NikoflowState | null | undefined,
	previous?: BeforeToolCall,
	policy: NikoflowToolPolicy = {},
): BeforeToolCall {
	return async (context, signal) => {
		const previousResult = await previous?.(context, signal);
		if (previousResult?.block) return previousResult;

		const reason = nikoflowToolViolation(getState(), context, policy);
		return reason ? { block: true, reason } : previousResult;
	};
}

export function createNikoflowOnTurnEnd<TMessages, TContext>(
	previous: OnTurnEnd<TMessages, TContext> | undefined,
	afterNikoflow: OnTurnEnd<TMessages, TContext>,
): OnTurnEnd<TMessages, TContext> {
	return async (messages, signal, context) => {
		await previous?.(messages, signal, context);
		await afterNikoflow(messages, signal, context);
	};
}

export function createNikoflowGetToolChoice<TDirective>(
	previous: ToolChoiceGetter<TDirective> | undefined,
	nikoflowChoice: ToolChoiceGetter<TDirective>,
): ToolChoiceGetter<TDirective> {
	return () => previous?.() ?? nikoflowChoice();
}

export function formatGateHoldMessage(state: NikoflowState): string {
	const phase = currentPhase(state) ?? "complete";
	if (isHumanGatePhase(state)) {
		return `Nikoflow ${phase} gate is waiting for a later human approval turn. Yield now; do not self-approve it.`;
	}
	if (phase === "execute") {
		if (state.depth !== "tactical") {
			const ticket = currentTicket(state) ?? getNextTicket(state.tickets);
			if (!ticket) {
				return "Nikoflow execute phase has no valid unblocked ticket. Yield now; ticket DAG needs plan/human repair.";
			}
			const acceptance = ticket.acceptance.map(item => `- ${item}`).join("\n") || "- (not supplied)";
			return [
				`Nikoflow execute ticket ${ticket.id}.`,
				"Implement ONLY this ticket.",
				"Acceptance:",
				acceptance,
				`Implementation notes: ${ticket.implementation_notes || "(not supplied)"}`,
				"After implementation, yield for an independent advisor review; do not self-approve.",
			].join("\n");
		}
		return "Nikoflow execute phase is active. Do the execute work now; do not skip straight to verify.";
	}
	if (phase === "verify") {
		return "Nikoflow verify gate is waiting for an independent reviewer pass. Fix reviewer findings, then yield for another review; do not self-approve.";
	}
	return `Nikoflow phase "${phase}" needs external action before continuing.`;
}

export function formatGateExternalActionMessage(state: NikoflowState): string {
	return `Nikoflow gate needs external action; yielding instead of queuing another follow-up. ${formatGateHoldMessage(state)}`;
}

export function createNikoflowOnBeforeYield(
	getState: () => NikoflowState | null | undefined,
	isGateSatisfied: (state: NikoflowState) => boolean,
	enqueueFollowUp: (message: string) => void | Promise<void>,
	previous?: OnBeforeYield,
	advanceExecuteGate?: NikoflowStateGateAdvance,
	requestAdvisorReview?: NikoflowAdvisorReviewRequest,
	advanceAdvisorGate?: NikoflowAdvisorGateAdvance,
	onAdvisorBlock?: NikoflowAdvisorBlock,
	onGateNeedsExternalAction?: NikoflowGateExternalAction,
	afterNikoflow?: OnBeforeYield,
): OnBeforeYield {
	let followUpKey: string | null = null;
	let requestedAdvisorReviewGateId: string | null = null;
	let consecutiveGateHoldFollowUps = 0;
	const queueGateHold = async (state: NikoflowState): Promise<void> => {
		const key = `${state.depth}:${state.phaseIndex}:${state.gateRequestId ?? "no-gate"}`;
		if (key !== followUpKey) {
			followUpKey = key;
			consecutiveGateHoldFollowUps = 0;
		}
		if (consecutiveGateHoldFollowUps >= MAX_GATE_HOLD_FOLLOW_UPS) {
			await onGateNeedsExternalAction?.(state, formatGateExternalActionMessage(state));
			return;
		}
		consecutiveGateHoldFollowUps++;
		await enqueueFollowUp(formatGateHoldMessage(state));
	};
	const yieldForExternalAction = async (state: NikoflowState): Promise<void> => {
		await onGateNeedsExternalAction?.(state, formatGateExternalActionMessage(state));
	};

	return async () => {
		await previous?.();
		let state = getState();
		if (state && currentPhase(state) === "execute") {
			if (state.phaseTurnStarted) {
				await advanceExecuteGate?.(state);
				state = getState();
			}
		}
		let advisorBlockAlreadyQueued = false;
		for (let reviewPass = 0; reviewPass < 2; reviewPass++) {
			if (!state?.gateRequestId || isGateSatisfied(state)) break;
			const reviewPhase = currentPhase(state);
			if (reviewPhase !== "verify" && reviewPhase !== "execute") break;
			if (state.phaseTurnStarted || state.gateRequestId !== requestedAdvisorReviewGateId) {
				const advisorReviewResult = await requestAdvisorReview?.(state);
				state = getState();
				if (!state) return;
				const currentReviewPhase = currentPhase(state);
				if (currentReviewPhase === "verify" || currentReviewPhase === "execute") {
					requestedAdvisorReviewGateId = state.gateRequestId;
				}
				if (advisorReviewResult) {
					const reviewerState = state;
					const review = normalizeNikoflowAdvisorReview(advisorReviewResult, reviewerState);
					if (review) {
						if (nikoflowAdvisorReviewBlockers(review).length > 0) {
							await onAdvisorBlock?.(reviewerState, review);
							advisorBlockAlreadyQueued = true;
							break;
						} else {
							await advanceAdvisorGate?.(reviewerState, review);
						}
					}
					state = getState();
				}
				continue;
			}
			break;
		}
		await afterNikoflow?.();
		state = getState();
		if (!state) return;
		const phase = currentPhase(state);
		if (phase === "execute" && !state.phaseTurnStarted) {
			await queueGateHold(state);
			return;
		}
		if (!state.gateRequestId || isGateSatisfied(state)) return;
		if (isHumanGatePhase(state)) {
			await yieldForExternalAction(state);
			return;
		}
		if ((phase === "verify" || phase === "execute") && advisorBlockAlreadyQueued) return;
		await yieldForExternalAction(state);
	};
}

export function createNikoflowCallbackBundle<TMessages = unknown, TContext = unknown, TDirective = unknown>(
	options: NikoflowCallbackBundleOptions<TMessages, TContext, TDirective>,
): NikoflowCallbackBundle<TMessages, TContext, TDirective> {
	const afterTurnEnd =
		options.afterTurnEnd || options.advanceHumanGate
			? async (messages: TMessages, signal?: AbortSignal, context?: TContext) => {
					await options.afterTurnEnd?.(messages, signal, context);
					await options.advanceHumanGate?.(messages, signal, context);
				}
			: undefined;
	const onTurnEnd = afterTurnEnd ? createNikoflowOnTurnEnd(options.onTurnEnd, afterTurnEnd) : options.onTurnEnd;
	const getToolChoice = options.nikoflowToolChoice
		? createNikoflowGetToolChoice(options.getToolChoice, options.nikoflowToolChoice)
		: options.getToolChoice;

	return {
		beforeToolCall: createNikoflowBeforeToolCall(options.getState, options.beforeToolCall, options.policy),
		onBeforeYield: createNikoflowOnBeforeYield(
			options.getState,
			options.isGateSatisfied,
			options.enqueueFollowUp,
			options.onBeforeYield,
			options.advanceExecuteGate,
			options.requestAdvisorReview,
			options.advanceAdvisorGate,
			options.onAdvisorBlock,
			options.onGateNeedsExternalAction,
			options.afterBeforeYield,
		),
		...(onTurnEnd ? { onTurnEnd } : {}),
		...(getToolChoice ? { getToolChoice } : {}),
	};
}

export function installNikoflowCallbacks<TMessages = unknown, TContext = unknown, TDirective = unknown>(
	host: NikoflowCallbackHost<TMessages, TContext, TDirective>,
	options: NikoflowCallbackBundleOptions<TMessages, TContext, TDirective>,
): InstalledNikoflowCallbacks<TMessages, TContext, TDirective> {
	const previousBeforeToolCall = host.beforeToolCall;
	const previousOnTurnEnd = options.onTurnEnd ?? host.getOnTurnEnd?.();
	const previousOnBeforeYield = options.onBeforeYield ?? host.getOnBeforeYield?.();
	const previousGetToolChoice = options.getToolChoice ?? host.getGetToolChoice?.();
	const bundle = createNikoflowCallbackBundle({
		...options,
		beforeToolCall: options.beforeToolCall ?? previousBeforeToolCall,
		onTurnEnd: previousOnTurnEnd,
		onBeforeYield: previousOnBeforeYield,
		getToolChoice: previousGetToolChoice,
	});

	host.beforeToolCall = bundle.beforeToolCall;
	host.setOnTurnEnd?.(bundle.onTurnEnd);
	host.setOnBeforeYield?.(bundle.onBeforeYield);
	host.setGetToolChoice?.(bundle.getToolChoice);

	return {
		bundle,
		uninstall: () => {
			host.beforeToolCall = previousBeforeToolCall;
			host.setOnTurnEnd?.(previousOnTurnEnd);
			host.setOnBeforeYield?.(previousOnBeforeYield);
			host.setGetToolChoice?.(previousGetToolChoice);
		},
	};
}

export async function installNikoflowAgentSessionMode<
	TMessages = unknown,
	TContext = unknown,
	TDirective = unknown,
	TModel extends NikoflowSessionModel = NikoflowSessionModel,
	TThinking = unknown,
>(
	host: NikoflowAgentSessionHost<TMessages, TContext, TDirective, TModel, TThinking>,
	options: NikoflowCallbackBundleOptions<TMessages, TContext, TDirective>,
): Promise<InstalledNikoflowCallbacks<TMessages, TContext, TDirective>> {
	assertNikoflowRoleRails(role => {
		const resolved = host.resolveRoleModelWithThinking(role);
		return resolved.model ? { provider: resolved.model.provider, model: resolved.model.id } : null;
	});

	const { advanceHumanGate, afterBeforeYield, afterTurnEnd, ...callbackOptions } = options;

	return installNikoflowCallbacks(host, {
		...callbackOptions,
		afterTurnEnd: async (messages, signal, context) => {
			await afterTurnEnd?.(messages, signal, context);
			await advanceHumanGate?.(messages, signal, context);
		},
		afterBeforeYield: async () => {
			await afterBeforeYield?.();
		},
	});
}
