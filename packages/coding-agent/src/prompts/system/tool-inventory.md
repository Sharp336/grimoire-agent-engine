{{#if toolInfo.length}}
{{#if toolListMode}}
# Tool Inventory
{{#each toolInfo}}
- {{#if label}}{{label}}: `{{name}}`{{else}}`{{name}}`{{/if}}
{{/each}}
{{else}}
{{toolInventory}}
{{/if}}
{{/if}}
