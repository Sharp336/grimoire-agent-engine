# whoRu & whoisme 功能设计文档

## 背景与目标

在 Oh My Pi 编码智能体系统中，用户需要一种方式来了解：
- **whoRu（你是谁）**：当前正在交互的智能体是谁，它具备什么能力
- **whoisme（我是谁）**：系统对用户的了解程度，基于历史会话构建的用户画像

此功能通过新增工具实现，既支持自然语言对话触发，也支持子智能体程序化调用。

## 架构设计

### 组件关系

```
┌─────────────────────────────────────────────────────────────┐
│                     用户输入层                               │
│  "你是谁"/"我是谁" 或子智能体调用                             │
└──────────────────────────┬──────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────┐
│                  IdentityTool (新增)                         │
│  ┌─────────────┐    ┌─────────────┐                         │
│  │   whoami    │    │  whoareyou  │                         │
│  │  (agent)    │    │   (user)    │                         │
│  └──────┬──────┘    └──────┬──────┘                         │
└─────────┼──────────────────┼────────────────────────────────┘
          │                  │
          │                  │
┌─────────▼──────┐  ┌────────▼────────────────────────┐
│   ToolSession  │  │   ProfileStore                   │
│  - agentId     │  │   (self-evolution)               │
│  - agentRegistry│  │  - toolFrequency                 │
│  - skills      │  │  - preferredLanguages            │
│  - taskDepth   │  │  - errorRate                     │
│  - model       │  │  - sessionCount                  │
└────────────────┘  └──────────────────────────────────┘
```

### 设计原则

1. **复用现有基础设施**：直接使用 `ToolSession`、`ProfileStore`、`AgentRegistry`，不新建存储层
2. **实时准确**：`whoami` 返回当前会话的实时状态；`whoareyou` 返回最新持久化的用户画像
3. **结构化返回**：工具返回 JSON 结构，便于智能体进一步处理或展示
4. **最小侵入性**：仅新增一个工具类，注册到 `BUILTIN_TOOLS`，在 system prompt 中添加一句引导

## 数据模型

### AgentIdentity（whoami 返回）

```typescript
interface AgentIdentity {
  /** 智能体标识，如 "0-Main" */
  agentId: string;
  /** 显示名称 */
  displayName: string;
  /** 当前使用的模型 */
  model: string;
  /** 会话递归深度 (0=顶层) */
  taskDepth: number;
  /** 当前工作目录 */
  cwd: string;
  /** 可用工具列表 */
  availableTools: string[];
  /** 已加载的 skills */
  skills: string[];
  /** 会话ID */
  sessionId?: string;
  /** 父智能体ID（如果是子智能体）*/
  parentAgentId?: string;
}
```

### UserIdentity（whoareyou 返回）

复用现有的 `UserProfile` 类型（位于 `packages/self-evolution/src/types.ts`）：

```typescript
interface UserIdentity {
  /** 总会话数 */
  sessionCount: number;
  /** 每次会话平均工具调用数 */
  avgToolCallsPerSession: number;
  /** 每次会话平均修改文件数 */
  avgFilesModifiedPerSession: number;
  /** 错误率 (0-1) */
  errorRate: number;
  /** 恢复率 (0-1) */
  recoveryRate: number;
  /** 偏好语言列表 */
  preferredLanguages: string[];
  /** 工具使用频率 */
  toolFrequency: Record<string, number>;
  /** 意图分布 */
  intentDistribution: Record<string, number>;
  /** 画像最后更新时间 */
  updatedAt: number;
}
```

## API 设计

### 工具 Schema

新增一个 `identity` 工具，内部通过 `action` 参数区分两个子命令：

```json
{
  "name": "identity",
  "description": "Query identity information about the current agent or the user.",
  "parameters": {
    "type": "object",
    "properties": {
      "action": {
        "type": "string",
        "enum": ["whoami", "whoareyou"],
        "description": "whoami: get current agent identity; whoareyou: get user profile"
      }
    },
    "required": ["action"]
  }
}
```

### 返回格式

工具返回 `AgentToolResult`，内容包含格式化文本 + 结构化 details：

```typescript
interface IdentityResult {
  action: "whoami" | "whoareyou";
  data: AgentIdentity | UserIdentity;
}
```

## 实现细节

### 文件变更清单

1. **新增** `packages/coding-agent/src/tools/identity.ts` — 工具实现
2. **新增** `packages/coding-agent/src/prompts/tools/identity.md` — 工具描述模板
3. **修改** `packages/coding-agent/src/tools/index.ts` — 注册到 BUILTIN_TOOLS
4. **修改** `packages/coding-agent/src/tools/renderers.ts` — 添加 TUI 渲染器
5. **修改** `packages/coding-agent/src/prompts/system/system-prompt.md` — 添加引导语

### 关键实现点

#### 1. whoami 数据收集

从 `ToolSession` 提取：
- `session.agentId` / `session.agentRegistry` → agentId
- `session.getActiveModelString()` → model
- `session.taskDepth` → taskDepth
- `session.cwd` → cwd
- `session.getSessionId()` → sessionId
- 工具列表从当前会话的可用工具推导
- `session.skills` → skills 名称列表

#### 2. whoareyou 数据收集

通过 `session.settings` 获取 self-evolution 的 `ProfileStore`：
- 用户 ID 使用 "default"（与现有 `/evolution-profile` 命令一致）
- 如果画像不存在，返回友好提示（"还没有足够的数据，多使用几次后会自动生成画像"）

#### 3. TUI 渲染

为两个 action 分别设计渲染格式：

**whoami 渲染示例**：
```
Identity
├─ Agent: 0-Main
├─ Model: claude-sonnet-4-20250514
├─ Depth: 0 (top-level)
├─ CWD: /Users/xxx/project
├─ Tools: read, edit, bash, python, task (32 total)
└─ Skills: gitnexus-exploring, test-driven-development, systematic-debugging
```

**whoareyou 渲染示例**：
```
User Profile
├─ Sessions: 47
├─ Avg tools/session: 8.3
├─ Avg files/session: 3.1
├─ Error rate: 4%
├─ Recovery rate: 92%
├─ Languages: typescript, rust, python
├─ Top tools: edit(156), search(89), bash(72)
└─ Intents: refactoring(12), testing(8), debugging(7)
```

#### 4. System Prompt 引导

在 system prompt 的 `<tools>` 相关段落中追加：

> When the user asks about identity ("who are you", "what can you do", "tell me about yourself"), invoke `identity` with `action: "whoami"`. When the user asks about their own profile or history ("who am I", "what do you know about me", "my stats"), invoke `identity` with `action: "whoareyou"`.

## 测试策略

### 单元测试

1. **whoami 测试**：
   - 验证能正确从 ToolSession 提取所有字段
   - 验证 agentId 缺省时的降级处理
   - 验证 skills 为空时的处理

2. **whoareyou 测试**：
   - 验证 ProfileStore 返回有效画像时的输出
   - 验证 ProfileStore 返回 undefined 时的友好提示
   - 验证工具频率排序（Top 5）

3. **渲染器测试**：
   - 验证 whoami 渲染输出格式
   - 验证 whoareyou 渲染输出格式
   - 验证错误状态的渲染

### 集成测试

1. 注册到工具系统后，验证工具能被正确创建和调用
2. 验证 system prompt 引导语能被正确渲染（检查模板变量）

## 风险与缓解

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| ProfileStore 未初始化（self-evolution 未启用） | whoareyou 无法获取数据 | 检测 `ProfileStore` 可用性，不可用时返回"用户画像功能未启用"提示 |
| AgentRegistry 中无当前 agent 信息 | whoami 部分字段缺失 | 所有字段都有降级默认值（如 agentId 回退到 "unknown"） |
| 工具名称冲突 | 与其他工具重名 | 工具名使用 "identity"，较为独特，冲突概率低 |
| 信息泄露风险 | 用户画像包含敏感行为数据 | 画像数据仅本地存储（SQLite），不传输；工具仅在用户主动询问时调用 |

## 与现有功能的对比

| 功能 | 现有方式 | 新增方式 | 关系 |
|------|----------|----------|------|
| 查看用户画像 | `/evolution-profile` 命令 | `identity` 工具（whoareyou） | 新增工具调用方式，数据同源 |
| 查看智能体信息 | IRC 列表（agent registry） | `identity` 工具（whoami） | 新增面向用户的查询方式 |
| 自然语言询问身份 | 智能体基于 prompt 猜测 | 结构化工具查询 + 智能体回答 | 更准确、可复用 |

## 后续扩展（非本次范围）

1. **跨智能体查询**：扩展 whoami 支持查询其他智能体（`agentId` 参数）
2. **实时状态**：whoami 增加当前正在执行的工具、待办事项状态
3. **用户画像增强**：whoareyou 增加最近会话摘要、常用工作流模式
