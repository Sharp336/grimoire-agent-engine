import { describe, expect, it } from "bun:test";
import type { TUI } from "@oh-my-pi/pi-tui";
import { ChatTranscriptBuilder } from "../../../src/modes/components/chat-transcript-builder";
import { TranscriptContainer } from "../../../src/modes/components/transcript-container";
import type { InteractiveModeContext } from "../../../src/modes/types";
import { UiHelpers } from "../../../src/modes/utils/ui-helpers";
import {
	type AsyncProgressDetails,
	type AsyncProgressEntry,
	buildAsyncProgressBatchMessage,
} from "../../../src/session/async-job-delivery";
import type { CustomMessage } from "../../../src/session/messages";
import type { SessionMessageEntry } from "../../../src/session/session-entries";

const RAW_PROGRESS = "stdout\tvalue\nError:\tfailed";

function progressMessage(): CustomMessage<AsyncProgressDetails> {
	const entry: AsyncProgressEntry = {
		jobId: "build",
		text: RAW_PROGRESS,
		job: undefined,
		seq: 1,
		elapsedMs: 1_000,
		epoch: 0,
		delivery: "ambient",
	};
	const message = buildAsyncProgressBatchMessage([entry]);
	if (!message) throw new Error("Expected async progress message");
	return message;
}

describe("async progress transcript tab sanitization", () => {
	it("replaces tabs at the live transcript display boundary without changing the model payload", () => {
		const message = progressMessage();
		const chatContainer = new TranscriptContainer();
		const ctx = {
			chatContainer,
			toolOutputExpanded: false,
			viewSession: { extensionRunner: undefined },
		} as unknown as InteractiveModeContext;

		new UiHelpers(ctx).addMessageToChat(message);
		const rendered = Bun.stripANSI(chatContainer.render(160).join("\n"));

		expect(rendered).not.toContain("\t");
		expect(rendered).toContain("stdout   value");
		expect(rendered).toContain("Error:   failed");
		expect(message.content).toContain(RAW_PROGRESS);
		expect(message.details?.jobs[0]?.text).toBe(RAW_PROGRESS);
	});

	it("replaces tabs when rebuilding a persisted transcript without changing the stored message", () => {
		const message = progressMessage();
		const builder = new ChatTranscriptBuilder({
			ui: {} as TUI,
			cwd: "/workspace",
			requestRender: () => {},
		});
		const entry: SessionMessageEntry = {
			type: "message",
			id: "entry-1",
			parentId: null,
			timestamp: "2026-08-22T00:00:00.000Z",
			message,
		};

		builder.rebuild([entry]);
		const rendered = Bun.stripANSI(builder.container.render(160).join("\n"));

		expect(rendered).not.toContain("\t");
		expect(rendered).toContain("stdout   value");
		expect(rendered).toContain("Error:   failed");
		expect(entry.message).toBe(message);
		expect(message.content).toContain(RAW_PROGRESS);
		expect(message.details?.jobs[0]?.text).toBe(RAW_PROGRESS);
	});
});
