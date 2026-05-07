# IM Gateway — 独立包实现计划

## 架构决策

**独立包 `packages/pi-gateway/`**，不是 omp 子命令。理由：
- 独立守护进程，omp 挂了不影响 IM 连接
- 可以独立部署、版本管理、依赖隔离
- 符合 Hermes/OpenClaw 行业标准

## 包结构

```
packages/pi-gateway/
  package.json
  src/
    index.ts              # 入口点，启动 gateway
    cli.ts                # CLI 入口 (pi-gateway start/status/config)
    gateway.ts            # Gateway 核心：管理 channels、sessions、消息路由
    config.ts             # 配置加载 (~/.pi/gateway.json)
    session-store.ts      # SQLite 会话存储 (per-user)
    channels/
      index.ts            # Channel 注册表
      channel.ts          # Channel 接口定义
      dingtalk/
        index.ts          # 钉钉 Channel 插件
        stream-client.ts  # DingTalk Stream WebSocket 连接
        message-handler.ts # 消息收发处理
    agent-bridge.ts       # 与 omp agent 通信的桥接层
    types.ts              # 共享类型定义
  test/
    channels/dingtalk.test.ts
    session-store.test.ts
```

## 核心接口

```typescript
// Channel 接口 — 所有 IM 平台必须实现
interface Channel {
  readonly id: string;    // 'dingtalk', 'feishu', 'wechat'
  readonly name: string;
  
  connect(config: ChannelConfig): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;
  
  // 收消息 → 转给 Gateway
  onMessage(handler: (msg: InboundMessage) => Promise<void>): void;
  
  // 发消息 ← 来自 Gateway
  sendMessage(msg: OutboundMessage): Promise<void>;
}

// 消息格式
interface InboundMessage {
  channelId: string;
  userId: string;
  userName?: string;
  conversationId: string;
  isGroup: boolean;
  content: TextContent | ImageContent | FileContent;
  timestamp: Date;
}

interface OutboundMessage {
  channelId: string;
  conversationId: string;
  content: TextContent | MarkdownContent;
  replyTo?: string;
}
```

## 数据流

```
[钉钉用户] → [Stream WS] → [DingTalk Channel] → [Gateway] → [Session Store]
                                                        ↓
                                                   [Agent Bridge] → [omp agent]
                                                        ↓
[钉钉回复] ← [Stream WS] ← [DingTalk Channel] ← [Gateway] ← [Agent Bridge] ← [agent response]
```

## Gateway 工作流程

1. **启动**: 加载配置 → 初始化 Session Store → 连接所有 enabled channels
2. **收消息**: Channel.onMessage → Gateway 查找/创建 session → 转发给 agent bridge
3. **Agent 处理**: Agent Bridge 启动 omp agent 会话（或复用）→ agent 执行 → 返回结果
4. **回消息**: Gateway 查找原始 channel → Channel.sendMessage → 回复到 IM

## Session 存储 (SQLite)

```sql
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_message_id TEXT,
  UNIQUE(channel_id, conversation_id)
);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL,  -- 'user' | 'assistant' | 'system'
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY(session_id) REFERENCES sessions(id)
);
```

## 钉钉 Stream 模式实现

```typescript
// 使用官方 dingtalk-stream SDK 或自建 WebSocket
// SDK: npm install dingtalk-stream
// 或直接 WebSocket 连接到 wss://api.dingtalk.com/v1.0/gateway/...

class DingTalkChannel implements Channel {
  #client: DWClient | null = null;
  #messageHandler: ((msg: InboundMessage) => Promise<void>) | null = null;
  
  async connect(config: DingTalkConfig) {
    this.#client = new DWClient({
      clientId: config.appKey,
      clientSecret: config.appSecret,
    });
    
    this.#client.registerCallbackListener('/v1.0/im/bot/messages/get', 
      async (request) => {
        // 解析钉钉消息 → 标准 InboundMessage
        const msg = this.#parseDingTalkMessage(request);
        await this.#messageHandler?.(msg);
        // 通过 sessionWebhook 回复
        return {};
      }
    );
    
    await this.#client.connect();
  }
  
  async sendMessage(msg: OutboundMessage) {
    // 使用 sessionWebhook 或 REST API 发送
    await fetch(msg.sessionWebhook || this.#buildSendUrl(msg), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        msgtype: 'markdown',
        markdown: { title: '消息', text: msg.content.text },
      }),
    });
  }
}
```

## 配置格式 (~/.pi/gateway.json)

```json
{
  "channels": {
    "dingtalk": {
      "enabled": true,
      "appKey": "dingxxxxxxxxx",
      "appSecret": "xxxxxxxxx",
      "allowedUsers": ["user1", "user2"]
    }
  },
  "agent": {
    "ompPath": "~/.local/bin/omp",
    "model": "claude-sonnet-4-5",
    "maxConcurrentSessions": 3
  },
  "session": {
    "idleTimeoutMinutes": 60,
    "resetPolicy": "daily"
  }
}
```

## 实施阶段

### Phase 1: 包脚手架
1. 创建 `packages/pi-gateway/` 目录结构
2. package.json, tsconfig.json
3. 定义核心接口 (Channel, Message, Gateway)
4. CLI 入口 (start/status/config)

### Phase 2: Session Store + Gateway 核心
1. SQLite session 存储
2. Gateway 消息路由逻辑
3. Channel 注册表

### Phase 3: 钉钉 Channel
1. DingTalk Stream WebSocket 连接
2. 消息解析 (文本/图片/文件)
3. 消息发送 (sessionWebhook + REST API fallback)
4. 用户白名单

### Phase 4: Agent Bridge
1. 启动 omp agent 会话
2. 消息双向转发
3. 流式输出转发

### Phase 5: 测试 + 文档
1. 单元测试
2. 集成测试 (mock DingTalk API)
3. 配置文档
