import * as path from "node:path";
import type { ContextFileEntry } from "../tools";

export function isAgentsContextFile(file: Pick<ContextFileEntry, "path" | "kind">): boolean {
	return file.kind === "agents-md" || path.basename(file.path).toLowerCase() === "agents.md";
}
