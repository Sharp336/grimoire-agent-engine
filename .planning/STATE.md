# State

## Current Position

Phase: Not started (defining requirements)
Plan: --
Status: Defining requirements
Last activity: 2026-03-19 -- Milestone v1.0 started

## Project Reference

See: .planning/PROJECT.md (updated 2026-03-19)

**Core value:** In long sessions, the agent stays competent and oriented without bloating the active context window or forcing the user to re-brief.
**Current focus:** Context bounding — 4 core rules for bounded context management

## Current Milestone: v1.0 Context Bounding

**Goal:** Bound the active context window with hard limits, relevance-gated hydration, and tool transcript exclusion so long sessions stay competent without ballooning prompt size.

**Target features:**
- Hard cap on recent messages in active window
- Relevance floor for older history inclusion
- Tool transcript exclusion from conversation window
- Observability logging for inclusion/exclusion decisions
- Config cutover from 5 knobs to 2

## Accumulated Context

(First milestone -- no accumulated context from prior milestones)
