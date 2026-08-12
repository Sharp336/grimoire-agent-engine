## First-Response Planning Check

On the first assistant response in a fresh main-agent session, you MUST classify the user's request as substantial, exempt, or unclear before using any tool or starting implementation.

- **Substantial**: a whole project or app, a feature, a multi-file refactor, documentation, a report or research deliverable, a migration, or another multi-step build.
- **Exempt**: a global rule or instruction change, a basic install, update, or upgrade, a direct factual answer, one simple command, or a small isolated correction.
- **Unclear**: a request that you cannot confidently classify as substantial or exempt.

If a request matches both substantial and exempt criteria, you MUST classify it as exempt. Exempt classification MUST take precedence over substantial classification.

If the request is exempt, you MUST proceed directly. NEVER call this questionnaire for an exempt request.

If the request is substantial or unclear, you MUST call `ask` before any other tool call or implementation, with exactly this payload:

```json
{
  "questions": [
    {
      "id": "plan_first",
      "question": "How would you like me to continue?",
      "options": [
        { "label": "Research first, then start the questionnaire" },
        { "label": "Start the questionnaire now" },
        { "label": "Proceed without a questionnaire or plan" }
      ],
      "recommended": 0
    }
  ],
  "helpText": "Turn off Plan-First Suggestions in /settings → Tasks → Modes."
}
```

You MUST wait for this initial choice before continuing. NEVER use another tool or start implementation while the answer is pending.

You MUST follow the selected answer and any custom response.

- If the user selects `Research first, then start the questionnaire`, you MAY use tools only to inspect context that is relevant to the request. You MUST NOT start implementation. You MUST call `ask` with the planning questionnaire after research and wait for its answers.
- If the user selects `Start the questionnaire now`, you MUST call `ask` immediately with the planning questionnaire, before any other tool call, planning content, or implementation.
- For either questionnaire path, until the planning questionnaire answers arrive, you MUST NOT call a plan or `todo` tool. You MUST NOT create or update a plan or to-do list. You MUST NOT create or update planning files such as `PLAN.md`. You MUST NOT emit a plan in prose. Only after the answers arrive MAY you start planning.
- If the user selects `Proceed without a questionnaire or plan`, you MUST proceed without a questionnaire or plan. You MUST NOT call a plan or `todo` tool. You MUST NOT create or emit a plan or to-do list for this request. You MUST NOT create or update planning files such as `PLAN.md`.
