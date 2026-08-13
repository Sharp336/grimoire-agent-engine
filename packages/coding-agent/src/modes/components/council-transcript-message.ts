import { type Component, visibleWidth } from "@oh-my-pi/pi-tui";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import {
	createCachedComponent,
	formatBadge,
	previewLine,
	replaceTabs,
	TRUNCATE_LENGTHS,
} from "../../tools/render-utils";
import { Ellipsis, truncateToWidth } from "../../tui";
import { theme } from "../theme/theme";

/** Collapse a caller-supplied fragment to a single safe, width-bounded display run. */
function bounded(value: string, max: number): string {
	return previewLine(replaceTabs(sanitizeText(value)), max);
}

/**
 * Opens a mirrored phase: `[<label>] <model> · <phase>` plus the durable
 * `history://<agentId>` pointer.
 *
 * The child's turns themselves render through the same assistant and tool
 * components as Main's, so this card is the only row that names the agent —
 * nothing the mirror emits after it carries a label prefix.
 */
export function createCouncilTranscriptHeaderCard(options: {
	label: string;
	model: string;
	phase: string;
	agentId: string;
}): Component {
	const { label, model, phase, agentId } = options;
	return createCachedComponent(
		() => false,
		width => {
			const parts = [theme.fg("customMessageLabel", theme.bold(`[${bounded(label, TRUNCATE_LENGTHS.TITLE)}]`))];
			const modelText = bounded(model, TRUNCATE_LENGTHS.SHORT);
			if (modelText.length > 0) parts.push(formatBadge(modelText, "muted", theme));
			const phaseText = bounded(phase, TRUNCATE_LENGTHS.SHORT);
			if (phaseText.length > 0) parts.push(theme.fg("dim", phaseText));
			const head = parts.join(" ");

			const pointer = theme.fg("dim", `history://${bounded(agentId, TRUNCATE_LENGTHS.SHORT)}`);
			const lines =
				visibleWidth(head) + 1 + visibleWidth(pointer) <= width ? [`${head} ${pointer}`] : [head, pointer];
			return lines.map(line => truncateToWidth(line, width, Ellipsis.Unicode));
		},
		{ paddingX: 1 },
	);
}
