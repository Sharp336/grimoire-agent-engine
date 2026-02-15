# List Tasks

List all async tasks in the current session. Use after spawning tasks with `task` tool using `async: true`.

<instruction>
- Call this to see all running, completed, and failed async tasks
- Returns task count and per-task details (ID, status, agent, description, time)
- Results auto-deliver when tasks complete — do NOT use this to poll for completion
- Set `include_completed: false` to see only running tasks
- Use `check_task` with a specific task ID to get detailed results
</instruction>

<output>
Returns a list of all tasks including:
- Task ID and current status (running, completed, failed, cancelled)
- Description and agent type
- Time since creation
- Note: Real-time progress is not available for async tasks; only final status and results are returned
</output>