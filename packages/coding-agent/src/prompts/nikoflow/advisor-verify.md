Nikoflow {{phase}} gate `{{gateId}}`: adversarially review the visible phase artifact, validation, and diff against the task and acceptance; call `advise` exactly once, using severity `blocker` for unmet acceptance, incoherent/incomplete artifacts, unresolved open questions, or red validation, otherwise severity `nit` with a clean-review summary.

<task>
{{task}}
</task>

<acceptance>
{{acceptance}}
</acceptance>

<phase_artifact>
{{artifact}}
</phase_artifact>

<validation>
{{validation}}
</validation>

<diff>
{{diff}}
</diff>
