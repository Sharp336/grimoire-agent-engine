---
title: Catalog regeneration can drop bundled fallback rows when authoritative discovery is incomplete
date: 2026-06-26
category: tooling
module: catalog
tags: [catalog, generate-models, umans, authoritative-discovery, models-json, agent-db]
applies_when: [regenerating packages/catalog/src/models.json, debugging bundle drift after generate-models]
---

# Catalog regeneration can drop bundled fallback rows when authoritative discovery is incomplete

## Context
`packages/catalog/scripts/generate-models.ts` reads provider credentials from env vars and auth storage (`agent.db`), then treats some providers as `dynamicModelsAuthoritative`. That means a local regen can replace bundled fallback rows with whatever the live provider discovery returned on this machine.

Observed symptom: a fresh regen dropped `umans-glm-5.1` from `packages/catalog/src/models.json` even though the checked-in bundle and `packages/catalog/test/umans-provider.test.ts` required both `umans-glm-5.1` and `umans-glm-5.2` to stay bundled as text-only via-handoff rows.

## What didn't work
- Treating the churn as a generated-file merge problem. Hand-merging `models.json` was the wrong layer.
- Regenerating with a temporary empty `PI_CODING_AGENT_DIR`. That removed auth-storage leakage, but Umans discovery still succeeded unauthenticated and remained authoritative.
- Building the Umans seed from the current bundled references. Once a bad regen had already removed `umans-glm-5.1`, the derived seed could no longer reconstruct it.

## Guidance
Fix the source-of-truth path, not the generated JSON:

1. Add an explicit source-level static seed for required bundled rows in `packages/catalog/src/provider-models/openai-compat.ts`.
2. Push that seed from `packages/catalog/scripts/generate-models.ts` alongside the other curated seeds (`xai-oauth`, `sakana`, `fireworks`).
3. Regenerate `packages/catalog/src/models.json`.
4. Verify the exact bundled-contract tests, not just the generator run:

```bash
bun test packages/catalog/test/umans-provider.test.ts
bun test packages/catalog/test/generated-policies.test.ts
```

## Why it works
For authoritative providers, `generate-models.ts` deliberately blocks previous-snapshot fallback rows from reappearing. If live discovery is incomplete, required bundled rows disappear unless they are seeded explicitly from source. Hard-coding the required Umans via-handoff rows makes the bundle deterministic and independent of whatever this machine's live discovery returns.

## When to apply
Use this when a regenerated `models.json` drops a checked-in bundled row even though the runtime/tests still require it, especially for providers marked authoritative in `openai-compat.ts` or `descriptors.ts`.
