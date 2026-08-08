# omp-cn（@oh-my-pi/pi-coding-agent）

这是 oh-my-pi-cn 仓库中编程代理的核心实现包，也是中文本地化 CLI 的主要代码目录。

本分支由 yequ172672 维护，B 站 ID 为 夜曲_flac，对外发布的本地化 CLI 包名为
[omp-cn](https://www.npmjs.com/package/omp-cn)。内部 workspace 包名仍保持为
@oh-my-pi/pi-coding-agent，以维持源码导入和上游兼容性。

本包基于 [can1357/oh-my-pi](https://github.com/can1357/oh-my-pi)，重点维护设置中心、
供应商配置、首次启动向导、随机提示和常用 CLI 文案的简体中文本地化。上游原作者
Mario Zechner、Can Bölük 及其版权信息保留不变，项目继续使用 MIT 协议。

安装、供应商配置、模型角色、斜杠命令和完整 CLI 参考见：

- [仓库 README（本地）](../../README.md)
- [仓库 README（GitHub）](https://github.com/yequ172672/oh-my-pi-cn#readme)

本软件包的其他参考资料：

- [变更日志](./CHANGELOG.md)
- [MCP 配置指南](../../docs/mcp-config.md)
- [MCP 运行时生命周期](../../docs/mcp-runtime-lifecycle.md)
- [MCP 服务器和工具开发](../../docs/mcp-server-tool-authoring.md)
- [开发说明](./DEVELOPMENT.md)

## 记忆后端

代理支持三种互斥的记忆后端，由 memory.backend 设置选择（设置 → 记忆，或 ~/.omp/config.yml）：

- off（默认）：不运行记忆子系统；
- local：使用现有的会话摘要流程，将 memory_summary.md 和汇总产物写入代理目录；
- hindsight：连接 [Hindsight](https://hindsight.vectorize.io) 服务器（云服务或自托管 Docker），每隔若干个用户回合保存记录，在会话第一回合召回记忆，并提供 retain、recall 和 reflect 工具。

### Hindsight 快速开始

1. 运行 Hindsight 服务器：可以使用云服务，也可以执行 docker run -p 8888:8888 ghcr.io/vectorize-io/hindsight:latest。
2. 设置 memory.backend = hindsight，并将 hindsight.apiUrl 设置为 http://localhost:8888 或你的云服务地址。
3. 可选的环境变量覆盖项（环境变量优先于设置）：
   - HINDSIGHT_API_URL、HINDSIGHT_API_TOKEN：连接信息；
   - HINDSIGHT_BANK_ID、HINDSIGHT_DYNAMIC_BANK_ID、HINDSIGHT_AGENT_NAME：记忆库地址；
   - HINDSIGHT_AUTO_RECALL、HINDSIGHT_AUTO_RETAIN、HINDSIGHT_RETAIN_MODE：生命周期；
   - HINDSIGHT_RECALL_BUDGET、HINDSIGHT_RECALL_MAX_TOKENS：召回规模；
   - HINDSIGHT_BANK_MISSION、HINDSIGHT_DEBUG：记忆库任务和调试选项。

在会话中切换后端会立即替换当前后端、记忆工具、监听器和系统提示词上下文。已有用户的 memories.enabled = true 或 false 配置只会在首次启动时迁移一次，分别转换为 memory.backend = local 或 off；之后 memory.backend 将成为唯一的运行时选择器。
