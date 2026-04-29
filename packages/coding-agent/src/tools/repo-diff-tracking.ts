import type { AgentTool, AgentToolContext, AgentToolExecFn, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import { logger } from "@oh-my-pi/pi-utils";
import { expandApplyPatchToEntries } from "../edit/modes/apply-patch";
import { splitHashlineInputs } from "../hashline/input";
import { ensureSessionStartRepoDiffSnapshots } from "../session/repo-diff-snapshots";
import type { SessionManager } from "../session/session-manager";
import { isInternalUrlPath, resolveToCwd } from "./path-utils";

const kRepoDiffTrackingWrapped = Symbol("RepoDiffTracking.Wrapped");

const TOOLS_WITH_CWD_SIDE_EFFECTS = new Set(["bash", "eval", "recipe"]);
const PATH_FIELD_BY_TOOL = new Map<string, readonly string[]>([
	["ast_edit", ["paths"]],
	["edit", ["path"]],
	["lsp", ["file", "new_name"]],
	["notebook", ["notebook_path"]],
	["write", ["path"]],
]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function addEditInputPaths(candidates: Set<string>, cwd: string, args: Record<string, unknown>): void {
	const input = args.input;
	if (typeof input !== "string") return;

	// The edit tool has multiple wire formats that share an `input` field.
	// Try apply_patch first, then hashline; invalid input is ignored here
	// because the edit tool itself owns validation and user-facing errors.
	try {
		for (const entry of expandApplyPatchToEntries({ input })) {
			addResolvedPath(candidates, cwd, entry.path);
			addResolvedPath(candidates, cwd, entry.rename);
		}
		return;
	} catch {}

	try {
		const path = typeof args.path === "string" ? args.path : undefined;
		for (const section of splitHashlineInputs(input, { cwd, path })) {
			addResolvedPath(candidates, cwd, section.path);
		}
	} catch {}
}

function addResolvedPath(candidates: Set<string>, cwd: string, value: unknown): void {
	if (Array.isArray(value)) {
		for (const item of value) {
			addResolvedPath(candidates, cwd, item);
		}
		return;
	}
	if (typeof value !== "string") return;
	const candidate = value;
	if (!candidate || isInternalUrlPath(candidate)) return;
	try {
		candidates.add(resolveToCwd(candidate, cwd));
	} catch {
		// Non-filesystem tool targets are intentionally ignored; the tool itself owns validation.
	}
}

function shouldTrackLspCall(args: Record<string, unknown>): boolean {
	const action = args.action;
	if (action === "rename" || action === "rename_file") return true;
	if (action === "code_actions") return args.apply === true;
	return false;
}

function collectCandidateCwds(toolName: string, args: unknown, sessionCwd: string): string[] {
	const candidates = new Set<string>();
	if (TOOLS_WITH_CWD_SIDE_EFFECTS.has(toolName)) candidates.add(sessionCwd);
	if (!isRecord(args)) return [...candidates];

	if (toolName === "bash" && typeof args.cwd === "string") {
		candidates.clear();
		addResolvedPath(candidates, sessionCwd, args.cwd);
	}

	if (toolName === "lsp" && !shouldTrackLspCall(args)) return [...candidates];
	const fields = PATH_FIELD_BY_TOOL.get(toolName);
	if (toolName === "edit") {
		addEditInputPaths(candidates, sessionCwd, args);
	}
	if (!fields) return [...candidates];
	for (const field of fields) {
		addResolvedPath(candidates, sessionCwd, args[field]);
	}
	return [...candidates];
}

async function ensureRepoDiffSnapshotsForTool(
	toolName: string,
	args: unknown,
	context: AgentToolContext | undefined,
): Promise<void> {
	const sessionManager = context?.sessionManager as SessionManager | undefined;
	if (!sessionManager) return;
	const candidates = collectCandidateCwds(toolName, args, sessionManager.getCwd());
	if (candidates.length === 0) return;
	await ensureSessionStartRepoDiffSnapshots(sessionManager, candidates);
}

export function wrapToolWithRepoDiffTracking<T extends AgentTool<any, any, any>>(tool: T): T {
	if (kRepoDiffTrackingWrapped in tool) return tool;
	const originalExecute = tool.execute;
	return Object.defineProperties(tool, {
		[kRepoDiffTrackingWrapped]: {
			value: true,
			enumerable: false,
			configurable: true,
		},
		execute: {
			value: async function trackedExecute(
				this: AgentTool & { execute: AgentToolExecFn },
				toolCallId: string,
				params: unknown,
				signal?: AbortSignal,
				onUpdate?: AgentToolUpdateCallback,
				context?: AgentToolContext,
			) {
				try {
					await ensureRepoDiffSnapshotsForTool(tool.name, params, context);
				} catch (error) {
					logger.debug("Failed to create repository diff start snapshot for tool", {
						error: error instanceof Error ? error.message : String(error),
						toolName: tool.name,
					});
				}
				return originalExecute.call(this, toolCallId, params as never, signal, onUpdate, context);
			},
			enumerable: false,
			configurable: true,
			writable: true,
		},
	});
}
