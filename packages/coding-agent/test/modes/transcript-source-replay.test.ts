import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { resetSettingsForTest, Settings } from "../../src/config/settings";
import { TranscriptRenderer } from "../../src/modes/controllers/transcript-renderer";
import { initTheme } from "../../src/modes/theme/theme";
import { ReplaySource } from "../../src/modes/transcript-source";

describe("ReplaySource", () => {
	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true, cwd: process.cwd() });
	});

	afterEach(() => {
		resetSettingsForTest();
	});

	it("should synthesize agent events from assistant message and tool results", async () => {
		const tempFilePath = path.join(os.tmpdir(), `transcript-source-replay-test-${Date.now()}.jsonl`);

		const fixture = `${[
			JSON.stringify({
				type: "message",
				id: "msg1",
				parentId: null,
				timestamp: new Date().toISOString(),
				message: {
					role: "assistant",
					model: "test-model",
					content: [
						{ type: "text", text: "Here is some text" },
						{
							type: "toolCall",
							id: "tc1",
							name: "read",
							arguments: { path: "foo.txt" },
						},
					],
				},
			}),
			JSON.stringify({
				type: "message",
				id: "msg2",
				parentId: "msg1",
				timestamp: new Date().toISOString(),
				message: {
					role: "toolResult",
					toolCallId: "tc1",
					toolName: "read",
					content: [{ type: "text", text: "my file contents" }],
					isError: false,
				},
			}),
		].join("\n")}\n`;

		try {
			await Bun.write(tempFilePath, fixture);

			const source = new ReplaySource(tempFilePath);
			const events = source.backlog();

			expect(events.length).toBe(4);

			// Assert types in order
			expect(events[0].type).toBe("message_start");
			expect(events[1].type).toBe("message_update");
			expect(events[2].type).toBe("message_end");
			expect(events[3].type).toBe("tool_execution_end");

			// Assert details of the tool_execution_end event
			const toolEnd = events[3];
			if (toolEnd.type === "tool_execution_end") {
				expect(toolEnd.toolCallId).toBe("tc1");
				expect(toolEnd.toolName).toBe("read");
				expect(toolEnd.isError).toBe(false);
				expect(toolEnd.result).toBeDefined();
				expect(toolEnd.result.content).toBeDefined();
				expect(toolEnd.result.content[0].type).toBe("text");
				expect(toolEnd.result.content[0].text).toBe("my file contents");
			} else {
				throw new Error("Expected fourth event to be tool_execution_end");
			}
		} finally {
			try {
				fs.unlinkSync(tempFilePath);
			} catch {
				// Ignore
			}
		}
	});

	it("renders replayed events through the TranscriptRenderer into visible lines", async () => {
		const tempFilePath = path.join(os.tmpdir(), `transcript-replay-render-${Date.now()}.jsonl`);
		const fixture = `${[
			JSON.stringify({
				type: "message",
				id: "m1",
				parentId: null,
				timestamp: new Date().toISOString(),
				message: {
					role: "assistant",
					model: "test-model",
					content: [
						{ type: "text", text: "Checking the token path." },
						{ type: "toolCall", id: "tc1", name: "read", arguments: { path: "src/auth.ts" } },
					],
				},
			}),
			JSON.stringify({
				type: "message",
				id: "m2",
				parentId: "m1",
				timestamp: new Date().toISOString(),
				message: {
					role: "toolResult",
					toolCallId: "tc1",
					toolName: "read",
					content: [{ type: "text", text: "import { verify } from 'jsonwebtoken'" }],
					isError: false,
				},
			}),
		].join("\n")}\n`;

		try {
			await Bun.write(tempFilePath, fixture);
			const renderer = new TranscriptRenderer({
				getSmoothStreaming: () => false,
				getHideThinkingBlock: () => false,
				getToolResultPreview: () => true,
				getToolOutputExpanded: () => true,
				getShowImages: () => false,
				requestRender: () => {},
			});
			renderer.seed(new ReplaySource(tempFilePath).backlog());

			expect(renderer.getContainer().children.length).toBeGreaterThan(0);
			const text = stripVTControlCharacters(renderer.getContainer().render(100).join("\n"));
			expect(text).toContain("Checking the token path.");
			expect(text.toLowerCase()).toContain("auth.ts");
		} finally {
			try {
				fs.unlinkSync(tempFilePath);
			} catch {
				// Ignore
			}
		}
	});
});
