<system-interrupt reason="tool_call_loop_detected">
You called `{{tool_name}}` with {{spread}} distinct argument sets without converging on an answer:
`{{arguments_summary}}`

This looks like wandering — probing many different inputs hoping one works, rather than making targeted progress.

NEVER call `{{tool_name}}` again this turn. Instead: run a web search to find the correct input, ask the user for the target, or summarize what you found and yield if complete.
</system-interrupt>
