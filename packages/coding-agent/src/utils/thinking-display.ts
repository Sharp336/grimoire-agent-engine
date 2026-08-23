import type { AgentMessage } from "@oh-my-pi/pi-agent-core";

// Single-slot-per-mode memo for formatThinkingForDisplay. During a streaming
// tick the same growing thinking text is formatted up to three times (reveal
// count, reveal slice, component render); this collapses them to one
// computation. Prose and raw modes produce different output for the same text,
// so each mode keeps its own slot. One entry per mode is enough for the common
// case of one active thinking block and never regresses (a miss recomputes
// exactly as before).
//
// Each slot also enables incremental extension for the streaming case: when
// text.startsWith(cache.text) the fold resumes at the last (possibly partial)
// line boundary — only the appended suffix is re-scanned, reusing the folded
// prefix and the fence state stored for that boundary. The last input line is
// always re-folded (never committed), so its transient effects — comment-noise
// skipping, the prose ellipsis — are replayed under the new context instead of
// leaking into the memoized prefix.
interface DisplayCache {
	/** last formatted text */
	text: string;
	/** formatted output for `text` */
	value: string;
	/** folded output lines for all but the last line of `text` */
	result: string[];
	/** number of newline-terminated lines of `text` = split count - 1 */
	lineCount: number;
	/** fence state at the `result` boundary (entering the last line) */
	inFence: boolean;
	fenceChar: string;
	fenceLen: number;
}

function freshDisplayCache(): DisplayCache {
	return { text: "", value: "", result: [], lineCount: 0, inFence: false, fenceChar: "", fenceLen: 0 };
}

const proseCache = freshDisplayCache();
const rawCache = freshDisplayCache();

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

// gpt-5.x reasoning summaries pad every summary part with an empty HTML
// comment (`**Headline**\n\n<!-- -->`), streamed as a `<!--` delta followed by
// ` -->`. Comments with actual content are left untouched.
const EMPTY_COMMENT_RE = /^<!--\s*-->$/;
const OPEN_COMMENT_RE = /^<!--\s*$/;

/**
 * Whether `line` is reasoning-summary comment noise: an empty HTML comment,
 * or its still-unterminated `<!--` prefix on the last line while streaming.
 */
function isCommentNoise(line: string, isLastLine: boolean): boolean {
	const trimmed = line.trim();
	return EMPTY_COMMENT_RE.test(trimmed) || (isLastLine && OPEN_COMMENT_RE.test(trimmed));
}

/**
 * Thinking text prepared for display. Both modes drop empty `<!-- -->`
 * sentinel lines outside code fences (see {@link isCommentNoise}); prose-only
 * mode additionally elides fenced code down to a trailing ellipsis.
 */
export function formatThinkingForDisplay(text: string, proseOnly: boolean): string {
	if (!text) return text;
	const hasComment = text.includes("<!--");
	if (proseOnly) {
		if (text === proseCache.text) return proseCache.value;
	} else {
		if (!hasComment) return text;
		if (text === rawCache.text) return rawCache.value;
	}

	const cache = proseOnly ? proseCache : rawCache;
	const lines = text.split("\n");
	const resuming = cache.text.length > 0 && text.startsWith(cache.text);
	const resultLines = resuming ? cache.result : [];
	let inFence = resuming ? cache.inFence : false;
	let fenceChar = resuming ? cache.fenceChar : "";
	let fenceLen = resuming ? cache.fenceLen : 0;

	const FENCE = /^( {0,3})([`~]{3,})/;
	const appendEllipsis = () => {
		let lastLineIdx = resultLines.length - 1;
		while (lastLineIdx >= 0 && resultLines[lastLineIdx]!.trim() === "") {
			lastLineIdx--;
		}

		if (lastLineIdx >= 0) {
			const lastLine = resultLines[lastLineIdx]!;
			const trimmed = lastLine.trimEnd();
			if (trimmed.endsWith("...")) {
				resultLines[lastLineIdx] = trimmed;
			} else if (trimmed.endsWith(".")) {
				resultLines[lastLineIdx] = `${trimmed.slice(0, -1)}...`;
			} else {
				resultLines[lastLineIdx] = `${trimmed}...`;
			}
		} else {
			resultLines.push("...");
		}
	};

	// Fold state entering the last line: the result and fence state produced
	// by the newline-terminated lines only. Committed as the next boundary.
	let boundaryResult: string[] | null = null;
	let boundaryInFence = false;
	let boundaryFenceChar = "";
	let boundaryFenceLen = 0;

	for (let i = resuming ? cache.lineCount : 0; i < lines.length; i++) {
		const line = lines[i]!;
		if (i === lines.length - 1) {
			boundaryResult = resultLines.slice();
			boundaryInFence = inFence;
			boundaryFenceChar = fenceChar;
			boundaryFenceLen = fenceLen;
		}

		if (inFence) {
			const close = FENCE.exec(line);
			// A closing fence is the same char, at least as long, with nothing else on the line.
			if (
				close &&
				close[2]![0] === fenceChar &&
				close[2]!.length >= fenceLen &&
				line.slice(close[1]!.length + close[2]!.length).trim() === ""
			) {
				inFence = false;
				fenceChar = "";
				fenceLen = 0;
			}
			// Prose mode skips all fence lines; raw mode keeps them verbatim
			// (comment markers inside fences are code, not noise).
			if (!proseOnly) resultLines.push(line);
			continue;
		}

		// Drop the whole line so `**Headline**\n\n<!-- -->` leaves no blank tail.
		if (hasComment && isCommentNoise(line, i === lines.length - 1)) continue;

		const open = FENCE.exec(line);
		if (open) {
			const marker = open[2]!;
			const ch = marker[0]!;
			// A backtick fence's info string may not contain a backtick.
			if (!(ch === "`" && line.slice(open[1]!.length + marker.length).includes("`"))) {
				inFence = true;
				fenceChar = ch;
				fenceLen = marker.length;
				if (proseOnly) {
					appendEllipsis();
				} else {
					resultLines.push(line);
				}
				continue;
			}
		}
		resultLines.push(line);
	}

	const formatted = resultLines.join("\n");
	cache.text = text;
	cache.value = formatted;
	cache.result = boundaryResult ?? resultLines;
	cache.lineCount = lines.length - 1;
	cache.inFence = boundaryInFence;
	cache.fenceChar = boundaryFenceChar;
	cache.fenceLen = boundaryFenceLen;
	return formatted;
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
