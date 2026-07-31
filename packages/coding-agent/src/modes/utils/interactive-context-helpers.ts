/**
 * Small helpers over {@link InteractiveModeContext} shared between
 * {@link UiHelpers} and the input/event controllers, so the live chat surfaces
 * construct components and reset editor state identically.
 */
import type { AssistantMessage, Model } from "@oh-my-pi/pi-ai";
import type { ConfiguredThinkingLevel } from "../../thinking";
import { AssistantMessageComponent } from "../components/assistant-message";
import type { InteractiveModeContext } from "../types";

/**
 * Construct an {@link AssistantMessageComponent} wired to the live context's
 * thinking/image settings. `message` is omitted for the streaming placeholder
 * component and supplied when rendering a persisted turn.
 */
export function createAssistantMessageComponent(
	ctx: InteractiveModeContext,
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
	component.setExpanded(ctx.toolOutputExpanded);
	return component;
}

/**
 * Apply a session-only model pick (compact picker via alt+p / bare `/switch`,
 * or `/switch <model>` directly): update agent state without persisting the
 * model to settings, refresh the chrome, and announce the switch. Both call
 * paths go through here so the status string and side effects cannot drift.
 * An explicit `thinkingLevel` (e.g. a `:<thinking>` suffix) wins over the
 * role-derived fallback.
 */
export async function applyTemporarySessionModel(
	ctx: InteractiveModeContext,
	model: Model,
	selector: string,
	thinkingLevel?: ConfiguredThinkingLevel,
): Promise<void> {
	// Session-only: update agent state but don't persist the model to settings.
	const resolvedThinkingLevel = thinkingLevel ?? ctx.session.resolveTemporaryModelThinkingLevel(model);
	await ctx.session.setModelTemporary(model, resolvedThinkingLevel);
	ctx.statusLine.invalidate();
	ctx.updateEditorBorderColor();
	const roleSelectorHint = ctx.keybindings.getKeys("app.model.select")[0] ?? "Alt+M";
	ctx.showStatus(`Session-only model: ${selector}. Use ${roleSelectorHint} or /model for roles.`);
}
