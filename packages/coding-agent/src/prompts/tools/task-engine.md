Delegate a bounded assignment to a child AgentInstance on a real Task or WorkStep.

Parent AgentInstance: {{parentAgentInstanceRef}}

Supply `target` as `{task_ref, work_step_id}`. Use `work_step_id: null` for an unoccupied Task-level writer; use an existing authorized WorkStep or real Child Task when the Task already has a responsible writer. The parent Attempt supplies provenance, not the child's work target or authority. The ClientHost checks target membership, current ACL, parent state and spawn ceilings before admission.

Supply `assignment` with the objective, context, constraints and expected result (at most 32 KiB UTF-8). The child launch uses the current authorized executor roster; neither profile refs nor model-selected special execution are accepted.
