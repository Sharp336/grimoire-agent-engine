# @oh-my-pi/lcm-context

SQLite-backed context projection and summary storage for Oh My Pi.

The package keeps a rebuildable, branch-aware view of caller-owned history. Callers provide already-redacted source entries, execute leased summary jobs with their own model provider, and fall back to authoritative history whenever a projection is not ready.

## Requirements

- Bun 1.3.14 or newer
- A caller-owned SQLite path, or `:memory:` for isolated use

## Basic use

```ts
import { openLcmContext, type ContextScope } from "@oh-my-pi/lcm-context";

const scope: ContextScope = {
	projectId: "example-project",
	sessionId: "example-session",
	branchId: "main",
};

const lcm = await openLcmContext({ dbPath: "./context.sqlite" });
try {
	lcm.reconcile({ scope, entries: [] });

	const projection = lcm.project({
		...scope,
		tokenBudget: 32_000,
		freshTail: { maxSources: 32, maxTokens: 8_000 },
	});

	if (!projection.ready) {
		// Continue with the caller's authoritative history.
	}
} finally {
	lcm.close();
}
```

`claimSummaryJobs()` returns token-fenced leases. Complete, fail, extend, or release every claimed job with its `jobId` and `leaseToken`; never treat the derived database as the authoritative transcript.

For the OMP integration, settings, recovery behavior, and operator commands, see [Lossless Context Management](https://github.com/can1357/oh-my-pi/blob/main/docs/lossless-context-management.md). API changes are recorded in the [package changelog](./CHANGELOG.md).
