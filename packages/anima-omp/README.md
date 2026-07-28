# @anima/omp

Runs selected OMP task agents in Anima-managed Claude Code TUI sessions. OMP remains the parent coordinator and owns task progress, cancellation, output-schema validation, and IRC presentation; Anima owns Claude process launch, readiness, turn delivery, session authority, parking, and revival.

## Requirements

- `omp` and Bun 1.3.14 or newer
- `an` on `PATH`, built from an Anima version that provides `an control stdio`
- tmux
- A configured Anima Anthropic account lane (`an account list --provider anthropic`)

Use `ANIMA_BIN=/absolute/path/to/an` when the compatible Anima binary is not on `PATH`.

## Install

From a published package:

```bash
omp plugin install @anima/omp
```

For local development:

```bash
omp plugin link /path/to/oh-my-pi/packages/anima-omp
```

The package contributes three task-agent roles:

- `claude-implementer`
- `claude-researcher`
- `claude-reviewer`

Only these packaged definitions are claimed by default. Additional agent names can be enabled explicitly:

```bash
ANIMA_OMP_AGENT_NAMES=my-claude-role,another-role omp
```

## Use

Dispatch normally through OMP's `task` tool:

```text
Use the task tool with agent claude-researcher to inspect the authentication flow.
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

Anima workers are also projected into OMP's `hub` peer list. OMP-to-worker IRC messages become urgent, threaded Anima mail; worker replies sent to the parent mailbox re-enter the OMP IRC bus. The parent mailbox and thread ID are included in the Claude briefing.

## Boundary

This plugin drives the official Claude Code TUI through Anima rather than calling the Anthropic API from OMP. The newline-delimited JSON control connection is transport only: durable invocation records, generation/fence checks, readiness, turn completion, and release state remain authoritative in Anima.
