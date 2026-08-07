import * as path from "node:path";
import type { ImageContent, TextContent } from "@oh-my-pi/pi-ai";
import { logger, prompt } from "@oh-my-pi/pi-utils";
import { Settings } from "../config/settings";
import type {
	ExtensionContext,
	ExtensionFactory,
	ToolResultEvent,
	ToolResultEventResult,
} from "../extensibility/extensions";
import selfHealPrompt from "../prompts/comment-checker-self-heal.md" with { type: "text" };
import { replaceTabs, shortenPath } from "../tools/render-utils";
import { type CommentCheckerRunResult, resolveCommentCheckerBinary, runCommentChecker } from "./cli";
import {
	type CommentCheckerHookInput,
	extractCommentCheckRequests,
	type ToolResultContent,
	type ToolResultLike,
	toHookInput,
} from "./core";
import {
	COMMENT_CHECKER_WIDGET_KEY,
	type CommentCheckerUiState,
	formatFooterStatus,
	formatPreview,
	syncCommentCheckerWidget,
} from "./ui";

export const OMP_WARNING_ENTRY_TYPE = "omp-comment-checker:warning";

type WarningRecord = {
	id: string;
	filePath: string;
	message: string;
	sourceToolName: string;
	ts: number;
	fired: boolean;
};

type WarningEntryData = {
	filePath: string;
	message: string;
	sourceToolName: string;
	ts: number;
	fired: boolean;
};

class SelfHealStore {
	#records = new Map<string, WarningRecord>();

	clear(): void {
		this.#records.clear();
	}

	clearFiles(filePaths: string[]): void {
		const filesSet = new Set(filePaths.map(filePath => path.resolve(filePath)));
		for (const [id, record] of this.#records) {
			if (filesSet.has(path.resolve(record.filePath))) {
				this.#records.delete(id);
			}
		}
	}

	record(warning: { filePath: string; message: string; sourceToolName: string }): WarningRecord {
		const filePath = path.resolve(warning.filePath);
		const id = `${filePath}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
		const record: WarningRecord = {
			id,
			filePath,
			message: warning.message,
			sourceToolName: warning.sourceToolName,
			ts: Date.now(),
			fired: false,
		};
		this.#records.set(id, record);
		return record;
	}

	rehydrate(entries: WarningEntryData[]): void {
		for (const entry of entries) {
			const filePath = path.resolve(entry.filePath);
			const id = `${filePath}:${entry.ts ?? Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
			this.#records.set(id, {
				id,
				filePath,
				message: entry.message,
				sourceToolName: entry.sourceToolName,
				ts: entry.ts ?? Date.now(),
				fired: entry.fired,
			});
		}
	}

	unfired(): WarningRecord[] {
		return [...this.#records.values()].filter(record => !record.fired);
	}

	markFired(ids: string[]): void {
		for (const id of ids) {
			const record = this.#records.get(id);
			if (record) record.fired = true;
		}
	}
}

function toToolResultLike(event: ToolResultEvent): ToolResultLike {
	return {
		toolName: event.toolName,
		input: event.input,
		content: event.content as ToolResultContent[] | undefined,
		isError: event.isError,
		details: event.details,
	};
}

function getSessionId(ctx: ExtensionContext): string {
	return ctx.sessionManager.getSessionId() ?? ctx.sessionManager.getHeader()?.id ?? "unknown";
}

export type CommentCheckerHandlerDeps = {
	run?: (input: CommentCheckerHookInput) => Promise<CommentCheckerRunResult>;
	onWarning?: (warning: { filePath: string; message: string; sourceToolName: string }) => void;
	onClearWarnings?: (filePaths: string[]) => void;
};

function syncUi(ctx: ExtensionContext, state: CommentCheckerUiState): void {
	syncCommentCheckerWidget(ctx.ui.setWidget, state);
	ctx.ui.setStatus(COMMENT_CHECKER_WIDGET_KEY, formatFooterStatus(state));
}

export function createCommentCheckerToolResultHandler(deps: CommentCheckerHandlerDeps) {
	return async (event: ToolResultEvent, ctx: ExtensionContext): Promise<ToolResultEventResult | undefined> => {
		const requests = extractCommentCheckRequests(toToolResultLike(event));
		if (requests.length === 0) return undefined;

		const checkedFiles: string[] = [];
		const warnings: Array<{ filePath: string; message: string; sourceToolName: string }> = [];
		const runner = deps.run ?? ((input: CommentCheckerHookInput) => runCommentChecker(input));

		for (const request of requests) {
			const normalizedPath = path.resolve(ctx.cwd, request.filePath);
			checkedFiles.push(normalizedPath);
			if (request.isDelete) {
				continue;
			}
			const input = toHookInput(request, { sessionId: getSessionId(ctx), cwd: ctx.cwd });
			const result = await runner(input);
			if (result.status === "missing") {
				syncUi(ctx, { status: "missing", checkedFiles, warnings });
				return undefined;
			}
			if (result.status === "error") {
				syncUi(ctx, {
					status: "error",
					checkedFiles,
					warnings,
					errorMessage: result.message,
				});
				ctx.ui.notify(`omp-comment-checker error: ${formatPreview(result.message)}`, "error");
				return undefined;
			}
			if (result.status === "warning" && result.message.trim().length > 0) {
				warnings.push({
					filePath: normalizedPath,
					message: result.message.trim(),
					sourceToolName: request.sourceToolName,
				});
			}
		}

		if (checkedFiles.length > 0) {
			deps.onClearWarnings?.(checkedFiles);
		}

		for (const warning of warnings) {
			deps.onWarning?.(warning);
		}

		if (warnings.length === 0) {
			syncUi(ctx, { status: "clean", checkedFiles, warnings });
			return undefined;
		}

		syncUi(ctx, { status: "warning", checkedFiles, warnings });
		const appended: (TextContent | ImageContent)[] = [
			...(event.content ?? []),
			...warnings.map(warning => ({ type: "text" as const, text: `\n\n${warning.message}` })),
		];
		return {
			content: appended,
			isError: event.isError,
		};
	};
}

export const createCommentCheckerExtension: ExtensionFactory = api => {
	const store = new SelfHealStore();
	let state: CommentCheckerUiState = { status: "idle", checkedFiles: [], warnings: [] };
	let cachedBinaryPath: string | undefined | null = null; // null = not yet resolved

	const setState = (ctx: ExtensionContext, nextState: CommentCheckerUiState): void => {
		state = nextState;
		syncUi(ctx, state);
	};

	const getCachedBinary = (): string | undefined => {
		if (cachedBinaryPath === null) {
			cachedBinaryPath = resolveCommentCheckerBinary();
		}
		return cachedBinaryPath;
	};

	api.on("session_start", async (_event, ctx) => {
		store.clear();
		cachedBinaryPath = null;
		if (!Settings.instance.get("commentChecker.enabled")) {
			if (state.status !== "idle") {
				setState(ctx, { status: "idle", checkedFiles: [], warnings: [] });
			}
			return;
		}
		// Rehydrate warnings from persisted session entries
		const persistedWarnings: WarningEntryData[] = ctx.sessionManager
			.getEntries()
			.filter(
				(entry): entry is { type: "custom"; customType: string; data: WarningEntryData } =>
					entry.type === "custom" && entry.customType === OMP_WARNING_ENTRY_TYPE,
			)
			.map(entry => entry.data);
		if (persistedWarnings.length > 0) {
			store.rehydrate(persistedWarnings);
		}
		if (!getCachedBinary()) {
			setState(ctx, { status: "missing", checkedFiles: [], warnings: [] });
			logger.warn("omp-comment-checker enabled in settings, but binary is not accessible on host system.");
			return;
		}
		setState(ctx, { status: "idle", checkedFiles: [], warnings: [] });
	});

	api.on("tool_result", async (event, ctx) => {
		if (!Settings.instance.get("commentChecker.enabled")) {
			if (state.status !== "idle") {
				setState(ctx, { status: "idle", checkedFiles: [], warnings: [] });
			}
			return undefined;
		}
		if (!getCachedBinary()) {
			setState(ctx, { status: "missing", checkedFiles: [], warnings: [] });
			return undefined;
		}
		const handler = createCommentCheckerToolResultHandler({
			run: input => runCommentChecker(input, { customPrompt: Settings.instance.get("commentChecker.prompt") }),
			onWarning: warning => {
				store.record(warning);
				api.appendEntry(OMP_WARNING_ENTRY_TYPE, {
					filePath: warning.filePath,
					message: warning.message,
					sourceToolName: warning.sourceToolName,
					ts: Date.now(),
					fired: false,
				} satisfies WarningEntryData);
			},
			onClearWarnings: cleanFiles => {
				store.clearFiles(cleanFiles);
			},
		});
		return handler(event, ctx);
	});

	api.on("session_compact", async () => {
		if (!Settings.instance.get("commentChecker.enabled")) return;
		if (!getCachedBinary()) return;
		const unfired = store.unfired();
		if (unfired.length === 0) return;
		const summary = unfired
			.map(w => `• ${replaceTabs(shortenPath(w.filePath))}:\n${replaceTabs(w.message)}`)
			.join("\n\n");
		const content = prompt.render(selfHealPrompt, { count: unfired.length, summary });
		api.sendMessage(
			{
				customType: OMP_WARNING_ENTRY_TYPE,
				content,
				display: true,
			},
			{ triggerTurn: false },
		);
		store.markFired(unfired.map(w => w.id));
	});

	api.registerCommand("comment-checker", {
		description: "Show omp-comment-checker status and pending warnings.",
		handler: async (_args, ctx) => {
			if (!Settings.instance.get("commentChecker.enabled")) {
				ctx.ui.notify("omp-comment-checker is currently disabled in settings.", "info");
				return;
			}
			// Re-resolve for the command to handle late installations
			cachedBinaryPath = resolveCommentCheckerBinary();
			if (!cachedBinaryPath) {
				setState(ctx, { status: "missing", checkedFiles: [], warnings: [] });
				ctx.ui.notify("omp-comment-checker binary missing; install @code-yeongyu/comment-checker.", "warning");
				return;
			}
			const unfired = store.unfired();
			if (unfired.length === 0) {
				ctx.ui.notify("omp-comment-checker: no pending warnings.", "info");
				return;
			}
			const summary = unfired
				.map(w => {
					const displayPath = replaceTabs(shortenPath(w.filePath));
					const preview = formatPreview(w.message);
					return `${displayPath}: ${preview}`;
				})
				.join("\n");
			ctx.ui.notify(`${unfired.length} pending warning(s):\n${summary}`, "warning");
		},
	});
};
