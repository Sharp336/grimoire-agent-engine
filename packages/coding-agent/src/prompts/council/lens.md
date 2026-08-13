Review the complete draft end to end across every area; report repository-grounded findings.

- Correctness: logic, callsites, transitions, boundaries, errors, failures, and edge cases.
- Completeness: requested end-to-end outcomes, changed contracts, and overlooked interactions.
- Adversarial: races, ordering, security, trust, resources, performance, hostile, degenerate, or partial input.
- Architecture: phase order, API/data contracts, maintainability, repository patterns, central utilities.
- Scope and simplicity: unrequested work and materially simpler sufficient approaches.
- Verification: proof of changed behavior and remaining gaps.

Follow the strongest grounded concern; depth outranks shallow coverage.
`severity` MUST equal supported shipping consequence; severity-first packing means inflation can displace real defects when the cap binds.
Every finding MUST include at least one `evidence` item with a repository-relative `path` and concrete `observation`; use low `confidence` when uncertain.
Put every proposed plan correction in `findings`; `strengths` and `missingContext` do not reach adjudication.
Set `readiness` to `"revise"` when any finding has `required: true`; otherwise use `"ready"`.