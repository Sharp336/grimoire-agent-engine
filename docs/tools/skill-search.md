# skill_search

> Search locally discovered skill metadata and return ranked `skill://...` URLs.

## Source
- Entry: `packages/coding-agent/src/tools/skill-search.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/skill-search.md`
- Skill discovery and ordering: `packages/coding-agent/src/extensibility/skills.ts`

## Registration / Visibility
- Tool metadata: `approval = "read"`, `strict = true`, `loadMode = "discoverable"`.
- Registration requires `skills.enabled != false` and a session that has or explicitly requests `read`.
- Ordinary sessions with `tools.xdev = true` mount it under `xd://skill_search`; explicitly requested tools remain top-level.
- The tool searches all active, non-hidden discovered skills, including skills omitted from the system prompt by `skills.promptMode`.

## Inputs

| Field | Type | Required | Description |
|---|---|---:|---|
| `query` | `string` | Yes | Skill name or capability to search for. |

## Outputs
- Matching results return up to eight ranked rows containing the skill name, description, `skill://<name>` URL, source, and numeric score.
- Text output lists each matching URL and tells the model to use `read` on the highest-ranked URL.
- No match returns `No matching skills found.`, an empty `details.results` array, and `useless = true`.

## Ranking
1. The query, skill name, and description are lowercased and split into Unicode letter/number tokens.
2. Each exact name-token match adds 6 points; a name-token prefix adds 3.
3. Each exact description-token match adds 3 points; a description-token prefix adds 1.
4. Zero-score entries are removed. Remaining entries sort by score, then the stable skill ordering used by discovery.
5. Hidden skills are removed before results are returned.

## Side Effects
- Filesystem: none. The tool searches the session's in-memory skill metadata.
- Network: none.
- Session state: read-only. It uses the session's live skill getter, so completed skill refreshes are visible to later calls.

## Limits & Caps
- Results are capped at eight.
- Empty or punctuation-only queries return no matches.
- Search does not inspect or return skill bodies. Use `read` with a returned `skill://...` URL for full instructions.
- Search does not fetch network content or discover new skill directories; `refreshSkills()` owns rediscovery.
