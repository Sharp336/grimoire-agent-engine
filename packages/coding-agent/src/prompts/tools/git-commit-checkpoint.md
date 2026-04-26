Commit outstanding work in the current project as a WIP checkpoint.

<when>
Call this at the end of a scope boundary — after a focused batch of direct edits, after a `task` batch returns with changes, or before yielding back to the user. The goal is to stop carrying uncommitted state across unrelated pieces of work.

Typical triggers:
- You finished a small mechanical change yourself and are about to move on to a different concern.
- A `task` batch merged and your working tree now has subagent commits plus your own uncommitted touches.
- The `task` tool already commits dirty state automatically before dispatching an isolated task. You do not need to checkpoint manually before `task` calls.
</when>

<behavior>
- Discovers every dirty repo under the project root (including nested repos) and commits each one separately with the project's agentic commit pipeline in silent mode.
- Stages all tracked + untracked changes before generating each commit message.
- Discovery aborts before staging if it encounters a nested repository with the same `remote.origin.url` as the project root or crosses a filesystem boundary under the project root.
- Commits are unsigned WIP checkpoints — the user coalesces them later via `/commit` or `omp commit`.
- Clean repos are skipped silently. If every repo is clean the call returns `status: "clean"` without doing anything.
- Errors committing one repo do not prevent the others from being committed; per-repo errors are reported in the result.
</behavior>

<parameters>
- `reason` (required): brief label for what scope is closing, e.g. `"after login refactor"`, `"end of scope"`. Used only for agent bookkeeping and surfaced in the transcript — it is not written into the commit message itself.
</parameters>

<avoid>
- Do not call this after every single edit — coalesce related edits into one scope, then checkpoint.
- Do not use this to publish work. It is a local WIP checkpoint, not a release commit.
</avoid>
