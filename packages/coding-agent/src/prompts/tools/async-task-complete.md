<async-task-complete task_id="{{taskId}}" agent="{{agent}}" status="{{status}}" duration="{{duration}}">
Task "{{description}}" {{statusMessage}}{{#if resultCount}} {{resultCount}} result(s) available. Use check_task with id "{{taskId}}" for details.{{/if}}{{#if error}} Error: {{error}}{{/if}}
</async-task-complete>
