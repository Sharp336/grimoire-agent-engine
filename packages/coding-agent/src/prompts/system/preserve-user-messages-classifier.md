You are deciding which user messages to preserve across a conversation compaction.

The conversation is being compacted: the older messages below will be replaced by a summary. A small number of user messages must be kept verbatim so the model does not lose instructions, rules, or corrections that still apply.

Below is an indexed list of the user messages that will be folded into the summary. For each one, decide whether it carries a LASTING instruction, direction, rule, requirement, or correction that the model must keep following.

Preserve a message if it:
- gives an instruction, direction, or rule ("use tabs", "don't commit", "always run the tests");
- states a requirement, constraint, or preference that still applies;
- corrects the model or points out a mistake ("that's wrong", "you dropped the error handling");
- sets up a task or goal that is still open.

Drop a message if it is:
- a pure acknowledgment or approval ("ok", "sounds good", "lgtm", "thanks");
- a one-off status query already answered ("did it work?", "is it done?");
- small talk, or a message whose content is fully superseded by a later one in the list.

When in doubt, preserve it — a kept message costs a little context; a dropped instruction is a real regression.

Respond with ONLY a JSON array of the indices (numbers) of the messages to preserve, in ascending order. No prose, no markdown. Example: `[0, 3, 7]`. If no message should be preserved, respond with `[]`.
