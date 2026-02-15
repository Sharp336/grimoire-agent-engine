# Check Task

Query the status of an async task by ID. Use after spawning tasks with `task` tool using `async: true`.

<instruction>
- Call this to check status of a specific async task by its task ID
- Returns status: running, completed, failed, cancelled, not_found
- For completed tasks, includes full results
- For failed tasks, includes error message
- Results auto-deliver when tasks complete — do NOT poll check_task in a loop
- Use `list_tasks` to see all tasks; use this for detailed results from ONE specific task
- Task results are automatically evicted from memory after approximately 5 minutes
</instruction>

<output>
Returns task status summary including:
- Current execution status
- Task metadata (agent, description, duration)
- Result data (for completed tasks)
- Error message (for failed tasks)
- Note: Real-time progress is not available for async tasks; only final status and results are returned
</output>