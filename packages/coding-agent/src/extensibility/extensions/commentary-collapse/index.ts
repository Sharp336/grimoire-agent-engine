import { logger, VERSION } from "@oh-my-pi/pi-utils";
import { AssistantMessageComponent } from "../../../modes/components/assistant-message";
import { ChatTranscriptBuilder } from "../../../modes/components/chat-transcript-builder";
import { UserMessageComponent } from "../../../modes/components/user-message";
import { EventController } from "../../../modes/controllers/event-controller";
import { UiHelpers } from "../../../modes/utils/ui-helpers";
import type { ExtensionAPI, ExtensionContext } from "../types";
import { installPresentationPatch } from "./patch";

const HOST_VERSION = VERSION;

export default function commentaryCollapse(_pi: ExtensionAPI): void {
	const patch = installPresentationPatch({
		pi: {
			version: HOST_VERSION,
			AssistantMessageComponent,
			ChatTranscriptBuilder,
			EventController,
			UserMessageComponent,
			UiHelpers,
		},
		logger,
	});
	const enable = (ctx: ExtensionContext): void => {
		patch.setSessionManager(ctx.sessionManager);
		patch.setEnabled(true);
		if (ctx.hasUI) patch.setDefaultExpanded(ctx.ui.getToolsExpanded());
	};
	_pi.on("session_start", (_event, ctx) => {
		enable(ctx);
	});
	_pi.on("session_switch", (_event, ctx) => {
		enable(ctx);
	});
	_pi.on("session_branch", (_event, ctx) => {
		enable(ctx);
	});
	_pi.on("session_tree", (_event, ctx) => {
		enable(ctx);
	});
	_pi.on("message_start", (_event, ctx) => {
		enable(ctx);
	});
	_pi.on("session_shutdown", (_event, ctx) => {
		if (ctx.sessionManager) patch.dispose();
	});
}
