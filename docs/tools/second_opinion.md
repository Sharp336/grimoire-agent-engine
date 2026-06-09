# second_opinion

> Send the current session transcript to a different model for an independent, adversarial second-opinion review. Some other tools call this a "rubber duck" review.

## Source
- Entry: `packages/coding-agent/src/tools/second-opinion.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/second-opinion.md`
- Reviewer system persona: `packages/coding-agent/src/prompts/tools/second-opinion-system.md`
- Key collaborators:
  - `packages/coding-agent/src/config/model-equivalence.ts` — `getModelSeries(...)` coarse vendor-lineage family used for the cross-family default and the same-family warning.
  - `packages/coding-agent/src/config/model-resolver.ts` — `expandRoleAlias(...)` / `resolveModelFromString(...)` / `formatModelString(...)` reviewer resolution.
  - `packages/coding-agent/src/config/model-registry.ts` — `secondopinion` model role, `getAvailable(...)`, `getCanonicalId(...)`, `getApiKey(...)`.
  - `packages/agent/src/telemetry.ts` — `instrumentedCompleteSimple(...)` / `resolveTelemetry(...)` one-shot completion with oneshot kind `second_opinion`.
  - `packages/coding-agent/src/session/session-manager.ts` — `sessionManager.getBranch()` supplies the transcript.

## Enablement
- Gated by `secondOpinion.enabled` (`tools/index.ts` `isToolAllowed`), **default `false`** — the tool forwards the full transcript to another model/vendor, so it is opt-in like `inspect_image` / `github`.
- `loadMode: "discoverable"`: hidden until activated by tool search even once enabled.
- First interactive transcript send shows a one-time data-disclosure consent (`secondOpinion.consented`), including explicit `model` calls. Headless runs treat `secondOpinion.enabled = true` as consent and never persist the flag.

## Inputs

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `focus` | `string` | No | What the reviewer should scrutinize. Falls back to a general adversarial-review instruction when omitted. |
| `model` | `string` | No | Explicit reviewer selector (`provider/id`, `id`, or substring). Bypasses the configured role and the picker; first-run transcript consent still applies; never persisted. |
| `effort` | `"off" \| "low" \| "medium" \| "high"` | No (default `medium`) | Reviewer reasoning effort, clamped to what the model supports via `getSupportedEfforts(...)`. |
| `lookback` | positive integer | No | Limit the review to the N most recent **rendered message turns** instead of all that fit the char budget. |

The schema is `.strict()`: only these four fields are accepted.

## Outputs
The tool returns a single `AgentToolResult`:

- `content`: one text block — the reviewer's prose review, with a trailing `Verdict: <…>` line when a verdict was produced.
- `details`:
  - `verdict`: `SOUND` / `SOUND_WITH_CAVEATS` / `FLAWED`, or omitted if none could be derived.
  - `reviewerModel`: `<provider>/<id>` of the reviewing model.
  - `sessionModel`: `<provider>/<id>` of the active session model, when known.
  - `source`: how the reviewer was chosen — `explicit`, `configured`, `slow`, or `fallback`.
  - `entriesIncluded`: number of transcript turns sent after budget/lookback trimming.
  - `transcriptChars`: character length of the rendered transcript.
  - `effort`: the requested effort level (pre-clamp).
  - `sameFamily`: whether reviewer and session model share an inferred series family.
  - `structured`: whether the verdict came from the forced tool call / JSON (`true`) or a prose keyword scan (`false`).

## Structured verdict
The reviewer is steered to call a single forced tool `submit_review({ verdict, review })` (`tools` + `toolChoice` on `instrumentedCompleteSimple`, the same mechanism as the eval `llm()` bridge). `parseVerdict(...)` reads the tool-call arguments while ignoring extra model-emitted fields, falls back to a JSON payload in the text, then to the raw prose with a keyword-scanned verdict. It never throws — the prose review is surfaced even when the structure is imperfect.

## Reviewer resolution
1. explicit `params.model` → `resolveModelFromString(...)`; unresolved selectors raise `ToolError`, `source = "explicit"`.
2. interactive picker may run (see below), persisting `modelRoles.secondopinion` + fingerprint, `source = "configured"`.
3. `resolveDefaultReviewer(...)`: configured role (`configured`) → slow model **if cross-family** with the session (`slow`) → any available cross-family model (`fallback`) → slow (`slow`) → first available only after exhausting cross-family candidates or when no session family is known (`fallback`).

There is intentionally **no** `priority.json` entry for `secondopinion`. Cross-family-by-default is achieved structurally via the series-family check, not a curated vendor list.

## Picker + change detection
- Source of truth: `settings.getModelRole("secondopinion")` / `setModelRole`.
- The picker (`context.ui.select` / `context.ui.confirm`) fires when: no stored fingerprint (first run), or the session/slow model **family** changed since the last confirmation. Its title states that the selection is saved as the default `modelRoles.secondopinion`. Point releases within a family (e.g. `opus-4.7` → `opus-4.8`) do not re-prompt — the fingerprint stores families, not raw model ids.
- The fingerprint is `{ sessionFamily, slowFamily, confirmedReviewer }`. A reviewer edited out of band (config/CLI) is taken as implicit confirmation: the fingerprint is refreshed silently and no prompt is shown.
- Same-family picks trigger a confirm warning that can be declined to re-pick.
- Headless: no picker; resolution falls through `resolveDefaultReviewer(...)`.

## Side Effects
- Settings: on picker confirmation writes `modelRoles.secondopinion` and `secondOpinion.lastPickerFingerprint`; on first interactive transcript send writes `secondOpinion.consented`. Reads those plus model usage order and the active model.
- Network: sends the rendered transcript to the reviewer model via `instrumentedCompleteSimple(...)`.
- Session state: reads the current branch via `sessionManager.getBranch()`; does not mutate the transcript. The verdict is returned as information only — it does not auto-steer subsequent turns.
- Cancellation: passes the caller `AbortSignal` into the completion call; aborted responses surface as `ToolError`.

## Limits & Caps
- `CHAR_BUDGET = 48_000` characters of transcript, keeping the most recent turns; at least one turn is always kept.
- `TOOL_RESULT_TRUNC = 400` characters per tool-result turn before `…[truncated]`.
- Reasoning effort is clamped to the model's supported set; non-reasoning models and `effort: "off"` send no reasoning level.
- Transcript rendering drops thinking and image blocks; tool calls render as `[tool call: <name>]` markers.

## Branch semantics
`lookback` counts **rendered message turns** (user/assistant/tool-result/custom-message), not raw entries, bytes, or tokens. "Current branch" is `SessionManager.getBranch()` — the path from the current leaf to the root — so in a forked session the reviewer sees only the active path, never sibling branches.

## Errors
- Context / registry: `second_opinion requires an active session context.`, `second_opinion has no session transcript to review.`, `Model registry is unavailable for second_opinion.`, `No authenticated models available for second_opinion.`
- Consent: `second_opinion cancelled: transcript sharing was declined.`
- Model resolution: `second_opinion: model "<selector>" not found. Available include: …`, `second_opinion could not resolve a reviewer model.`, `No API key available for <provider>/<id>. …`
- Transcript: `second_opinion has no prior conversation context to review.`
- Model call: provider `errorMessage` passthrough else `second_opinion reviewer request failed.`, `second_opinion review aborted.`, `second_opinion reviewer returned no review text.`

Failures surface as thrown `ToolError`s from `execute(...)`.

## Notes
- The `secondopinion` model role is first-class (`MODEL_ROLES` / `MODEL_ROLE_IDS`) but intentionally absent from `cycleOrder` and `priority.json`.
- Family inference uses `getModelSeries(...)` on the model's canonical id (so mirrors/proxies and point releases fold onto the same vendor lineage) and is used only for cross-family default selection and the same-family warning, never for resolution itself.
- Distinct from `task(agent:"oracle")`: that re-runs the agent loop with tools and its own system prompt on a same-tier model; `second_opinion` is a stateless one-shot review of the verbatim transcript on a deliberately different model.
