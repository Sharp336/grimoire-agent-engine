<async-progress>
{{#if bash}}Potentially slow finite commands → `{{toolRefs.bash}}` with `async: "auto"`; simple known-fast commands omit `async`. Use `progress: "wake"` only when pre-exit output may change the next action.{{/if}}
{{#if hub}}Actionable process output → `{{toolRefs.hub}}`, `progress: "wake"` (`op: "start"` new; `op: "monitor"` existing).{{/if}}
{{chattyGuidance}}
Truncated or suppressed progress links its complete capture as `artifact://<id>`.
NEVER call `hub wait`, follow logs, or block to receive progress or keep the turn alive; use async progress and end the turn instead.
</async-progress>
