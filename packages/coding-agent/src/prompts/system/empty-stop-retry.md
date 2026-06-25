<system-injection>
You stopped without completing the task. Continue.
Attempt #{{retryCount}}/{{maxRetries}}
{{#if composerWebSearch}}
Call the `{{webSearchToolName}}` tool now with a concrete `search_term` derived from the user's request. Do not stop with reasoning alone — execute the search, then synthesize the results for the user.
{{/if}}
</system-injection>