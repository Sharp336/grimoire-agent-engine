# MCP discovery benchmark analysis

## Configuration
- Model: `openai-codex/gpt-5.4`
- Thinking: `medium`
- Variants: baseline vs discovery
- Total runs: `600` (`300` per variant)
- Suites: retrieval + workflow
- Catalog buckets: `small`, `medium`, `large`
- Runs per task cell: `5`

## Headline results
- Overall success: baseline `99.7%`, discovery `98.7%`
- Retrieval success: baseline `99.6%`, discovery `99.2%`
- Workflow success: baseline `100.0%`, discovery `95.6%`
- Avg total tokens: baseline `23,861`, discovery `16,259`
- Successful-run avg total tokens: baseline `23,863`, discovery `15,842`
- p95 total tokens: baseline `58,404`, discovery `40,705`

## Interpretation
Discovery was materially more token-efficient overall, especially as catalogs grew:
- large catalog avg tokens: baseline `43,073`, discovery `16,569`
- medium catalog avg tokens: baseline `18,189`, discovery `16,673`
- small catalog avg tokens: baseline `10,322`, discovery `15,534`

Discovery was strongest when the catalog was medium/large and the task was retrieval-heavy or distractor-heavy. It cut token spend sharply while preserving near-perfect recall.

Discovery was weakest on multi-step workflows, especially large-catalog tasks that needed both documentation lookup and ticket creation. Those regressions were mostly from search/activation drift and turn-limit failures rather than simple inability to find any relevant tool.

## Where discovery is useful
Use discovery mode when:
- the MCP catalog is medium or large
- the user intent maps to one or a small number of MCP tools
- distractor density is high and prompt-space tool listing is expensive
- retrieval, alias, distractor, abstain, and single-tool tasks dominate

Evidence:
- discovery preserved `100%` abstain accuracy
- discovery kept retrieval success at `99.2%`
- discovery reduced avg total tokens by about `31.9%` overall
- discovery reduced large-catalog avg token usage by about `61.5%`

## Where discovery is not useful
Avoid or treat carefully when:
- the catalog is already small
- the workflow is multi-step and depends on chaining multiple tools correctly
- the model may over-search or activate semantically similar but wrong tools
- max-turn limits are tight and the task requires iterative exploration before action

Evidence:
- small-catalog avg tokens got worse under discovery: `15,534` vs baseline `10,322`
- workflow success regressed to `95.6%` from baseline `100.0%`
- multi-tool discovery success was `95.6%` vs baseline `98.9%`
- discovery failures clustered on docs/ticket workflows in large catalogs

## Failure modes observed
There were `5` failed runs total:
- `1` baseline failure
- `4` discovery failures

Discovery failure pattern:
- `4/5` total failures were `Benchmark task exceeded max turn limit of 8`
- all discovery failures were on multi-step docs/ticket or workflow tasks
- failures were concentrated in `large` catalogs
- one baseline failure used an incorrect filler Jira tool instead of the required ticket-creation tool

Most problematic task families:
- `retrieval/docs-ticket-link-02`
- `retrieval/docs-ticket-link-03`
- `workflow/docs-ticket-followup`
- `workflow/pager-alert-summary`

## Practical recommendation
For Codex medium thinking, discovery mode is a good default for large MCP catalogs when the dominant problem is tool selection cost. It is not a universal win: for small catalogs and multi-step workflows, baseline direct exposure remained more reliable.

If discovery is enabled in production, the safest rollout shape is:
1. enable it first for medium/large catalogs
2. prefer it for retrieval-oriented tool selection
3. keep additional scrutiny on multi-step workflow tasks
4. consider higher turn budgets or better search activation constraints for docs/ticket chains
