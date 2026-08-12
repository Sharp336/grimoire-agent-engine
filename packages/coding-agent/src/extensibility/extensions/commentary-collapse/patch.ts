import type { Component } from "@oh-my-pi/pi-tui";
import { isRecord } from "@oh-my-pi/pi-utils/type-guards";
import {
	type AssistantClass,
	type AssistantPrototype,
	type BuilderPrototype,
	type EventControllerPrototype,
	type HostLikeModule,
	PATCH_OWNER,
	type UiHelpersPrototype,
	type UserClass,
	validateCompatibility,
} from "./compatibility";
import { inspectMessagePhases, parseNativeTextSignature } from "./phase";
import {
	createCollapsedThinkingSummary,
	transformMessageForCollapsedDisplay,
	transformMessageWithoutCommentary,
} from "./transform";
import { TurnActivityGroup } from "./turn-group";
import type { PhaseMessage } from "./types";

export const PATCH_SYMBOL = Symbol.for("omp-commentary-collapse.patch.v1");

const EMPTY_ROWS: readonly string[] = Object.freeze([]);
type OriginalMethod = (...args: never[]) => unknown;

export interface PresentationPatchApi {
	readonly pi: HostLikeModule;
	readonly logger: {
		warn(message: string, context?: Record<string, unknown>): void;
	};
}

interface ComponentState {
	sourceMessage?: PhaseMessage;
	expanded: boolean;
	phaseAware: boolean;
	hasCommentary: boolean;
	hasFinalAnswer: boolean;
	lastTransient: boolean;
}

interface OriginalMethods {
	assistantUpdateContent: OriginalMethod;
	assistantSettledRows: OriginalMethod;
	assistantFinalize: OriginalMethod;
	assistantSetExpanded?: OriginalMethod;
	builderSetExpanded: OriginalMethod;
	builderRebuild: OriginalMethod;
	builderAppend: OriginalMethod;
	eventHandle: OriginalMethod;
	uiAddMessage: OriginalMethod;
}

interface TranscriptContainerLike {
	readonly children: Component[];
	addChild(component: Component): void;
	removeChild(component: Component): void;
}

interface LiveContextLike {
	readonly chatContainer: TranscriptContainerLike;
	readonly toolOutputExpanded: boolean;
	readonly streamingComponent?: Component;
	readonly sessionStreaming?: boolean;
}

interface ActivityMetadata {
	readonly commentarySignatures: readonly unknown[];
	readonly toolCallIds: readonly string[];
	readonly thinkingSummaries: readonly string[];
	readonly hasCommentary: boolean;
	readonly hasFinalAnswer: boolean;
	readonly terminalAnswer: boolean;
	readonly terminalFailure: boolean;
}

interface TurnState {
	group?: TurnActivityGroup;
	pendingTerminalComponents?: readonly Component[];
}

interface VisibilityGate {
	readonly group: TurnActivityGroup;
	readonly ownRenderDescriptor?: PropertyDescriptor;
}

export interface PresentationPatch {
	readonly installed: true;
	readonly compatible: boolean;
	readonly warning?: string;
	readonly componentState: WeakMap<object, ComponentState>;
	readonly originals?: OriginalMethods;
	readonly assistantClass?: AssistantClass;
	defaultExpanded: boolean;
	enabled: boolean;
	setDefaultExpanded(expanded: boolean): void;
	setEnabled(enabled: boolean): void;
	setSessionManager(sessionManager: unknown): void;
	dispose(): void;
}

interface InternalRegistry extends PresentationPatch {
	readonly api: PresentationPatchApi;
	readonly displaySources: WeakMap<object, PhaseMessage>;
	readonly controllerState: WeakMap<object, TurnState>;
	readonly uiHelpersState: WeakMap<object, TurnState>;
	readonly builderState: WeakMap<object, TurnState>;
	readonly visibilityGates: WeakMap<object, VisibilityGate>;
	readonly warnedRuntimeErrors: Record<string, true>;
}

function getInstalledRegistry(): InternalRegistry | undefined {
	const existing: unknown = Reflect.get(globalThis, PATCH_SYMBOL);
	if (typeof existing !== "object" || existing === null || !("installed" in existing)) return undefined;
	return existing.installed === true ? (existing as InternalRegistry) : undefined;
}

function setInstalledRegistry(registry: InternalRegistry): void {
	Reflect.set(globalThis, PATCH_SYMBOL, registry);
}

function createComponentState(expanded: boolean): ComponentState {
	return {
		expanded,
		phaseAware: false,
		hasCommentary: false,
		hasFinalAnswer: false,
		lastTransient: false,
	};
}

function getOrCreateState(registry: InternalRegistry, component: object, initialExpanded?: boolean): ComponentState {
	const existing = registry.componentState.get(component);
	if (existing !== undefined) return existing;

	const state = createComponentState(initialExpanded ?? registry.defaultExpanded);
	registry.componentState.set(component, state);
	return state;
}

function deriveDisplayMessage(registry: InternalRegistry, state: ComponentState): PhaseMessage | undefined {
	const source = state.sourceMessage;
	if (source === undefined) return undefined;
	if (!state.hasCommentary || state.expanded) return source;

	const display = state.hasFinalAnswer
		? transformMessageWithoutCommentary(source)
		: state.lastTransient
			? source
			: transformMessageForCollapsedDisplay(source);
	if (display !== source) registry.displaySources.set(display, source);
	return display;
}

function warnRuntimeOnce(registry: InternalRegistry, kind: string, error: unknown): void {
	if (registry.warnedRuntimeErrors[kind] === true) return;
	registry.warnedRuntimeErrors[kind] = true;
	registry.api.logger.warn("omp-commentary-collapse transform failed; using stock renderer", {
		kind,
		errorType: error instanceof Error ? error.name : typeof error,
	});
}

function markOwned(method: (...args: never[]) => unknown): void {
	Object.defineProperty(method, PATCH_OWNER, { value: true });
}

function readTranscriptContainer(value: unknown): TranscriptContainerLike | undefined {
	if (!isRecord(value) || !Array.isArray(value.children)) return undefined;
	if (typeof value.addChild !== "function" || typeof value.removeChild !== "function") return undefined;
	return value as unknown as TranscriptContainerLike;
}

function readLiveContext(controller: object): LiveContextLike | undefined {
	const value = Reflect.get(controller, "ctx");
	if (!isRecord(value)) return undefined;
	const chatContainer = readTranscriptContainer(value.chatContainer);
	if (chatContainer === undefined || typeof value.toolOutputExpanded !== "boolean") return undefined;
	const streamingComponent = value.streamingComponent;
	if (streamingComponent !== undefined && !isRecord(streamingComponent)) return undefined;
	const sessionStreaming =
		isRecord(value.session) && typeof value.session.isStreaming === "boolean" ? value.session.isStreaming : undefined;
	return {
		chatContainer,
		toolOutputExpanded: value.toolOutputExpanded,
		...(streamingComponent === undefined ? {} : { streamingComponent: streamingComponent as unknown as Component }),
		...(sessionStreaming === undefined ? {} : { sessionStreaming }),
	};
}

function readBuilderContainer(builder: object): TranscriptContainerLike | undefined {
	return readTranscriptContainer(Reflect.get(builder, "container"));
}

function readBuilderExpanded(builder: object, fallback: boolean): boolean {
	const expanded = Reflect.get(builder, "expanded");
	return typeof expanded === "boolean" ? expanded : fallback;
}

function inspectActivity(message: unknown): ActivityMetadata {
	const phases = inspectMessagePhases(message);
	const commentarySignatures: unknown[] = [];
	const toolCallIds: string[] = [];
	const thinkingSummaries: string[] = [];

	if (isRecord(message) && Array.isArray(message.content)) {
		for (const block of message.content) {
			if (!isRecord(block)) continue;
			if (block.type === "text") {
				const signature = parseNativeTextSignature(block.textSignature);
				if (signature?.phase === "commentary") commentarySignatures.push(block.textSignature);
			} else if (block.type === "thinking" && typeof block.thinking === "string") {
				const summary = createCollapsedThinkingSummary(block.thinking);
				if (summary !== undefined) thinkingSummaries.push(summary);
			} else if (block.type === "toolCall" && typeof block.id === "string" && block.id.length > 0) {
				toolCallIds.push(block.id);
			}
		}
	}

	const stopReason = isRecord(message) ? message.stopReason : undefined;
	return {
		commentarySignatures,
		thinkingSummaries,
		toolCallIds,
		hasCommentary: phases.hasCommentary,
		hasFinalAnswer: phases.hasFinalAnswer,
		terminalAnswer:
			phases.hasFinalAnswer || (toolCallIds.length === 0 && (stopReason === "stop" || stopReason === "length")),
		terminalFailure: stopReason === "error" || stopReason === "aborted",
	};
}

function hasCollapsibleActivity(metadata: ActivityMetadata): boolean {
	return metadata.hasCommentary || metadata.toolCallIds.length > 0 || metadata.thinkingSummaries.length > 0;
}

function eventType(event: unknown): string | undefined {
	return isRecord(event) && typeof event.type === "string" ? event.type : undefined;
}

function eventMessage(event: unknown): unknown {
	return isRecord(event) ? event.message : undefined;
}

function eventToolCallId(event: unknown): string | undefined {
	return isRecord(event) && typeof event.toolCallId === "string" && event.toolCallId.length > 0
		? event.toolCallId
		: undefined;
}

function messageRole(message: unknown): string | undefined {
	return isRecord(message) && typeof message.role === "string" ? message.role : undefined;
}

function observeMetadata(group: TurnActivityGroup, metadata: ActivityMetadata): void {
	group.observeCommentarySignatures(metadata.commentarySignatures);
	group.observeToolCallIds(metadata.toolCallIds);
	group.observeThinkingSummaries(metadata.thinkingSummaries);
}

function insertBefore(container: TranscriptContainerLike, target: Component, component: Component): void {
	const index = container.children.indexOf(target);
	if (index < 0) {
		container.addChild(component);
		return;
	}
	const tail = container.children.slice(index);
	for (const child of tail) container.removeChild(child);
	container.addChild(component);
	for (const child of tail) container.addChild(child);
}

function gateComponent(registry: InternalRegistry, component: Component, group: TurnActivityGroup): void {
	if (component === group) return;
	const existing = registry.visibilityGates.get(component);
	if (existing !== undefined) {
		if (existing.group !== group) throw new Error("Transcript component already belongs to another activity group");
		return;
	}

	const ownRenderDescriptor = Object.getOwnPropertyDescriptor(component, "render");
	const originalRender = component.render;
	Object.defineProperty(component, "render", {
		configurable: true,
		writable: true,
		value: function gatedRender(this: Component, width: number): readonly string[] {
			if (!group.expanded) return EMPTY_ROWS;
			return Reflect.apply(originalRender, this, [width]);
		},
	});
	registry.visibilityGates.set(component, {
		group,
		...(ownRenderDescriptor === undefined ? {} : { ownRenderDescriptor }),
	});
}

function ungateComponent(registry: InternalRegistry, component: Component): void {
	const gate = registry.visibilityGates.get(component);
	if (gate === undefined) return;
	if (gate.ownRenderDescriptor === undefined) {
		Reflect.deleteProperty(component, "render");
	} else {
		Object.defineProperty(component, "render", gate.ownRenderDescriptor);
	}
	registry.visibilityGates.delete(component);
}

function ensureGroupBefore(
	state: TurnState,
	container: TranscriptContainerLike,
	target: Component,
	expanded: boolean,
	initialize?: (group: TurnActivityGroup) => void,
): TurnActivityGroup {
	if (state.group !== undefined) {
		initialize?.(state.group);
		return state.group;
	}
	const group = new TurnActivityGroup();
	group.setExpanded(expanded);
	initialize?.(group);
	insertBefore(container, target, group);
	state.group = group;
	return group;
}

function gateComponents(registry: InternalRegistry, group: TurnActivityGroup, components: readonly Component[]): void {
	const installed: Component[] = [];
	try {
		for (const component of components) {
			if (component instanceof TurnActivityGroup) continue;
			if (registry.visibilityGates.get(component)?.group === group) continue;
			gateComponent(registry, component, group);
			installed.push(component);
		}
	} catch (error) {
		for (const component of installed) ungateComponent(registry, component);
		throw error;
	}
}

function addedChildren(container: TranscriptContainerLike, before: ReadonlySet<Component>): Component[] {
	return container.children.filter(child => !before.has(child));
}

function settleTurn(state: TurnState): void {
	state.group?.markTranscriptBlockFinalized();
}

function finalizeTurn(state: TurnState): void {
	settleTurn(state);
	delete state.group;
	delete state.pendingTerminalComponents;
}

function reclassifyPendingTerminal(registry: InternalRegistry, state: TurnState): void {
	const group = state.group;
	const pending = state.pendingTerminalComponents;
	if (group === undefined || pending === undefined) return;
	const untagged: Component[] = [];
	for (const component of pending) {
		gateComponent(registry, component, group);
		const metadata = inspectActivity(registry.componentState.get(component)?.sourceMessage);
		if (metadata.commentarySignatures.length === 0) untagged.push(component);
	}
	group.observeAssistantMessages(untagged);
	delete state.pendingTerminalComponents;
}

function isFinalAssistant(
	registry: InternalRegistry,
	assistantClass: AssistantClass,
	component: Component,
	acceptGenericTerminalAnswer: boolean,
): boolean {
	if (!(component instanceof assistantClass)) return false;
	const metadata = inspectActivity(registry.componentState.get(component)?.sourceMessage);
	return metadata.hasFinalAnswer || (acceptGenericTerminalAnswer && metadata.terminalAnswer);
}

function mergeComponentMetadata(
	registry: InternalRegistry,
	assistantClass: AssistantClass,
	components: readonly Component[],
	metadata: ActivityMetadata,
): ActivityMetadata {
	const commentarySignatures = [...metadata.commentarySignatures];
	const toolCallIds = [...metadata.toolCallIds];
	const thinkingSummaries = [...metadata.thinkingSummaries];
	let hasCommentary = metadata.hasCommentary;
	let hasFinalAnswer = metadata.hasFinalAnswer;
	let terminalAnswer = metadata.terminalAnswer;
	let terminalFailure = metadata.terminalFailure;
	for (const component of components) {
		if (!(component instanceof assistantClass)) continue;
		const componentMetadata = inspectActivity(registry.componentState.get(component)?.sourceMessage);
		commentarySignatures.push(...componentMetadata.commentarySignatures);
		toolCallIds.push(...componentMetadata.toolCallIds);
		thinkingSummaries.push(...componentMetadata.thinkingSummaries);
		hasCommentary ||= componentMetadata.hasCommentary;
		hasFinalAnswer ||= componentMetadata.hasFinalAnswer;
		terminalAnswer ||= componentMetadata.terminalAnswer;
		terminalFailure ||= componentMetadata.terminalFailure;
	}
	return {
		commentarySignatures,
		toolCallIds,
		thinkingSummaries,
		hasCommentary,
		hasFinalAnswer,
		terminalAnswer,
		terminalFailure,
	};
}

function processAssistantComponents(
	registry: InternalRegistry,
	assistantClass: AssistantClass,
	state: TurnState,
	container: TranscriptContainerLike,
	components: readonly Component[],
	metadata: ActivityMetadata,
	expanded: boolean,
	acceptGenericTerminalAnswer: boolean,
): void {
	const observedMetadata = mergeComponentMetadata(registry, assistantClass, components, metadata);
	const first = components[0];
	if (first === undefined && state.group === undefined) return;
	const existingGroup = state.group;
	const group =
		existingGroup ??
		(first === undefined
			? undefined
			: ensureGroupBefore(state, container, first, expanded, candidate =>
					observeMetadata(candidate, observedMetadata),
				));
	if (group === undefined) return;
	if (existingGroup !== undefined) observeMetadata(group, observedMetadata);

	const terminalComponents = components.filter(component =>
		isFinalAssistant(registry, assistantClass, component, acceptGenericTerminalAnswer),
	);
	const activityComponents = components.filter(component => !terminalComponents.includes(component));
	gateComponents(registry, group, activityComponents);
	for (const component of terminalComponents) ungateComponent(registry, component);

	if (
		observedMetadata.hasFinalAnswer ||
		(acceptGenericTerminalAnswer && observedMetadata.terminalAnswer) ||
		observedMetadata.terminalFailure
	) {
		if (terminalComponents.length > 0) state.pendingTerminalComponents = terminalComponents;
		settleTurn(state);
	}
}

function processUiMessage(
	registry: InternalRegistry,
	assistantClass: AssistantClass,
	helper: object,
	message: unknown,
	container: TranscriptContainerLike,
	components: readonly Component[],
	expanded: boolean,
): void {
	const state = registry.uiHelpersState.get(helper) ?? {};
	registry.uiHelpersState.set(helper, state);
	const role = messageRole(message);
	if (role === "user") {
		finalizeTurn(state);
		return;
	}

	if (role === "assistant") {
		reclassifyPendingTerminal(registry, state);
		const metadata = inspectActivity(message);
		if (state.group !== undefined || hasCollapsibleActivity(metadata)) {
			processAssistantComponents(registry, assistantClass, state, container, components, metadata, expanded, true);
		}
		return;
	}

	if (role === "toolResult" && state.group !== undefined) {
		reclassifyPendingTerminal(registry, state);
		gateComponents(registry, state.group, components);
	}
}

function prepareLiveEvent(
	registry: InternalRegistry,
	controller: object,
	event: unknown,
	context: LiveContextLike | undefined,
): void {
	if (context === undefined) return;
	const type = eventType(event);
	const state = registry.controllerState.get(controller) ?? {};
	registry.controllerState.set(controller, state);
	const target = context.streamingComponent ?? context.chatContainer.children.at(-1);
	if (target === undefined) return;

	if (type === "tool_execution_start") {
		reclassifyPendingTerminal(registry, state);
		const toolCallId = eventToolCallId(event);
		const group = ensureGroupBefore(state, context.chatContainer, target, context.toolOutputExpanded, candidate => {
			if (toolCallId !== undefined) candidate.observeToolCallIds([toolCallId]);
		});
		gateComponent(registry, target, group);
		return;
	}

	if (type === "message_update" && messageRole(eventMessage(event)) === "assistant") {
		const metadata = inspectActivity(eventMessage(event));
		if (!hasCollapsibleActivity(metadata) || metadata.hasFinalAnswer || metadata.terminalFailure) return;
		const group = ensureGroupBefore(state, context.chatContainer, target, context.toolOutputExpanded, candidate =>
			observeMetadata(candidate, metadata),
		);
		gateComponent(registry, target, group);
	}
}

function processLiveEvent(
	registry: InternalRegistry,
	assistantClass: AssistantClass,
	controller: object,
	event: unknown,
	contextBefore: LiveContextLike | undefined,
	streamingBefore: Component | undefined,
	beforeChildren: ReadonlySet<Component>,
): void {
	const context = readLiveContext(controller) ?? contextBefore;
	if (context === undefined) return;
	const state = registry.controllerState.get(controller) ?? {};
	registry.controllerState.set(controller, state);
	const type = eventType(event);
	const message = eventMessage(event);
	const components = addedChildren(context.chatContainer, beforeChildren);

	if (type === "agent_start") return;
	if (type === "message_start" && messageRole(message) === "user") {
		finalizeTurn(state);
		return;
	}
	if (type === "message_start" && messageRole(message) === "assistant") {
		reclassifyPendingTerminal(registry, state);
		const metadata = inspectActivity(message);
		if (state.group === undefined && !hasCollapsibleActivity(metadata)) {
			return;
		}
		processAssistantComponents(
			registry,
			assistantClass,
			state,
			context.chatContainer,
			components,
			metadata,
			context.toolOutputExpanded,
			false,
		);
		return;
	}
	if ((type === "message_update" || type === "message_end") && messageRole(message) === "assistant") {
		const metadata = inspectActivity(message);
		const acceptGenericTerminalAnswer = type === "message_end";
		if (
			state.group === undefined &&
			(metadata.hasFinalAnswer ||
				(acceptGenericTerminalAnswer && metadata.terminalAnswer) ||
				metadata.terminalFailure)
		) {
			return;
		}
		const candidateComponents = [...components];
		if (streamingBefore !== undefined && !candidateComponents.includes(streamingBefore)) {
			candidateComponents.push(streamingBefore);
		}
		processAssistantComponents(
			registry,
			assistantClass,
			state,
			context.chatContainer,
			candidateComponents,
			metadata,
			context.toolOutputExpanded,
			acceptGenericTerminalAnswer,
		);
		return;
	}
	if (type === "tool_execution_start") {
		reclassifyPendingTerminal(registry, state);
		const first = components[0];
		const group =
			state.group ??
			(first === undefined
				? undefined
				: ensureGroupBefore(state, context.chatContainer, first, context.toolOutputExpanded));
		if (group === undefined) return;
		const toolCallId = eventToolCallId(event);
		if (toolCallId !== undefined) group.observeToolCallIds([toolCallId]);
		gateComponents(registry, group, components);
		return;
	}
	if ((type === "tool_execution_update" || type === "tool_execution_end") && state.group !== undefined) {
		const toolCallId = eventToolCallId(event);
		if (toolCallId !== undefined) state.group.observeToolCallIds([toolCallId]);
		gateComponents(registry, state.group, components);
		return;
	}
	if (type === "agent_end" && context.sessionStreaming !== true) settleTurn(state);
}

function regroupHistoricalBuilder(
	registry: InternalRegistry,
	assistantClass: AssistantClass,
	userClass: UserClass,
	builder: object,
	entries: unknown,
): void {
	const container = readBuilderContainer(builder);
	if (container === undefined) return;
	const state: TurnState = {};
	registry.builderState.set(builder, state);
	const groups: TurnActivityGroup[] = [];
	const snapshot = [...container.children];
	const expanded = readBuilderExpanded(builder, registry.defaultExpanded);

	for (const component of snapshot) {
		if (component instanceof userClass) {
			finalizeTurn(state);
			continue;
		}
		if (component instanceof assistantClass) {
			reclassifyPendingTerminal(registry, state);
			const metadata = inspectActivity(registry.componentState.get(component)?.sourceMessage);
			if (hasCollapsibleActivity(metadata)) {
				const group = ensureGroupBefore(state, container, component, expanded);
				if (!groups.includes(group)) groups.push(group);
				observeMetadata(group, metadata);
			}
			if (metadata.terminalAnswer && state.group !== undefined) {
				ungateComponent(registry, component);
				state.pendingTerminalComponents = [component];
				settleTurn(state);
			} else if (state.group !== undefined) {
				gateComponent(registry, component, state.group);
			}
			continue;
		}
		if (state.group !== undefined) {
			reclassifyPendingTerminal(registry, state);
			gateComponent(registry, component, state.group);
		}
	}
	settleTurn(state);

	if (!Array.isArray(entries)) return;
	const metadataByTurn: ActivityMetadata[] = [];
	let current:
		| {
				commentarySignatures: unknown[];
				toolCallIds: string[];
				thinkingSummaries: string[];
				hasCommentary: boolean;
				hasFinalAnswer: boolean;
				terminalAnswer: boolean;
				terminalFailure: boolean;
		  }
		| undefined;
	for (const entry of entries) {
		if (!isRecord(entry) || !isRecord(entry.message)) continue;
		const role = messageRole(entry.message);
		if (role === "user") {
			if (current !== undefined) metadataByTurn.push(current);
			current = undefined;
			continue;
		}
		if (role !== "assistant") continue;
		const metadata = inspectActivity(entry.message);
		if (current === undefined && hasCollapsibleActivity(metadata)) {
			current = {
				commentarySignatures: [],
				thinkingSummaries: [],
				toolCallIds: [],
				hasCommentary: false,
				hasFinalAnswer: false,
				terminalAnswer: false,
				terminalFailure: false,
			};
		}
		if (current === undefined) continue;
		current.commentarySignatures.push(...metadata.commentarySignatures);
		current.toolCallIds.push(...metadata.toolCallIds);
		current.thinkingSummaries.push(...metadata.thinkingSummaries);
		current.hasCommentary ||= metadata.hasCommentary;
		current.hasFinalAnswer ||= metadata.hasFinalAnswer;
		current.terminalAnswer ||= metadata.terminalAnswer;
		current.terminalFailure ||= metadata.terminalFailure;
	}
	if (current !== undefined) metadataByTurn.push(current);
	for (let index = 0; index < groups.length; index++) {
		const metadata = metadataByTurn[index];
		if (metadata !== undefined) observeMetadata(groups[index]!, metadata);
	}
}

function appendHistoricalBuilder(
	registry: InternalRegistry,
	assistantClass: AssistantClass,
	userClass: UserClass,
	builder: object,
	entries: unknown,
	beforeChildren: ReadonlySet<Component>,
): void {
	const container = readBuilderContainer(builder);
	if (container === undefined) return;
	const state = registry.builderState.get(builder) ?? {};
	registry.builderState.set(builder, state);
	const expanded = readBuilderExpanded(builder, registry.defaultExpanded);
	const components = addedChildren(container, beforeChildren);

	for (const component of components) {
		if (component instanceof userClass) {
			finalizeTurn(state);
			continue;
		}
		if (component instanceof assistantClass) {
			reclassifyPendingTerminal(registry, state);
			const metadata = inspectActivity(registry.componentState.get(component)?.sourceMessage);
			if (hasCollapsibleActivity(metadata)) {
				const group = ensureGroupBefore(state, container, component, expanded);
				observeMetadata(group, metadata);
			}
			if (metadata.terminalAnswer && state.group !== undefined) {
				ungateComponent(registry, component);
				state.pendingTerminalComponents = [component];
				settleTurn(state);
			} else if (state.group !== undefined) {
				gateComponent(registry, component, state.group);
			}
			continue;
		}
		if (state.group !== undefined) {
			reclassifyPendingTerminal(registry, state);
			gateComponent(registry, component, state.group);
		}
	}

	if (!Array.isArray(entries) || state.group === undefined) return;
	for (const entry of entries) {
		if (!isRecord(entry) || !isRecord(entry.message) || messageRole(entry.message) !== "assistant") continue;
		observeMetadata(state.group, inspectActivity(entry.message));
	}
}

function applyExpansionToBuilder(registry: InternalRegistry, builder: object, expanded: boolean): void {
	const container = readBuilderContainer(builder);
	if (container === undefined) return;
	for (const child of container.children) {
		if (child instanceof TurnActivityGroup) {
			child.setExpanded(expanded);
			continue;
		}
		if (
			registry.assistantClass !== undefined &&
			child instanceof registry.assistantClass &&
			registry.componentState.get(child)?.expanded !== expanded
		) {
			const setExpanded = Reflect.get(child, "setExpanded");
			if (typeof setExpanded === "function") Reflect.apply(setExpanded, child, [expanded]);
		}
	}
}

function installWrappers(
	registry: InternalRegistry,
	originals: OriginalMethods,
	assistantClass: AssistantClass,
	assistantPrototype: AssistantPrototype,
	builderPrototype: BuilderPrototype,
	eventControllerPrototype: EventControllerPrototype,
	uiHelpersPrototype: UiHelpersPrototype,
	userClass: UserClass,
): void {
	function patchedUpdateContent(this: object, message: PhaseMessage, options?: { transient?: boolean }): unknown {
		if (!registry.enabled) return Reflect.apply(originals.assistantUpdateContent, this, [message, options]);
		let displayMessage = message;
		try {
			const state = getOrCreateState(registry, this);
			const knownSource = registry.displaySources.get(message);
			const sourceMessage = knownSource ?? message;
			const phases = inspectMessagePhases(sourceMessage);
			state.sourceMessage = sourceMessage;
			state.lastTransient = options?.transient === true;
			state.phaseAware = phases.phaseAware;
			state.hasCommentary = phases.hasCommentary;
			state.hasFinalAnswer = phases.hasFinalAnswer;
			displayMessage =
				knownSource !== undefined && !state.expanded && !state.lastTransient
					? message
					: (deriveDisplayMessage(registry, state) ?? sourceMessage);
		} catch (error) {
			warnRuntimeOnce(registry, "update-content", error);
		}
		return Reflect.apply(originals.assistantUpdateContent, this, [displayMessage, options]);
	}

	function patchedSettledRows(this: object): unknown {
		if (!registry.enabled) return Reflect.apply(originals.assistantSettledRows, this, []);
		try {
			const state = registry.componentState.get(this);
			if (state?.hasCommentary === true && state.lastTransient) return 0;
		} catch (error) {
			warnRuntimeOnce(registry, "settled-rows", error);
		}
		return Reflect.apply(originals.assistantSettledRows, this, []);
	}

	function patchedFinalize(this: object): unknown {
		if (!registry.enabled) return Reflect.apply(originals.assistantFinalize, this, []);
		try {
			const state = registry.componentState.get(this);
			if (state?.sourceMessage !== undefined && state.hasCommentary && !state.expanded) {
				state.lastTransient = false;
				const displayMessage = deriveDisplayMessage(registry, state) ?? state.sourceMessage;
				Reflect.apply(originals.assistantUpdateContent, this, [displayMessage, { transient: false }]);
			}
		} catch (error) {
			warnRuntimeOnce(registry, "finalization", error);
		}
		return Reflect.apply(originals.assistantFinalize, this, []);
	}

	function patchedSetExpanded(this: object, expanded: boolean): unknown {
		const existingState = registry.componentState.get(this);
		if (!registry.enabled || existingState === undefined) {
			return originals.assistantSetExpanded === undefined
				? undefined
				: Reflect.apply(originals.assistantSetExpanded, this, [expanded]);
		}
		let displayMessage: PhaseMessage | undefined;
		let transient = false;
		try {
			existingState.expanded = expanded;
			registry.defaultExpanded = expanded;
			transient = existingState.lastTransient;
			displayMessage = deriveDisplayMessage(registry, existingState);
		} catch (error) {
			warnRuntimeOnce(registry, "set-expanded", error);
		}
		const nativeResult =
			originals.assistantSetExpanded === undefined
				? undefined
				: Reflect.apply(originals.assistantSetExpanded, this, [expanded]);
		if (displayMessage !== undefined) {
			Reflect.apply(originals.assistantUpdateContent, this, [displayMessage, { transient }]);
		}
		return nativeResult;
	}
	markOwned(patchedSetExpanded);

	function patchedBuilderSetExpanded(this: object, expanded: boolean): unknown {
		if (!registry.enabled) return Reflect.apply(originals.builderSetExpanded, this, [expanded]);
		const result = Reflect.apply(originals.builderSetExpanded, this, [expanded]);
		try {
			applyExpansionToBuilder(registry, this, expanded);
		} catch (error) {
			warnRuntimeOnce(registry, "builder-expansion", error);
		}
		return result;
	}

	function patchedBuilderRebuild(this: object, entries: unknown): unknown {
		if (!registry.enabled) return Reflect.apply(originals.builderRebuild, this, [entries]);
		const result = Reflect.apply(originals.builderRebuild, this, [entries]);
		try {
			regroupHistoricalBuilder(registry, assistantClass, userClass, this, entries);
			applyExpansionToBuilder(registry, this, readBuilderExpanded(this, registry.defaultExpanded));
		} catch (error) {
			warnRuntimeOnce(registry, "builder-rebuild", error);
		}
		return result;
	}

	function patchedBuilderAppend(this: object, entries: unknown): unknown {
		if (!registry.enabled) return Reflect.apply(originals.builderAppend, this, [entries]);
		const containerBefore = readBuilderContainer(this);
		const beforeChildren = new Set(containerBefore?.children ?? []);
		const result = Reflect.apply(originals.builderAppend, this, [entries]);
		try {
			appendHistoricalBuilder(registry, assistantClass, userClass, this, entries, beforeChildren);
			applyExpansionToBuilder(registry, this, readBuilderExpanded(this, registry.defaultExpanded));
		} catch (error) {
			warnRuntimeOnce(registry, "builder-append", error);
		}
		return result;
	}

	async function patchedEventHandle(this: object, event: unknown): Promise<unknown> {
		if (!registry.enabled) return Reflect.apply(originals.eventHandle, this, [event]);
		const contextBefore = readLiveContext(this);
		try {
			prepareLiveEvent(registry, this, event, contextBefore);
		} catch (error) {
			warnRuntimeOnce(registry, "live-turn-prepare", error);
		}
		const streamingBefore = contextBefore?.streamingComponent;
		const beforeChildren = new Set(contextBefore?.chatContainer.children ?? []);
		const result = await Reflect.apply(originals.eventHandle, this, [event]);
		try {
			processLiveEvent(registry, assistantClass, this, event, contextBefore, streamingBefore, beforeChildren);
		} catch (error) {
			warnRuntimeOnce(registry, "live-turn-group", error);
		}
		return result;
	}

	function patchedUiAddMessage(this: object, message: unknown, options?: unknown): unknown {
		if (!registry.enabled) return Reflect.apply(originals.uiAddMessage, this, [message, options]);
		const context = readLiveContext(this);
		const beforeChildren = new Set(context?.chatContainer.children ?? []);
		const result = Reflect.apply(originals.uiAddMessage, this, [message, options]);
		try {
			const currentContext = readLiveContext(this) ?? context;
			if (currentContext !== undefined) {
				processUiMessage(
					registry,
					assistantClass,
					this,
					message,
					currentContext.chatContainer,
					addedChildren(currentContext.chatContainer, beforeChildren),
					currentContext.toolOutputExpanded,
				);
			}
		} catch (error) {
			warnRuntimeOnce(registry, "historical-turn-group", error);
		}
		return result;
	}

	markOwned(patchedUpdateContent);
	markOwned(patchedSettledRows);
	markOwned(patchedFinalize);
	markOwned(patchedBuilderSetExpanded);
	markOwned(patchedBuilderRebuild);
	markOwned(patchedBuilderAppend);
	markOwned(patchedEventHandle);
	markOwned(patchedUiAddMessage);

	assistantPrototype.updateContent = patchedUpdateContent;
	assistantPrototype.getTranscriptBlockSettledRows = patchedSettledRows;
	assistantPrototype.markTranscriptBlockFinalized = patchedFinalize;
	assistantPrototype.setExpanded = patchedSetExpanded;
	builderPrototype.setExpanded = patchedBuilderSetExpanded;
	builderPrototype.rebuild = patchedBuilderRebuild;
	builderPrototype.append = patchedBuilderAppend;
	eventControllerPrototype.handleEvent = patchedEventHandle;
	uiHelpersPrototype.addMessageToChat = patchedUiAddMessage;
}

export function installPresentationPatch(api: PresentationPatchApi): PresentationPatch {
	const existing = getInstalledRegistry();
	if (existing !== undefined) return existing;

	const compatibility = validateCompatibility(api.pi);
	if (!compatibility.ok) {
		const registry: InternalRegistry = {
			installed: true,
			compatible: false,
			warning: `${compatibility.warning}. Stock display is unchanged.`,
			componentState: new WeakMap(),
			defaultExpanded: false,
			enabled: false,
			displaySources: new WeakMap(),
			controllerState: new WeakMap(),
			uiHelpersState: new WeakMap(),
			builderState: new WeakMap(),
			visibilityGates: new WeakMap(),
			api,
			warnedRuntimeErrors: {},
			setDefaultExpanded(expanded: boolean): void {
				this.defaultExpanded = expanded;
			},
			setEnabled(enabled: boolean): void {
				this.enabled = this.compatible && enabled;
			},
			setSessionManager(_sessionManager: unknown): void {},
			dispose(): void {
				this.enabled = false;
			},
		};
		setInstalledRegistry(registry);
		api.logger.warn("omp-commentary-collapse disabled", {
			ompVersion: compatibility.detectedVersion ?? "unknown",
			reason: compatibility.reason,
			missingMethods: compatibility.missing.map(item => `${item.surface}.${item.member}`),
			conflicts: compatibility.conflicting.map(item => `${item.surface}.${item.member}`),
		});
		return registry;
	}

	const originals: OriginalMethods = {
		assistantUpdateContent: compatibility.assistantPrototype.updateContent,
		assistantSettledRows: compatibility.assistantPrototype.getTranscriptBlockSettledRows,
		assistantFinalize: compatibility.assistantPrototype.markTranscriptBlockFinalized,
		...(compatibility.assistantPrototype.setExpanded === undefined
			? {}
			: { assistantSetExpanded: compatibility.assistantPrototype.setExpanded }),
		builderSetExpanded: compatibility.builderPrototype.setExpanded,
		builderRebuild: compatibility.builderPrototype.rebuild,
		builderAppend: compatibility.builderPrototype.append,
		eventHandle: compatibility.eventControllerPrototype.handleEvent,
		uiAddMessage: compatibility.uiHelpersPrototype.addMessageToChat,
	};
	const registry: InternalRegistry = {
		installed: true,
		compatible: true,
		componentState: new WeakMap(),
		displaySources: new WeakMap(),
		controllerState: new WeakMap(),
		uiHelpersState: new WeakMap(),
		builderState: new WeakMap(),
		visibilityGates: new WeakMap(),
		originals,
		assistantClass: compatibility.assistantClass,
		defaultExpanded: false,
		enabled: false,
		api,
		warnedRuntimeErrors: {},
		setDefaultExpanded(expanded: boolean): void {
			this.defaultExpanded = expanded;
		},
		setEnabled(enabled: boolean): void {
			this.enabled = this.compatible && enabled;
		},
		setSessionManager(_sessionManager: unknown): void {},
		dispose(): void {
			this.enabled = false;
		},
	};

	setInstalledRegistry(registry);
	installWrappers(
		registry,
		originals,
		compatibility.assistantClass,
		compatibility.assistantPrototype,
		compatibility.builderPrototype,
		compatibility.eventControllerPrototype,
		compatibility.uiHelpersPrototype,
		compatibility.userClass,
	);
	return registry;
}
