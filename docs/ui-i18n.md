# UI i18n (English + 简体中文)

omp ships a lightweight gettext-style UI catalog.

## Design

| Rule | Detail |
|------|--------|
| Source language | English strings are the keys |
| Lookup | `t("Settings")` → `"设置"` when `ui.language` is `zh-CN` |
| Fallback | Missing keys return the English source unchanged |
| Interpolation | `t("{n} matches", { n: 3 })` |
| Dependencies | None (no i18next) |

## User setting

`ui.language` (Settings → Appearance → Theme → **Language**):

- `system` (default) — follow `LANG` / `LC_ALL` (`zh*` → 简体中文)
- `en` — English
- `zh-CN` — Simplified Chinese

Config:

```yaml
ui:
  language: zh-CN
```

## Code

```ts
import { t, applyUiLanguage } from "../i18n";

// Static UI copy
out.push(topBorder(width, t("Settings")));

// Settings schema labels are localized at adapter time
// (see modes/components/settings-defs.ts)
```

Catalog: `packages/coding-agent/src/i18n/locales/zh-CN.generated.ts`  
Core: `packages/coding-agent/src/i18n/index.ts`

## Adding strings

1. Use English in source: `t("My new label")`.
2. Add the same English key → Chinese value to the zh-CN catalog.
3. Prefer `t()` at render / adapter boundaries so schema English stays readable.

## Out of scope (follow-ups)

- Full slash-command dynamic status templates
- CLI `--help` extraction
- Plural rules / ICU
- Additional locales (ja, ko, …)

## CJK display note

`packages/tui` writes UTF-8 via `Buffer.from(data, "utf8")` on the stdout path so Bun’s string fast-path cannot double-encode CJK under some WSL hosts.
