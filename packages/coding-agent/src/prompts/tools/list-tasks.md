# List Tasks

List all async tasks in the current session with their status.

<instruction>
- Use this to see all running and completed tasks
- Results auto-deliver when tasks complete - do NOT use this to poll for results
- By default includes both running and completed/failed tasks
- Set `include_completed: false` to see only running tasks
- Returns task count and detailed status for each task
</instruction>

<output>
Returns a list of all tasks including:
- Task ID
- Current status (running, completed, failed, cancelled)
- Description
- Agent type
- Time since creation
</output>