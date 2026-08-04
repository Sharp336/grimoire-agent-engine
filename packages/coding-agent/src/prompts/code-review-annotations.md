{{#if forReviewer}}
## Operator-Supplied Review Focus

You MUST verify every annotation against the diff and surrounding code. NEVER repeat an operator note without independently validating it.
{{else}}
## Code Review Annotations
{{/if}}

{{#list annotations join="\n\n"}}
### {{pathLabel}} — {{lineLabel}}

Hunk: `{{hunkHeader}}`

{{#codeblock lang="diff"}}
{{rawLine}}
{{/codeblock}}

{{note}}
{{/list}}
{{#if supplementalInstructions}}

## Supplemental Review Instructions

{{supplementalInstructions}}
{{/if}}
