# #7833 commit analyze_files 上限实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 `omp commit` agentic 路径的 `analyze_files` 工具增加持久设置控制(开关 + 单次调用文件数上限),默认行为不变。

**Architecture:** 设置经 settings-schema 的 `commit.*` 组新增两键,`agent.ts:55` 把硬编码 `enableAnalyzeFiles: true` 换成 `settings.get("commit.analyzeFiles")` 并透传 `maxAnalyzeFiles`,最终在 `analyze-file.ts` 工具 `execute()` 内单点截断文件列表并在结果文本附加可见警告。

**Tech Stack:** bun, TypeScript, bun:test, settings-schema 模式(Settings.isolated + settings.get)

**规格:** `docs/superpowers/specs/2026-08-08-7833-commit-analyze-files-cap-design.md`

## Global Constraints

- 本 worktree 的 `packages/natives/native/index.js` 是本地 stub(真 addon 未编译),测试直接跑;若 index.js 已被恢复为真实文件而 `pi_natives.darwin-arm64.node` 不存在,先重新执行 stub 替换(见 git status 中的 `index.js.real-backup`)
- 测试文件用动态 `import()`(与 `test/issue-7833-analyze-files-fanout.test.ts` 一致),保证在 stub 环境下可加载
- 不新增 CLI flag、不改变 dry-run 行为、默认无上限(向后兼容)
- 每任务结束提交一次,提交信息遵循仓库风格(`feat(commit): ...`)

---

### Task 1: settings-schema 新增 commit.analyzeFiles / commit.analyzeFilesMaxFiles

**Files:**
- Modify: `packages/coding-agent/src/config/settings-schema.ts`(commit.* 键组约 L5474;CommitSettings 接口约 L5746;GroupTypeMap 的 commit 条目已存在)
- Test: `packages/coding-agent/test/commit-analyze-files-cap.test.ts`(新建)

**Interfaces:**
- Produces: `Settings.get("commit.analyzeFiles"): boolean`(默认 true)、`Settings.get("commit.analyzeFilesMaxFiles"): number | undefined`(默认 undefined)

- [ ] **Step 1: 写失败测试**

```ts
// test/commit-analyze-files-cap.test.ts
import { describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";

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
```

- [ ] **Step 2: 运行确认失败**

Run: `cd packages/coding-agent && bun test test/commit-analyze-files-cap.test.ts`
Expected: 类型错误 —— `"commit.analyzeFiles"` 不在 SettingPath 中

- [ ] **Step 3: 实现 schema 键**

在 settings-schema.ts 的 `"commit.changelogMaxDiffChars"` 键(约 L5482)后追加:

```ts
	"commit.analyzeFiles": { type: "boolean", default: true },

	"commit.analyzeFilesMaxFiles": { type: "number", default: undefined },
```

在 `CommitSettings` 接口(约 L5746)追加字段:

```ts
export interface CommitSettings {
	mapReduceEnabled: boolean;
	mapReduceMinFiles: number;
	mapReduceMaxFileTokens: number;
	mapReduceTimeoutMs: number;
	mapReduceMaxConcurrency: number;
	changelogMaxDiffChars: number;
	analyzeFiles: boolean;
	analyzeFilesMaxFiles?: number;
}
```

- [ ] **Step 4: 运行确认通过**

Run: `cd packages/coding-agent && bun test test/commit-analyze-files-cap.test.ts`
Expected: 2 pass

- [ ] **Step 5: 提交**

```bash
git add packages/coding-agent/src/config/settings-schema.ts packages/coding-agent/test/commit-analyze-files-cap.test.ts
git commit -m "feat(commit): add commit.analyzeFiles and commit.analyzeFilesMaxFiles settings"
```

---

### Task 2: agent.ts 从设置读取开关并透传上限

**Files:**
- Modify: `packages/coding-agent/src/commit/agentic/agent.ts:55`(createCommitTools 调用)
- Modify: `packages/coding-agent/src/commit/agentic/tools/index.ts:19-39`(CommitToolOptions + 透传)
- Test: `packages/coding-agent/test/commit-analyze-files-cap.test.ts`(追加用例)

**Interfaces:**
- Consumes: `settings.get("commit.analyzeFiles")`、`settings.get("commit.analyzeFilesMaxFiles")`(Task 1)
- Produces: `CommitToolOptions.maxAnalyzeFiles?: number`;`createAnalyzeFileTool` 的 options 新增 `maxFiles?: number`

- [ ] **Step 1: 写失败测试(接线)**

在 `test/commit-analyze-files-cap.test.ts` 追加:

```ts
import { afterEach, describe, expect, it, vi } from "bun:test";
// (保留顶部 Settings import,新增:)
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { runCommitAgentSession } from "@oh-my-pi/pi-coding-agent/commit/agentic/agent";
import type { CreateAgentSessionResult } from "@oh-my-pi/pi-coding-agent/sdk";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import * as toolsModule from "@oh-my-pi/pi-coding-agent/commit/agentic/tools";

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
```

- [ ] **Step 2: 运行确认失败**

Run: `cd packages/coding-agent && bun test test/commit-analyze-files-cap.test.ts`
Expected: 新用例失败(enableAnalyzeFiles 仍为 true、maxAnalyzeFiles 属性不存在)

- [ ] **Step 3: 实现**

`agent.ts:55` 处改为:

```ts
		enableAnalyzeFiles: settings.get("commit.analyzeFiles"),
		maxAnalyzeFiles: settings.get("commit.analyzeFilesMaxFiles"),
```

`tools/index.ts` 的 `CommitToolOptions` 追加字段并透传:

```ts
export interface CommitToolOptions {
	// ... 现有字段不变
	enableAnalyzeFiles?: boolean;
	maxAnalyzeFiles?: number;
}
```

`createCommitTools` 内 `createAnalyzeFileTool({ ... })` 调用追加:

```ts
			createAnalyzeFileTool({
				cwd: options.cwd,
				authStorage: options.authStorage,
				modelRegistry: options.modelRegistry,
				settings: options.settings,
				spawns: options.spawns,
				state: options.state,
				maxFiles: options.maxAnalyzeFiles,
			}),
```

- [ ] **Step 4: 运行确认通过**

Run: `cd packages/coding-agent && bun test test/commit-analyze-files-cap.test.ts`
Expected: 全部通过(4 pass)

- [ ] **Step 5: 提交**

```bash
git add packages/coding-agent/src/commit/agentic/agent.ts packages/coding-agent/src/commit/agentic/tools/index.ts packages/coding-agent/test/commit-analyze-files-cap.test.ts
git commit -m "feat(commit): thread commit.analyzeFiles settings into the agentic commit tools"
```

---

### Task 3: analyze-file.ts 截断 + 可见警告

**Files:**
- Modify: `packages/coding-agent/src/commit/agentic/tools/analyze-file.ts`(createAnalyzeFileTool options 类型约 L56-66;execute 约 L70-110)
- Test: `packages/coding-agent/test/commit-analyze-files-cap.test.ts`(追加用例)

**Interfaces:**
- Consumes: `createAnalyzeFileTool({ maxFiles?: number })`(Task 2)
- Produces: 工具结果文本在截断时包含 `warning: analyze_files capped at N files; skipped: <names>` 后缀

- [ ] **Step 1: 写失败测试**

在 `test/commit-analyze-files-cap.test.ts` 追加:

```ts
import { createAnalyzeFileTool } from "@oh-my-pi/pi-coding-agent/commit/agentic/tools/analyze-file";
import { TaskTool } from "@oh-my-pi/pi-coding-agent/task";

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
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd packages/coding-agent && bun test test/commit-analyze-files-cap.test.ts`
Expected: 新 3 个用例失败(maxFiles 参数不存在/未截断)

- [ ] **Step 3: 实现**

`analyze-file.ts` 的 `createAnalyzeFileTool` options 类型追加 `maxFiles?: number;`,并在 `execute()` 中:

```ts
		async execute(toolCallId, params, _onUpdate, ctx, signal) {
			const toolSession = buildToolSession(ctx, options);
			const taskTool = await TaskTool.create(toolSession);
			const numstat = options.state.overview?.numstat ?? [];
			const files =
				options.maxFiles === undefined ? params.files : params.files.slice(0, options.maxFiles);
			const skipped = params.files.slice(files.length);

			const analyses = await Promise.all(
				files.map((file, index) => {
					const relatedFiles = formatRelatedFiles(params.files, file, numstat);
					const assignment = prompt.render(analyzeFilePrompt, {
						file,
						goal: params.goal,
						related_files: relatedFiles,
					});
					const taskParams: TaskParams = {
						name: `AnalyzeFile${index + 1}`,
						agent: "sonic",
						task: assignment,
					};
					return taskTool.execute(`${toolCallId}-${index + 1}`, taskParams, signal);
				}),
			);
			const results = analyses.flatMap(analysis => analysis.details?.results ?? []);
			const text = analyses
				.map(analysis => analysis.content.find(part => part.type === "text")?.text ?? "")
				.filter(Boolean)
				.join("\n\n");
			const capWarning =
				skipped.length > 0
					? `\n\nwarning: analyze_files capped at ${files.length} file${files.length === 1 ? "" : "s"}; skipped: ${skipped.join(", ")}`
					: "";
			return {
				content: [{ type: "text", text: text + capWarning }],
				details: {
					projectAgentsDir: null,
					results,
					totalDurationMs: analyses.reduce((sum, analysis) => sum + (analysis.details?.totalDurationMs ?? 0), 0),
				},
			};
		},
```

注意:截断后 `formatRelatedFiles(params.files, ...)` 仍传原始 `params.files`(被跳过文件仍参与相关文件提示,模型可见全貌)。

- [ ] **Step 4: 运行确认通过**

Run: `cd packages/coding-agent && bun test test/commit-analyze-files-cap.test.ts test/issue-7833-analyze-files-fanout.test.ts`
Expected: 全部通过(原 fan-out 3 用例 + 新 5 用例)

- [ ] **Step 5: 提交**

```bash
git add packages/coding-agent/src/commit/agentic/tools/analyze-file.ts packages/coding-agent/test/commit-analyze-files-cap.test.ts
git commit -m "feat(commit): cap analyze_files fan-out with visible skip warning"
```

---

### Task 4: 回归验证

**Files:** 无修改

- [ ] **Step 1: 跑 commit 相关回归测试**

Run: `cd packages/coding-agent && bun test test/commit-execute.test.ts test/commit-agentic-attribution.test.ts test/commit-analyze-files-cap.test.ts test/issue-7833-analyze-files-fanout.test.ts`
Expected: 全部通过

- [ ] **Step 2: 类型检查**

Run: `cd packages/coding-agent && bun run check:types`
Expected: 无错误

- [ ] **Step 3: 提交(如有残留)**

```bash
git status --short
git commit -am "chore(commit): verify analyze-files cap regression" # 仅在确有改动时
```
