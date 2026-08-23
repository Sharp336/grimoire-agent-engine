import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as os from "node:os";
import type { TUI } from "@oh-my-pi/pi-tui";
import { resetSettingsForTest, Settings } from "../../../src/config/settings";
import { ChatTranscriptBuilder } from "../../../src/modes/components/chat-transcript-builder";
import { TranscriptContainer } from "../../../src/modes/components/transcript-container";
import { initTheme } from "../../../src/modes/theme/theme";
import type { InteractiveModeContext } from "../../../src/modes/types";
import { UiHelpers } from "../../../src/modes/utils/ui-helpers";
import {
	type AsyncProgressDetails,
	type AsyncProgressEntry,
	buildAsyncProgressBatchMessage,
} from "../../../src/session/async-job-delivery";
import type { CustomMessage } from "../../../src/session/messages";
import type { SessionMessageEntry } from "../../../src/session/session-entries";

const HOME_PATH = `${os.homedir()}/projects/async-progress/build.log`;
const DISPLAY_PATH = "~/projects/async-progress/build.log";
const RAW_PROGRESS = `stdout\tvalue\nError:\tfailed at ${HOME_PATH}`;

beforeAll(async () => {
	await initTheme(false);
});

beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
});

afterEach(() => {
	resetSettingsForTest();
});

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

describe("async progress transcript display sanitization", () => {
	it("sanitizes tabs and home paths in the live transcript without changing the model payload", () => {
		const message = progressMessage();
		const modelContent = message.content;
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
		expect(rendered).not.toContain(HOME_PATH);
		expect(rendered).toContain(DISPLAY_PATH);
		expect(message.content).toContain(RAW_PROGRESS);
		expect(message.details?.jobs[0]?.text).toBe(RAW_PROGRESS);
		expect(message.content).toBe(modelContent);
	});

	it("sanitizes tabs and home paths in a rebuilt transcript without changing the stored message", () => {
		const message = progressMessage();
		const modelContent = message.content;
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
		expect(rendered).not.toContain(HOME_PATH);
		expect(rendered).toContain(DISPLAY_PATH);
		expect(entry.message).toBe(message);
		expect(message.content).toContain(RAW_PROGRESS);
		expect(message.details?.jobs[0]?.text).toBe(RAW_PROGRESS);
		expect(message.content).toBe(modelContent);
	});
});
