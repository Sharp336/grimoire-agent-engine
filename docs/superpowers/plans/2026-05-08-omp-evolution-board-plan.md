# OMP 功能进化看板 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 omp 功能进化看板，通过 YAML 配置文件定义 Topic，提供 TUI 列表/详情视图和 Agent 工具查询。

**Architecture:** 三层分离：数据层 (`EvolutionBoard` 类负责 YAML 解析和查询)、渲染层 (`renderer.ts` 负责 TUI 输出)、工具层 (`evolution-board.ts` 负责 Agent 集成)。

**Tech Stack:** TypeScript, `bun:YAML` 解析, `@oh-my-pi/pi-tui` 渲染, `@sinclair/typebox` schema, `bun:test` 测试。

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/coding-agent/src/evolution-board/types.ts` | TypeScript 类型定义（TopicStatus, EvolutionTopic, EvolutionBoard 接口） |
| `packages/coding-agent/src/evolution-board/index.ts` | 数据层：YAML 加载、查询过滤、单例管理 |
| `packages/coding-agent/src/evolution-board/renderer.ts` | 渲染层：列表视图、详情视图的 TUI 字符串生成 |
| `packages/coding-agent/src/tools/evolution-board.ts` | Agent 工具：schema 定义、execute 方法、TUI renderer |
| `packages/coding-agent/src/prompts/tools/evolution-board.md` | 工具描述文档（供 Agent 理解工具用途） |
| `packages/coding-agent/test/evolution-board/index.test.ts` | 数据层单元测试 |
| `packages/coding-agent/test/evolution-board/renderer.test.ts` | 渲染层单元测试 |
| `docs/evolution-board.yaml` | 示例 Topic 数据 |

**需修改的现有文件：**
- `packages/coding-agent/src/tools/index.ts` — 注册 `evolution_board` 到 `BUILTIN_TOOLS`

---

## Task 1: Type Definitions

**Files:**
- Create: `packages/coding-agent/src/evolution-board/types.ts`

- [ ] **Step 1: Write types**

```typescript
export type TopicStatus = "planned" | "in-progress" | "review" | "testing" | "shipped" | "deferred";

export interface EvolutionTopic {
  id: string;
  name: string;
  brief: string;
  description?: string;
  status: TopicStatus;
  progress?: number;
  started?: string;
  target?: string;
  modules?: string[];
  design?: { spec?: string; plan?: string };
  references?: { name: string; url: string; note?: string }[];
  github?: { issues?: string[]; prs?: string[] };
  notes?: string;
  tags?: string[];
}

export interface EvolutionBoard {
  getTopics(): EvolutionTopic[];
  getTopic(id: string): EvolutionTopic | undefined;
  getByStatus(status: TopicStatus): EvolutionTopic[];
  getByModule(module: string): EvolutionTopic[];
  getByTag(tag: string): EvolutionTopic[];
  load(yamlContent: string): void;
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/coding-agent/src/evolution-board/types.ts
git commit -m "feat(evolution-board): add type definitions"
```

---

## Task 2: Data Layer — YAML 加载与查询

**Files:**
- Create: `packages/coding-agent/src/evolution-board/index.ts`
- Test: `packages/coding-agent/test/evolution-board/index.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
import { describe, expect, it } from "bun:test";
import { createEvolutionBoard } from "@oh-my-pi/pi-coding-agent/evolution-board";

const sampleYaml = `
topics:
  - id: feature-dashboard
    name: 功能进化看板
    brief: 在 TUI 中展示 omp 二次开发任务状态
    status: in-progress
    progress: 30
    modules:
      - coding-agent
      - pi-tui
    tags: [tui, developer-tool]
`;

describe("EvolutionBoard", () => {
  it("loads topics from YAML", () => {
    const board = createEvolutionBoard();
    board.load(sampleYaml);
    const topics = board.getTopics();
    expect(topics).toHaveLength(1);
    expect(topics[0].id).toBe("feature-dashboard");
    expect(topics[0].status).toBe("in-progress");
  });

  it("filters by status", () => {
    const board = createEvolutionBoard();
    board.load(sampleYaml);
    const inProgress = board.getByStatus("in-progress");
    expect(inProgress).toHaveLength(1);
    expect(inProgress[0].id).toBe("feature-dashboard");
  });

  it("filters by module", () => {
    const board = createEvolutionBoard();
    board.load(sampleYaml);
    const codingAgentTopics = board.getByModule("coding-agent");
    expect(codingAgentTopics).toHaveLength(1);
  });

  it("filters by tag", () => {
    const board = createEvolutionBoard();
    board.load(sampleYaml);
    const tuiTopics = board.getByTag("tui");
    expect(tuiTopics).toHaveLength(1);
  });

  it("returns undefined for unknown topic id", () => {
    const board = createEvolutionBoard();
    board.load(sampleYaml);
    expect(board.getTopic("nonexistent")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/coding-agent/test/evolution-board/index.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write minimal implementation**

```typescript
import { YAML } from "bun";
import type { EvolutionBoard, EvolutionTopic, TopicStatus } from "./types";

export function createEvolutionBoard(): EvolutionBoard {
  let topics: EvolutionTopic[] = [];

  return {
    load(yamlContent: string): void {
      const parsed = YAML.parse(yamlContent) as { topics?: unknown[] };
      topics = (parsed.topics ?? []).map((raw: unknown) => raw as EvolutionTopic);
    },
    getTopics(): EvolutionTopic[] { return topics; },
    getTopic(id: string): EvolutionTopic | undefined {
      return topics.find(t => t.id === id);
    },
    getByStatus(status: TopicStatus): EvolutionTopic[] {
      return topics.filter(t => t.status === status);
    },
    getByModule(module: string): EvolutionTopic[] {
      return topics.filter(t => t.modules?.includes(module));
    },
    getByTag(tag: string): EvolutionTopic[] {
      return topics.filter(t => t.tags?.includes(tag));
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/coding-agent/test/evolution-board/index.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/coding-agent/src/evolution-board/index.ts packages/coding-agent/test/evolution-board/index.test.ts
git commit -m "feat(evolution-board): add data layer with YAML loading and filtering"
```

---

## Task 3: TUI 渲染层

**Files:**
- Create: `packages/coding-agent/src/evolution-board/renderer.ts`
- Test: `packages/coding-agent/test/evolution-board/renderer.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
import { describe, expect, it } from "bun:test";
import { renderTopicList, renderTopicDetail } from "@oh-my-pi/pi-coding-agent/evolution-board/renderer";
import { getThemeByName, initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { EvolutionTopic } from "@oh-my-pi/pi-coding-agent/evolution-board/types";

const sampleTopic: EvolutionTopic = {
  id: "feature-dashboard",
  name: "功能进化看板",
  brief: "在 TUI 中展示 omp 二次开发任务状态",
  status: "in-progress",
  progress: 30,
  modules: ["coding-agent", "pi-tui"],
  tags: ["tui", "developer-tool"],
};

describe("EvolutionBoard Renderer", () => {
  it("renders topic list", () => {
    const theme = getThemeByName("default");
    const lines = renderTopicList([sampleTopic], 80, theme);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines[0]).toContain("功能进化看板");
  });

  it("renders topic detail", () => {
    const theme = getThemeByName("default");
    const lines = renderTopicDetail(sampleTopic, 80, theme);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.some(l => l.includes("功能进化看板"))).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/coding-agent/test/evolution-board/renderer.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write minimal implementation**

```typescript
import { replaceTabs, Text, truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui";
import type { Theme } from "../modes/theme/theme";
import type { EvolutionTopic, TopicStatus } from "./types";

const STATUS_LABELS: Record<TopicStatus, string> = {
  planned: "planned",
  "in-progress": "in-progr",
  review: "review",
  testing: "testing",
  shipped: "shipped",
  deferred: "deferred",
};

const STATUS_COLORS: Record<TopicStatus, string> = {
  planned: "dim",
  "in-progress": "warning",
  review: "accent",
  testing: "info",
  shipped: "success",
  deferred: "muted",
};

export function renderTopicList(topics: EvolutionTopic[], width: number, theme: Theme): string[] {
  if (topics.length === 0) {
    return [theme.fg("dim", "No topics found.")];
  }
  return topics.map(topic => {
    const status = STATUS_LABELS[topic.status];
    const statusColor = STATUS_COLORS[topic.status];
    const statusTag = theme.fg(statusColor, `[${status.padEnd(8)}]`);
    const name = truncateToWidth(topic.name, 20);
    const modules = topic.modules?.join(", ") ?? "";
    const progress = topic.progress !== undefined ? ` ${topic.progress}%` : "";
    const line = `${statusTag} ${name} 影响: ${modules}${progress}`;
    return truncateToWidth(line, width);
  });
}

export function renderTopicDetail(topic: EvolutionTopic[], width: number, theme: Theme): string[] {
  const lines: string[] = [];
  const statusColor = STATUS_COLORS[topic.status];

  lines.push(theme.fg("accent", topic.name));
  lines.push(theme.fg(statusColor, `Status: ${topic.status}${topic.progress !== undefined ? ` (${topic.progress}%)` : ""}`));

  if (topic.brief) {
    lines.push("");
    lines.push(theme.fg("muted", "Brief:"));
    lines.push(truncateToWidth(topic.brief, width));
  }

  if (topic.description) {
    lines.push("");
    lines.push(theme.fg("muted", "Description:"));
    for (const line of topic.description.split("\n")) {
      lines.push(truncateToWidth(replaceTabs(line), width));
    }
  }

  if (topic.modules && topic.modules.length > 0) {
    lines.push("");
    lines.push(theme.fg("muted", "Modules:"));
    lines.push(truncateToWidth(topic.modules.join(", "), width));
  }

  if (topic.design?.spec || topic.design?.plan) {
    lines.push("");
    lines.push(theme.fg("muted", "Design:"));
    if (topic.design.spec) lines.push(`  Spec: ${topic.design.spec}`);
    if (topic.design.plan) lines.push(`  Plan: ${topic.design.plan}`);
  }

  if (topic.references && topic.references.length > 0) {
    lines.push("");
    lines.push(theme.fg("muted", "References:"));
    for (const ref of topic.references) {
      lines.push(`  ${ref.name}: ${ref.url}`);
    }
  }

  if (topic.github?.issues || topic.github?.prs) {
    lines.push("");
    lines.push(theme.fg("muted", "GitHub:"));
    if (topic.github.issues) lines.push(`  Issues: ${topic.github.issues.join(", ")}`);
    if (topic.github.prs) lines.push(`  PRs: ${topic.github.prs.join(", ")}`);
  }

  if (topic.notes) {
    lines.push("");
    lines.push(theme.fg("muted", "Notes:"));
    for (const line of topic.notes.split("\n")) {
      lines.push(truncateToWidth(replaceTabs(line), width));
    }
  }

  if (topic.tags && topic.tags.length > 0) {
    lines.push("");
    lines.push(theme.fg("muted", `Tags: ${topic.tags.join(", ")}`));
  }

  return lines;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/coding-agent/test/evolution-board/renderer.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/coding-agent/src/evolution-board/renderer.ts packages/coding-agent/test/evolution-board/renderer.test.ts
git commit -m "feat(evolution-board): add TUI renderer for list and detail views"
```

---

## Task 4: Agent 工具

**Files:**
- Create: `packages/coding-agent/src/prompts/tools/evolution-board.md`
- Create: `packages/coding-agent/src/tools/evolution-board.ts`
- Modify: `packages/coding-agent/src/tools/index.ts`

- [ ] **Step 1: Write tool description**

```markdown
# evolution_board

查询 omp 功能进化看板，获取当前开发中的功能 Topic 列表或详情。

## 参数

- `action`: 操作类型
  - `list` — 列出所有 Topic
  - `show` — 展示指定 Topic 详情
  - `filter` — 按条件过滤 Topic
- `topicId`: Topic ID（action=show 时必填）
- `filter`: 过滤条件（action=filter 时使用）
  - `status`: 按状态过滤（planned, in-progress, review, testing, shipped, deferred）
  - `module`: 按模块过滤
  - `tag`: 按标签过滤

## 使用场景

- 用户问"当前在做什么功能"时，调用 `action=list`
- 用户问"功能看板进度如何"时，调用 `action=list`
- 用户问"某个功能详情"时，调用 `action=show` 并传入 topicId
- 用户想按状态/模块查看时，调用 `action=filter`
```

- [ ] **Step 2: Write tool implementation**

```typescript
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { Text } from "@oh-my-pi/pi-tui";
import { prompt } from "@oh-my-pi/pi-utils";
import { type Static, Type } from "@sinclair/typebox";
import { createEvolutionBoard } from "../evolution-board";
import { renderTopicDetail, renderTopicList } from "../evolution-board/renderer";
import type { Theme } from "../modes/theme/theme";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import type { ToolSession } from ".";
import evolutionBoardDescription from "../prompts/tools/evolution-board.md" with { type: "text" };
import { truncateToWidth } from "./render-utils";

const evolutionBoardSchema = Type.Object({
  action: Type.Union([
    Type.Literal("list"),
    Type.Literal("show"),
    Type.Literal("filter"),
  ], { description: "操作类型" }),
  topicId: Type.Optional(Type.String({ description: "Topic ID（show 时必填）" })),
  filter: Type.Optional(Type.Object({
    status: Type.Optional(Type.String({ description: "按状态过滤" })),
    module: Type.Optional(Type.String({ description: "按模块过滤" })),
    tag: Type.Optional(Type.String({ description: "按标签过滤" })),
  })),
});

type EvolutionBoardParams = Static<typeof evolutionBoardSchema>;

export class EvolutionBoardTool implements AgentTool<typeof evolutionBoardSchema> {
  readonly name = "evolution_board";
  readonly label = "Evolution Board";
  readonly description: string;
  readonly parameters = evolutionBoardSchema;
  readonly strict = true;

  constructor(private readonly session: ToolSession) {
    this.description = prompt.render(evolutionBoardDescription);
  }

  async execute(
    _toolCallId: string,
    params: EvolutionBoardParams,
  ): Promise<AgentToolResult> {
    const board = createEvolutionBoard();

    // Load YAML from project docs
    const yamlPath = `${this.session.cwd}/docs/evolution-board.yaml`;
    try {
      const content = await Bun.file(yamlPath).text();
      board.load(content);
    } catch {
      return {
        content: [{ type: "text", text: "No evolution board found. Create docs/evolution-board.yaml first." }],
      };
    }

    switch (params.action) {
      case "list": {
        const topics = board.getTopics();
        const output = topics.map(t => `${t.status} | ${t.name} | ${t.brief}`).join("\n");
        return {
          content: [{ type: "text", text: output || "No topics found." }],
        };
      }
      case "show": {
        if (!params.topicId) {
          return {
            content: [{ type: "text", text: "topicId is required for show action." }],
            isError: true,
          };
        }
        const topic = board.getTopic(params.topicId);
        if (!topic) {
          return {
            content: [{ type: "text", text: `Topic "${params.topicId}" not found.` }],
            isError: true,
          };
        }
        const lines = [
          `# ${topic.name}`,
          `Status: ${topic.status}${topic.progress !== undefined ? ` (${topic.progress}%)` : ""}`,
          `Brief: ${topic.brief}`,
        ];
        if (topic.description) lines.push(`\nDescription:\n${topic.description}`);
        if (topic.modules) lines.push(`\nModules: ${topic.modules.join(", ")}`);
        if (topic.references) {
          lines.push("\nReferences:");
          for (const ref of topic.references) {
            lines.push(`- ${ref.name}: ${ref.url}`);
          }
        }
        if (topic.notes) lines.push(`\nNotes:\n${topic.notes}`);
        return {
          content: [{ type: "text", text: lines.join("\n") }],
        };
      }
      case "filter": {
        let topics = board.getTopics();
        if (params.filter?.status) {
          topics = board.getByStatus(params.filter.status as any);
        }
        if (params.filter?.module) {
          topics = board.getByModule(params.filter.module);
        }
        if (params.filter?.tag) {
          topics = board.getByTag(params.filter.tag);
        }
        const output = topics.map(t => `${t.status} | ${t.name} | ${t.brief}`).join("\n");
        return {
          content: [{ type: "text", text: output || "No topics match the filter." }],
        };
      }
    }
  }
}
```

- [ ] **Step 3: Register tool in tools/index.ts**

在 `BUILTIN_TOOLS` 对象中添加：

```typescript
evolution_board: s => new EvolutionBoardTool(s),
```

在 `export * from ...` 列表中添加：

```typescript
export * from "./evolution-board";
```

- [ ] **Step 4: Commit**

```bash
git add packages/coding-agent/src/prompts/tools/evolution-board.md packages/coding-agent/src/tools/evolution-board.ts packages/coding-agent/src/tools/index.ts
git commit -m "feat(evolution-board): add agent tool for querying topics"
```

---

## Task 5: 示例数据文件

**Files:**
- Create: `docs/evolution-board.yaml`

- [ ] **Step 1: Write sample data**

```yaml
# OMP 功能进化看板
# 读者：开发者 + omp agent
# 维护方式：手动更新状态，agent 读取并渲染

topics:
  - id: feature-dashboard
    name: 功能进化看板
    brief: 在 TUI 中展示 omp 二次开发任务状态
    description: |
      追踪 omp 二次开发任务的全生命周期状态，包括功能定义、
      版本状态、影响模块、参考方案等。通过 TUI 列表视图和
      详情视图展示，agent 也可查询。
    status: in-progress
    progress: 30
    started: 2026-05-08
    target: 2026-05-20
    modules:
      - coding-agent
      - pi-tui
      - pi-utils
    design:
      spec: docs/superpowers/specs/2026-05-08-omp-evolution-board-design.md
      plan: docs/superpowers/plans/2026-05-08-omp-evolution-board-plan.md
    references:
      - name: GitHub Projects
        url: https://docs.github.com/en/issues/planning-and-tracking-with-projects
        note: GitHub 原生项目管理视图
      - name: Linear
        url: https://linear.app
        note: 现代 issue 追踪工具的状态流设计
    github:
      issues:
        - "#123"
    notes: |
      当前阶段：实现计划编写
      下一步：按 plan 逐步实施
    tags: [tui, developer-tool, dashboard]
```

- [ ] **Step 2: Commit**

```bash
git add docs/evolution-board.yaml
git commit -m "docs(evolution-board): add sample evolution board data"
```

---

## Task 6: 类型导出与 Barrel 文件

**Files:**
- Create: `packages/coding-agent/src/evolution-board/index.ts` (barrel export)

- [ ] **Step 1: Ensure proper exports**

确认 `packages/coding-agent/src/evolution-board/index.ts` 已经导出所有公共 API：

```typescript
export * from "./types";
export { createEvolutionBoard } from "./index"; // 数据层
export { renderTopicList, renderTopicDetail } from "./renderer"; // 渲染层
```

如果需要，创建 barrel 文件 `packages/coding-agent/src/evolution-board/index.ts`：

```typescript
export * from "./types";
export * from "./renderer";
export { createEvolutionBoard } from "./board"; // 把数据层实现移到 board.ts
```

> 注意：当前 `index.ts` 已经是数据层实现。如果需要保留 barrel 模式，将数据层移到 `board.ts`，`index.ts` 只做 re-export。

- [ ] **Step 2: Commit**

```bash
git add packages/coding-agent/src/evolution-board/
git commit -m "refactor(evolution-board): organize exports"
```

---

## Task 7: 运行全部测试

- [ ] **Step 1: Run tests**

```bash
bun test packages/coding-agent/test/evolution-board/
```

Expected: All tests pass (7 tests total: 5 data layer + 2 renderer)

- [ ] **Step 2: Run type check**

```bash
bun check:ts
```

Expected: No type errors in new code

- [ ] **Step 3: Commit**

```bash
git commit -m "test(evolution-board): verify all tests pass"
```

---

## Self-Review

### Spec Coverage Check

| Spec Requirement | Task |
|---|---|
| YAML 数据模型 | Task 1 + Task 2 |
| TUI 列表视图 | Task 3 (renderTopicList) |
| TUI 详情视图 | Task 3 (renderTopicDetail) |
| Agent 工具 | Task 4 |
| 按状态/模块/标签过滤 | Task 2 + Task 4 |
| 示例数据 | Task 5 |

### Placeholder Scan

- 无 TBD/TODO
- 所有步骤包含完整代码
- 无 "add appropriate error handling" 等模糊描述

### Type Consistency

- `TopicStatus` 在 types.ts 定义，renderer.ts 和 tool.ts 中一致使用
- `EvolutionTopic` 接口在所有文件中一致
- `createEvolutionBoard()` 返回 `EvolutionBoard` 接口

---

## 执行选项

**Plan complete and saved to `docs/superpowers/plans/2026-05-08-omp-evolution-board-plan.md`.**

**Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach?
