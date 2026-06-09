import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { stripVTControlCharacters } from "node:util";
import type { AgentEvent } from "@oh-my-pi/pi-agent-core";
import { resetSettingsForTest, Settings } from "../../src/config/settings";
import { TranscriptRenderer } from "../../src/modes/controllers/transcript-renderer";
import { initTheme } from "../../src/modes/theme/theme";
import { HybridSource, ReplaySource } from "../../src/modes/transcript-source";
import { TASK_SUBAGENT_EVENT_CHANNEL } from "../../src/task";
import { EventBus } from "../../src/utils/event-bus";

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

describe("HybridSource", () => {
	it("delivers in-flight live messages to the renderer and filters other agents", async () => {
		const tempFilePath = path.join(os.tmpdir(), `transcript-hybrid-${Date.now()}.jsonl`);
		// One completed assistant message already flushed to disk (the backlog).
		const backlog = `${JSON.stringify({
			type: "message",
			id: "e1",
			parentId: null,
			timestamp: new Date().toISOString(),
			message: {
				role: "assistant",
				model: "test-model",
				content: [{ type: "text", text: "Completed turn." }],
			},
		})}\n`;

		try {
			await Bun.write(tempFilePath, backlog);

			const bus = new EventBus();
			const agentId = "Worker";
			const source = new HybridSource(tempFilePath, bus, agentId);

			expect(source.backlog().some(e => e.type === "message_start")).toBe(true);

			const received: AgentEvent[] = [];
			const unsub = source.subscribe(e => received.push(e));

			// In-flight assistant message that started AFTER attach (not yet on disk): its
			// events MUST reach the renderer, not be dropped as a positional "backlog" dup.
			const inflight = {
				role: "assistant",
				model: "test-model",
				content: [{ type: "text", text: "Live in-flight text." }],
			};
			bus.emit(TASK_SUBAGENT_EVENT_CHANNEL, {
				id: agentId,
				index: 0,
				agent: "task",
				agentSource: "bundled",
				task: "t",
				event: { type: "message_start", message: inflight },
			});
			bus.emit(TASK_SUBAGENT_EVENT_CHANNEL, {
				id: agentId,
				index: 0,
				agent: "task",
				agentSource: "bundled",
				task: "t",
				event: { type: "message_end", message: inflight },
			});

			// An event for a different agent must be filtered out by the id filter.
			bus.emit(TASK_SUBAGENT_EVENT_CHANNEL, {
				id: "OtherAgent",
				index: 0,
				agent: "task",
				agentSource: "bundled",
				task: "t",
				event: {
					type: "message_start",
					message: { role: "assistant", model: "test-model", content: [{ type: "text", text: "noise" }] },
				},
			});

			unsub();

			const texts: string[] = [];
			for (const e of received) {
				if ((e.type === "message_start" || e.type === "message_end") && e.message.role === "assistant") {
					for (const block of e.message.content) {
						if (block.type === "text") texts.push(block.text);
					}
				}
			}
			expect(texts).toContain("Live in-flight text.");
			expect(texts).not.toContain("noise");
		} finally {
			try {
				fs.unlinkSync(tempFilePath);
			} catch {
				// Ignore
			}
		}
	});
});

describe("TranscriptRenderer orphan recovery", () => {
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

	it("renders an in-flight assistant turn whose message_start was missed (mid-attach)", () => {
		const renderer = new TranscriptRenderer({
			getSmoothStreaming: () => false,
			getHideThinkingBlock: () => false,
			getToolResultPreview: () => true,
			getToolOutputExpanded: () => true,
			getShowImages: () => false,
			requestRender: () => {},
		});
		// Simulate attaching to a running subagent AFTER its message_start: only the
		// later update/end events arrive. The renderer must synthesize the component
		// so the in-flight turn renders instead of being silently dropped.
		const message = {
			role: "assistant",
			model: "test-model",
			content: [{ type: "text", text: "Mid-flight reasoning." }],
		};
		renderer.feed({ type: "message_update", message } as unknown as AgentEvent);
		renderer.feed({ type: "message_end", message } as unknown as AgentEvent);

		expect(renderer.getContainer().children.length).toBeGreaterThan(0);
		const text = stripVTControlCharacters(renderer.getContainer().render(100).join("\n"));
		expect(text).toContain("Mid-flight reasoning.");
	});
});
