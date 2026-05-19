# Tool Approval Policies

Control which tools require your confirmation before running.

## Why This Exists

By default, the coding agent can run destructive commands (bash, file edits, etc.) without asking. This feature lets you:
- **Require confirmation** for dangerous operations
- **Auto-allow** trusted tools to speed up workflows
- **Block** specific tools entirely

## Quick Examples

```bash
# Bypass all approvals (automation mode)
omp --auto-approve -p "Fix all TypeScript errors"

# Configure specific tools (interactive mode only)
omp config set tools.approval.bash allow     # Never ask for bash
omp config set tools.approval.write prompt   # Always ask for writes  
omp config set tools.approval.browser deny   # Block browser (in interactive mode)
```

Or edit `~/.omp/agent/config.yml`:

```yaml
tools:
  approval:
    bash: allow        # Trust all bash commands
    write: prompt      # Ask before writing files
    browser: deny      # Block browser in interactive mode
```

**Note:** These policies only apply in interactive mode. With `--auto-approve` / `--yolo` or in headless mode, all tools execute regardless of policy.

## Policy Values

| Value | Behavior (Interactive Mode) | Behavior (--yolo / Headless) |
|-------|----------|----------|
| `allow` | Never prompt, always run | Same - always run |
| `prompt` | Ask for confirmation each time | Bypassed - auto-executes |
| `deny` | Block entirely, throw error | Bypassed - executes anyway |

**Key insight:** Approval policies only work in interactive mode (with UI, without `--auto-approve`). In automation/headless mode, all policies are ignored.

## Built-in Defaults

Tools have sensible defaults so you don't need to configure everything:

| Tool Type | Default | Examples |
|-----------|---------|----------|
| **Read-only** | `allow` | read, find, search, web_search |
| **Destructive** | `prompt` | bash, write, edit, debug, browser |
| **External** | `prompt` | MCP tools, custom extensions |

## How Approval Decisions Are Made

When a tool is about to run, the system checks policies in this order (first match wins):

### 1. Your Explicit Blocks (Interactive Mode Only)
**In interactive mode, if you set a tool to `deny`, it's completely blocked.**

```yaml
tools:
  approval:
    bash: deny  # Blocks ALL bash in interactive mode
```

Even safe commands like `ls` are blocked. Even dangerous patterns that would normally just prompt are blocked.

**Important:** Deny policies only work in interactive mode (with UI, without `--auto-approve`). In headless or `--yolo` mode, deny is bypassed and tools execute anyway.

---

### 2. Built-in Safety Rules (Interactive Mode Only)
**When running interactively with UI, dangerous bash patterns require confirmation**, even if you allowlisted bash.

Example: Critical bash patterns like `rm -rf /`, `sudo rm`, fork bombs.

```yaml
tools:
  approval:
    bash: allow  # You trust bash in general
```

**But** if the agent tries `rm -rf /` in interactive mode, you still get a prompt. Safety rules override `allow` (but not `deny`).

**Important:** Safety rules are **completely bypassed** when:
- Using `--auto-approve` / `--yolo` flags (automation mode)
- Running in headless/non-UI mode (API usage, background jobs)

If you need safety enforcement in automation or headless mode, implement it via hooks (see "Security Considerations" section).

---

### 3. Your Tool-Specific Settings
**Your config for individual tools.**

```yaml
tools:
  approval:
    bash: allow     # Trust bash (except safety rules above)
    write: prompt   # Always ask before writes
```

---

### 4. Smart Auto-Allows
**Some operations are so harmless and frequent, they're auto-allowed even if you set the tool to `prompt`.**

Example: LSP read-only operations (hover tooltips, diagnostics, find references).

```yaml
tools:
  approval:
    lsp: prompt  # You want approval for LSP in general
```

**But** hovering over a variable or checking diagnostics won't prompt. Those operations:
- Are read-only (can't break anything)
- Fire constantly (dozens per minute while coding)
- Would make the UI unusable if they prompted

However, LSP renames and code actions **will** still prompt because they modify code.

---

### 5. Built-in Tool Defaults
**If you haven't configured a tool, use its built-in default** (see table above).

Example: You haven't configured `bash`, so it uses its default (`prompt`).

---

### 6. Your Global Default
**Set a fallback for all unknown/external tools.**

```yaml
tools:
  approval:
    _default: allow  # Trust everything by default
    risky-mcp-tool: prompt  # Override specific external tool
```

This is useful for MCP tools or custom extensions where you don't want to configure each one individually.

---

### 7. System Fallback (Last Resort)
**If nothing else matched, default to `prompt`** (safe choice).

## Special Cases

### Critical Bash Patterns

In **interactive mode** (UI available, without `--auto-approve`), these patterns **always prompt** even when bash is set to `allow`:

```bash
rm -rf /           # Root deletion
sudo rm -rf        # Root deletion with sudo
:(){ :|:& };:      # Fork bomb
chmod -R 777 /     # Dangerous permissions
curl ... | bash    # Pipe to shell execution
```

**Why?** These can destroy your system. The agent forces confirmation as a safety net.

**Important caveats:**
- If you set `bash: deny` in interactive mode, it's blocked with an error
- If you use `--auto-approve` / `--yolo`, **even deny policies are bypassed** - everything executes
- In headless/non-UI mode, **even deny policies are bypassed** - everything executes

**For automation safety:** If you need pattern blocking in `--auto-approve` or headless mode, implement it via hooks (see examples in `docs/hooks.md`).

### LSP Read-Only Operations

These **never prompt** even with `lsp: prompt`:

- `diagnostics` — Error checking
- `hover` — Tooltip info
- `references` — Find usages
- `definition` — Jump to definition
- `implementation` — Find implementations

**Why?** These fire constantly (dozens per minute while coding). Prompting would make the editor unusable.

**Operations that DO prompt:**
- `rename` — Modifies code
- `code_actions` — May modify code
- `format` — Modifies formatting

### Headless/Non-Interactive Mode

**When running without a UI** (API usage, background jobs, CI/CD):
- Approval is **completely bypassed** (functionally identical to `--auto-approve`)
- All tools execute without prompting, including:
  - Tools set to `prompt` → execute without asking
  - Tools set to `deny` → execute anyway (deny NOT enforced)
  - Critical bash patterns like `rm -rf /` → execute without confirmation
- Prevents breaking automated workflows

**For user-facing automation**, use `--auto-approve`:

```bash
# CLI automation (bypasses approval even in interactive terminal)
omp --auto-approve --no-session -p "Run tests"
omp --yolo -p "Update dependencies"  # Same as --auto-approve

# SDK usage
await session.prompt("Fix errors", { autoApprove: true });
```

**Security note:** Headless mode and `--auto-approve` are **functionally identical** - both skip the entire approval system via the same code path. Neither mode enforces any policies (allow, prompt, or deny). If you need safety checks in automation, implement them via hooks (see \"Security Considerations\" section).

## Configuration Examples

### Local Development (Permissive)

```yaml
# .omp/config.yml (project-local)
tools:
  approval:
    bash: allow
    write: allow
    edit: allow
    # Still protected by critical pattern safety rules
```

### Shared/Production Environment (Restrictive)

```yaml
# ~/.omp/agent/config.yml (user-global)
tools:
  approval:
    bash: prompt      # Always ask
    browser: deny     # Never allow automation
    write: prompt     # Confirm file changes
```

### Automation Workflow

```yaml
# For CI/CD, use --auto-approve instead of config
# (safer than permanently allowlisting in config)
```

```bash
# GitHub Actions
omp --auto-approve --no-session -p "Run tests and fix linting"

# Cron job  
omp --yolo -p "Update dependencies"
```

### External Tools (MCP/Extensions)

```yaml
tools:
  approval:
    _default: prompt        # Unknown tools require approval
    github-mcp: allow       # Trust specific MCP server
    database-tool: deny     # Block specific extension
```

## Migrating from Custom Extensions

If you used custom approval extensions (like `confirm-destructive.ts`), you can remove them:

**Old way** (extension):
```typescript
// ~/.omp/agent/extensions/confirm-destructive.ts
const ALLOWED_TOOLS = ["read", "find", "search"];
// ...custom logic...
```

**New way** (built-in config):
```yaml
# ~/.omp/agent/config.yml
tools:
  approval:
    bash: prompt
    write: prompt
    # read/find/search already allowed by default
```

## Troubleshooting

### "Tool requires approval but no UI available"

**Cause:** Running in non-interactive mode (RPC, JSON, headless)

**Fix:** Add `--auto-approve` flag or set `tools.approval.<tool>: allow`

### Prompts for harmless operations

**Cause:** External/MCP tool not recognized as read-only

**Fix:**
```yaml
tools:
  approval:
    my-readonly-tool: allow
```

### Critical patterns still prompt despite allowlist

**This is intentional.** Safety rules override `allow` for patterns like `rm -rf /`.

**To bypass:** Use `--auto-approve` flag (accepts responsibility for all commands)

### Tool blocked unexpectedly

**Check:** Did you set the tool to `deny`? This completely blocks it.

**Fix:** Change to `prompt` or `allow`

## Security Considerations

### What Bypasses Safety Checks

**ALL approval enforcement is completely bypassed when:**
1. Using `--auto-approve` or `--yolo` flags
2. Running in headless/non-UI mode (API usage, background jobs, RPC, CLI utilities)

**In these modes:**
- Critical pattern detection disabled (`rm -rf /` executes without prompt)
- Prompt policies treated as allow (everything auto-executes)
- **Deny policies are NOT enforced** (even explicitly denied tools execute)

**`--yolo` means YOLO** - zero safety checks, total trust mode.

### Automation Safety

If you need safety checks in automation or headless mode:

```typescript
// Hook example: ~/.omp/agent/extensions/safety-check.ts
import type { HookAPI } from "@oh-my-pi/pi-coding-agent";

export default function (pi: HookAPI) {
  pi.on("tool_call", async (event) => {
    if (event.toolName !== "bash") return;
    const cmd = String(event.input.command ?? "");
    
    if (/rm\s+-rf\s+\//.test(cmd)) {
      return { block: true, reason: "safety-check: rm -rf / blocked" };
    }
  });
}
```

Hooks run in **all modes** (interactive, headless, auto-approve), giving you universal enforcement.

### Best Practices

- **`--auto-approve` is for trusted workflows only** — use with caution
- **Review your allowlists regularly** — tools you trusted 6 months ago might be risky now
- **Critical patterns only protect interactive mode** — don't rely on them for automation
- **External tools (MCP, extensions) default to prompt** — you must explicitly trust them
- **For CI/CD safety:** Implement blocking via hooks, not approval policies

## Summary: How to Think About It

1. **Start with defaults**: Most tools have sensible defaults (read-only → allow, destructive → prompt)
2. **Allowlist trusted tools**: Set frequently-used tools to `allow` for your workflow
3. **Safety nets in interactive mode only**: Critical bash patterns prompt in interactive mode (but not with `--auto-approve` or headless)
4. **Deny only works in interactive mode**: Setting `deny` blocks in interactive sessions, but is bypassed in `--auto-approve` or headless
5. **Automation is zero-trust bypass**: `--auto-approve` and headless mode skip ALL checks (even deny); use hooks for enforcement

## See Also

- [Configuration Reference](config.md)
- [Custom Tools](custom-tools.md)
- [Extensions](extensions.md)
- GitHub Issue [#1030](https://github.com/can1357/oh-my-pi/issues/1030)
