Start one managed event source whose intermediate output matters.

Use a command source for newline-delimited shell output or a WebSocket source for text/binary frames. Output must flush line by line; use line-buffered filters such as `grep --line-buffered` when needed. Do not use `tail -f` as a success detector unless the filter has an explicit exit or failure signature.

Use `bash` with `async: true` for one-shot background work where only completion matters. After starting a monitor, do not poll or sleep: relevant events wake the agent automatically. Keep filters selective because sustained noisy output automatically stops the monitor. Stop a monitor with `hub` (`op: "cancel"`, `ids: [jobId]`).
