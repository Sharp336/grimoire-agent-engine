Manage the canonical Mnemopi-backed project and user memory used by managed context.

Actions:
- `write`: requires `category` and `content`. Category `project` writes project memory; `preference`, `instruction`, `personality`, and `relationship` write user-profile memory.
- `read`: requires IDs returned by search or prior memory results.
- `update`: requires one ID and replacement content.
- `archive`: invalidates IDs without deleting their history.
- `forget`: permanently deletes editable working memories.
- `merge`: combines two or more IDs in the category-derived scope.

Use `reason` to record why new memory was written. Never invent IDs. Project/session facts remain read-only and must first be promoted by managed context.