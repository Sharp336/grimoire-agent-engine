import type { ImageContent, TextContent } from "@oh-my-pi/pi-ai";
import { Settings } from "../config/settings";
import type {
	ExtensionContext,
	ExtensionFactory,
	ToolResultEvent,
	ToolResultEventResult,
} from "../extensibility/extensions";
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

class SelfHealStore {
	#records = new Map<string, WarningRecord>();

	clear(): void {
		this.#records.clear();
	}

	record(warning: { filePath: string; message: string; sourceToolName: string }): WarningRecord {
		const id = `${warning.filePath}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
		const record: WarningRecord = {
			id,
			filePath: warning.filePath,
			message: warning.message,
			sourceToolName: warning.sourceToolName,
			ts: Date.now(),
			fired: false,
		};
		this.#records.set(id, record);
		return record;
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
};

export function createCommentCheckerToolResultHandler(deps: CommentCheckerHandlerDeps) {
	return async (event: ToolResultEvent, ctx: ExtensionContext): Promise<ToolResultEventResult | undefined> => {
		const requests = extractCommentCheckRequests(toToolResultLike(event));
		if (requests.length === 0) return undefined;

		const checkedFiles: string[] = [];
		const warnings: Array<{ filePath: string; message: string; sourceToolName: string }> = [];
		const runner = deps.run ?? ((input: CommentCheckerHookInput) => runCommentChecker(input));

		for (const request of requests) {
			const input = toHookInput(request, { sessionId: getSessionId(ctx), cwd: ctx.cwd });
			const result = await runner(input);
			if (result.status === "missing") {
				syncCommentCheckerWidget(ctx.ui.setWidget, { status: "missing", checkedFiles, warnings });
				return undefined;
			}
			if (result.status === "error") {
				syncCommentCheckerWidget(ctx.ui.setWidget, {
					status: "error",
					checkedFiles,
					warnings,
					errorMessage: result.message,
				});
				return undefined;
			}
			checkedFiles.push(request.filePath);
			if (result.status === "warning" && result.message.trim().length > 0) {
				warnings.push({
					filePath: request.filePath,
					message: result.message.trim(),
					sourceToolName: request.sourceToolName,
				});
			}
		}

		for (const warning of warnings) {
			deps.onWarning?.(warning);
		}

		if (warnings.length === 0) {
			syncCommentCheckerWidget(ctx.ui.setWidget, { status: "clean", checkedFiles, warnings });
			return undefined;
		}

		syncCommentCheckerWidget(ctx.ui.setWidget, { status: "warning", checkedFiles, warnings });
		const appended: (TextContent | ImageContent)[] = [
			...(event.content ?? []),
			...warnings.map(warning => ({ type: "text" as const, text: `\n\n${warning.message}` })),
		];
		return { content: appended };
	};
}

export const createCommentCheckerExtension: ExtensionFactory = api => {
	const store = new SelfHealStore();
	let state: CommentCheckerUiState = { status: "idle", checkedFiles: [], warnings: [] };

	const setState = (ctx: ExtensionContext, nextState: CommentCheckerUiState): void => {
		state = nextState;
		syncCommentCheckerWidget(ctx.ui.setWidget, state);
		ctx.ui.setStatus(COMMENT_CHECKER_WIDGET_KEY, formatFooterStatus(state));
	};

	api.on("session_start", async (_event, ctx) => {
		store.clear();
		if (!resolveCommentCheckerBinary()) {
			setState(ctx, { status: "missing", checkedFiles: [], warnings: [] });
			return;
		}
		setState(ctx, { status: "idle", checkedFiles: [], warnings: [] });
	});

	api.on("tool_result", async (event, ctx) => {
		const handler = createCommentCheckerToolResultHandler({
			run: input => runCommentChecker(input, { customPrompt: Settings.instance.get("commentChecker.prompt") }),
			onWarning: warning => {
				const record = store.record(warning);
				api.appendEntry(OMP_WARNING_ENTRY_TYPE, {
					filePath: record.filePath,
					message: record.message,
					sourceToolName: record.sourceToolName,
					ts: record.ts,
					id: record.id,
				});
			},
		});
		return handler(event, ctx);
	});

	api.on("session_compact", async () => {
		const unfired = store.unfired();
		if (unfired.length === 0) return;
		const summary = unfired.map(w => `• ${w.filePath}: ${w.message}`).join("\n");
		api.sendMessage(
			{
				customType: OMP_WARNING_ENTRY_TYPE,
				content: `omp-comment-checker self-heal: ${unfired.length} warning(s) still need addressing:\n${summary}`,
				display: true,
			},
			{ triggerTurn: false },
		);
		store.markFired(unfired.map(w => w.id));
	});

	api.registerCommand("comment-checker", {
		description: "Show omp-comment-checker status and pending warnings.",
		handler: async (_args, ctx) => {
			if (!resolveCommentCheckerBinary()) {
				setState(ctx, { status: "missing", checkedFiles: [], warnings: [] });
				ctx.ui.notify("omp-comment-checker binary missing; reinstall @code-yeongyu/comment-checker.", "warning");
				return;
			}
			const unfired = store.unfired();
			if (unfired.length === 0) {
				ctx.ui.notify("omp-comment-checker: no pending warnings.", "info");
				return;
			}
			const summary = unfired.map(w => `${w.filePath}: ${w.message}`).join("\n");
			ctx.ui.notify(`${unfired.length} pending warning(s):\n${summary}`, "warning");
		},
	});
};
