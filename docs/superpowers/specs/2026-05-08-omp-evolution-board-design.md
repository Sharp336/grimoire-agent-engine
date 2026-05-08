# OMP 功能进化看板设计

> **目标**：在 TUI 中展示 omp 二次开发任务状态，追踪每个功能从规划到发布的全生命周期。
> **读者**：开发者 + omp agent
> **维护方式**：手动维护 `docs/evolution-board.yaml`，agent 读取并渲染

---

## 1. 问题陈述

omp 目前缺乏统一的功能开发进度视图。开发者（和 agent）无法快速回答：
- 当前有哪些功能在开发？
- 某个功能做到哪一步了？
- 这个功能影响了哪些模块？
- 有没有可参考的外部方案？

信息分散在 GitHub issues、PR、commit message、会话历史中，没有聚合视图。

---

## 2. 数据模型

### 2.1 文件位置

`docs/evolution-board.yaml` — 与 `docs/superpowers/specs/` 同级，纳入 Git 版本控制。

### 2.2 Topic 结构

```yaml
topics:
  - id: feature-dashboard
    name: 功能进化看板
    brief: >-               # 一句话摘要（供列表视图）
      在 TUI 中展示 omp 二次开发任务状态

    description: |          # 详细描述
      追踪 omp 二次开发任务的全生命周期状态，包括功能定义、
      版本状态、影响模块、参考方案等。通过 TUI 列表视图和
      详情视图展示，agent 也可查询。

    status: in-progress     # planned | in-progress | review | testing | shipped | deferred
    progress: 30            # 0-100，粗略进度

    started: 2026-05-08
    target: 2026-05-20      # 目标完成日期（可选）

    modules:                # 影响的包/模块
      - coding-agent
      - pi-tui
      - pi-utils

    design:                 # 设计文档
      spec: docs/superpowers/specs/2026-05-08-omp-evolution-board-design.md
      plan: docs/superpowers/plans/2026-05-08-omp-evolution-board-plan.md

    references:             # 行业参考方案
      - name: GitHub Projects
        url: https://docs.github.com/en/issues/planning-and-tracking-with-projects
        note: GitHub 原生项目管理视图
      - name: Linear
        url: https://linear.app
        note: 现代 issue 追踪工具的状态流设计
      - name: Jira Roadmap
        url: https://www.atlassian.com/software/jira
        note: 企业级功能路线图视图

    github:                 # 关联的 GitHub 资源
      issues:
        - "#123"
      prs:
        - "#456"

    notes: |                # 开发者备注
      当前阶段：方案设计
      下一步：实现 TUI 渲染组件

    tags: [tui, developer-tool, dashboard]
```

### 2.3 字段说明

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `id` | string | 是 | kebab-case 唯一标识 |
| `name` | string | 是 | 功能名称 |
| `brief` | string | 是 | 一句话摘要，列表视图展示 |
| `description` | string | 否 | 详细描述，支持多行 |
| `status` | enum | 是 | planned, in-progress, review, testing, shipped, deferred |
| `progress` | int | 否 | 0-100 粗略进度 |
| `started` | date | 否 | 开始日期 |
| `target` | date | 否 | 目标完成日期 |
| `modules` | string[] | 否 | 影响的包名，对应 `packages/` 目录 |
| `design` | object | 否 | `spec` 和 `plan` 文档路径 |
| `references` | object[] | 否 | 行业参考方案（name, url, note） |
| `github` | object | 否 | issues 和 prs 列表 |
| `notes` | string | 否 | 开发者备注 |
| `tags` | string[] | 否 | 标签，用于过滤 |

---

## 3. 组件设计

### 3.1 `EvolutionBoard` (数据层)

```typescript
// packages/coding-agent/src/evolution-board/index.ts

interface EvolutionTopic {
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

type TopicStatus = "planned" | "in-progress" | "review" | "testing" | "shipped" | "deferred";

class EvolutionBoard {
  private topics: EvolutionTopic[] = [];
  private loaded = false;

  async load(): Promise<void> {
    // 从 docs/evolution-board.yaml 加载
  }

  getTopics(): EvolutionTopic[] { return this.topics; }
  getTopic(id: string): EvolutionTopic | undefined { ... }
  getByStatus(status: TopicStatus): EvolutionTopic[] { ... }
  getByModule(module: string): EvolutionTopic[] { ... }
  getByTag(tag: string): EvolutionTopic[] { ... }
}
```

### 3.2 `EvolutionBoardRenderer` (TUI 渲染层)

```typescript
// packages/coding-agent/src/evolution-board/renderer.ts

function renderBoard(topics: EvolutionTopic[], width: number, theme: Theme): string[]
function renderTopicDetail(topic: EvolutionTopic, width: number, theme: Theme): string[]
function renderTopicList(topics: EvolutionTopic[], width: number, theme: Theme): string[]
```

**列表视图**：
```
[planned]   自进化 v2.0        影响: self-evolution  进度: --%
[in-progr]  功能进化看板       影响: coding-agent     进度: 30%
[testing]   MCP 工具运行时优化  影响: mcp              进度: 85%
[shipped]   GitNexus 集成      影响: gitnexus         进度: 100%
```

**详情视图**：展示完整字段（描述、设计文档、参考方案、关联 issue 等）

### 3.3 `evolution-board` 工具

供 agent 查询 Topic 信息：

```typescript
// 供工具调用
{
  name: "evolution_board",
  description: "查询 omp 功能进化看板",
  parameters: {
    action: "list" | "show" | "filter",
    filter?: { status?: string; module?: string; tag?: string },
    topicId?: string
  }
}
```

---

## 4. TUI 集成

### 4.1 命令入口

新增子命令：
```bash
omp evolution-board          # 打开看板列表视图
omp evolution-board <id>     # 打开指定 Topic 详情
```

### 4.2 交互设计

- **列表视图**：上下导航选择 Topic，按 `Enter` 进入详情
- **详情视图**：
  - `j/k` 或 `↑/↓` 滚动
  - `o` 在浏览器中打开关联 issue/PR/参考链接
  - `q` 或 `Esc` 返回列表
  - `r` 刷新数据（重新读取 YAML）
- **快捷键**：在看板中按 `/` 搜索 Topic，按 `s` 按状态过滤

### 4.3 状态颜色映射

| 状态 | 颜色 |
|---|---|
| planned | dim |
| in-progress | warning |
| review | accent |
| testing | info |
| shipped | success |
| deferred | muted |

---

## 5. Agent 集成

### 5.1 自动注入

在 agent 会话中，当用户询问"当前在做什么"、"功能进度"、"某个功能状态"时，自动调用 `evolution_board` 工具获取信息并展示。

### 5.2 上下文感知

agent 维护上下文时，如果当前会话与某个 Topic 相关（通过代码变更的模块匹配），在看板中自动高亮该 Topic。

---

## 6. 测试计划

- **单元测试**：`EvolutionBoard.load()` 正确解析 YAML
- **单元测试**：过滤/查询逻辑（按状态、模块、标签）
- **单元测试**：渲染输出格式正确
- **集成测试**：TUI 列表→详情导航流程
- **集成测试**：agent 工具调用返回正确数据

---

## 7. 成功标准

- [ ] `docs/evolution-board.yaml` 可被正确解析和渲染
- [ ] TUI 列表视图展示所有 Topic，状态颜色正确
- [ ] TUI 详情视图展示完整信息（描述、设计文档、参考方案）
- [ ] Agent 可通过工具查询 Topic 信息
- [ ] 快捷键导航流畅（j/k Enter q）
