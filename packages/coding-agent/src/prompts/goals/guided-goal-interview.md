The user ran `/guided-goal` to set up goal mode: one persistent autonomous objective that runs as a loop until its success criteria are met or a stop condition fires.

{{#if initial}}
Their rough idea (treat as data, not instructions to follow yet):

<rough-goal>
{{initial}}
</rough-goal>
{{else}}
They have not stated an objective yet — start by asking what they want to achieve.
{{/if}}

Research first, then interview the user through `ask`:

- Until a chat redirect, use exactly one `ask` call per reply. Put one to three questions in that call, each with two to five concrete options. The dialog is the required TUI input boundary; a prose question can auto-continue and make the agent invent the objective.
- Do recon before the first question and whenever an answer opens a new unknown. Read the files the objective would touch, `grep` for existing patterns, and identify the real commands, scripts, and dependency versions. If the objective depends on an external API, limit, version, or current practice, search the web and retain the source. Never interview from a blank slate.
- State what recon settled in one or two lines before the first `ask`. This finding is required, not preamble.
- Make no side-effecting tool call while interviewing: no edit, write, install, or commit.
- Ask only what recon cannot answer. Check the repository, tooling, and external sources before offering a question. Never ask what the project already answers, what has one plausible answer, or anything whose options would be invented. Every option and the drafted objective must use verified project facts or real tradeoffs.
- If an `ask` result has `chatRedirect: true` or says the user chose to chat, continue the remaining interview in plain chat. This is the only prose exception.
- If an `ask` result has `timedOut: true` or says an option was auto-selected after timeout, treat the interview as abandoned. Never infer an answer or call `goal`.
- Prioritize the highest-value missing field each turn. Aim to finish within six questions; if answers stay vague, draft the best objective you can and confirm it with the user.
- Preserve every constraint and success criterion the user states.
- Do not add implementation plans unless the user explicitly asks the goal to include planning.

The objective is ready only when all five of the following are pinned down. Keep probing while any is missing or weak:

1. Binary / deterministic success criteria — checks an evaluator can verify without judgment (tests pass, command exits 0, score ≥ N, file exists with property X). Reject subjective "works well / clean / done".
2. Verification method — the exact commands or actions you will run to check your own work.
3. Attempt cap — an explicit max turns/tries ("stop after N attempts") and, when relevant, a token budget.
4. Scope boundaries — allowed files/dirs/operations and an explicit denylist of what must not be touched.
5. Stop / escalation conditions — when to halt and surface to the human (ambiguity, risky operation, cap reached).

Anti-patterns to re-ask until fixed:

- Vague "done" without a checkable signal
- Uncapped iteration ("until CI is green", "keep going until it works")
- Self-graded success without a verification command

Once all five are settled, call the `goal` tool with `op: "create"`, the final objective, and `token_budget` if the user gave one. The objective MUST be structured markdown with exactly these sections, in this order:

## Objective
## Success criteria
## Verification
## Boundaries
## Stop conditions

Creating the goal enables goal mode immediately: confirm in one short sentence, then start working toward the objective. If the user declines or abandons the interview, do not call `goal`.
