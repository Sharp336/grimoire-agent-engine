import { Text } from "@oh-my-pi/pi-tui";
import { theme } from "../theme/theme";
import { TranscriptBlock } from "./transcript-container";

/**
 * Single-line transcript rule marking where a `/side` conversation begins.
 * Carries the same ghost glyph and `warning` token as the focused-session
 * status badge so the marker and the badge read as one mode. The persisted
 * `<system-notice>` content is for the model only.
 */
export function createSideBoundaryBlock(): TranscriptBlock {
	const icon = theme.icon.ghost ? `${theme.icon.ghost} ` : "";
	const line = [
		theme.fg("warning", `${icon}Side conversation`),
		theme.fg("dim", `${theme.format.dash} context above is inherited, reference only`),
	].join(" ");
	const block = new TranscriptBlock();
	block.addChild(new Text(line, 1, 0));
	return block;
}
