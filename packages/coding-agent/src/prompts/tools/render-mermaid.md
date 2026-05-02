Convert raw Mermaid graph source into ASCII diagram output.

Parameters:
- `mermaid` (required): Raw Mermaid graph text to render, not a fenced Markdown code block.
- `config` (optional): JSON render configuration (spacing and layout options).
Behavior:
- Returns ASCII diagram text.
- ASCII only; does not emit Mermaid Markdown, SVG, or PNG.
- Saves full ASCII output to an artifact URL (`artifact://<id>`) when artifact storage is available.
- Returns an error when the Mermaid input is invalid or rendering fails.
