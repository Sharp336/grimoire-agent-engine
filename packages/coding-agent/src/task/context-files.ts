import type { ToolSession } from "..";

export function inheritContextFilesForSubagent(
	contextFiles: ToolSession["contextFiles"],
): ToolSession["contextFiles"] {
	return contextFiles;
}
