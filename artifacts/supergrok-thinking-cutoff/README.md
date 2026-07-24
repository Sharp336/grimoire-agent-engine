# SuperGrok thinking cutoff evidence

## Before

- Live `api.x.ai/v1/responses` dumps in `fib_comparison.json` and `PLANNING_FINDINGS.json`
- Real OMP session mid-cut summary in `before.session-thinking-excerpt.txt`
- `before.png` — rendered panel

## After (this branch)

- `resolveOpenAIResponsesOutputClamp` treats `xai-oauth` / `xai` like native Meta: use catalog `maxTokens` instead of the 64k OpenAI-compatible ceiling
- TUI thinking header shows `Thinking · summary` for those providers
- `after.tests.txt` — focused unit/integration test output
- `after.png` — rendered panel

## Limitation

SuperGrok still exposes **reasoning summaries**, not Cursor-identical full chain-of-thought. This PR fixes the OMP-side 64k clamp and sets honest UI expectations; fuller thinking requires xAI API changes.
