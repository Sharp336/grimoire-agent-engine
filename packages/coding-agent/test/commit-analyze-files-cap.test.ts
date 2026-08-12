import { afterEach, describe, expect, it, vi } from "bun:test";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { runCommitAgentSession } from "@oh-my-pi/pi-coding-agent/commit/agentic/agent";
import * as toolsModule from "@oh-my-pi/pi-coding-agent/commit/agentic/tools";
import { createAnalyzeFileTool } from "@oh-my-pi/pi-coding-agent/commit/agentic/tools/analyze-file";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { CreateAgentSessionResult } from "@oh-my-pi/pi-coding-agent/sdk";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import { TaskTool } from "@oh-my-pi/pi-coding-agent/task";

describe("commit.analyzeFiles settings (issue #7833)", () => {
	it("defaults analyzeFiles to true and maxFiles to undefined", () => {
		const settings = Settings.isolated();
		expect(settings.get("commit.analyzeFiles")).toBe(true);
		expect(settings.get("commit.analyzeFilesMaxFiles")).toBeUndefined();
	});

	it("honors explicit overrides", () => {
		const settings = Settings.isolated({
			"commit.analyzeFiles": false,
			"commit.analyzeFilesMaxFiles": 5,
		});
		expect(settings.get("commit.analyzeFiles")).toBe(false);
		expect(settings.get("commit.analyzeFilesMaxFiles")).toBe(5);
	});
});

describe("commit agent analyze-files wiring (issue #7833)", () => {
	afterEach(() => vi.restoreAllMocks());

	it("reads enableAnalyzeFiles and maxAnalyzeFiles from settings", async () => {
		let received: toolsModule.CommitToolOptions | undefined;
		vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue({
			session: {
				prompt: async () => {},
				subscribe: () => () => {},
				dispose: async () => {},
			},
		} as unknown as CreateAgentSessionResult);
		vi.spyOn(toolsModule, "createCommitTools").mockImplementation(options => {
			received = options;
			return [];
		});
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");

		await runCommitAgentSession({
			cwd: "/tmp",
			model,
			settings: Settings.isolated({ "commit.analyzeFiles": false, "commit.analyzeFilesMaxFiles": 3 }),
			modelRegistry: {} as never,
			authStorage: {} as never,
			changelogTargets: [],
			requireChangelog: false,
		});

		expect(received?.enableAnalyzeFiles).toBe(false);
		expect(received?.maxAnalyzeFiles).toBe(3);
	});
});

describe("analyze_files cap behavior (issue #7833)", () => {
	afterEach(() => vi.restoreAllMocks());

	function makeContext() {
		return {
			sessionManager: { getSessionFile: () => null },
			modelRegistry: {},
			model: undefined,
			isIdle: () => true,
			hasQueuedMessages: () => false,
			abort: () => {},
		} as never;
	}

	function mockTaskTool() {
		const execute = vi.fn().mockResolvedValue({
			content: [{ type: "text", text: "ok" }],
			details: { results: [], totalDurationMs: 0 },
		});
		vi.spyOn(TaskTool, "create").mockResolvedValue({ execute } as never);
		return execute;
	}

	async function makeTool(maxFiles?: number) {
		return createAnalyzeFileTool({
			cwd: "/tmp",
			authStorage: {} as never,
			modelRegistry: {} as never,
			settings: Settings.isolated(),
			spawns: "sonic",
			state: {},
			maxFiles,
		});
	}

	it("analyzes at most maxFiles files and reports skipped ones", async () => {
		const execute = mockTaskTool();
		const tool = await makeTool(5);
		const files = ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts", "f.ts"];

		const result = await tool.execute("tc1", { files }, () => {}, makeContext(), new AbortController().signal);

		expect(execute).toHaveBeenCalledTimes(5);
		const text = result.content.find(p => p.type === "text")?.text ?? "";
		expect(text).toContain("warning: analyze_files capped at 5 files");
		expect(text).toContain("skipped: f.ts");
	});

	it("does not cap when maxFiles is unset", async () => {
		const execute = mockTaskTool();
		const tool = await makeTool(undefined);
		const files = ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts", "f.ts"];

		const result = await tool.execute("tc1", { files }, () => {}, makeContext(), new AbortController().signal);

		expect(execute).toHaveBeenCalledTimes(6);
		const text = result.content.find(p => p.type === "text")?.text ?? "";
		expect(text).not.toContain("capped");
	});

	it("analyzes nothing and reports all files when maxFiles is 0", async () => {
		const execute = mockTaskTool();
		const tool = await makeTool(0);
		const files = ["a.ts", "b.ts"];

		const result = await tool.execute("tc1", { files }, () => {}, makeContext(), new AbortController().signal);

		expect(execute).toHaveBeenCalledTimes(0);
		const text = result.content.find(p => p.type === "text")?.text ?? "";
		expect(text).toContain("skipped: a.ts, b.ts");
	});

	it("treats a negative maxFiles as zero instead of slicing from the tail", async () => {
		const execute = mockTaskTool();
		const tool = await makeTool(-3);
		const files = ["a.ts", "b.ts", "c.ts"];

		const result = await tool.execute("tc1", { files }, () => {}, makeContext(), new AbortController().signal);

		expect(execute).toHaveBeenCalledTimes(0);
		const text = result.content.find(p => p.type === "text")?.text ?? "";
		expect(text).toContain("skipped: a.ts, b.ts, c.ts");
	});
});
