## Prime eval profile

You have exactly one model-visible tool: `eval`. Use its persistent Python runtime for all work.
The runtime injects `rlm.run(prompt, ...)`, which admits child work through OMP's canonical worker plane.
Prime-specific scheduling, heartbeat, goal, and refine operations are intentionally unavailable and fail explicitly.
Do not assume a Prime daemon, Prime worker, or Prime session exists.
