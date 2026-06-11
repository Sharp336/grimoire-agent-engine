import * as path from "node:path";
import { HASHLINE_EDIT_INPUT_GUIDANCE } from "../edit/hashline/guidance";
import type { ToolSession } from "../tools";

/** Error message when eval `write`/`append` targets project source while `edit` is available. */
export const EVAL_SOURCE_WRITE_BLOCKED_MESSAGE = `eval write() and append() cannot change project source files when the edit tool is available. ${HASHLINE_EDIT_INPUT_GUIDANCE}`;

export function sessionHasEditTool(session: ToolSession | undefined): boolean {
	if (!session) return false;
	if (session.hasEditTool === true) return true;
	if (session.hasEditTool === false) return false;
	return true;
}

export function shouldBlockEvalSourceWrites(session: ToolSession | undefined): boolean {
	return sessionHasEditTool(session);
}

const INTERNAL_URL_RE = /^([a-z][a-z0-9+.-]*):\/\/(.*)$/i;

/** Artifact/session `local://` (and other injected roots) stays writable in eval. */
export function isEvalArtifactWritePath(rawPath: string, localRoots: Record<string, string>): boolean {
	const match = INTERNAL_URL_RE.exec(rawPath.trim());
	if (!match) return false;
	const scheme = match[1].toLowerCase();
	return Object.hasOwn(localRoots, scheme);
}
/** Resolved artifact paths (after `local://` → disk) stay writable in eval. */
export function isEvalLocalRootFilesystemPath(rawPath: string, localRoots: Record<string, string>): boolean {
	const normalized = path.normalize(rawPath);
	for (const root of Object.values(localRoots)) {
		const normRoot = path.normalize(root);
		if (normalized === normRoot || normalized.startsWith(`${normRoot}${path.sep}`)) {
			return true;
		}
	}
	return false;
}
