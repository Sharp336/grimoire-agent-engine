import type { AgentMessage } from "@oh-my-pi/pi-agent-core";

// Fence marker: 3+ backticks or tildes at line start, up to 3 spaces of indent.
const FENCE = /^( {0,3})([`~]{3,})/;

export function canonicalizeMessage(text: string | null | undefined): string {
	if (!text) return "";
	const trimmed = text.trim();
	for (let i = 0; i < trimmed.length; i++) {
		const code = trimmed.charCodeAt(i);
		if (code !== 0x2e && code !== 0x2026 && code !== 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) {
			return trimmed;
		}
	}
	return "";
}

/**
 * Whether `line` is reasoning-summary comment noise: an empty HTML comment,
 * or its still-unterminated `<!--` prefix on the last line while streaming.
 * Fast-rejects ordinary prose lines without scanning past their first char.
 */
// gpt-5.x reasoning summaries pad every summary part with an empty HTML
// comment (`**Headline**\n\n<!-- -->`), streamed as a `<!--` delta followed by
// ` -->`. Comments with actual content are left untouched.
function isCommentNoise(line: string, isLastLine: boolean): boolean {
	const t = line.trimStart();
	if (!t.startsWith("<!--")) return false;
	const r = t.slice(4).trim();
	return r === "-->" || (isLastLine && r === "");
}

// Incremental per-mode cache for formatThinkingForDisplay. Streaming thinking
// text is append-only, so every COMPLETE line's output is frozen the moment it
// terminates; a call re-processes only the appended delta and re-emits the
// still-unterminated last line with isLastLine=true. Byte-identical to a full
// re-format at every prefix: the cache holds exactly the state a full pass
// has after the same complete lines, and the pending tail is never committed
// (it may still grow, and its noise-drop verdict depends on being last).
// A rewrite is detected by a verified append prefix (length + startsWith) and
// resets the slot, which re-runs the same delta path over the whole text.
// Prose and raw outputs differ, so each mode keeps its own slot.
type Cache = {
	text: string;
	out: string;
	result: string;
	hasLine: boolean;
	hasComment: boolean;
	pending: string;
	fence: string;
};
const newCache = (): Cache => ({
	text: "",
	out: "",
	result: "",
	hasLine: false,
	hasComment: false,
	pending: "",
	fence: "",
});
const proseCache = newCache(),
	rawCache = newCache();

/** Append a completed line to `out` (the implicit join separator is "\n"). */
function pushLine(c: Cache, line: string): void {
	c.out = c.hasLine ? `${c.out}\n${line}` : line;
	c.hasLine = true;
}

/** Prose fence collapse: rewrite the last non-blank output line with an ellipsis. */
function appendEllipsis(c: Cache): void {
	for (let end = c.out.length; end > 0; end = c.out.lastIndexOf("\n", end - 1)) {
		const start = c.out.lastIndexOf("\n", end - 1) + 1;
		if (c.out.slice(start, end).trim() === "") continue;
		const t = c.out.slice(start, end).trimEnd();
		c.out = `${c.out.slice(0, start)}${t.endsWith("...") ? t : `${t.endsWith(".") ? t.slice(0, -1) : t}...`}${c.out.slice(end)}`;
		return;
	}
	c.out = c.hasLine ? `${c.out}\n...` : "...";
	c.hasLine = true;
}

/** Process one complete line into the cache state, mirroring the original loop. */
function processLine(c: Cache, line: string, isLastLine: boolean, proseOnly: boolean): void {
	if (c.fence !== "") {
		const close = FENCE.exec(line);
		if (
			close &&
			close[2]![0] === c.fence[0] &&
			close[2]!.length >= c.fence.length &&
			line.slice(close[1]!.length + close[2]!.length).trim() === ""
		)
			c.fence = "";
		// Prose skips fence lines; raw keeps them verbatim (comments in fences are code).
		if (!proseOnly) pushLine(c, line);
		return;
	}
	// Drop the whole line so `**Headline**\n\n<!-- -->` leaves no blank tail.
	if (c.hasComment && isCommentNoise(line, isLastLine)) return;
	const open = FENCE.exec(line);
	if (open) {
		const marker = open[2]!;
		// A backtick fence's info string may not contain a backtick.
		if (!(marker[0] === "`" && line.slice(open[1]!.length + marker.length).includes("`"))) {
			c.fence = marker;
			if (proseOnly) appendEllipsis(c);
			else pushLine(c, line);
			return;
		}
	}
	pushLine(c, line);
}

/**
 * Thinking text prepared for display. Both modes drop empty `<!-- -->`
 * sentinel lines outside code fences (see {@link isCommentNoise}); prose-only
 * mode additionally elides fenced code down to a trailing ellipsis.
 */
export function formatThinkingForDisplay(text: string, proseOnly: boolean): string {
	if (!text) return text;
	const c = proseOnly ? proseCache : rawCache;
	if (text === c.text) return c.result;
	const isLonger = text.length > c.text.length;
	const delta = isLonger ? text.slice(c.text.length) : text;
	// hasComment is exact on every call: on appends the delta plus the 3-char
	// seam scan cover the added text; on rewrites the delta is the whole text.
	const hasComment =
		c.hasComment ||
		delta.includes("<!--") ||
		(isLonger && `${c.text.slice(-3)}${delta.slice(0, 3)}`.includes("<!--"));
	// Full prefix verification: the streamed text is a sibling slice of its
	// parent, so appends compare slice offsets in O(1). A rewrite — or a raw
	// slot first meeting a comment (its pending holds the whole text) —
	// resets the slot.
	const isAppend = isLonger && text.startsWith(c.text);
	// Identity fast path: marker-free text formats to itself — raw always
	// (its only transformation is dropping noise comment lines); prose while
	// it is a verified append of a single unterminated line that cannot open
	// a fence nor be a noise comment. The prose verdict rests on the cached
	// line state plus a delta newline scan, so it is only valid on appends —
	// on a rewrite the delta starts at the old length and can miss newlines
	// and fence markers before it. Entering identity resets the slot so no
	// stale line state leaks in. Ordinary lines pass these checks in O(1).
	if (
		proseOnly
			? isAppend && !hasComment && !c.hasLine && delta.indexOf("\n") === -1 && !FENCE.test(text)
			: !text.includes("<!--")
	) {
		Object.assign(c, newCache());
		c.pending = text;
		c.text = text;
		c.result = text;
		return c.result;
	}
	const reset = !isAppend || (!proseOnly && !c.hasComment);
	if (reset) Object.assign(c, newCache());
	c.hasComment = reset ? text.includes("<!--") : hasComment;
	const part = reset ? text : delta;
	if (part.indexOf("\n") === -1) {
		// No newline in the delta: only the pending tail grows.
		c.pending += part;
	} else {
		const parts = `${c.pending}${part}`.split("\n");
		c.pending = parts.pop()!;
		for (const line of parts) processLine(c, line, false, proseOnly);
	}
	c.text = text;
	// Re-emit the pending tail with isLastLine=true on a scratch copy so the
	// cached state stays "at the tail's start" (the tail may still grow).
	const s = { ...c };
	processLine(s, s.pending, true, proseOnly);
	c.result = s.out;
	return c.result;
}

/** Whether a formatted thinking block has non-placeholder content worth rendering. */
export function hasDisplayableThinking(
	text: string | null | undefined,
	formattedText: string | null | undefined,
): boolean {
	if (!text || !formattedText) return false;
	// Visibility keys off the formatted text: a block whose raw text is only
	// comment noise (`<!-- -->\n`) formats to whitespace and stays hidden. The
	// raw canonicalize check still hides dot/ellipsis-only placeholder blocks.
	return formattedText.trim().length > 0 && canonicalizeMessage(text).length > 0;
}

/** Whether an assistant message contains thinking content the TUI can reveal. */
export function messageHasDisplayableThinking(message: AgentMessage, proseOnly: boolean): boolean {
	if (message.role !== "assistant") return false;
	for (const content of message.content) {
		if (content.type !== "thinking") continue;
		if (hasDisplayableThinking(content.thinking, formatThinkingForDisplay(content.thinking, proseOnly))) {
			return true;
		}
	}
	return false;
}
