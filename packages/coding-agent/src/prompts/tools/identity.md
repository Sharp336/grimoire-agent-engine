Query identity information.

<instruction>
- `whoRu`: Returns the current agent's identity — name, role, model, available tools, skills, work style
- `whoisme`: Returns the user's persona profile (if configured)
- `update_persona`: Updates the user's persona. Provide `section` (basics/career/interests/preferences/interaction/thinking/constraints) and `data` (partial object to merge)
</instruction>

<output>
- whoRu: structured agent identity
- whoisme: structured user persona or empty template
- update_persona: success confirmation with updated fields
</output>
