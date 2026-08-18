# Reduce-motion runtime evidence

## Surface

The real source CLI was driven in tmux from this worktree with:

```sh
secrets ANTHROPIC_API_KEY OPENAI_API_KEY GEMINI_API_KEY -- bun packages/coding-agent/src/cli.ts --reduce-motion <level>
```

The prompt instructed the agent to invoke `bash sleep 8`, creating a visible live tool spinner.

## Observed frames

Two `tmux capture-pane` snapshots one second apart during the baseline tool run showed different frames:

```text
⠧ Sleeping 8 seconds ⟦esc⟧
⠏ Sleeping 8 seconds ⟦esc⟧
```

Two snapshots one second apart during the strict-mode tool run showed the same frozen frame:

```text
⠋ Sleeping 8 seconds ⟦esc⟧
⠋ Sleeping 8 seconds ⟦esc⟧
```

The source CLI accepted `--reduce-motion strict`, reached the real Anthropic-backed interactive session, and executed the tool. Both tmux sessions were explicitly killed after capture. External configured MCP connection failures were displayed but did not prevent the agent or tool run.
