# Tool Approval Policies

Per-tool approval policies allow fine-grained control over which tools require user confirmation before execution.

## Overview

By default:
- **Read-only tools** (read, find, search, ast_grep, web_search) are auto-allowed
- **Destructive tools** (bash, write, edit, ast_edit, debug, browser, eval) require approval
- **External/custom tools** (MCP, extensions) require approval
- **LSP tool** requires approval by default, but read-only actions (diagnostics, hover, references) are exempted
- **Critical bash patterns** always prompt, even if bash is allowlisted (safety override)

### Action-Based Exceptions

Some tools have **action-based exceptions** that apply policy based on specific inputs:

**LSP Tool** (performance optimization):
- Default policy: `prompt`
- Exception: read-only actions → auto-allowed
- Result: `diagnostics`, `hover`, `references` don't prompt; `rename`, `code_actions` do prompt

**Bash Tool** (safety override):
- Default policy: `prompt`
- Exception: critical patterns → force prompt (overrides user config)
- Result: `rm -rf /`, `sudo rm`, fork bombs always prompt, even with `bash: allow`

## Quick Start

### Bypass all approvals for automation

```bash
omp --auto-approve -p "Fix all TypeScript errors"
omp --yolo -p "Refactor the auth module"
```

### Configure per-tool policies

Add to `~/.omp/agent/config.yml` or `.omp/config.yml`:

```yaml
tools:
  approval:
    bash: allow        # Never prompt for bash
    write: prompt      # Always prompt for write (default)
    edit: allow        # Never prompt for edit
    custom-tool: deny  # Block a custom tool entirely
```

## Configuration

### Policy Values

- `allow` — Auto-approve (never prompt)
- `deny` — Block the tool entirely (throws error)
- `prompt` — Require user confirmation (default for destructive tools)

### Resolution Order

Policy resolution follows this precedence (first match wins):

1. **Explicit user deny** (`tools.approval.<toolName>: deny`)
   - Absolute block - cannot be overridden by any exception
   - Example: `bash: deny` blocks ALL bash commands, even safe ones
2. **Overriding exceptions** (safety rules with `override: true`)
   - Example: Critical bash patterns force `prompt` even if user sets `bash: allow`
3. **User config for specific tool** (`tools.approval.<toolName>: allow|prompt`)
4. **Non-overriding exceptions** (performance optimizations)
   - Example: LSP read-only actions auto-allowed even with `lsp: prompt`
5. **Built-in default for tool** (see `DEFAULT_APPROVAL_POLICIES` in code)
6. **User's `_default` override** (`tools.approval._default`)
7. **System-wide fallback** (`prompt`)

### Unknown/External Tools

Tools not in the built-in registry (MCP tools, custom extensions) fall back to:
1. User's `_default` policy if set
2. System default (`prompt`)

Example:
```yaml
tools:
  approval:
    _default: allow  # Auto-approve all unknown tools
    risky-mcp-tool: prompt  # Override specific tool
```

### Critical Pattern Override

Dangerous bash patterns **always** prompt when set to `allow`, regardless of policy:

```bash
rm -rf /
sudo rm -rf
:(){ :|:& };:
chmod -R 777 /
```

These patterns force confirmation even if `tools.approval.bash: allow` is set.

**Important**: If you set `bash: deny`, ALL bash commands are blocked, including safe ones. Explicit `deny` is absolute and cannot be overridden by any exception.

## Non-Interactive Mode

When running without a UI (headless sessions, internal tool invocations, SDK usage without UI context):

- **Approval is automatically skipped** (tools are auto-allowed)
- This prevents breaking internal/background workflows
- For user-facing workflows without UI, use `--auto-approve`:

```bash
# CLI automation mode
omp --auto-approve --no-session -p "Run tests"

# SDK usage
await session.prompt("Fix errors", { autoApprove: true });
```

**Security note**: Headless sessions are considered trusted. If you need approval enforcement in headless mode, implement it at the orchestration layer (e.g., CI/CD approval gates).

## Automated Workflows

For CI/CD or scripted workflows, use `--auto-approve`:

```bash
# GitHub Actions
omp --auto-approve --no-session -p "Run tests and fix linting"

# Cron job
omp --yolo -p "Update dependencies and commit"
```

## Security Considerations

- **Trust your prompts**: `--auto-approve` bypasses all safety checks
- **Review allowlists**: Regularly audit `tools.approval` config
- **Critical patterns**: Cannot be disabled (this is intentional)
- **External tools**: Require approval by default (no built-in allowlist)

## Examples

### Allow bash and write for local development

```yaml
# .omp/config.yml (project-local)
tools:
  approval:
    bash: allow
    write: allow
```

### Deny browser tool in shared environments

```yaml
# ~/.omp/agent/config.yml (user-global)
tools:
  approval:
    browser: deny
```

### Selective automation

```bash
# Auto-approve for known-safe operations
omp --auto-approve --tools read,find,grep -p "Analyze codebase"

# Manual approval for destructive changes
omp -p "Refactor authentication module"
```

## Migration from Extensions

If you previously used a custom extension for approval (e.g., `confirm-destructive.ts`), you can:

1. **Remove the extension** — built-in approval supersedes it
2. **Migrate allowlists** — convert extension config to `tools.approval.*`
3. **Test behavior** — verify prompts appear as expected

Example migration:

```typescript
// Old extension: ~/.omp/agent/extensions/confirm-destructive.ts
const ALLOWED_TOOLS = ["read", "find", "search"];

// New config: ~/.omp/agent/config.yml
tools:
  approval:
    bash: prompt
    write: prompt
    edit: prompt
    # read/find/search already auto-allowed by default
```

## Troubleshooting

### "Tool requires approval but no UI available"

**Problem**: Running in non-interactive mode (RPC, JSON, headless)

**Solution**:
- Add `--auto-approve` flag, or
- Set `tools.approval.<tool>: allow` in config

### Prompts appear for read-only tools

**Problem**: Custom or MCP tools may not be recognized as read-only

**Solution**:
```yaml
tools:
  approval:
    custom-readonly-tool: allow
```

### Critical pattern bypass attempt

**Problem**: `rm -rf /` prompts even though bash is allowlisted

**Behavior**: **This is intentional**. Critical patterns cannot be auto-approved.

## See Also

- [Configuration Reference](config.md)
- [Custom Tools](custom-tools.md)
- [Extensions](extensions.md)
- GitHub Issue [#1030](https://github.com/can1357/oh-my-pi/issues/1030)
