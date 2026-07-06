import { humanGateAccepted } from "./gates";
import { assertNikoflowRoleRails } from "./roles";
import {
	advancePhase,
	currentPhase,
	currentRole,
	isHumanGatePhase,
	mintGateRequest,
	type NikoflowRole,
	type NikoflowState,
} from "./state";

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
		return ensureNikoflowHumanGate(state, options);
	}
	const gateMintedAt = state.gateMintedAt;
	const hasLaterUserTurn = messages.some(message => {
		if (!options.isGenuineUserTurn(message)) return false;
		return humanGateAccepted(gateMintedAt, options.messageTimestamp(message));
	});
	if (!hasLaterUserTurn) return state;
	return ensureNikoflowHumanGate(advancePhase(state), options);
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
	return `Nikoflow gate for phase "${phase}" is not satisfied. Continue only by satisfying the current gate; do not self-approve it.`;
}

export function createNikoflowOnBeforeYield(
	getState: () => NikoflowState | null | undefined,
	isGateSatisfied: (state: NikoflowState) => boolean,
	enqueueFollowUp: (message: string) => void | Promise<void>,
	previous?: OnBeforeYield,
): OnBeforeYield {
	return async () => {
		await previous?.();
		const state = getState();
		if (!state?.gateRequestId || isGateSatisfied(state)) return;
		await enqueueFollowUp(formatGateHoldMessage(state));
	};
}

export function createNikoflowCallbackBundle<TMessages = unknown, TContext = unknown, TDirective = unknown>(
	options: NikoflowCallbackBundleOptions<TMessages, TContext, TDirective>,
): NikoflowCallbackBundle<TMessages, TContext, TDirective> {
	const onTurnEnd = options.afterTurnEnd
		? createNikoflowOnTurnEnd(options.onTurnEnd, options.afterTurnEnd)
		: options.onTurnEnd;
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

	let appliedRole: NikoflowRole | null = null;
	const applyCurrentRole = async () => {
		const state = options.getState();
		const role = state ? currentRole(state) : null;
		if (!role || role === appliedRole) return;

		const resolved = host.resolveRoleModelWithThinking(role);
		if (!resolved.model) return;

		await host.applyRoleModel({
			role,
			model: resolved.model,
			thinkingLevel: resolved.thinkingLevel,
			explicitThinkingLevel: resolved.explicitThinkingLevel,
		});
		appliedRole = role;
	};

	await applyCurrentRole();

	return installNikoflowCallbacks(host, {
		...options,
		afterTurnEnd: async (messages, signal, context) => {
			await options.afterTurnEnd?.(messages, signal, context);
			await options.advanceHumanGate?.(messages, signal, context);
			await applyCurrentRole();
		},
	});
}
