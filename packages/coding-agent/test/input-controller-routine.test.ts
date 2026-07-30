import { describe, expect, it, vi } from "bun:test";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import type { RoutineProgress } from "@oh-my-pi/pi-coding-agent/extensibility/routines";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { UiHelpers } from "@oh-my-pi/pi-coding-agent/modes/utils/ui-helpers";

function makeCtx() {
	let text = "";
	const addToHistory = vi.fn();
	const setText = vi.fn((next: string) => {
		text = next;
	});
	const runRoutineInvocation = vi.fn(
		async (_text: string, _options: { onProgress?: (progress: RoutineProgress) => void | Promise<void> } = {}) =>
			true,
	);
	const prompt = vi.fn(
		async (_text: string, _options?: { streamingBehavior?: "steer" | "followUp"; images?: ImageContent[] }) => true,
	);
	const updatePendingMessagesDisplay = vi.fn();
	const requestRender = vi.fn();
	const showStatus = vi.fn();
	const showError = vi.fn();
	const editor = {
		onSubmit: undefined as undefined | ((input: string) => Promise<void>),
		getText: () => text,
		getExpandedText: () => text,
		setText,
		addToHistory,
		imageLinks: undefined as (string | undefined)[] | undefined,
		pendingImages: [] as ImageContent[],
		pendingImageLinks: [] as (string | undefined)[],
		clearDraft(historyText?: string) {
			if (historyText !== undefined) addToHistory(historyText);
			text = "";
			this.imageLinks = undefined;
			this.pendingImages = [];
			this.pendingImageLinks = [];
		},
	};
	const ctx = {
		editor,
		focusedAgentId: undefined,
		collabGuest: undefined,
		skillCommands: new Map(),
		session: {
			isStreaming: false,
			isCompacting: false,
			isBashRunning: false,
			isEvalRunning: false,
			queuedMessageCount: 0,
			extensionRunner: undefined,
			runRoutineInvocation,
			customCommands: [],
			prompt,
		},
		get viewSession() {
			return (this as typeof ctx).session;
		},
		showStatus,
		showError,
		updatePendingMessagesDisplay,
		ui: { requestRender },
		isBashMode: false,
		isPythonMode: false,
		loopModeEnabled: false,
		goalModeEnabled: false,
		compactionQueuedMessages: [],
		fileSlashCommands: new Set<string>(),
		routineSlashCommands: new Set<string>(["review-all"]),
		locallySubmittedUserSignatures: new Set<string>(),
		withLocalSubmission: async (_text: string, fn: () => unknown) => fn(),
	} as unknown as InteractiveModeContext;
	const helpers = new UiHelpers(ctx);
	ctx.queueCompactionMessage = helpers.queueCompactionMessage.bind(helpers);
	ctx.isKnownSlashCommand = helpers.isKnownSlashCommand.bind(helpers);
	return {
		ctx,
		editor,
		addToHistory,
		setText,
		runRoutineInvocation,
		prompt,
		updatePendingMessagesDisplay,
		requestRender,
		showStatus,
		showError,
	};
}

describe("InputController routine dispatch", () => {
	it("submits routine invocations through the routine runner instead of raw prompt", async () => {
		const { ctx, editor, addToHistory, runRoutineInvocation, prompt, updatePendingMessagesDisplay, requestRender } =
			makeCtx();
		const image: ImageContent = { type: "image", mimeType: "image/png", data: "c3VjY2Vzcw==" };
		editor.imageLinks = ["local://routine-success.png"];
		editor.pendingImages = [image];
		editor.pendingImageLinks = ["local://routine-success.png"];
		const controller = new InputController(ctx);
		controller.setupEditorSubmitHandler();

		await editor.onSubmit?.("/review-all src/foo.ts");

		expect(runRoutineInvocation).toHaveBeenCalledWith("/review-all src/foo.ts", { onProgress: expect.any(Function) });
		expect(prompt).not.toHaveBeenCalled();
		expect(addToHistory).toHaveBeenCalledWith("/review-all src/foo.ts");
		expect(editor.getText()).toBe("");
		expect(editor.imageLinks).toBeUndefined();
		expect(editor.pendingImages).toEqual([]);
		expect(editor.pendingImageLinks).toEqual([]);
		expect(updatePendingMessagesDisplay).toHaveBeenCalled();
		expect(requestRender).toHaveBeenCalled();
		const sessionState = ctx.session as unknown as { isStreaming: boolean };
		sessionState.isStreaming = true;
		await editor.onSubmit?.("next prompt");
		expect(prompt).toHaveBeenCalledWith("next prompt", { streamingBehavior: "steer", images: undefined });
	});

	it("consumes pending images when routine execution fails", async () => {
		const { ctx, editor, runRoutineInvocation, prompt, showError } = makeCtx();
		const controller = new InputController(ctx);
		controller.setupEditorSubmitHandler();
		const image: ImageContent = { type: "image", mimeType: "image/png", data: "ZmFpbHVyZQ==" };
		editor.imageLinks = ["local://routine-error.png"];
		editor.pendingImages = [image];
		editor.pendingImageLinks = ["local://routine-error.png"];
		runRoutineInvocation.mockRejectedValueOnce(new Error("routine execution failed"));

		await editor.onSubmit?.("/review-all src/foo.ts");

		expect(showError).toHaveBeenCalledWith("routine execution failed");
		expect(editor.getText()).toBe("");
		expect(editor.imageLinks).toBeUndefined();
		expect(editor.pendingImages).toEqual([]);
		expect(editor.pendingImageLinks).toEqual([]);

		const sessionState = ctx.session as unknown as { isStreaming: boolean };
		sessionState.isStreaming = true;
		await editor.onSubmit?.("next prompt");
		expect(prompt).toHaveBeenCalledWith("next prompt", { streamingBehavior: "steer", images: undefined });
	});

	it("queues routine submissions until compaction hands off", async () => {
		const { ctx, editor, runRoutineInvocation, prompt } = makeCtx();
		const controller = new InputController(ctx);
		controller.setupEditorSubmitHandler();
		const image: ImageContent = { type: "image", mimeType: "image/png", data: "aW1hZ2U=" };
		const sessionState = ctx.session as unknown as { isCompacting: boolean };
		sessionState.isCompacting = true;
		editor.pendingImages = [image];
		prompt.mockImplementationOnce(async submittedText => {
			await runRoutineInvocation(submittedText, { onProgress: () => {} });
			return true;
		});

		await editor.onSubmit?.("/review-all src/foo.ts");

		expect(runRoutineInvocation).not.toHaveBeenCalled();
		expect(ctx.compactionQueuedMessages).toEqual([
			{ text: "/review-all src/foo.ts", mode: "steer", images: [image] },
		]);

		sessionState.isCompacting = false;
		await new UiHelpers(ctx).flushCompactionQueue();

		expect(prompt).toHaveBeenCalledTimes(1);
		expect(prompt).toHaveBeenCalledWith("/review-all src/foo.ts");
		expect(runRoutineInvocation).toHaveBeenCalledTimes(1);
		expect(runRoutineInvocation).toHaveBeenCalledWith("/review-all src/foo.ts", {
			onProgress: expect.any(Function),
		});
	});

	it("delegates follow-up routine invocations before raw follow-up prompt", async () => {
		const { ctx, editor, addToHistory, runRoutineInvocation, prompt } = makeCtx();
		const controller = new InputController(ctx);
		editor.setText("/review-all src/foo.ts");

		await controller.handleFollowUp();

		expect(runRoutineInvocation).toHaveBeenCalledWith("/review-all src/foo.ts", { onProgress: expect.any(Function) });
		expect(prompt).not.toHaveBeenCalled();
		expect(addToHistory).toHaveBeenCalledWith("/review-all src/foo.ts");
		expect(editor.getText()).toBe("");
	});

	it("recognizes colon-form routine invocations as known slash commands", () => {
		const ctx = {
			session: {
				extensionRunner: undefined,
				customCommands: [],
			},
			fileSlashCommands: new Set<string>(),
			routineSlashCommands: new Set<string>(["review-all"]),
		} as unknown as InteractiveModeContext;
		const helpers = new UiHelpers(ctx);

		expect(helpers.isKnownSlashCommand("/review-all:src/foo.ts")).toBe(true);
		expect(helpers.isKnownSlashCommand("/other:src/foo.ts")).toBe(false);
	});
});
