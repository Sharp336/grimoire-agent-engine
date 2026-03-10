# MCP Tool Discovery Benchmark Report

## Configuration

| Setting | Value |
|---------|-------|
| Started | 2026-03-09T23:37:25.976Z |
| Finished | 2026-03-10T01:47:57.820Z |
| Models | openai-codex/gpt-5.4 |
| Thinking Level | medium |
| Runs per task | 5 |
| Task concurrency | 1 |
| Timeout | 120000 ms |
| Max turns | 8 |
| Suites | retrieval, workflow |
| Catalog buckets | small, medium, large |
| Max total runs | 600 |
| Variants | baseline, discovery |

## Side-by-side Summary

| Metric | Baseline | Discovery |
|--------|----------|-----------|
| Runs | 300 | 300 |
| Task success rate | 99.7% | 98.7% |
| Exact tool-set match | 87.3% | 85.0% |
| Required-tool recall | 99.8% | 99.3% |
| Tool precision | 95.1% | 93.7% |
| Avg total tokens | 23,886 | 16,181 |
| Avg successful-run tokens | 23,888 | 15,736 |
| Tokens per successful task | 23,966 | 16,400 |
| p50 total tokens | 15,780 | 13,605 |
| p95 total tokens | 58,404 | 38,984 |
| Avg duration | 11.9s | 13.6s |
| Avg turns | 2.3 | 3.3 |
| Avg MCP tool calls | 1.30 | 1.32 |
| Avg search calls | 0.00 | 0.98 |
| Avg tokens before first relevant MCP tool | 10,405 | 9,727 |

## Retrieval Accuracy

| Metric | Baseline | Discovery |
|--------|----------|-----------|
| Task success rate | 99.6% | 99.2% |
| Exact tool-set match | 89.4% | 87.8% |
| Required-tool recall | 99.8% | 99.4% |
| Tool precision | 96.0% | 94.8% |
| Final-output correctness | 99.6% | 99.2% |
| Workflow-step correctness | 99.6% | 99.2% |
| Abstain accuracy | 100.0% | 100.0% |

## End-to-end Accuracy

| Metric | Baseline | Discovery |
|--------|----------|-----------|
| Task success rate | 100.0% | 95.6% |
| Exact tool-set match | 75.6% | 68.9% |
| Required-tool recall | 100.0% | 98.9% |
| Tool precision | 90.4% | 87.4% |
| Final-output correctness | 100.0% | 95.6% |
| Workflow-step correctness | 100.0% | 97.8% |

## Tokens & Time

| Metric | Baseline | Discovery |
|--------|----------|-----------|
| Avg input tokens | 9,965 | 8,558 |
| Avg output tokens | 211 | 291 |
| Avg cached tokens | 13,710 | 7,332 |
| Avg total tokens | 23,886 | 16,181 |
| Avg successful-run tokens | 23,888 | 15,736 |
| Tokens per successful task | 23,966 | 16,400 |
| Avg duration | 11.9s | 13.6s |
| Avg turns | 2.3 | 3.3 |
| Avg tool calls | 1.30 | 2.31 |
| Avg MCP tool calls | 1.30 | 1.32 |
| Avg search calls | 0.00 | 0.98 |

### Successful-run token averages

| Variant | Avg input | Avg output | Avg total |
|---------|-----------|------------|-----------|
| baseline | 9,973 | 209 | 23,888 |
| discovery | 8,383 | 283 | 15,736 |

## Discovery Diagnostics

| Metric | Discovery |
|--------|-----------|
| First-search recall@k | 95.4% |
| First-search MRR | 0.983 |
| Search-to-activation success | 98.8% |
| Avg tokens before first relevant MCP tool | 9,727 |

## Breakdowns

### Model

| Value | Variant | Runs | Success | Avg total tokens | Avg search calls |
|-------|---------|------|---------|------------------|------------------|
| openai-codex/gpt-5.4 | baseline | 300 | 99.7% | 23,886 | 0.00 |
| openai-codex/gpt-5.4 | discovery | 300 | 98.7% | 16,181 | 0.98 |

### Catalog bucket

| Value | Variant | Runs | Success | Avg total tokens | Avg search calls |
|-------|---------|------|---------|------------------|------------------|
| large | baseline | 100 | 100.0% | 43,069 | 0.00 |
| large | discovery | 100 | 97.0% | 16,315 | 0.98 |
| medium | baseline | 100 | 99.0% | 18,267 | 0.00 |
| medium | discovery | 100 | 99.0% | 16,703 | 1.01 |
| small | baseline | 100 | 100.0% | 10,321 | 0.00 |
| small | discovery | 100 | 100.0% | 15,527 | 0.96 |

### Task type

| Value | Variant | Runs | Success | Avg total tokens | Avg search calls |
|-------|---------|------|---------|------------------|------------------|
| abstain | baseline | 60 | 100.0% | 9,752 | 0.00 |
| abstain | discovery | 60 | 100.0% | 3,927 | 0.00 |
| alias | baseline | 60 | 100.0% | 20,919 | 0.00 |
| alias | discovery | 60 | 100.0% | 13,559 | 1.00 |
| distractor | baseline | 45 | 100.0% | 21,163 | 0.00 |
| distractor | discovery | 45 | 100.0% | 13,546 | 1.00 |
| multi | baseline | 90 | 98.9% | 38,036 | 0.00 |
| multi | discovery | 90 | 95.6% | 28,533 | 1.61 |
| single | baseline | 45 | 100.0% | 21,110 | 0.00 |
| single | discovery | 45 | 100.0% | 13,950 | 1.00 |

### Suite

| Value | Variant | Runs | Success | Avg total tokens | Avg search calls |
|-------|---------|------|---------|------------------|------------------|
| retrieval | baseline | 255 | 99.6% | 21,621 | 0.00 |
| retrieval | discovery | 255 | 99.2% | 14,662 | 0.93 |
| workflow | baseline | 45 | 100.0% | 36,723 | 0.00 |
| workflow | discovery | 45 | 95.6% | 24,794 | 1.31 |

## Per-task Results

| Task | Suite | Bucket | Model | Baseline success | Discovery success | Baseline tokens | Discovery tokens | Baseline search | Discovery search |
|------|-------|--------|-------|------------------|-------------------|-----------------|------------------|-----------------|------------------|
| retrieval/abstain-01-calendar-next-day | retrieval | large | openai-codex/gpt-5.4 | 100.0% | 100.0% | 17,806 | 3,915 | 0.00 | 0.00 |
| retrieval/abstain-01-calendar-next-day | retrieval | medium | openai-codex/gpt-5.4 | 100.0% | 100.0% | 7,272 | 3,921 | 0.00 | 0.00 |
| retrieval/abstain-01-calendar-next-day | retrieval | small | openai-codex/gpt-5.4 | 100.0% | 100.0% | 4,162 | 3,924 | 0.00 | 0.00 |
| retrieval/abstain-02-simple-arithmetic | retrieval | large | openai-codex/gpt-5.4 | 100.0% | 100.0% | 17,825 | 3,912 | 0.00 | 0.00 |
| retrieval/abstain-02-simple-arithmetic | retrieval | medium | openai-codex/gpt-5.4 | 100.0% | 100.0% | 7,271 | 3,919 | 0.00 | 0.00 |
| retrieval/abstain-02-simple-arithmetic | retrieval | small | openai-codex/gpt-5.4 | 100.0% | 100.0% | 4,166 | 3,909 | 0.00 | 0.00 |
| retrieval/abstain-03-sort-letters | retrieval | large | openai-codex/gpt-5.4 | 100.0% | 100.0% | 17,817 | 3,941 | 0.00 | 0.00 |
| retrieval/abstain-03-sort-letters | retrieval | medium | openai-codex/gpt-5.4 | 100.0% | 100.0% | 7,282 | 3,958 | 0.00 | 0.00 |
| retrieval/abstain-03-sort-letters | retrieval | small | openai-codex/gpt-5.4 | 100.0% | 100.0% | 4,175 | 3,927 | 0.00 | 0.00 |
| retrieval/abstain-04-uppercase-word | retrieval | large | openai-codex/gpt-5.4 | 100.0% | 100.0% | 17,809 | 3,933 | 0.00 | 0.00 |
| retrieval/abstain-04-uppercase-word | retrieval | medium | openai-codex/gpt-5.4 | 100.0% | 100.0% | 7,271 | 3,940 | 0.00 | 0.00 |
| retrieval/abstain-04-uppercase-word | retrieval | small | openai-codex/gpt-5.4 | 100.0% | 100.0% | 4,164 | 3,926 | 0.00 | 0.00 |
| retrieval/beeper-owner-01 | retrieval | large | openai-codex/gpt-5.4 | 100.0% | 100.0% | 38,228 | 13,573 | 0.00 | 1.00 |
| retrieval/beeper-owner-01 | retrieval | medium | openai-codex/gpt-5.4 | 100.0% | 100.0% | 15,592 | 13,534 | 0.00 | 1.00 |
| retrieval/beeper-owner-01 | retrieval | small | openai-codex/gpt-5.4 | 100.0% | 100.0% | 8,924 | 13,420 | 0.00 | 1.00 |
| retrieval/beeper-owner-04 | retrieval | large | openai-codex/gpt-5.4 | 100.0% | 100.0% | 38,230 | 13,583 | 0.00 | 1.00 |
| retrieval/beeper-owner-04 | retrieval | medium | openai-codex/gpt-5.4 | 100.0% | 100.0% | 15,600 | 13,764 | 0.00 | 1.00 |
| retrieval/beeper-owner-04 | retrieval | small | openai-codex/gpt-5.4 | 100.0% | 100.0% | 8,927 | 13,591 | 0.00 | 1.00 |
| retrieval/beeper-owner-07 | retrieval | large | openai-codex/gpt-5.4 | 100.0% | 100.0% | 38,226 | 13,553 | 0.00 | 1.00 |
| retrieval/beeper-owner-07 | retrieval | medium | openai-codex/gpt-5.4 | 100.0% | 100.0% | 15,599 | 13,562 | 0.00 | 1.00 |
| retrieval/beeper-owner-07 | retrieval | small | openai-codex/gpt-5.4 | 100.0% | 100.0% | 8,940 | 13,508 | 0.00 | 1.00 |
| retrieval/beeper-owner-10 | retrieval | large | openai-codex/gpt-5.4 | 100.0% | 100.0% | 38,232 | 13,571 | 0.00 | 1.00 |
| retrieval/beeper-owner-10 | retrieval | medium | openai-codex/gpt-5.4 | 100.0% | 100.0% | 15,600 | 13,535 | 0.00 | 1.00 |
| retrieval/beeper-owner-10 | retrieval | small | openai-codex/gpt-5.4 | 100.0% | 100.0% | 8,934 | 13,510 | 0.00 | 1.00 |
| retrieval/broadcast-note-02 | retrieval | large | openai-codex/gpt-5.4 | 100.0% | 100.0% | 38,273 | 13,566 | 0.00 | 1.00 |
| retrieval/broadcast-note-02 | retrieval | medium | openai-codex/gpt-5.4 | 100.0% | 100.0% | 15,617 | 13,540 | 0.00 | 1.00 |
| retrieval/broadcast-note-02 | retrieval | small | openai-codex/gpt-5.4 | 100.0% | 100.0% | 9,902 | 13,506 | 0.00 | 1.00 |
| retrieval/broadcast-note-05 | retrieval | large | openai-codex/gpt-5.4 | 100.0% | 100.0% | 38,246 | 13,579 | 0.00 | 1.00 |
| retrieval/broadcast-note-05 | retrieval | medium | openai-codex/gpt-5.4 | 100.0% | 100.0% | 15,619 | 13,582 | 0.00 | 1.00 |
| retrieval/broadcast-note-05 | retrieval | small | openai-codex/gpt-5.4 | 100.0% | 100.0% | 9,956 | 13,560 | 0.00 | 1.00 |
| retrieval/broadcast-note-08 | retrieval | large | openai-codex/gpt-5.4 | 100.0% | 100.0% | 38,250 | 13,501 | 0.00 | 1.00 |
| retrieval/broadcast-note-08 | retrieval | medium | openai-codex/gpt-5.4 | 100.0% | 100.0% | 15,616 | 13,546 | 0.00 | 1.00 |
| retrieval/broadcast-note-08 | retrieval | small | openai-codex/gpt-5.4 | 100.0% | 100.0% | 8,984 | 13,533 | 0.00 | 1.00 |
| retrieval/create-issue-04 | retrieval | large | openai-codex/gpt-5.4 | 100.0% | 100.0% | 38,445 | 13,747 | 0.00 | 1.00 |
| retrieval/create-issue-04 | retrieval | medium | openai-codex/gpt-5.4 | 100.0% | 100.0% | 15,789 | 13,771 | 0.00 | 1.00 |
| retrieval/create-issue-04 | retrieval | small | openai-codex/gpt-5.4 | 100.0% | 100.0% | 9,105 | 13,725 | 0.00 | 1.00 |
| retrieval/create-issue-08 | retrieval | large | openai-codex/gpt-5.4 | 100.0% | 100.0% | 38,408 | 13,794 | 0.00 | 1.00 |
| retrieval/create-issue-08 | retrieval | medium | openai-codex/gpt-5.4 | 100.0% | 100.0% | 15,796 | 13,781 | 0.00 | 1.00 |
| retrieval/create-issue-08 | retrieval | small | openai-codex/gpt-5.4 | 100.0% | 100.0% | 9,123 | 14,684 | 0.00 | 1.00 |
| retrieval/create-issue-12 | retrieval | large | openai-codex/gpt-5.4 | 100.0% | 100.0% | 38,428 | 13,723 | 0.00 | 1.00 |
| retrieval/create-issue-12 | retrieval | medium | openai-codex/gpt-5.4 | 100.0% | 100.0% | 15,792 | 13,710 | 0.00 | 1.00 |
| retrieval/create-issue-12 | retrieval | small | openai-codex/gpt-5.4 | 100.0% | 100.0% | 9,101 | 14,614 | 0.00 | 1.00 |
| retrieval/docs-ticket-link-01 | retrieval | large | openai-codex/gpt-5.4 | 100.0% | 100.0% | 81,202 | 24,186 | 0.00 | 1.40 |
| retrieval/docs-ticket-link-01 | retrieval | medium | openai-codex/gpt-5.4 | 80.0% | 100.0% | 26,373 | 27,857 | 0.00 | 1.40 |
| retrieval/docs-ticket-link-01 | retrieval | small | openai-codex/gpt-5.4 | 100.0% | 100.0% | 13,390 | 24,666 | 0.00 | 1.40 |
| retrieval/docs-ticket-link-02 | retrieval | large | openai-codex/gpt-5.4 | 100.0% | 100.0% | 65,932 | 30,679 | 0.00 | 1.80 |
| retrieval/docs-ticket-link-02 | retrieval | medium | openai-codex/gpt-5.4 | 100.0% | 80.0% | 32,715 | 39,659 | 0.00 | 2.40 |
| retrieval/docs-ticket-link-02 | retrieval | small | openai-codex/gpt-5.4 | 100.0% | 100.0% | 18,256 | 34,114 | 0.00 | 2.20 |
| retrieval/docs-ticket-link-03 | retrieval | large | openai-codex/gpt-5.4 | 100.0% | 80.0% | 70,169 | 37,972 | 0.00 | 2.00 |
| retrieval/docs-ticket-link-03 | retrieval | medium | openai-codex/gpt-5.4 | 100.0% | 100.0% | 29,838 | 41,549 | 0.00 | 2.60 |
| retrieval/docs-ticket-link-03 | retrieval | small | openai-codex/gpt-5.4 | 100.0% | 100.0% | 16,271 | 29,769 | 0.00 | 2.00 |
| workflow/docs-ticket-followup | workflow | large | openai-codex/gpt-5.4 | 100.0% | 80.0% | 74,281 | 35,769 | 0.00 | 2.00 |
| workflow/docs-ticket-followup | workflow | medium | openai-codex/gpt-5.4 | 100.0% | 100.0% | 43,070 | 32,604 | 0.00 | 1.60 |
| workflow/docs-ticket-followup | workflow | small | openai-codex/gpt-5.4 | 100.0% | 100.0% | 22,376 | 30,911 | 0.00 | 1.60 |
| workflow/github-triage-slack | workflow | large | openai-codex/gpt-5.4 | 100.0% | 100.0% | 57,822 | 19,660 | 0.00 | 1.00 |
| workflow/github-triage-slack | workflow | medium | openai-codex/gpt-5.4 | 100.0% | 100.0% | 23,869 | 19,328 | 0.00 | 1.00 |
| workflow/github-triage-slack | workflow | small | openai-codex/gpt-5.4 | 100.0% | 100.0% | 13,863 | 18,828 | 0.00 | 1.00 |
| workflow/pager-alert-summary | workflow | large | openai-codex/gpt-5.4 | 100.0% | 80.0% | 57,757 | 26,140 | 0.00 | 1.40 |
| workflow/pager-alert-summary | workflow | medium | openai-codex/gpt-5.4 | 100.0% | 100.0% | 23,768 | 21,002 | 0.00 | 1.20 |
| workflow/pager-alert-summary | workflow | small | openai-codex/gpt-5.4 | 100.0% | 100.0% | 13,704 | 18,905 | 0.00 | 1.00 |

## Biggest Wins / Worst Regressions

### Biggest wins

- retrieval/docs-ticket-link-01 · medium · openai-codex/gpt-5.4: success +20.0%, tokens +1,483
- retrieval/docs-ticket-link-01 · large · openai-codex/gpt-5.4: success 0.0%, tokens -57,017
- workflow/github-triage-slack · large · openai-codex/gpt-5.4: success 0.0%, tokens -38,162
- retrieval/docs-ticket-link-02 · large · openai-codex/gpt-5.4: success 0.0%, tokens -35,253
- retrieval/broadcast-note-08 · large · openai-codex/gpt-5.4: success 0.0%, tokens -24,749

### Worst regressions

- retrieval/docs-ticket-link-02 · medium · openai-codex/gpt-5.4: success -20.0%, tokens +6,944
- workflow/pager-alert-summary · large · openai-codex/gpt-5.4: success -20.0%, tokens -31,617
- retrieval/docs-ticket-link-03 · large · openai-codex/gpt-5.4: success -20.0%, tokens -32,197
- workflow/docs-ticket-followup · large · openai-codex/gpt-5.4: success -20.0%, tokens -38,512
- retrieval/docs-ticket-link-02 · small · openai-codex/gpt-5.4: success 0.0%, tokens +15,858
