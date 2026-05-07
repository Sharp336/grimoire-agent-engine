/**
 * NudgeDeliverer: formats and delivers nudge messages to the user.
 */
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import type { Nudge } from "./nudge-detector";

export class NudgeDeliverer {
	format(nudge: Nudge): string {
		const severityLabel = nudge.severity === "warn" ? "Warning" : "Tip";
		return `[${severityLabel}] ${nudge.message}\nSuggestion: ${nudge.suggestion}`;
	}

	deliver(nudge: Nudge, ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		const text = this.format(nudge);
		ctx.ui.notify(text, nudge.severity === "warn" ? "warning" : "info");
	}
}
