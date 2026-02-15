<async-task-complete task_id="{{taskId}}" agent="{{agent}}" status="{{status}}" duration="{{duration}}">
Task "{{description}}" {{statusMessage}}{{#if resultCount}} {{resultCount}} result(s) available. Call the check_task tool with task_id "{{taskId}}" to retrieve results.{{/if}}{{#if error}} Error: {{error}}{{/if}}
</async-task-complete>