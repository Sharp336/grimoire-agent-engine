/**
 * Small helpers over {@link InteractiveModeContext} shared between
 * {@link UiHelpers} and the input/event controllers, so the live chat surfaces
 * construct components and reset editor state identically.
 */
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import type { TUI } from "@oh-my-pi/pi-tui";
import type { Settings } from "../../config/settings";
import type { AgentSession } from "../../session/agent-session";
import { AssistantMessageComponent } from "../components/assistant-message";

/**
 * The {@link InteractiveModeContext} slice an assistant card is built from.
 * Named separately so a surface that renders a *foreign* agent's turns into the
 * live transcript — the council transcript mirror — produces cards identical to
 * Main's without depending on the whole interactive context.
 */
export interface AssistantMessageComponentContext {
	readonly ui: TUI;
	readonly settings: Settings;
	readonly viewSession: AgentSession;
	readonly effectiveHideThinkingBlock: boolean;
	readonly proseOnlyThinking: boolean;
	readonly toolOutputExpanded: boolean;
	readonly hideToolActivity: boolean;
}

/**
 * Construct an {@link AssistantMessageComponent} wired to the live context's
 * thinking/image settings. `message` is omitted for the streaming placeholder
 * component and supplied when rendering a persisted turn.
 */
export function createAssistantMessageComponent(
	ctx: AssistantMessageComponentContext,
	message?: AssistantMessage,
): AssistantMessageComponent {
	const component = new AssistantMessageComponent(
		message,
		ctx.effectiveHideThinkingBlock,
		() => ctx.ui.requestRender(),
		ctx.viewSession.extensionRunner?.getAssistantThinkingRenderers(),
		ctx.ui.imageBudget,
		ctx.proseOnlyThinking,
	);
	component.setImagesVisible(ctx.settings.get("terminal.showImages"));
	component.setToolResultImagesVisible(!ctx.hideToolActivity);
	component.setExpanded(ctx.toolOutputExpanded);
	return component;
}
