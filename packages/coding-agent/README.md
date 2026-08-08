# omp-cn（@oh-my-pi/pi-coding-agent）

这是 `oh-my-pi-cn` monorepo 中 coding agent 的核心实现包，也是中文本地化 CLI 的主要代码目录。

本分支由 `yequ172672` 维护，B 站 ID 为 `夜曲_flac`，对外发布的本地化 CLI 包名为
[`omp-cn`](https://www.npmjs.com/package/omp-cn)。内部 workspace 包名仍保持为
`@oh-my-pi/pi-coding-agent`，以维持源码导入和上游兼容性。

本包基于 [can1357/oh-my-pi](https://github.com/can1357/oh-my-pi)，重点维护设置中心、
供应商配置、首次启动向导、随机提示和常用 CLI 文案的简体中文本地化。上游原作者
Mario Zechner、Can Bölük 及其版权信息保留不变，项目继续使用 MIT 协议。

安装、供应商配置、模型角色、斜杠命令和完整 CLI 参考见：

- [Monorepo README (local)](../../README.md)
- [Monorepo README (GitHub)](https://github.com/yequ172672/oh-my-pi-cn#readme)

Package-specific references:

- [CHANGELOG](./CHANGELOG.md)
- [MCP configuration guide](../../docs/mcp-config.md)
- [MCP runtime lifecycle](../../docs/mcp-runtime-lifecycle.md)
- [MCP server/tool authoring](../../docs/mcp-server-tool-authoring.md)
- [DEVELOPMENT](./DEVELOPMENT.md)

## Memory backends

The agent supports three mutually-exclusive memory backends, selected via the `memory.backend` setting (Settings → Memory tab, or `~/.omp/config.yml`):

- `off` (default) — no memory subsystem runs.
- `local` — existing rollout-summarisation pipeline; writes `memory_summary.md` and consolidated artifacts under the agent dir.
- `hindsight` — talks to a [Hindsight](https://hindsight.vectorize.io) server (Cloud or self-hosted Docker), retains transcripts every Nth user turn, recalls memories on the first turn of a session, and exposes `retain`, `recall`, and `reflect`.

### Hindsight quickstart

1. Run a Hindsight server (Cloud or `docker run -p 8888:8888 ghcr.io/vectorize-io/hindsight:latest`).
2. Set `memory.backend = "hindsight"` and `hindsight.apiUrl = "http://localhost:8888"` (or your Cloud URL).
3. Optional environment overrides (env wins over settings):
   - `HINDSIGHT_API_URL`, `HINDSIGHT_API_TOKEN` — connection
   - `HINDSIGHT_BANK_ID`, `HINDSIGHT_DYNAMIC_BANK_ID`, `HINDSIGHT_AGENT_NAME` — bank addressing
   - `HINDSIGHT_AUTO_RECALL`, `HINDSIGHT_AUTO_RETAIN`, `HINDSIGHT_RETAIN_MODE` — lifecycle
   - `HINDSIGHT_RECALL_BUDGET`, `HINDSIGHT_RECALL_MAX_TOKENS` — recall sizing
   - `HINDSIGHT_BANK_MISSION`, `HINDSIGHT_DEBUG`

Switching backends mid-session immediately replaces the live backend, memory tools, listeners, and system-prompt context. Existing users with `memories.enabled = true|false` are migrated to `memory.backend = "local"|"off"` exactly once on first launch; afterward, `memory.backend` is the sole runtime selector.
