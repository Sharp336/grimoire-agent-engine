import { describe, expect, it, mock } from "bun:test";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";

function makeCtx(state: { isStreaming?: boolean; isCompacting?: boolean } = {}) {
	const prompt = mock(async (_message: string, _options?: { streamingBehavior?: "steer" | "followUp" }) => true);
	const queueCompactionMessage = mock((_text: string, _mode: "steer" | "followUp", _images?: unknown) => {});
	const showStatus = mock((_message: string, _options?: { dim?: boolean }) => {});
	const setText = mock(() => {});
	const addToHistory = mock(() => {});
	const requestRender = mock(() => {});
	const ctx = {
		session: {
			isStreaming: state.isStreaming ?? false,
			isCompacting: state.isCompacting ?? false,
			prompt,
		},
		editor: { setText, addToHistory, imageLinks: undefined as (string | undefined)[] | undefined },
		pendingImages: [],
		pendingImageLinks: [],
		withLocalSubmission: async <T>(_text: string, fn: () => Promise<T>) => fn(),
		updatePendingMessagesDisplay: mock(() => {}),
		ui: { requestRender },
		showStatus,
		queueCompactionMessage,
		collabGuest: undefined,
	} as unknown as InteractiveModeContext;
	return { ctx, prompt, queueCompactionMessage, showStatus, setText };
}

describe("/steer and /followup slash commands", () => {
	it("steers while streaming and fully consumes the line", async () => {
		const { ctx, prompt } = makeCtx({ isStreaming: true });
		const result = await executeBuiltinSlashCommand("/steer fix the bug", { ctx });
		expect(result).toBe(true);
		expect(prompt.mock.calls.length).toBe(1);
		const [msg, opts] = prompt.mock.calls[0];
		expect(msg).toBe("fix the bug");
		expect(opts?.streamingBehavior).toBe("steer");
	});

	it("queues a follow-up while streaming", async () => {
		const { ctx, prompt } = makeCtx({ isStreaming: true });
		await executeBuiltinSlashCommand("/followup do x", { ctx });
		expect(prompt.mock.calls.length).toBe(1);
		const [msg, opts] = prompt.mock.calls[0];
		expect(msg).toBe("do x");
		expect(opts?.streamingBehavior).toBe("followUp");
	});

	it("resolves the follow-up alias to followUp behavior", async () => {
		const { ctx, prompt } = makeCtx({ isStreaming: true });
		await executeBuiltinSlashCommand("/follow-up do x", { ctx });
		expect(prompt.mock.calls.length).toBe(1);
		const [, opts] = prompt.mock.calls[0];
		expect(opts?.streamingBehavior).toBe("followUp");
	});

	it("rejects /steer with a notice when the agent is idle", async () => {
		const { ctx, prompt, showStatus } = makeCtx({ isStreaming: false, isCompacting: false });
		const result = await executeBuiltinSlashCommand("/steer hello", { ctx });
		expect(result).toBe(true);
		expect(prompt.mock.calls.length).toBe(0);
		expect(showStatus.mock.calls[0]?.[0]).toMatch(/Nothing to steer/);
	});

	it("queues into the compaction queue while compacting", async () => {
		const { ctx, prompt, queueCompactionMessage } = makeCtx({ isCompacting: true });
		await executeBuiltinSlashCommand("/steer x", { ctx });
		expect(prompt.mock.calls.length).toBe(0);
		expect(queueCompactionMessage.mock.calls[0]).toEqual(["x", "steer", undefined]);
	});

	it("shows usage and does not prompt when /steer has no message", async () => {
		const { ctx, prompt, showStatus } = makeCtx({ isStreaming: true });
		await executeBuiltinSlashCommand("/steer", { ctx });
		expect(prompt.mock.calls.length).toBe(0);
		expect(showStatus.mock.calls[0]?.[0]).toMatch(/Usage/);
	});
});
