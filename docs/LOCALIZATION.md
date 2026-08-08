# 本地化维护指南

本分支以 `upstream/main` 为上游基线，`origin/main` 为分叉发布分支。英文是默认语言和资源基线，简体中文通过 `packages/coding-agent/src/i18n/` 提供覆盖。

## 语言行为

- 默认语言为 English（`en`）。
- 在交互 TUI 中使用 `/language` 查看当前语言。
- 使用 `/language en` 或 `/language zh-CN` 切换语言，也接受 `english`、`中文` 等常用别名。
- 选择会写入当前 OMP profile 的 `config.yml`，下次启动继续生效。
- 未翻译的文本保留英文，避免破坏错误详情、模型输出、插件自定义内容和命令参数。

## 同步上游

每次同步前确认工作区干净，并单独记录本地化改动：

```powershell
git fetch upstream --prune
git switch main
git diff --stat upstream/main...HEAD
git merge upstream/main
```

合并冲突时优先保留上游的业务逻辑，再重新接回本地化边界：

1. `src/i18n/` 中的语言类型、资源和翻译测试属于本分支维护内容。
2. `config/settings-schema.ts` 中的 `language` 字段必须保留。
3. `main.ts`、`settings.ts`、`builtin-registry.ts`、`available-commands.ts`、`acp-builtins.ts`、`ui-helpers.ts` 和设置面板中的本地化调用必须保留。
4. 上游新增用户可见英文时，先保留英文作为 fallback，再在 `zh-CN` 资源中增加对应翻译；不要把业务逻辑复制到中文分支。

合并后执行：

```powershell
bun check
bun test packages/coding-agent/test/i18n.test.ts
git diff --check
```

## 设置页翻译

设置页的标签、分组、选项和描述来自 `packages/coding-agent/src/config/settings-schema.ts`，对应中文资源集中在 `packages/coding-agent/src/i18n/locales/zh-CN-settings.ts`。设置行使用原始配置值进行交互，同时通过 `SettingItem.valueLabels` 显示本地化值，因此翻译不会把 `true`、`high` 等显示文本写回配置文件。

上游新增设置时，先保留英文 fallback，再补充设置资源；如果新增的是枚举值，同时确认主列表和子菜单都使用了中文显示标签。

## 添加翻译

新增用户可见文本时，优先使用 `t()` 的稳定键；对已有的大量英文出口使用 `localizeUiText()` 作为兼容层。英文资源表达默认行为，中文资源只覆盖同一个键或同一条英文 UI 文本。动态错误详情、路径、模型名、插件名和用户输入必须作为变量或 fallback 保持原样。

完成翻译后，至少验证：启动时配置语言、`/language` 切换、命令自动补全描述、设置面板、错误/警告/状态消息，以及非交互模式不受影响。
