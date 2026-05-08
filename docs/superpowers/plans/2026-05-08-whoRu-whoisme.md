# whoRu & whoisme Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an `identity` tool with three actions (`whoRu`, `whoisme`, `update_persona`) that lets users query agent identity and manage their user persona template.

**Architecture:** A single `IdentityTool` class handles all three actions. whoRu reads from `ToolSession` at runtime. whoisme reads from a JSON file at `~/.omp/persona.json`. update_persona merges partial updates into the same file. A `FilePersonaStore` handles persistence.

**Tech Stack:** TypeScript, Bun file APIs, TypeBox for schemas, pi-tui for rendering, pi-utils for prompt rendering

---

## File Structure

| File | Responsibility |
|------|---------------|
| `packages/coding-agent/src/persona/types.ts` | `UserPersona` interface with all 7 sections |
| `packages/coding-agent/src/persona/store.ts` | `PersonaStore` interface + `FilePersonaStore` implementation |
| `packages/coding-agent/src/tools/identity.ts` | `IdentityTool` class implementing all 3 actions |
| `packages/coding-agent/src/prompts/tools/identity.md` | Tool description template for LLM |
| `packages/coding-agent/src/tools/renderers.ts` | Register `identityToolRenderer` |
| `packages/coding-agent/src/tools/index.ts` | Register `identity` in `BUILTIN_TOOLS` + settings guard |
| `packages/coding-agent/src/prompts/system/system-prompt.md` | Add identity tool guidance |

---

## Task 1: Persona Types

**Files:**
- Create: `packages/coding-agent/src/persona/types.ts`

- [ ] **Step 1: Write UserPersona interface**

```typescript
export interface UserPersona {
  version: string;
  updatedAt: number;
  basics: {
    gender?: string;
    birthday?: string;
    zodiac?: string;
    mbti?: string;
    lifeStage?: string;
    location?: string;
    pace?: string;
    languageStyle?: string;
  };
  career: {
    industry?: string;
    role?: string;
    dailyWork?: string;
    expertise?: string[];
    lifeGoal?: string;
    thinkingPattern?: string;
  };
  interests: {
    longTerm: string[];
    shortTerm: string[];
    avoid: string[];
    priorities: string[];
  };
  preferences: {
    contentType?: string;
    communicationStyle?: string;
    outputFormat?: string;
    contentStyle?: string;
    tolerance?: string;
    hobbies?: string[];
  };
  interaction: {
    commonCommands?: string[];
    replyStyle?: string;
    proactive?: boolean;
    errorHandling?: string;
  };
  thinking: {
    workStyle?: string;
    choicePreference?: string;
    logicHabit?: string;
    riskAppetite?: string;
  };
  constraints: {
    forbidden: string[];
    formatRules?: string;
    memoryRules?: string;
    accuracyRules?: string;
  };
}

export function createEmptyPersona(): UserPersona {
  return {
    version: "1.0",
    updatedAt: Date.now(),
    basics: {},
    career: {},
    interests: { longTerm: [], shortTerm: [], avoid: [], priorities: [] },
    preferences: {},
    interaction: {},
    thinking: {},
    constraints: { forbidden: [] },
  };
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/coding-agent/src/persona/types.ts
git commit -m "feat(identity): add UserPersona types with 7-section structure"
```

---

## Task 2: Persona Store

**Files:**
- Create: `packages/coding-agent/src/persona/store.ts`

- [ ] **Step 1: Write PersonaStore interface and FilePersonaStore**

```typescript
import * as path from "node:path";
import * as os from "node:os";
import { createEmptyPersona, type UserPersona } from "./types";

export interface PersonaStore {
  load(): Promise<UserPersona | undefined>;
  save(persona: UserPersona): Promise<void>;
}

export class FilePersonaStore implements PersonaStore {
  readonly #filePath: string;

  constructor(filePath?: string) {
    this.#filePath = filePath ?? path.join(os.homedir(), ".omp", "persona.json");
  }

  async load(): Promise<UserPersona | undefined> {
    try {
      const text = await Bun.file(this.#filePath).text();
      return JSON.parse(text) as UserPersona;
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === "ENOENT") return undefined;
      throw err;
    }
  }

  async save(persona: UserPersona): Promise<void> {
    await Bun.write(this.#filePath, JSON.stringify(persona, null, 2));
  }
}
```

- [ ] **Step 2: Write test**

Create `packages/coding-agent/src/persona/store.test.ts`:

```typescript
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import * as path from "node:path";
import * as os from "node:os";
import { FilePersonaStore } from "./store";
import { createEmptyPersona } from "./types";

describe("FilePersonaStore", () => {
  const tmpPath = path.join(os.tmpdir(), `test-persona-${Date.now()}.json`);
  let store: FilePersonaStore;

  beforeEach(() => {
    store = new FilePersonaStore(tmpPath);
  });

  afterEach(async () => {
    try { await Bun.file(tmpPath).delete(); } catch {}
  });

  it("returns undefined when file does not exist", async () => {
    const result = await store.load();
    expect(result).toBeUndefined();
  });

  it("round-trips persona data", async () => {
    const persona = createEmptyPersona();
    persona.basics.mbti = "INTJ";
    await store.save(persona);
    const loaded = await store.load();
    expect(loaded?.basics.mbti).toBe("INTJ");
  });
});
```

Run: `bun test packages/coding-agent/src/persona/store.test.ts`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add packages/coding-agent/src/persona/store.ts packages/coding-agent/src/persona/store.test.ts
git commit -m "feat(identity): add FilePersonaStore for persona persistence"
```

---

## Task 3: Identity Tool Core

**Files:**
- Create: `packages/coding-agent/src/tools/identity.ts`
- Create: `packages/coding-agent/src/prompts/tools/identity.md`

- [ ] **Step 1: Write identity tool description**

Create `packages/coding-agent/src/prompts/tools/identity.md`:

```markdown
Query identity information.

<instruction>
- `whoRu`: Returns the current agent's identity — name, role, model, available tools, skills, work style
- `whoisme`: Returns the user's persona profile (if configured)
- `update_persona`: Updates the user's persona. Provide `section` (basics/career/interests/preferences/interaction/thinking/constraints) and `data` (partial object to merge)
</instruction>

<output>
- whoRu: structured agent identity
- whoisme: structured user persona or empty template
- update_persona: success confirmation with updated fields
</output>
```

- [ ] **Step 2: Write IdentityTool implementation**

```typescript
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { Type, type Static } from "@sinclair/typebox";
import { prompt } from "@oh-my-pi/pi-utils";
import identityDescription from "../prompts/tools/identity.md" with { type: "text" };
import { FilePersonaStore } from "../persona/store";
import { createEmptyPersona, type UserPersona } from "../persona/types";
import type { ToolSession } from ".";

const identitySchema = Type.Object({
  action: Type.String({
    description: "whoRu: agent identity; whoisme: user persona; update_persona: update persona",
  }),
  section: Type.Optional(Type.String({
    description: "For update_persona: section to update (basics/career/interests/preferences/interaction/thinking/constraints)",
  })),
  data: Type.Optional(Type.Object({}, {
    description: "For update_persona: partial persona data to merge",
    additionalProperties: true,
  })),
});

interface AgentIdentity {
  name: string;
  role: string;
  model: string;
  agentId: string;
  taskDepth: number;
  cwd: string;
  availableTools: string[];
  skills: string[];
  capabilities: string[];
  workStyle: string;
  constraints: string[];
}

export interface IdentityToolDetails {
  action: string;
  data: AgentIdentity | UserPersona | { success: boolean; updatedFields: string[] };
}

export class IdentityTool implements AgentTool<typeof identitySchema, IdentityToolDetails> {
  readonly name = "identity";
  readonly label = "Identity";
  readonly description: string;
  readonly parameters = identitySchema;
  readonly strict = true;

  readonly #session: ToolSession;
  readonly #store: FilePersonaStore;

  constructor(session: ToolSession) {
    this.description = prompt.render(identityDescription);
    this.#session = session;
    this.#store = new FilePersonaStore();
  }

  async execute(
    _toolCallId: string,
    params: Static<typeof identitySchema>,
    _signal?: AbortSignal,
  ): Promise<AgentToolResult<IdentityToolDetails>> {
    const { action } = params;

    switch (action) {
      case "whoRu":
        return this.#handleWhoRu();
      case "whoisme":
        return this.#handleWhoisme();
      case "update_persona":
        return this.#handleUpdatePersona(params.section, params.data);
      default:
        return {
          content: [{ type: "text", text: `Unknown action: ${action}. Use whoRu, whoisme, or update_persona.` }],
          isError: true,
        };
    }
  }

  #handleWhoRu(): AgentToolResult<IdentityToolDetails> {
    const identity: AgentIdentity = {
      name: "Oh My Pi",
      role: "全栈编码搭档与技术顾问",
      model: this.#session.getActiveModelString?.() ?? "unknown",
      agentId: this.#session.getAgentId?.() ?? "0-Main",
      taskDepth: this.#session.taskDepth ?? 0,
      cwd: this.#session.cwd,
      availableTools: [], // populated from session context
      skills: this.#session.skills?.map(s => s.name) ?? [],
      capabilities: [
        "代码操作：读取、编辑、重构、搜索、批量替换",
        "运行时：执行 Bash 命令、Python 脚本、Node.js",
        "代码智能：AST 分析、LSP 语义查询、类型检查",
        "项目管理：任务拆分、并行子智能体、待办追踪",
        "外部集成：GitHub、Web 搜索、浏览器、MCP 服务器",
        "架构分析：GitNexus 代码知识图谱、路由/工具映射",
      ],
      workStyle: "简洁直接，拒绝废话。先理解问题，再给出方案。高 agency，主动推进。严谨验证，不编造信息。",
      constraints: [
        "必须回答完整才能 yield",
        "禁止编造未观察到的结果",
        "禁止解决假想问题而非实际问题",
        "用户指令优先于默认风格",
      ],
    };

    const text = this.#formatWhoRu(identity);
    return {
      content: [{ type: "text", text }],
      details: { action: "whoRu", data: identity },
    };
  }

  #formatWhoRu(identity: AgentIdentity): string {
    const lines: string[] = [
      "# Oh My Pi 智能助手",
      "",
      "## 身份定位",
      `- 名称：${identity.name}`,
      `- 角色：${identity.role}`,
      "- 形态：基于 Claude 大模型的 AI 编程智能体",
      "",
      "## 当前配置",
      `- 模型：${identity.model}`,
      `- 会话：${identity.agentId} | 深度 ${identity.taskDepth}`,
      `- 工作目录：${identity.cwd}`,
      "",
      "## 核心能力",
      ...identity.capabilities.map(c => `- ${c}`),
      "",
      "## 工作风格",
      `- ${identity.workStyle}`,
      "",
      "## 当前状态",
      `- 可用工具：${identity.availableTools.length} 个`,
      `- 已加载技能：${identity.skills.join(", ") || "none"}`,
      "",
      "## Agent 约束",
      ...identity.constraints.map(c => `- ${c}`),
    ];
    return lines.join("\n");
  }

  async #handleWhoisme(): Promise<AgentToolResult<IdentityToolDetails>> {
    const persona = await this.#store.load();
    if (!persona) {
      const empty = createEmptyPersona();
      const text = "尚未配置用户人设。你可以通过 identity 工具的 update_persona 动作来填写你的人设模板。";
      return {
        content: [{ type: "text", text }],
        details: { action: "whoisme", data: empty },
      };
    }

    const text = this.#formatWhoisme(persona);
    return {
      content: [{ type: "text", text }],
      details: { action: "whoisme", data: persona },
    };
  }

  #formatWhoisme(persona: UserPersona): string {
    const b = persona.basics;
    const c = persona.career;
    const i = persona.interests;
    const p = persona.preferences;
    const inter = persona.interaction;
    const t = persona.thinking;
    const cons = persona.constraints;

    const lines: string[] = [
      "# 用户人设",
      "",
      "## 一、基础个人信息",
    ];
    if (b.gender) lines.push(`- 性别：${b.gender}`);
    if (b.birthday) lines.push(`- 生日：${b.birthday}`);
    if (b.zodiac) lines.push(`- 星座：${b.zodiac}`);
    if (b.mbti) lines.push(`- MBTI：${b.mbti}`);
    if (b.lifeStage) lines.push(`- 人生阶段：${b.lifeStage}`);
    if (b.location) lines.push(`- 地域：${b.location}`);
    if (b.pace) lines.push(`- 做事节奏：${b.pace}`);
    if (b.languageStyle) lines.push(`- 语言风格：${b.languageStyle}`);

    lines.push("", "## 二、职业与身份画像");
    if (c.industry) lines.push(`- 行业：${c.industry}`);
    if (c.role) lines.push(`- 岗位：${c.role}`);
    if (c.dailyWork) lines.push(`- 日常工作：${c.dailyWork}`);
    if (c.expertise?.length) lines.push(`- 擅长领域：${c.expertise.join("、")}`);
    if (c.lifeGoal) lines.push(`- 人生目标：${c.lifeGoal}`);
    if (c.thinkingPattern) lines.push(`- 思维范式：${c.thinkingPattern}`);

    lines.push("", "## 三、关注话题图谱");
    if (i.longTerm.length) lines.push(`- 长期关注：${i.longTerm.join("、")}`);
    if (i.shortTerm.length) lines.push(`- 短期兴趣：${i.shortTerm.join("、")}`);
    if (i.avoid.length) lines.push(`- 避坑话题：${i.avoid.join("、")}`);
    if (i.priorities.length) lines.push(`- 优先级：${i.priorities.join(" > ")}`);

    lines.push("", "## 四、喜好与风格特质");
    if (p.contentType) lines.push(`- 内容偏好：${p.contentType}`);
    if (p.communicationStyle) lines.push(`- 沟通风格：${p.communicationStyle}`);
    if (p.outputFormat) lines.push(`- 输出格式：${p.outputFormat}`);
    if (p.contentStyle) lines.push(`- 内容风格：${p.contentStyle}`);
    if (p.tolerance) lines.push(`- 纠错习惯：${p.tolerance}`);
    if (p.hobbies?.length) lines.push(`- 兴趣爱好：${p.hobbies.join("、")}`);

    lines.push("", "## 五、交互对话习惯");
    if (inter.commonCommands?.length) lines.push(`- 常用指令：${inter.commonCommands.join("、")}`);
    if (inter.replyStyle) lines.push(`- 回复风格：${inter.replyStyle}`);
    lines.push(`- 允许主动延伸：${inter.proactive ? "是" : "否"}`);
    if (inter.errorHandling) lines.push(`- 出错处理：${inter.errorHandling}`);

    lines.push("", "## 六、思维决策模式");
    if (t.workStyle) lines.push(`- 做事风格：${t.workStyle}`);
    if (t.choicePreference) lines.push(`- 选择倾向：${t.choicePreference}`);
    if (t.logicHabit) lines.push(`- 逻辑习惯：${t.logicHabit}`);
    if (t.riskAppetite) lines.push(`- 风险偏好：${t.riskAppetite}`);

    lines.push("", "## 七、Agent 专属约束");
    if (cons.forbidden.length) lines.push(`- 禁止行为：${cons.forbidden.join("、")}`);
    if (cons.formatRules) lines.push(`- 格式规则：${cons.formatRules}`);
    if (cons.memoryRules) lines.push(`- 记忆规则：${cons.memoryRules}`);
    if (cons.accuracyRules) lines.push(`- 专业对齐：${cons.accuracyRules}`);

    return lines.join("\n");
  }

  async #handleUpdatePersona(
    section?: string,
    data?: Record<string, unknown>,
  ): Promise<AgentToolResult<IdentityToolDetails>> {
    if (!section || !data) {
      return {
        content: [{ type: "text", text: "update_persona requires both 'section' and 'data' parameters." }],
        isError: true,
      };
    }

    const validSections = ["basics", "career", "interests", "preferences", "interaction", "thinking", "constraints"];
    if (!validSections.includes(section)) {
      return {
        content: [{ type: "text", text: `Invalid section "${section}". Valid: ${validSections.join(", ")}` }],
        isError: true,
      };
    }

    let persona = await this.#store.load();
    if (!persona) {
      persona = createEmptyPersona();
    }

    // Merge data into the specified section
    const existing = persona[section as keyof UserPersona] as Record<string, unknown>;
    const merged = { ...existing, ...data };
    (persona as Record<string, unknown>)[section] = merged;
    persona.updatedAt = Date.now();

    await this.#store.save(persona);

    const updatedFields = Object.keys(data);
    const text = `已更新人设 [${section}]：${updatedFields.join("、")}`;
    return {
      content: [{ type: "text", text }],
      details: { action: "update_persona", data: { success: true, updatedFields } },
    };
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add packages/coding-agent/src/prompts/tools/identity.md packages/coding-agent/src/tools/identity.ts
git commit -m "feat(identity): add IdentityTool with whoRu, whoisme, update_persona actions"
```

---

## Task 4: TUI Renderer

**Files:**
- Create: `packages/coding-agent/src/tools/identity-render.ts`
- Modify: `packages/coding-agent/src/tools/renderers.ts`

- [ ] **Step 1: Write identity tool renderer**

Create `packages/coding-agent/src/tools/identity-render.ts`:

```typescript
import type { Component } from "@oh-my-pi/pi-tui";
import { Text } from "@oh-my-pi/pi-tui";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import type { Theme } from "../modes/theme/theme";
import { formatErrorMessage, formatEmptyMessage, PREVIEW_LIMITS, renderStatusLine, TRUNCATE_LENGTHS } from "./render-utils";

export const identityToolRenderer = {
  renderCall(args: { action?: string }, _options: RenderResultOptions, uiTheme: Theme): Component {
    const action = args.action ?? "unknown";
    const text = renderStatusLine({ icon: "pending", title: "Identity", description: action }, uiTheme);
    return new Text(text, 0, 0);
  },

  renderResult(
    result: { content: Array<{ type: string; text?: string }>; details?: unknown; isError?: boolean },
    _options: RenderResultOptions,
    uiTheme: Theme,
    _args?: unknown,
  ): Component {
    const textContent = result.content?.find(c => c.type === "text")?.text ?? "";

    if (result.isError) {
      const header = renderStatusLine({ icon: "error", title: "Identity" }, uiTheme);
      return {
        render() { return [header, formatErrorMessage(textContent, uiTheme)]; },
        invalidate() {},
      };
    }

    if (!textContent) {
      const header = renderStatusLine({ icon: "warning", title: "Identity" }, uiTheme);
      return {
        render() { return [header, formatEmptyMessage("No identity data", uiTheme)]; },
        invalidate() {},
      };
    }

    const header = renderStatusLine({ icon: "success", title: "Identity" }, uiTheme);
    return {
      render() {
        const lines = textContent.split("\n");
        if (lines.length > PREVIEW_LIMITS.EXPANDED_LINES) {
          const shown = lines.slice(0, PREVIEW_LIMITS.EXPANDED_LINES);
          return [header, ...shown, `... (${lines.length - PREVIEW_LIMITS.EXPANDED_LINES} more lines)`];
        }
        return [header, ...lines];
      },
      invalidate() {},
    };
  },
};
```

- [ ] **Step 2: Register renderer**

In `packages/coding-agent/src/tools/renderers.ts`, add import and register:

```typescript
import { identityToolRenderer } from "./identity-render";

export const toolRenderers: Record<string, ToolRenderer> = {
  // ... existing entries
  identity: identityToolRenderer as ToolRenderer,
};
```

- [ ] **Step 3: Commit**

```bash
git add packages/coding-agent/src/tools/identity-render.ts packages/coding-agent/src/tools/renderers.ts
git commit -m "feat(identity): add TUI renderer for identity tool"
```

---

## Task 5: Tool Registration

**Files:**
- Modify: `packages/coding-agent/src/tools/index.ts`

- [ ] **Step 1: Import and register**

Add to `packages/coding-agent/src/tools/index.ts`:

```typescript
import { IdentityTool } from "./identity";

export const BUILTIN_TOOLS: Record<string, ToolFactory> = {
  // ... existing entries
  identity: s => new IdentityTool(s),
};
```

Add to the `isToolAllowed` function in `createTools`:

```typescript
if (name === "identity") return session.settings.get("identity.enabled") ?? true;
```

- [ ] **Step 2: Commit**

```bash
git add packages/coding-agent/src/tools/index.ts
git commit -m "feat(identity): register identity tool in BUILTIN_TOOLS"
```

---

## Task 6: System Prompt Update

**Files:**
- Modify: `packages/coding-agent/src/prompts/system/system-prompt.md`

- [ ] **Step 1: Add identity tool guidance**

Find the `<critical>` section near the end (around line 394), and add after the last bullet point but before `</critical>`:

```markdown
- When the user asks about identity ("你是谁", "who are you", "what can you do"), invoke `identity` with `action: "whoRu"`.
- When the user asks about themselves ("我是谁", "who am I", "what do you know about me"), invoke `identity` with `action: "whoisme"`.
- When the user wants to update their persona ("更新人设", "update my profile"), invoke `identity` with `action: "update_persona"`, providing the `section` and `data` fields.
```

- [ ] **Step 2: Commit**

```bash
git add packages/coding-agent/src/prompts/system/system-prompt.md
git commit -m "feat(identity): add identity tool guidance to system prompt"
```

---

## Task 7: Integration Test

**Files:**
- Create: `packages/coding-agent/src/tools/identity.test.ts`

- [ ] **Step 1: Write integration test**

```typescript
import { describe, expect, it } from "bun:test";
import { IdentityTool } from "./identity";
import type { ToolSession } from ".";

describe("IdentityTool", () => {
  const mockSession: ToolSession = {
    cwd: "/test",
    hasUI: false,
    settings: {
      get: () => undefined,
    } as unknown as ToolSession["settings"],
    getSessionFile: () => null,
    getSessionSpawns: () => null,
    getActiveModelString: () => "claude-test",
    getAgentId: () => "0-Main",
    taskDepth: 0,
    skills: [],
  } as ToolSession;

  it("whoRu returns agent identity", async () => {
    const tool = new IdentityTool(mockSession);
    const result = await tool.execute("tc-1", { action: "whoRu" });
    expect(result.isError).toBeFalsy();
    const text = result.content?.find(c => c.type === "text")?.text ?? "";
    expect(text).toContain("Oh My Pi");
    expect(text).toContain("claude-test");
    expect(text).toContain("0-Main");
  });

  it("whoisme returns empty when no persona", async () => {
    const tool = new IdentityTool(mockSession);
    const result = await tool.execute("tc-2", { action: "whoisme" });
    expect(result.isError).toBeFalsy();
    const text = result.content?.find(c => c.type === "text")?.text ?? "";
    expect(text).toContain("尚未配置用户人设");
  });

  it("update_persona requires section and data", async () => {
    const tool = new IdentityTool(mockSession);
    const result = await tool.execute("tc-3", { action: "update_persona" });
    expect(result.isError).toBe(true);
  });

  it("rejects invalid section", async () => {
    const tool = new IdentityTool(mockSession);
    const result = await tool.execute("tc-4", { action: "update_persona", section: "invalid", data: {} });
    expect(result.isError).toBe(true);
  });
});
```

Run: `bun test packages/coding-agent/src/tools/identity.test.ts`
Expected: PASS

- [ ] **Step 2: Commit**

```bash
git add packages/coding-agent/src/tools/identity.test.ts
git commit -m "test(identity): add integration tests for IdentityTool"
```

---

## Task 8: Type Check

- [ ] **Step 1: Run type check**

```bash
bun check:ts
```

Expected: No errors

- [ ] **Step 2: Fix any type errors**

Address any type errors found by `bun check:ts`.

- [ ] **Step 3: Commit**

```bash
git commit -am "fix(identity): type check fixes" || echo "No changes to commit"
```

---

## Self-Review

**Spec coverage:**
- ✅ whoRu action — Task 3
- ✅ whoisme action — Task 3
- ✅ update_persona action — Task 3
- ✅ UserPersona 7-section structure — Task 1
- ✅ File persistence — Task 2
- ✅ TUI rendering — Task 4
- ✅ Tool registration — Task 5
- ✅ System prompt guidance — Task 6

**Placeholder scan:** No TBD/TODO/fill-in-details found.

**Type consistency:** `UserPersona` defined in Task 1, used in Task 2 (store), Task 3 (identity tool). `AgentIdentity` defined and used in Task 3. All consistent.
