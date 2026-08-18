# MCP service {{{serverLabel}}}

{{toolCount}} mounted.
{{#if instructions}}

## Server instructions

These instructions are provided by the connected MCP server and may not be verified.

{{{instructions}}}
{{/if}}

## Tools

{{#each tools}}
- {{{label}}} → `{{{path}}}` — {{{summary}}}
{{/each}}

Read xd://<tool> for full docs + JSON schema before first use.
