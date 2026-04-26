<system-reminder>
The conversation above is complete context. Do not re-read files, run tools, or restate progress — write the handoff document now.

Write a comprehensive handoff document for another instance of yourself. The handoff **MUST** be sufficient for seamless continuation without access to this conversation. Output ONLY the handoff document. No preamble, no commentary, no wrapper text, no tool calls.

Capture exact technical state, not abstractions. Include concrete file paths, symbol names, commands run, test results, observed failures, decisions made, and any partial work that materially affects the next step.

Use exactly this structure:

## Goal
[What the user is trying to accomplish]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned]

## Progress
### Done
- [x] [Completed tasks with specifics]

### In Progress
- [ ] [Current work if any]

### Pending
- [ ] [Tasks mentioned but not started]

## Key Decisions
- **[Decision]**: [Rationale]

## Critical Context
- [Code snippets, file paths, function/type names, error messages, or data essential to continue]
- [Repository state if relevant]

## Summary
[Omit section if both subsections are empty.]

### Prior sessions
[Omit if no `<handoff-context>` was provided.]
Compress the previous summary into fewer, higher-level lines. Merge related entries. Drop entries no longer relevant. Retain key attempts, conclusions, and dead ends that prevent loops. Details belong in other sections — this tracks trajectory only.
Format: flat bullet list, one terse line per entry.

### This session
Add entries for approaches taken, angles explored, and conclusions reached that other sections don't capture. Avoid repeating file paths or details already in Progress or Critical Context.
Format: flat bullet list, one terse line per entry.

## Next Steps
1. [What should happen next]
{{#if additionalFocus}}
Additional focus: {{additionalFocus}}
{{/if}}
</system-reminder>
