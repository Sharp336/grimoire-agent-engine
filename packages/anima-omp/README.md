# @anima/omp

Routes OMP parent turns and selected task agents through Anima-managed Claude Code TUI sessions. OMP remains the parent coordinator and owns task progress, cancellation, output-schema validation, and IRC presentation; Anima owns Claude process launch, readiness, turn delivery, session authority, parking, and revival.

## Requirements

- OMP host `@oh-my-pi/pi-coding-agent` and `@oh-my-pi/pi-ai >=17.2.0 <18`, plus Bun 1.3.14 or newer
- `an` on `PATH`, built from an Anima version that provides `an control stdio`
- tmux
- A configured Anima Anthropic account lane (`an account list --provider anthropic`)

The `17.2.0` lower bound is the publishing assumption for the first OMP release containing
`registerSubagentExecutor`, `getSubagentExecutorRegistry`, and the host IRC-bus integration used here. The patched
source workspace still identifies itself as `17.1.5`, but an unpatched published `17.1.5` is unsupported and is
intentionally excluded from the peer contract. If upstream assigns those APIs a different release number, update the
peer range before publishing this package.

Use `AN_BIN=/absolute/path/to/an` when the compatible Anima binary is not on `PATH`.

## Install

From a published package:

```bash
omp plugin install @anima/omp
```

For local development:

```bash
omp plugin link /path/to/oh-my-pi/packages/anima-omp
```

## Use

The package registers an `anima-claude` model provider with four rolling Claude Code aliases:

- `anima-claude/opus`
- `anima-claude/fable`
- `anima-claude/sonnet`
- `anima-claude/haiku`

Select one in OMP's normal `/model` screen or at launch:

```bash
omp --model anima-claude/opus
```

These are ordinary OMP model selections, but each turn runs in the official Claude Code TUI under Anima lifecycle and account control. The aliases let Claude Code resolve the current concrete model. Add concrete model IDs when an exact route is required:

```bash
ANIMA_OMP_CLAUDE_MODELS=claude-opus-5-20260701,claude-fable-5-20260701 omp
```

The package also contributes three task-agent roles:

- `anima-claude-opus`
- `anima-claude-haiku`
- `anima-claude-fable`

Only these packaged definitions are claimed by default. Additional agent names can be enabled explicitly:

```bash
ANIMA_OMP_AGENT_NAMES=my-claude-role,another-role omp
```

Dispatch normally through OMP's `task` tool:

```text
Use the task tool with agent anima-claude-haiku to inspect the authentication flow.
```

The task appears in OMP like any other subagent. Its work runs in the caller's working tree; the plugin does not create another worktree. OMP forwards the selected agent prompt, shared context, approved-plan reference, tool-capability description, model/effort route, output schema, cancellation signal, and timeout through the control protocol.

The default retention policy is `park`: Anima stops the Claude pane after the completed turn but retains the session so a follow-up can revive the same conversation. Use `keep` to leave the pane running between turns:

```bash
ANIMA_OMP_RETENTION=keep omp
```

Supported values are `park` and `keep`.

## Operator commands

Inside OMP:

```text
/anima status
/anima status <task-id>
/anima attach <task-id>
/anima message <task-id> <text>
/anima cancel <task-id>
/anima release <task-id>
```

`attach` prints the corresponding `an attach <session>` command for a second terminal. `message` sends a retained follow-up turn. `cancel` interrupts active work. `release` applies the configured retention policy.

Anima workers are also projected into OMP's `hub` peer list under the Anima session name shown by `/anima status` (for example, `omp-anima-claude-haiku-…`). OMP-to-worker IRC messages become urgent, threaded Anima mail. Each worker receives only an invocation-private `anima-omp-reply` command on `PATH`; the command fixes the authenticated sender and parent destination while accepting only body and reply/thread correlation fields.

## Boundary

This plugin drives the official Claude Code TUI through Anima rather than calling the Anthropic API from OMP. The newline-delimited JSON control connection is transport only: durable invocation records, generation/fence checks, readiness, turn completion, and release state remain authoritative in Anima.
