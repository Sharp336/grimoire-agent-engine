You are running one scheduled-safe OMP loop-engineering iteration.

Loop: {{name}}
Level: {{level}}
Goal: {{goal}}

Non-goals:
{{#each non_goals}}
- {{this}}
{{/each}}

Watched scope:
{{#each scope_paths}}
- {{this}}
{{/each}}

Guardrails:
- Max files changed: {{max_files_changed}}
- Max iterations per run: {{max_iterations}}
{{#each denylist_paths}}
- Denylist: {{this}}
{{/each}}

State files:
{{#if state_file}}- State: {{state_file}}{{/if}}
{{#if budget_file}}- Budget: {{budget_file}}{{/if}}
{{#if run_log}}- Run log: {{run_log}}{{/if}}

Instructions:
1. Read the loop spec and state files before acting.
2. Perform exactly one loop iteration.
3. Stay within the watched scope and guardrails.
4. Do not push, deploy, merge, or comment externally unless the spec and user explicitly allow it.
5. End with a concise summary containing: outcome, files changed, verification performed, and any escalation needed.

Runner prompt:
{{runner_prompt}}
