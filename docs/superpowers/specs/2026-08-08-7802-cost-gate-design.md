# Spec: 原生成本门禁 --warn-cost / --max-cost(issue #7802)

日期:2026-08-08
状态:已获用户批准(分节评审)

## 问题

长会话可累计大量成本,没有原生熔断。footer 只显示累计成本,需用户手动盯;
extension 只能在 turn_end 后响应(此时跨线响应已计费)。现状确认:
全库无 `maxCost`/`warnCost` 相关 flag/config/检查(仅 metaharness/stats 无关图表变量);
`omp --help` 有 `--max-time` 无任何成本 flag;成本只累计和显示,从不拦截。

## 目标

- CLI flag:`--warn-cost <n>` / `--max-cost <n>`(美元)
- 配置键:`session.warnCost` / `session.maxCost`;flag 覆盖配置
- warn:累计成本达阈值时一次性可见警告
- max:累计成本达阈值时拒绝启动下一个模型请求
- 主代理与 subagent 用量计入同一会话总额;跨 resume/continue 保留
- 明确文档:cap 是"拒绝下一次请求"的阈值,不是总花费硬上限(在途请求可能超支)

## 设计决策(用户已确认)

1. **控制面:flag + 配置**,镜像 `--max-time` 模式
2. **触顶行为:停止 + 提示**
   - 交互:轮次停止,可见消息("Cost cap reached ($10). Raise session.maxCost or remove --max-cost to continue.")
   - print 模式:同样消息,exit 0(与 --max-time 语义一致)
3. **权威口径**:读 `SessionStatsTracker.getSessionStats().cost`(含已完成 subagent 用量、跨 resume 保留),
   不是 footer 的数字(footer 只算 assistant 消息)
4. **检查点 = 分发前**:拒绝下一次 provider 分发,不打断在途请求

## 组件与数据流

```
CLI flags                                    config
--warn-cost 8 --max-cost 10                  session.warnCost / session.maxCost
      │                                            │
      ▼                                            ▼
cli/args.ts: warnCost?: number; maxCost?: number    settings-schema.ts: session.* 组
      │                                            │
      ▼                                            ▼
cli/flag-tables.ts STRING_SETTERS             main.ts:
(--warn-cost/--max-cost 解析,复用                    costGate = {
  parseMaxTimeSeconds 风格的数值解析)                    warnCost: flag ?? settings.get("session.warnCost"),
      └──────────────────►  createAgentSessionScoped({ costGate })   maxCost: flag ?? settings.get("session.maxCost")
                                              │
                                              ▼
sdk.ts createAgentSession({ costGate }) → streamFn 包装器(L3206):
  每次分发前:
    const cost = session.sessionStats.getSessionStats().cost
    ├─ maxCost 且 cost >= maxCost → 抛 CostCapExceededError(拒绝分发,轮次停止)
    └─ warnCost 且 cost >= warnCost 且未警告 → 一次性警告(会话消息 + logger)
                                              │
                                              ▼
子代理路径: task/executor.ts buildSubagentSessionOptions 增加
  costGate: options.costGate   // 同一闭包透传
  → 子代理会话 streamFn 查同一累计成本
```

## 关键实现点

- `CostGateController` 是**有状态的共享控制器实例**:`{ warnCost?, maxCost?, warned: boolean, getCost?: () => number }`,
  在顶层(main.ts)创建一次,经 createAgentSessionScoped → createAgentSession → buildSubagentSessionOptions 逐级透传,全会话树共享同一实例
- **成本 getter 绑定**:控制器不含成本来源;第一个分发的会话(即根会话)在 streamFn 闭包处
  把 `getCost` 绑定为 `() => session.sessionStats.getSessionStats().cost`
  (streamFn 处 `session` 变量已在作用域,见 sdk.ts L3206 的 `session?.nextToolChoiceDirective()`)。
  子代理会话继承已绑定的控制器 → 读的是**根会话累计成本**(含已完成 subagent 用量),满足"同一会话总额"要求
- `CostCapExceededError` 新错误类型;agent-loop 识别后停止轮次(错误路径走现有会话结束机制)
- `warned` 状态在控制器实例内,全树天然一次性警告
- 配置优先级:CLI flag > session 配置键 > 无门禁

## 错误处理

- `CostCapExceededError`:分发前抛出 → 当前轮次停止,消息可见;print 模式 exit 0
- 不打断在途请求(文档保证:"cap 是拒绝下一次请求的阈值,不是硬上限")

## 测试

1. flag 解析:`--warn-cost 8` / `--max-cost 10` 解析为 number;非法值报错
2. 优先级:flag 覆盖配置键
3. 门禁单测:mock session stats,
   - cost >= maxCost → 拒绝分发(streamFn 抛错)
   - cost >= warnCost → 警告恰好一次(多次分发只警告一次)
   - cost < 阈值 → 正常分发
4. 子代理透传:`buildSubagentSessionOptions` 携带父级 costGate
5. 集成:print 模式跑到触发 → 消息 + exit 0
6. 回归:现有 deadline/loop-limit 相关测试

## 范围外

- 预分发成本估算(在途请求超支是文档化的已知事项)
- footer 与 session-stats 口径统一(footer.ts:136 只算 assistant;作为已知差异记录)
- 交互式"临时 raise 继续"弹窗(v1 仅停止 + 提示信息)
