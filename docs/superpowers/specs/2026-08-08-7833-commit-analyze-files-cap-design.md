# Spec: commit analyze_files 上限控制(issue #7833)

日期:2026-08-08
状态:已获用户批准(分节评审)

## 问题

`omp commit`(agentic 路径)对每个变更文件 spawn 一个 AnalyzeFile 子代理,无数量上限。
E2E 实测(deepseek-v4-flash, 2026-08-08):6 个文件 → 6 个真实子代理会话,共 $0.0293,
每个子代理携带 24k–43k input tokens 固定上下文(与 issue 报告的"每个子代理约 5 倍父会话上下文"一致)。
issue 请求者实测 fan-out 占总成本 90–96%。模型遵守 system.md 规则 5 只是自律,没有机械保障。

## 目标

- 持久设置控制 analyze_files 的开与关
- 持久设置控制单次 analyze_files 调用的文件数上限
- 默认行为不变(向后兼容)

## 设计决策(用户已确认)

1. **控制面:仅持久设置**(不做 CLI flag)
   - `commit.analyzeFiles`(boolean,默认 true)
   - `commit.analyzeFilesMaxFiles`(number,可选,不设置 = 无上限)
2. **超限行为:截断 + 可见警告**
   - 分析前 N 个文件;结果文本附加警告,列出被跳过的文件,模型可决定补一轮或继续
   - 不静默丢证据
3. **默认无上限**(保持现行为,opt-in 控制成本)
4. **dry-run 不特殊处理**(上限在 dry-run 与真实 commit 同样生效,共享同一工具)

## 组件与数据流

```
settings.yml
  commit.analyzeFiles          (bool, 默认 true)
  commit.analyzeFilesMaxFiles  (number, 可选)
        │
        ▼
packages/coding-agent/src/config/settings-schema.ts
  commit.* 组新增两键(现有 commit.mapReduce* 同组, L5474 附近)
        │
        ▼
commit/agentic/index.ts:136 → runCommitAgentSession input:
  CommitAgentInput 新增可选 maxAnalyzeFiles?: number
        │
        ▼
commit/agentic/agent.ts:55:
  enableAnalyzeFiles: settings.get("commit.analyzeFiles")   // 替换硬编码 true
  maxAnalyzeFiles: input.maxAnalyzeFiles
        │
        ▼
commit/agentic/tools/index.ts:
  CommitToolOptions 新增 maxAnalyzeFiles?: number(L23 现有 enableAnalyzeFiles 旁)
  透传给 createAnalyzeFileTool
        │
        ▼
commit/agentic/tools/analyze-file.ts:
  createAnalyzeFileTool({ maxFiles }) → execute():
    const files = maxFiles === undefined ? params.files : params.files.slice(0, maxFiles)
    分析 files;若被截断,结果文本附加:
    "warning: capped at N files; skipped: <余下文件名>"
```

## 关键实现点

- `enableAnalyzeFiles` 走现有管道:`tools/index.ts:34` 的 `options.enableAnalyzeFiles ?? true` 已支持 false,
  只需把 agent.ts 的硬编码换成 `settings.get("commit.analyzeFiles")`
- 截断在工具 `execute()` 内单点实现(analyze-file.ts),真实 commit 与 dry-run 共享此工具
- 上限按**单次调用**的文件数计(模型通常一次全传)
- `commit.analyzeFilesMaxFiles: 0` 等价禁用该工具(与 enableAnalyzeFiles=false 同效)

## 错误处理

- 无新错误类型
- 截断警告进入工具结果文本(模型可见);不抛错

## 测试

1. settings-schema:`commit.analyzeFiles` / `commit.analyzeFilesMaxFiles` 默认值与类型解析
2. 工具层(扩展现有 `test/issue-7833-analyze-files-fanout.test.ts` 模式,mock TaskTool):
   - 6 文件 + maxFiles=5 → 恰好 5 次 TaskTool.execute,警告包含被跳过的第 6 个文件名
   - maxFiles 未设置 → 不截断(向后兼容)
   - 6 文件 + maxFiles=0 → 0 次 execute
3. 接线:agent.ts 读 settings 传给 createCommitTools(extend `commit-agentic-attribution.test.ts` 模式)
4. 回归:现有 commit 相关测试(`commit-execute` 等)

## 范围外

- CLI flag(--analyze-files 等)
- dry-run 特殊行为
- 分派前的成本估算
