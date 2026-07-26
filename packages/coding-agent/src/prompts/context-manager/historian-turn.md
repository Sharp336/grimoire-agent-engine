{{#if language}}
Write natural-language titles, summaries, and fact content in {{language}}.
{{/if}}

{{#if repair}}
Your previous response failed validation.

Validation error:
<validation-error>
{{validation_error}}
</validation-error>

Previous invalid response:
<previous-response>
{{previous_response}}
</previous-response>

Return a corrected full JSON object for the exact same source records. Do not change the requested source range.
{{else}}
Create compartments and supported facts for the supplied canonical records.
{{/if}}
{{#if merge}}
This is a merge pass. Cover the entire source range with exactly one compartment that consolidates the adjacent older compartments.
{{/if}}

The ordered tag sequence that must be covered is:
<tag-sequence>
{{tag_sequence}}
</tag-sequence>

Canonical source records:
<canonical-records>
{{canonical_records}}
</canonical-records>

Existing active compartments are continuity context only. Do not repeat or edit them:
<existing-compartments>
{{existing_compartments}}
</existing-compartments>

Return only the strict JSON object defined by the system contract.
