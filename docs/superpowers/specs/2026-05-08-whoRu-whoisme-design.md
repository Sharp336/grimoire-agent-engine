# whoRu & whoisme 功能设计文档

## 背景与目标

在 Oh My Pi 编码智能体系统中，用户需要一种方式来了解：
- **whoRu（你是谁）**：当前正在交互的智能体是谁，它具备什么能力、它的工作风格和约束是什么
- **whoisme（我是谁）**：用户自己的完整画像模板，用于让 agent 深度理解用户偏好、习惯、风格和约束

此功能通过新增工具实现，既支持自然语言对话触发，也支持子智能体程序化调用。

## 核心概念澄清

| 功能 | 数据来源 | 内容性质 |
|------|----------|----------|
| **whoisme** | 用户主动填写的人设模板 | 静态配置：用户的个人信息、职业、偏好、风格、约束等 |
| **whoRu** | 系统运行时状态 + 静态配置 | 动态+静态：agent 的能力、当前配置、工作风格、约束规则 |

> 注意：`whoisme` 不是 self-evolution 自动生成的行为统计画像，而是用户主动维护的**人设模板**。

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
│  │   whoRu     │    │  whoisme    │                         │
│  │  (agent)    │    │   (user)    │                         │
│  └──────┬──────┘    └──────┬──────┘                         │
└─────────┼──────────────────┼────────────────────────────────┘
          │                  │
          │                  │
┌─────────▼──────┐  ┌────────▼────────────────────────┐
│   ToolSession  │  │   UserPersonaStore (新增)        │
│  - agentId     │  │   用户人设模板持久化              │
│  - agentRegistry│  │  - 基础个人信息                  │
│  - skills      │  │  - 职业与身份画像                │
│  - taskDepth   │  │  - 关注话题图谱                  │
│  - model       │  │  - 喜好与风格特质                │
│  - cwd         │  │  - 交互对话习惯                  │
│  - tools       │  │  - 思维决策模式                  │
│                │  │  - Agent专属约束                 │
└────────────────┘  └──────────────────────────────────┘
```

### 设计原则

1. **whoisme 是用户主动维护的人设模板**：不是自动统计，而是用户填写/编辑的结构化配置
2. **whoRu 是 agent 的自我介绍**：结合系统静态配置（能力声明、风格定义）和运行时状态（当前模型、工具列表）
3. **复用现有基础设施**：`ToolSession` 提供 whoRu 的运行时数据；whoisme 需要新增轻量级存储
4. **结构化返回**：工具返回 JSON 结构，便于智能体进一步处理或展示
5. **可编辑**：用户可以通过命令或工具调用更新 whoisme 模板

## 数据模型

### whoisme — 用户人设模板

存储位置：`~/.omp/persona.json`（或其他配置目录）

```typescript
interface UserPersona {
  version: "1.0";
  updatedAt: number;

  // 一、基础个人信息
  basics: {
    gender?: string;
    birthday?: string;        // 格式：MM/DD 或 YYYY-MM-DD
    zodiac?: string;
    mbti?: string;
    lifeStage?: string;       // 成家/育儿/创业/职场中层/学生等
    location?: string;        // 地域与生活环境
    pace?: string;            // 急性子/慢节奏/高效极简/细致拆解
    languageStyle?: string;   // 直白/文艺/严谨/随性、常用语气
  };

  // 二、职业与身份画像
  career: {
    industry?: string;
    role?: string;            // 核心岗位
    dailyWork?: string;       // 核心业务/日常工作内容
    expertise?: string[];     // 知识储备领域
    lifeGoal?: string;        // 当前人生主线目标
    thinkingPattern?: string; // 工科逻辑/商业战略/人文思辨等
  };

  // 三、关注话题图谱
  interests: {
    longTerm: string[];       // 长期高频关注领域
    shortTerm: string[];      // 短期临时兴趣
    avoid: string[];          // 避坑排斥话题
    priorities: string[];     // 学习/探索优先级排序
  };

  // 四、喜好与风格特质
  preferences: {
    contentType?: string;     // 干货/故事/文案/技术/生活闲聊
    communicationStyle?: string; // 简洁直白/详细拆解/温柔共情/逻辑严谨
    outputFormat?: string;    // 拒绝废话/精准可落地/要原理/只要步骤
    contentStyle?: string;    // 理性硬核/极简干练/文艺走心/务实落地
    tolerance?: string;       // 容忍轻度啰嗦/要求零冗余直给
    hobbies?: string[];       // 日常喜好
  };

  // 五、交互对话习惯
  interaction: {
    commonCommands?: string[];   // 常用指令话术
    replyStyle?: string;         // 口语化/专业书面/技术极简
    proactive?: boolean;         // 是否允许 Agent 主动延伸
    errorHandling?: string;      // 直接给修复方案 / 先分析原因再给方案
  };

  // 六、思维决策模式
  thinking: {
    workStyle?: string;       // 先框架后细节 / 直接落地试错
    choicePreference?: string; // 性价比/安全可控/长期价值/极简效率
    logicHabit?: string;      // 分层拆解/对比表格/流程图可视化
    riskAppetite?: string;    // 保守稳健/探索尝新/中性
  };

  // 七、Agent专属约束
  constraints: {
    forbidden: string[];      // 禁止行为：幻觉/过度延展/鸡汤说教/偏离话题
    formatRules?: string;     // 必带分点/必用表格/禁用长篇大段
    memoryRules?: string;     // 需要长期记忆的内容/临时对话无需留存
    accuracyRules?: string;   // 技术类严格按官方文档/生活类口语化分步/不夸大不杜撰
  };
}
```

### whoRu — 智能体身份

```typescript
interface AgentIdentity {
  /** 智能体名称 */
  name: string;
  /** 角色定位 */
  role: string;
  /** 基于什么模型 */
  model: string;
  /** 当前会话标识 */
  agentId: string;
  /** 会话深度 (0=顶层主agent) */
  taskDepth: number;
  /** 当前工作目录 */
  cwd: string;
  /** 可用工具数量及列表 */
  availableTools: string[];
  /** 已加载技能 */
  skills: string[];
  /** 核心能力描述 */
  capabilities: string[];
  /** 工作风格 */
  workStyle: string;
  /** 当前约束规则 */
  constraints: string[];
}
```

> **注**：whoRu 的具体输出模板需要用户确认。以下是一个基于 Oh My Pi 系统特性的参考模板：

```
# Oh My Pi 智能助手

## 身份定位
- 名称：Oh My Pi（OMP）
- 角色：你的全栈编码搭档与技术顾问
- 形态：基于 Claude 大模型的 AI 编程智能体

## 当前配置
- 模型：{{model}}
- 会话：{{agentId}} | 深度 {{taskDepth}}
- 工作目录：{{cwd}}

## 核心能力
- 代码操作：读取、编辑、重构、搜索、批量替换
- 运行时：执行 Bash 命令、Python 脚本、Node.js
- 代码智能：AST 分析、LSP 语义查询、类型检查
- 项目管理：任务拆分、并行子智能体、待办追踪
- 外部集成：GitHub、Web 搜索、浏览器、MCP 服务器
- 架构分析：GitNexus 代码知识图谱、路由/工具映射

## 工作风格
- 简洁直接，拒绝废话
- 先理解问题，再给出方案
- 高 agency，主动推进而非等待指令
- 严谨验证，不编造信息

## 当前状态
- 可用工具：{{toolCount}} 个
- 已加载技能：{{skills}}
- 活跃 MCP 服务器：{{mcpServers}}
```

## API 设计

### 工具 Schema

新增一个 `identity` 工具，内部通过 `action` 参数区分子命令：

```json
{
  "name": "identity",
  "description": "Query or update identity information. whoRu returns agent self-introduction. whoisme returns or updates user persona.",
  "parameters": {
    "type": "object",
    "properties": {
      "action": {
        "type": "string",
        "enum": ["whoRu", "whoisme", "update_persona"],
        "description": "whoRu: agent identity; whoisme: user persona; update_persona: update user persona fields"
      },
      "section": {
        "type": "string",
        "description": "For update_persona: which section to update (basics/career/interests/preferences/interaction/thinking/constraints)"
      },
      "data": {
        "type": "object",
        "description": "For update_persona: partial persona data to merge"
      }
    },
    "required": ["action"]
  }
}
```

### 返回格式

```typescript
interface IdentityResult {
  action: "whoRu" | "whoisme" | "update_persona";
  // whoRu → AgentIdentity
  // whoisme → UserPersona
  // update_persona → { success: boolean, updatedFields: string[] }
  data: AgentIdentity | UserPersona | UpdateResult;
}
```

## 实现细节

### 文件变更清单

1. **新增** `packages/coding-agent/src/tools/identity.ts` — 工具实现
2. **新增** `packages/coding-agent/src/prompts/tools/identity.md` — 工具描述模板
3. **新增** `packages/coding-agent/src/persona/` — 用户人设存储模块
   - `types.ts` — UserPersona 类型定义
   - `store.ts` — PersonaStore 接口及文件系统实现
4. **修改** `packages/coding-agent/src/tools/index.ts` — 注册到 BUILTIN_TOOLS
5. **修改** `packages/coding-agent/src/tools/renderers.ts` — 添加 TUI 渲染器
6. **修改** `packages/coding-agent/src/prompts/system/system-prompt.md` — 添加引导语

### 关键实现点

#### 1. whoRu 数据收集

从 `ToolSession` 提取运行时信息：
- `session.agentId` → agentId
- `session.getActiveModelString()` → model
- `session.taskDepth` → taskDepth
- `session.cwd` → cwd
- 工具列表从当前会话可用工具推导
- `session.skills` → skills 名称列表

静态信息来自系统配置：
- 核心能力列表（内置，与工具列表对应）
- 工作风格（从 system prompt 的 `<behavior>` 提取或内置）
- 约束规则（从 system prompt 的 `<contract>` 提取或内置）

#### 2. whoisme 数据收集

通过 `PersonaStore` 读取：
- 存储位置：`~/.omp/persona.json`
- 如果不存在，返回空模板 + 引导用户填写的提示
- 支持增量更新（只更新指定 section）

#### 3. update_persona 数据更新

- 接收 `section` + `data` 参数
- 读取现有 persona，合并新数据
- 写回文件
- 返回更新成功的字段列表

#### 4. TUI 渲染

**whoRu 渲染**：按用户确认后的模板格式渲染（当前为参考模板，待确认）

**whoisme 渲染**：按七个大类分层渲染

```
User Persona
├─ Basics
│  ├─ Gender: male
│  ├─ MBTI: INTJ
│  └─ Pace: 急性子，高效极简
├─ Career
│  ├─ Industry: 互联网
│  └─ Role: 全栈工程师
├─ Interests
│  ├─ Long-term: AI, 系统架构, 开源
│  └─ Avoid: 职场八卦, 成功学
...
```

**update_persona 渲染**：
```
Persona Updated
├─ Section: basics
└─ Fields: gender, mbti, pace
```

#### 5. System Prompt 引导

在 system prompt 中追加：

> When the user asks about identity ("你是谁", "who are you", "what can you do"), invoke `identity` with `action: "whoRu"`. When the user asks about themselves ("我是谁", "who am I", "what do you know about me"), invoke `identity` with `action: "whoisme"`. If the user wants to update their persona ("更新我的人设", "修改我的偏好"), invoke `identity` with `action: "update_persona"`.

## 测试策略

### 单元测试

1. **whoRu 测试**：
   - 验证能正确从 ToolSession 提取运行时字段
   - 验证 agentId 缺省时的降级处理
   - 验证工具列表推导正确

2. **whoisme 测试**：
   - 验证能正确读取 persona.json
   - 验证文件不存在时返回空模板
   - 验证返回数据结构符合 UserPersona 接口

3. **update_persona 测试**：
   - 验证增量更新（只改指定 section）
   - 验证创建新文件（首次更新）
   - 验证无效 section 的错误处理

4. **渲染器测试**：
   - 验证 whoRu 渲染输出格式
   - 验证 whoisme 七层结构渲染
   - 验证 update_persona 成功/失败渲染

### 集成测试

1. 注册到工具系统后，验证工具能被正确创建和调用
2. 验证 persona.json 的读写持久化
3. 验证 system prompt 引导语能被正确渲染

## 风险与缓解

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| persona.json 格式升级 | 旧版本数据不兼容 | `version` 字段 + 迁移逻辑 |
| 用户不填写 whoisme | 功能形同虚设 | 首次调用时主动引导填写，提供示例模板 |
| whoRu 模板不符合用户期望 | 输出不满意 | 模板可配置，用户可自定义 |
| 敏感个人信息存储 | 隐私顾虑 | 数据仅本地存储（JSON 文件），不上传 |
| 人设过于冗长影响上下文 | token 占用 | 提供"精简模式"，只输出关键字段 |

## 与现有功能的对比

| 功能 | 现有方式 | 新增方式 | 关系 |
|------|----------|----------|------|
| 查看用户统计 | `/evolution-profile` 命令 | `identity` 工具（whoisme） | 完全不同：evolution-profile 是行为统计，whoisme 是人设模板 |
| 查看智能体信息 | IRC 列表（agent registry） | `identity` 工具（whoRu） | 新增面向用户的结构化查询 |
| 自然语言询问身份 | 智能体基于 prompt 猜测 | 结构化工具查询 + 智能体回答 | 更准确、可复用、可配置 |

## 待确认事项

1. **whoRu 输出模板**：当前文档中的模板为参考方案，需要用户确认或提供自己的版本
2. **whoisme 初始值**：是否提供一份默认模板供用户参考修改？
3. **存储位置**：`~/.omp/persona.json` 是否合适？
4. **编辑方式**：除了 `update_persona` 工具，是否需要 CLI 命令（如 `/persona-edit`）？

## 后续扩展（非本次范围）

1. **whoisme 自动填充**：基于 self-evolution 的行为统计，自动推断部分字段（如常用工具、偏好语言）并建议填入
2. **多角色切换**：支持多套人设模板（工作/个人/项目A/项目B），按需切换
3. **whoRu 自定义模板**：允许用户自定义 agent 自我介绍模板
4. **导入导出**：支持从 JSON/YAML 文件导入/导出 persona
