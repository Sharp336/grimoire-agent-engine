import { Patch } from "@oh-my-pi/hashline";
import { ToolError } from "../../tools/tool-errors";
import { HASHLINE_EDIT_INPUT_GUIDANCE } from "./guidance";

/** Parse hashline edit input; surfaces a single actionable {@link ToolError} for prose/JSON/malformed input. */
export function parseHashlineEditInput(input: string, cwd: string) {
	try {
		const patch = Patch.parse(input, { cwd });
		if (patch.sections.length === 0) {
			throw new ToolError(`No hashline sections found in input. ${HASHLINE_EDIT_INPUT_GUIDANCE}`);
		}
		return patch;
	} catch (error) {
		if (error instanceof ToolError) throw error;
		const detail = error instanceof Error ? error.message : String(error);
		throw new ToolError(`${detail} ${HASHLINE_EDIT_INPUT_GUIDANCE}`);
	}
}
