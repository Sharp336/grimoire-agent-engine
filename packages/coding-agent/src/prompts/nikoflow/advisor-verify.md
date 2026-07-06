Nikoflow verify gate `{{gateId}}`: adversarially review the final diff against the task and acceptance; call `advise` exactly once, using severity `blocker` for unmet acceptance or red validation, otherwise severity `nit` with a clean-review summary.

<task>
{{task}}
</task>

<acceptance>
{{acceptance}}
</acceptance>

<validation>
{{validation}}
</validation>

<diff>
{{diff}}
</diff>
