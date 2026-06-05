Send the current conversation to a different model for an independent, adversarial second-opinion review of your findings, plan, or code. Some other tools call this a "rubber duck" review.

<instruction>
- Use before committing to a non-trivial conclusion, when you want a cross-model sanity check, or when the user asks for a second opinion / to "rubber duck" something
- This is NOT a subagent: no tools, no agent loop, no re-derivation. It is a one-shot review of the verbatim conversation transcript on a deliberately different model — distinct from `task`/`oracle`, which re-run the agent loop on a same-tier model from an assignment you write
- The reviewer reads the prior transcript automatically — you do NOT repaste it
- Write a specific `focus` describing what to pressure-test (the claim, the risky branch, the question). Omit for a general adversarial review
- A cross-family reviewer (different model lineage than this session) catches more, because it does not share your blind spots; the tool prefers one by default and warns on same-family picks
- Leave `model` unset to use the configured `modelRoles.secondopinion` reviewer, falling back to a cross-family slow model. Set `model` only to force a specific reviewer for this one call
- This tool forwards the full transcript (including tool outputs and file contents it contains) to another model, possibly a different vendor. It is off by default and gated behind a one-time consent
</instruction>

<parameters>
- `focus` (optional): what the reviewer should pressure-test, and the desired output shape
- `model` (optional): explicit reviewer selector ("provider/id", "id", or substring). Bypasses the configured role and the picker
- `effort` (optional, default "medium"): reviewer reasoning effort, clamped to what the model supports
- `lookback` (optional): limit the review to the N most recent message turns instead of the full fitting transcript
</parameters>

<output>
- Returns the reviewer's prose analysis, ending with a one-line verdict: SOUND, SOUND_WITH_CAVEATS, or FLAWED (also surfaced structurally in details)
- Treat the verdict as advice, not authority: weigh it against the evidence before acting
</output>
