# Check Task

Query the status of an async task by ID.

<instruction>
- Use this to check the status of tasks spawned via the `task` tool
- Results auto-deliver when tasks complete - do NOT poll or call check_task in a loop
- Returns task status (running, completed, failed, cancelled, not_found)
- For completed tasks, includes results
- For failed tasks, includes error message
</instruction>

<output>
Returns task status summary including:
- Current execution status
- Task metadata (agent, description, duration)
- Result data (for completed tasks)
- Error message (for failed tasks)
</output>